import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const repository = 'vltstudio/vltmusic';
const platforms = [
  { key: 'windows-x86_64', payload: '.exe', installer: 'nsis', extras: [] },
  { key: 'darwin-aarch64', payload: '.app.tar.gz', installer: 'app', extras: ['.dmg'] },
  { key: 'darwin-x86_64', payload: '.app.tar.gz', installer: 'app', extras: ['.dmg'] },
  { key: 'linux-x86_64', payload: '.AppImage', installer: 'appimage', extras: ['.deb'] },
];

function requireValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function versionParts(version) {
  if (typeof version !== 'string' || version.trim() !== version
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Releases require a stable major.minor.patch version');
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version component is too large');
  return parts;
}

function newerThan(version, previous) {
  const current = versionParts(version);
  const old = versionParts(previous);
  for (let index = 0; index < current.length; index++) {
    if (current[index] !== old[index]) return current[index] > old[index];
  }
  return false;
}

function checkTag(tag, version) {
  versionParts(version);
  if (tag !== `v${version}`) throw new Error('Release tag must exactly match the configured version');
}

function versionInfo(release = false) {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
  const crate = cargo.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const crateLock = readFileSync('src-tauri/Cargo.lock', 'utf8').split('[[package]]')
    .find((entry) => entry.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === crate);
  const lockedVersion = crateLock?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const version = config.version;
  versionParts(version);
  if ([pkg.version, lock.version, lock.packages?.['']?.version, cargoVersion, lockedVersion].some((item) => item !== version)) {
    throw new Error('Tauri, npm, Cargo and lockfile versions must match');
  }
  if (release) {
    checkTag(requireValue('RELEASE_TAG'), version);
    if (config.bundle?.createUpdaterArtifacts !== true || !config.plugins?.updater?.pubkey?.trim()
      || !config.plugins.updater.endpoints?.includes(`https://github.com/${repository}/releases/latest/download/latest.json`)) {
      throw new Error('Signed updater artifacts, public key and the static release endpoint must be configured');
    }
  }
  return version;
}

function context() {
  if (requireValue('GITHUB_REPOSITORY') !== repository) throw new Error('Unexpected release repository');
  const sha = requireValue('GITHUB_SHA');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid release commit');
  return { sha, tag: requireValue('RELEASE_TAG') };
}

async function request(path, options = {}) {
  const { method = 'GET', body, binary = false, optional = false } = options;
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${requireValue('GITHUB_TOKEN')}`,
      accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release API failed with HTTP ${response.status}`);
  if (response.status === 204) return null;
  return binary ? response.text() : response.json();
}

async function list(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await request(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub list response');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function verifyTagCommit(tag, sha) {
  const ref = await request(`/git/ref/tags/${encodeURIComponent(tag)}`, { optional: true });
  if (!ref) {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Release tag does not exist');
    return;
  }
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    object = (await request(`/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || object.sha !== sha) throw new Error('Release tag points to a different commit');
}

async function verifyNewer(version) {
  const latest = await request('/releases/latest', { optional: true });
  if (latest && !newerThan(version, latest.tag_name?.replace(/^v/, ''))) {
    throw new Error('Refusing to replace latest with the same or an older version');
  }
}

function output(values) {
  const path = requireValue('GITHUB_OUTPUT');
  for (const [key, value] of Object.entries(values)) appendFileSync(path, `${key}=${value}\n`);
}

async function prepare() {
  const version = versionInfo(true);
  const { tag, sha } = context();
  await verifyTagCommit(tag, sha);
  await verifyNewer(version);
  const releases = (await list('/releases')).filter((release) => release.tag_name === tag);
  if (releases.length > 1) throw new Error('Multiple releases exist for this tag');
  let release = releases[0];
  if (release && (!release.draft || release.target_commitish !== sha)) {
    throw new Error('Existing release is published or belongs to a different commit');
  }
  if (!release) {
    release = await request('/releases', { method: 'POST', body: {
      tag_name: tag, target_commitish: sha, name: `VLT Music ${version}`,
      body: 'Desktop installers and signed automatic-update payloads for VLT Music.',
      draft: true, prerelease: false,
    } });
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('Invalid release ID');
  output({ release_id: release.id, version, tag });
}

function expectedAssets(version) {
  return platforms.flatMap((platform) => {
    const prefix = `vltmusic_${version}_${platform.key}`;
    return [platform.payload, `${platform.payload}.sig`, ...platform.extras].map((extension) => prefix + extension);
  });
}

function validateAssets(version, assets) {
  const found = new Map();
  for (const asset of assets) {
    if (found.has(asset.name)) throw new Error('Duplicate release asset names');
    found.set(asset.name, asset);
  }
  for (const name of expectedAssets(version)) {
    const asset = found.get(name);
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !(asset.size > 0) || asset.state !== 'uploaded') {
      throw new Error(`Missing or incomplete release asset: ${name}`);
    }
  }
  return found;
}

function manifest(version, tag, assets, signatures, notes = '') {
  checkTag(tag, version);
  const found = validateAssets(version, assets);
  const entries = {};
  for (const platform of platforms) {
    const name = `vltmusic_${version}_${platform.key}${platform.payload}`;
    const signatureName = `${name}.sig`;
    const signature = signatures.get(signatureName)?.trim();
    if (!signature || signature.length > 16_384 || found.get(signatureName).size > 16_384) {
      throw new Error('Missing or invalid updater signature');
    }
    const entry = { signature, url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` };
    entries[platform.key] = entry;
    entries[`${platform.key}-${platform.installer}`] = entry;
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms: entries };
}

async function publish() {
  const version = versionInfo(true);
  const { tag, sha } = context();
  const id = requireValue('RELEASE_ID');
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid release ID');
  const release = await request(`/releases/${id}`);
  if (!release.draft || release.tag_name !== tag || release.target_commitish !== sha) {
    throw new Error('Only the matching draft release may be published');
  }
  await verifyTagCommit(tag, sha);
  await verifyNewer(version);
  const assets = await list(`/releases/${id}/assets`);
  const found = validateAssets(version, assets);
  const signatures = new Map();
  for (const platform of platforms) {
    const name = `vltmusic_${version}_${platform.key}${platform.payload}.sig`;
    if (found.get(name).size > 16_384) throw new Error('Updater signature is unexpectedly large');
    signatures.set(name, await request(`/releases/assets/${found.get(name).id}`, { binary: true }));
  }
  const body = JSON.stringify(manifest(version, tag, assets, signatures, release.body || ''), null, 2);
  writeFileSync('latest.json', body);
  const previous = assets.find((asset) => asset.name === 'latest.json');
  if (previous) await request(`/releases/assets/${previous.id}`, { method: 'DELETE' });
  const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=latest.json`, {
    method: 'POST', headers: {
      authorization: `Bearer ${requireValue('GITHUB_TOKEN')}`,
      'content-type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, body, signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Manifest upload failed with HTTP ${response.status}`);
  const uploaded = await response.json();
  if (uploaded.state !== 'uploaded' || uploaded.size !== Buffer.byteLength(body)) throw new Error('Manifest upload is incomplete');
  await request(`/releases/${id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  console.log(`Published complete signed release ${tag}`);
}

function selfTest() {
  assert.equal(newerThan('0.1.2', '0.1.1'), true);
  assert.equal(newerThan('0.1.2', '0.1.2'), false);
  assert.equal(newerThan('0.2.0', '1.0.0'), false);
  assert.throws(() => checkTag('v0.1.1', '0.1.2'));
  for (const invalid of ['0.1.2-beta', '01.1.2', '1.2', '1.2.3\n', `1.2.3${String.fromCharCode(10)}`, '9007199254740992.0.0']) assert.throws(() => versionParts(invalid));
  const version = '0.1.2';
  const assets = expectedAssets(version).map((name, index) => ({ name, id: index + 1, size: 100, state: 'uploaded' }));
  const signatures = new Map(assets.filter((asset) => asset.name.endsWith('.sig')).map((asset) => [asset.name, 'synthetic-public-signature']));
  const complete = manifest(version, 'v0.1.2', assets, signatures);
  assert.equal(Object.keys(complete.platforms).length, 8);
  for (const platform of platforms) {
    assert.match(complete.platforms[platform.key].url, /\/releases\/download\/v0\.1\.2\//);
    assert.equal(complete.platforms[platform.key], complete.platforms[`${platform.key}-${platform.installer}`]);
  }
  for (const missing of assets) assert.throws(() => manifest(version, 'v0.1.2', assets.filter((asset) => asset !== missing), signatures));
  assert.throws(() => manifest(version, 'v0.1.2', [...assets, assets[0]], signatures));
  assert.throws(() => manifest(version, 'v0.1.2', assets, new Map()));
  assert.throws(() => manifest(version, 'v0.1.2', assets.map((asset, index) => index ? asset : { ...asset, size: 0 }), signatures));
  assert.throws(() => manifest(version, 'v0.1.2', assets.map((asset, index) => index ? asset : { ...asset, state: 'new' }), signatures));
  console.log('Release guards and complete-manifest checks passed');
}

try {
  switch (process.argv[2]) {
    case 'check': console.log(`Version metadata matches: ${versionInfo()}`); break;
    case 'ci-config': writeFileSync('ci-tauri.json', JSON.stringify({ bundle: { createUpdaterArtifacts: false } })); break;
    case 'check-signing': if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Set TAURI_SIGNING_PRIVATE_KEY before releasing'); break;
    case 'prepare': await prepare(); break;
    case 'publish': await publish(); break;
    case 'test': selfTest(); break;
    default: throw new Error('Expected check, ci-config, check-signing, prepare, publish or test');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release helper failed');
  process.exitCode = 1;
}
