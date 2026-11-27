use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Extensions the scanner treats as music. Everything else in a folder is left
/// alone, so pointing the app at a big directory stays cheap.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "webm", "wma", "aiff", "aif",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    /// Stable id: `local:<absolute path>`.
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: Option<u32>,
    pub has_cover: bool,
    /// Folder the track was found under, used for grouping.
    pub root: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub roots: Vec<String>,
    pub total: usize,
    pub generation: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrackPage {
    pub items: Vec<LocalTrack>,
    pub total: usize,
    pub library_total: usize,
    pub generation: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalAddRootResult {
    pub status: LocalStatus,
    pub found: usize,
}

const MAX_TRACK_PAGE: usize = 256;
const NO_ARTIST_LABEL: &str = "Локальный файл";

#[derive(Default)]
struct TrackIndex {
    tracks: Vec<LocalTrack>,
    paths: HashMap<PathBuf, usize>,
    texts: Vec<String>,
    postings: HashMap<u64, Vec<u32>>,
    matches: Mutex<VecDeque<(String, Vec<u32>)>>,
    generation: u64,
    scanned: bool,
}

impl TrackIndex {
    fn new(tracks: Vec<LocalTrack>, generation: u64) -> Self {
        let mut index = Self {
            paths: HashMap::with_capacity(tracks.len()),
            texts: Vec::with_capacity(tracks.len()),
            tracks,
            generation,
            scanned: true,
            ..Self::default()
        };
        for (position, track) in index.tracks.iter().enumerate() {
            index
                .paths
                .entry(PathBuf::from(&track.path))
                .or_insert(position);
            let title = if track.title.is_empty() {
                &track.path
            } else {
                &track.title
            };
            let artist = if track.artist.is_empty() {
                NO_ARTIST_LABEL
            } else {
                &track.artist
            };
            let text = format!("{title} {artist} {}", track.album).to_lowercase();
            let (mut previous, mut pair) = (0, 0);
            for ch in text.chars() {
                let code = u64::from(ch) + 1;
                let next_pair = (previous << 21) | code;
                for gram in [code, next_pair, (pair << 21) | code] {
                    let postings = index.postings.entry(gram).or_default();
                    let position = position as u32;
                    if postings.last() != Some(&position) {
                        postings.push(position);
                    }
                }
                previous = code;
                pair = next_pair;
            }
            index.texts.push(text);
        }
        index
    }

    fn page(&self, query: &str, offset: usize, limit: usize) -> LocalTrackPage {
        let query = query
            .trim_matches(|ch: char| ch.is_whitespace() && ch != '\u{0085}' || ch == '\u{feff}')
            .to_lowercase();
        let limit = limit.clamp(1, MAX_TRACK_PAGE);
        let mut page = LocalTrackPage {
            items: Vec::new(),
            total: 0,
            library_total: self.tracks.len(),
            generation: self.generation,
        };
        if query.is_empty() {
            page.total = self.tracks.len();
            page.items
                .extend(self.tracks.iter().skip(offset).take(limit).cloned());
            return page;
        }

        let (mut gram, mut length, mut candidates) = (0, 0, None::<&[u32]>);
        const TRIGRAM_MASK: u64 = (1 << 63) - 1;
        for ch in query.chars() {
            gram = ((gram << 21) | (u64::from(ch) + 1)) & TRIGRAM_MASK;
            length += 1;
            if length < 3 {
                continue;
            }
            let Some(postings) = self.postings.get(&gram) else {
                return page;
            };
            if candidates.is_none_or(|current| postings.len() < current.len()) {
                candidates = Some(postings);
            }
        }
        if length <= 3 {
            if let Some(postings) = self.postings.get(&gram) {
                page.total = postings.len();
                page.items.extend(
                    postings
                        .iter()
                        .skip(offset)
                        .take(limit)
                        .map(|&position| self.tracks[position as usize].clone()),
                );
            }
            return page;
        }

        let mut cache = self
            .matches
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = cache
            .iter()
            .position(|(cached, _)| cached == &query)
            .and_then(|position| cache.remove(position))
            .unwrap_or_else(|| {
                let matches = candidates
                    .unwrap_or_default()
                    .iter()
                    .copied()
                    .filter(|&position| self.texts[position as usize].contains(&query))
                    .collect();
                (query, matches)
            });
        page.total = entry.1.len();
        page.items.extend(
            entry
                .1
                .iter()
                .skip(offset)
                .take(limit)
                .map(|&position| self.tracks[position as usize].clone()),
        );
        cache.push_front(entry);
        cache.truncate(4);
        page
    }
}

/// One app-level favourite. It carries its own metadata so the list renders
/// offline, without asking either source to resolve the id again.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    /// Source-tagged: `yt:<videoId>` or `local:<absolute path>`.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub duration: Option<u32>,
    /// `yt` or `local`.
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub video_id: Option<String>,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub thumb: Option<String>,
}

pub fn youtube_favorite_id(favorite: &Favorite) -> Option<&str> {
    if favorite.source != "yt" || favorite.local_path.is_some() {
        return None;
    }
    let id = favorite.video_id.as_deref()?;
    (id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && favorite.id == format!("yt:{id}"))
    .then_some(id)
}

/// One playlist moved to the local archive. It carries its own metadata so the
/// archive still renders when YouTube Music is unreachable.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedPlaylist {
    /// `playlistId` when known, otherwise the browse id.
    pub id: String,
    #[serde(default)]
    pub playlist_id: Option<String>,
    #[serde(default)]
    pub browse_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub thumbs: Vec<String>,
    #[serde(default)]
    pub archived_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    roots: Vec<String>,
    #[serde(deserialize_with = "deserialize_favorites")]
    favorites: Vec<Favorite>,
    favorites_account: Option<String>,
    archive: Vec<ArchivedPlaylist>,
    /// Absolute path of the archive's own cover, when the person set one.
    archive_cover: Option<String>,
}

/// Older builds stored favourites as bare ids. Accept both shapes so a store
/// written by them still loads its folder list.
fn deserialize_favorites<'de, D>(deserializer: D) -> std::result::Result<Vec<Favorite>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::String(id) => {
                let mut favorite = Favorite {
                    id: id.clone(),
                    ..Default::default()
                };
                if let Some(video_id) = id.strip_prefix("yt:") {
                    favorite.source = "yt".to_string();
                    favorite.video_id = Some(video_id.to_string());
                    favorite.title = video_id.to_string();
                } else {
                    favorite.source = "local".to_string();
                    let path = id.strip_prefix("local:").unwrap_or(&id).to_string();
                    favorite.title = Path::new(&path)
                        .file_stem()
                        .map(|stem| stem.to_string_lossy().to_string())
                        .unwrap_or(path.clone());
                    favorite.local_path = Some(path);
                }
                Some(favorite)
            }
            other => serde_json::from_value::<Favorite>(other).ok(),
        })
        .collect())
}

/// Local files plus the app's own favourites, kept in one small JSON file.
/// Favourites are source-tagged (`local:…`, `yt:…`) so more sources can join
/// later without touching this store.
pub struct LocalLibrary {
    path: PathBuf,
    /// The scanned list survives restarts; a 20k-file library must not be
    /// re-read every launch just to open the tab.
    tracks_path: PathBuf,
    cache_dir: PathBuf,
    store: std::sync::RwLock<Store>,
    writes: std::sync::Mutex<()>,
    tracks: OnceLock<RwLock<TrackIndex>>,
    scanning: Mutex<()>,
}

impl LocalLibrary {
    pub fn load(path: PathBuf, cache_dir: PathBuf) -> Self {
        let store = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Store>(&text).ok())
            .unwrap_or_default();
        let tracks_path = path.with_file_name("tracks.json");
        let _ = std::fs::create_dir_all(&cache_dir);
        Self {
            path,
            tracks_path,
            cache_dir,
            store: std::sync::RwLock::new(store),
            writes: std::sync::Mutex::new(()),
            tracks: OnceLock::new(),
            scanning: Mutex::new(()),
        }
    }

    fn track_index(&self) -> &RwLock<TrackIndex> {
        self.tracks.get_or_init(|| {
            let roots = self.roots();
            if roots.is_empty() {
                return RwLock::new(TrackIndex::default());
            }
            let cached = std::fs::File::open(&self.tracks_path)
                .ok()
                .and_then(|file| {
                    serde_json::from_reader::<_, Vec<LocalTrack>>(BufReader::new(file)).ok()
                });
            RwLock::new(cached.map_or_else(TrackIndex::default, |mut tracks| {
                tracks.retain(|track| roots.contains(&track.root));
                TrackIndex::new(tracks, 1)
            }))
        })
    }

    pub fn status(&self) -> Result<LocalStatus> {
        let index = self
            .track_index()
            .read()
            .map_err(|_| Error::io("track index is locked"))?;
        Ok(LocalStatus {
            roots: self.roots(),
            total: index.tracks.len(),
            generation: index.generation,
        })
    }

    pub fn search(
        &self,
        query: &str,
        offset: usize,
        limit: usize,
        generation: Option<u64>,
    ) -> Result<LocalTrackPage> {
        let index = self
            .track_index()
            .read()
            .map_err(|_| Error::io("track index is locked"))?;
        if generation.is_some_and(|generation| generation != index.generation) {
            return Err(Error::api(
                "Локальная библиотека изменилась. Выберите трек ещё раз.",
            ));
        }
        Ok(index.page(query, offset, limit))
    }

    fn save(&self) -> Result<()> {
        let store = self
            .store
            .read()
            .map_err(|_| Error::io("local store is locked"))?;
        self.write_store(&store)
    }

    fn write_store(&self, store: &Store) -> Result<()> {
        let _write = self
            .writes
            .lock()
            .map_err(|_| Error::io("local store is locked"))?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text =
            serde_json::to_string_pretty(store).map_err(|error| Error::io(error.to_string()))?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, &self.path)?;
        Ok(())
    }

    pub fn roots(&self) -> Vec<String> {
        self.store
            .read()
            .map(|store| store.roots.clone())
            .unwrap_or_default()
    }

    /// Newest first, so the list reads as a history of what was hearted.
    pub fn favorites(&self) -> Vec<Favorite> {
        self.store
            .read()
            .map(|store| store.favorites.clone())
            .unwrap_or_default()
    }

    /// Returns the new state: true when the favourite was added.
    pub fn toggle_favorite(&self, favorite: Favorite) -> Result<bool> {
        let mut store = self
            .store
            .write()
            .map_err(|_| Error::io("local store is locked"))?;
        let mut candidate = store.clone();
        let added = if let Some(index) = candidate
            .favorites
            .iter()
            .position(|item| item.id == favorite.id)
        {
            candidate.favorites.remove(index);
            false
        } else {
            candidate.favorites.insert(0, favorite);
            true
        };
        self.write_store(&candidate)?;
        *store = candidate;
        Ok(added)
    }

    pub fn favorites_account(&self) -> Result<Option<String>> {
        Ok(self
            .store
            .read()
            .map_err(|_| Error::io("local store is locked"))?
            .favorites_account
            .clone())
    }

    pub fn merge_synced_favorites(
        &self,
        started: &[Favorite],
        desired: Vec<Favorite>,
        expected_account: Option<&str>,
        account: &str,
    ) -> Result<Vec<Favorite>> {
        use std::collections::{BTreeMap, BTreeSet};
        let mut store = self
            .store
            .write()
            .map_err(|_| Error::io("local store is locked"))?;
        if store.favorites_account.as_deref() != expected_account {
            return Err(Error::api(
                "Аккаунт локального избранного изменился во время синхронизации",
            ));
        }
        let initial: BTreeSet<&str> = started.iter().filter_map(youtube_favorite_id).collect();
        let current: BTreeSet<&str> = store
            .favorites
            .iter()
            .filter_map(youtube_favorite_id)
            .collect();
        let mut wanted: BTreeMap<String, Favorite> = desired
            .iter()
            .filter_map(|item| youtube_favorite_id(item).map(|id| (id.to_string(), item.clone())))
            .collect();
        for removed in initial.difference(&current) {
            wanted.remove(*removed);
        }
        for item in &store.favorites {
            if let Some(id) = youtube_favorite_id(item) {
                if !initial.contains(id) {
                    wanted.insert(id.to_string(), item.clone());
                }
            }
        }
        let mut merged = Vec::new();
        for item in &store.favorites {
            match youtube_favorite_id(item) {
                Some(id) => {
                    if let Some(favorite) = wanted.remove(id) {
                        merged.push(favorite);
                    }
                }
                None => merged.push(item.clone()),
            }
        }
        for item in desired {
            if let Some(id) = youtube_favorite_id(&item) {
                if let Some(favorite) = wanted.remove(id) {
                    merged.push(favorite);
                }
            }
        }
        let mut candidate = store.clone();
        candidate.favorites = merged.clone();
        candidate.favorites_account = Some(account.to_string());
        self.write_store(&candidate)?;
        *store = candidate;
        Ok(merged)
    }

    /// Archived playlists, newest first.
    pub fn archive(&self) -> Vec<ArchivedPlaylist> {
        self.store
            .read()
            .map(|store| store.archive.clone())
            .unwrap_or_default()
    }

    pub fn archive_push(&self, item: ArchivedPlaylist) -> Result<Vec<ArchivedPlaylist>> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive.retain(|entry| entry.id != item.id);
            store.archive.insert(0, item);
        }
        self.save()?;
        Ok(self.archive())
    }

    pub fn archive_remove(&self, id: &str) -> Result<Vec<ArchivedPlaylist>> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive.retain(|entry| entry.id != id);
        }
        self.save()?;
        Ok(self.archive())
    }

    /// Copies the chosen image into the app's cache and remembers it as the
    /// archive cover. The bytes are validated as an image before they land.
    pub fn set_archive_cover(&self, source: &str) -> Result<()> {
        let bytes = std::fs::read(source)
            .map_err(|error| Error::io(format!("Не удалось прочитать картинку: {error}")))?;
        if bytes.is_empty() {
            return Err(Error::io("Файл обложки пустой"));
        }
        if bytes.len() > 12 * 1024 * 1024 {
            return Err(Error::io("Картинка больше 12 МБ"));
        }
        if !looks_like_image(&bytes) {
            return Err(Error::io(
                "Это не похоже на картинку: нужен JPEG, PNG, GIF или WebP",
            ));
        }
        std::fs::create_dir_all(&self.cache_dir)?;
        let path = self.cache_dir.join("archive-cover.img");
        std::fs::write(&path, &bytes)?;
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive_cover = Some(path.to_string_lossy().to_string());
        }
        self.save()
    }

    pub fn clear_archive_cover(&self) -> Result<()> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive_cover = None;
        }
        self.save()
    }

    pub fn archive_cover(&self) -> Option<Vec<u8>> {
        let path = self
            .store
            .read()
            .ok()
            .and_then(|store| store.archive_cover.clone())?;
        std::fs::read(path).ok()
    }

    pub fn add_root_and_scan(
        &self,
        root: &str,
        progress: &dyn Fn(usize),
    ) -> Result<LocalAddRootResult> {
        let path = Path::new(root);
        if !path.is_dir() {
            return Err(Error::io(format!("Папка не найдена: {root}")));
        }
        let _scan = self
            .scanning
            .lock()
            .map_err(|_| Error::io("scan is locked"))?;
        let (scanned, count, generation) = {
            let index = self
                .track_index()
                .read()
                .map_err(|_| Error::io("track index is locked"))?;
            (index.scanned, index.tracks.len(), index.generation)
        };
        let (added, roots) = {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            let added = !store.roots.iter().any(|current| current == root);
            if added {
                let mut candidate = store.clone();
                candidate.roots.push(root.to_owned());
                self.write_store(&candidate)?;
                *store = candidate;
            }
            (added, store.roots.clone())
        };
        if !scanned {
            self.scan_roots(&roots, generation + 1, progress)?;
        } else if added {
            progress(count);
            let mut fresh = Vec::new();
            walk_root(root, &mut fresh, &|found| progress(count + found));
            let mut index = self
                .track_index()
                .write()
                .map_err(|_| Error::io("track index is locked"))?;
            let mut tracks = std::mem::take(&mut index.tracks);
            tracks.append(&mut fresh);
            sort_tracks(&mut tracks);
            *index = TrackIndex::new(tracks, generation + 1);
            drop(index);
            self.save_tracks()?;
        }
        let index = self
            .track_index()
            .read()
            .map_err(|_| Error::io("track index is locked"))?;
        Ok(LocalAddRootResult {
            status: LocalStatus {
                roots,
                total: index.tracks.len(),
                generation: index.generation,
            },
            found: index
                .tracks
                .iter()
                .filter(|track| track.root == root)
                .count(),
        })
    }

    pub fn remove_root(&self, root: &str) -> Result<LocalStatus> {
        let _scan = self
            .scanning
            .lock()
            .map_err(|_| Error::io("scan is locked"))?;
        let index = self.track_index();
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            if !store.roots.iter().any(|current| current == root) {
                drop(store);
                return self.status();
            }
            let mut candidate = store.clone();
            candidate.roots.retain(|current| current != root);
            self.write_store(&candidate)?;
            *store = candidate;
        }
        let mut index = index
            .write()
            .map_err(|_| Error::io("track index is locked"))?;
        if index.scanned {
            let generation = index.generation + 1;
            let mut tracks = std::mem::take(&mut index.tracks);
            tracks.retain(|track| track.root != root);
            *index = TrackIndex::new(tracks, generation);
            drop(index);
            self.save_tracks()?;
        } else {
            index.generation += 1;
            drop(index);
        }
        self.status()
    }

    pub fn ensure_scan(&self, progress: &dyn Fn(usize)) -> Result<LocalStatus> {
        if self.roots().is_empty()
            || self
                .track_index()
                .read()
                .map_err(|_| Error::io("track index is locked"))?
                .scanned
        {
            return self.status();
        }
        let _scan = self
            .scanning
            .lock()
            .map_err(|_| Error::io("scan is locked"))?;
        let (scanned, generation) = {
            let index = self
                .track_index()
                .read()
                .map_err(|_| Error::io("track index is locked"))?;
            (index.scanned, index.generation)
        };
        let roots = self.roots();
        if !scanned && !roots.is_empty() {
            self.scan_roots(&roots, generation + 1, progress)?;
        }
        self.status()
    }

    pub fn scan(&self, progress: &dyn Fn(usize)) -> Result<LocalStatus> {
        let _scan = self
            .scanning
            .lock()
            .map_err(|_| Error::io("scan is locked"))?;
        let generation = self
            .track_index()
            .read()
            .map_err(|_| Error::io("track index is locked"))?
            .generation
            + 1;
        self.scan_roots(&self.roots(), generation, progress)?;
        self.status()
    }

    fn scan_roots(
        &self,
        roots: &[String],
        generation: u64,
        progress: &dyn Fn(usize),
    ) -> Result<()> {
        let mut tracks = Vec::new();
        progress(0);
        for root in roots {
            walk_root(root, &mut tracks, progress);
        }
        sort_tracks(&mut tracks);
        let index = TrackIndex::new(tracks, generation);
        *self
            .track_index()
            .write()
            .map_err(|_| Error::io("track index is locked"))? = index;
        self.save_tracks()
    }

    fn save_tracks(&self) -> Result<()> {
        let index = self
            .track_index()
            .read()
            .map_err(|_| Error::io("track index is locked"))?;
        let temporary = self.tracks_path.with_extension("tmp");
        let mut writer = BufWriter::new(std::fs::File::create(&temporary)?);
        serde_json::to_writer(&mut writer, &index.tracks)
            .map_err(|error| Error::io(error.to_string()))?;
        writer.flush()?;
        drop(writer);
        std::fs::rename(temporary, &self.tracks_path)?;
        Ok(())
    }

    /// True when the path belongs to the scanned library; the media protocol
    /// refuses anything else so the webview cannot read arbitrary files.
    pub fn allows(&self, path: &str) -> bool {
        self.track_index()
            .read()
            .map(|index| index.paths.contains_key(Path::new(path)))
            .unwrap_or(false)
    }

    /// Embedded artwork written next to the settings as a small cache file.
    pub fn cover(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let Some(path) = id.strip_prefix("local:") else {
            return Ok(None);
        };
        let index = self
            .track_index()
            .read()
            .map_err(|_| Error::io("track index is locked"))?;
        let Some(&position) = index.paths.get(Path::new(path)) else {
            return Ok(None);
        };
        if index.tracks[position].id != id && !index.tracks.iter().any(|track| track.id == id) {
            return Ok(None);
        }
        drop(index);
        let cache_path = self.cache_dir.join(format!("{:x}.img", md5ish(id)));
        if let Ok(bytes) = std::fs::read(&cache_path) {
            return Ok(Some(bytes));
        }
        let Some(picture) = read_picture(Path::new(path)) else {
            return Ok(None);
        };
        let _ = std::fs::write(&cache_path, &picture);
        Ok(Some(picture))
    }
}

/// Magic-byte check for the formats an archive cover may arrive in.
fn looks_like_image(bytes: &[u8]) -> bool {
    let jpeg = bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
    let png = bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let gif = bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a");
    let webp = bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP";
    jpeg || png || gif || webp
}

fn walk_root(root: &str, found: &mut Vec<LocalTrack>, progress: &dyn Fn(usize)) {
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            let extension = path
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            found.push(read_track(&path, root));
            if found.len() % 200 == 0 {
                progress(found.len());
            }
        }
    }
}

fn sort_tracks(tracks: &mut [LocalTrack]) {
    tracks.sort_by_cached_key(|track| {
        (
            track.artist.to_lowercase(),
            track.album.to_lowercase(),
            track.title.to_lowercase(),
        )
    });
}

fn read_track(path: &Path, root: &str) -> LocalTrack {
    let id = format!("local:{}", path.to_string_lossy());
    let file_stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Без названия".into());

    let mut track = LocalTrack {
        id,
        path: path.to_string_lossy().to_string(),
        title: file_stem.clone(),
        artist: String::new(),
        album: String::new(),
        duration: None,
        has_cover: false,
        root: root.to_string(),
    };

    if let Ok(tagged) = lofty::read_from_path(path) {
        use lofty::prelude::{AudioFile, TaggedFileExt};
        track.duration = tagged.properties().duration().as_secs().try_into().ok();
        track.has_cover = tagged.tags().iter().any(|tag| !tag.pictures().is_empty());

        let mut title = None;
        let mut artist = None;
        let mut album = None;
        for tag in tagged.tags() {
            for item in tag.items() {
                let Some(text) = item.value().text() else {
                    continue;
                };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let key = item
                    .key()
                    .map_key(tag.tag_type(), false)
                    .unwrap_or_default();
                match key {
                    "TITLE" if title.is_none() => title = Some(text.to_string()),
                    "ARTIST" if artist.is_none() => artist = Some(text.to_string()),
                    "ALBUM" if album.is_none() => album = Some(text.to_string()),
                    _ => {}
                }
            }
        }
        if let Some(value) = title {
            track.title = value;
        }
        if let Some(value) = artist {
            track.artist = value;
        }
        if let Some(value) = album {
            track.album = value;
        }
    }

    if track.artist.is_empty() {
        // "Artist - Title.mp3" is the common untagged naming on disk.
        if let Some((artist, title)) = file_stem.split_once(" - ") {
            track.artist = artist.trim().to_string();
            track.title = title.trim().to_string();
        }
    }
    track
}

fn read_picture(path: &Path) -> Option<Vec<u8>> {
    use lofty::prelude::TaggedFileExt;
    let tagged = lofty::read_from_path(path).ok()?;
    for tag in tagged.tags() {
        if let Some(picture) = tag.pictures().first() {
            return Some(picture.data().to_vec());
        }
    }
    None
}

/// Small stable hash for cache file names; not security sensitive.
fn md5ish(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod track_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("ytmusicdt-index-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn indexed_queries_keep_substring_and_sort_order_across_pages() {
        let mut tracks = vec![
            LocalTrack {
                id: "local:1".into(),
                title: "Ёлка".into(),
                artist: "Жанна".into(),
                album: "Альбом".into(),
                ..LocalTrack::default()
            },
            LocalTrack {
                id: "local:2".into(),
                title: "Dancing 🪩 Tonight".into(),
                artist: "Жанна".into(),
                album: "Живой альбом".into(),
                ..LocalTrack::default()
            },
            LocalTrack {
                id: "local:3".into(),
                path: "/path/Fallback.flac".into(),
                ..LocalTrack::default()
            },
        ];
        sort_tracks(&mut tracks);
        let index = TrackIndex::new(tracks, 7);
        for (query, ids) in [
            ("", vec!["local:3", "local:1", "local:2"]),
            ("  альБОм ", vec!["local:1", "local:2"]),
            ("ж", vec!["local:1", "local:2"]),
            ("ЖА", vec!["local:1", "local:2"]),
            ("АНН", vec!["local:1", "local:2"]),
            ("фА", vec!["local:3"]),
            ("ЁЛКА ЖАННА", vec!["local:1"]),
            ("nG 🪩", vec!["local:2"]),
            ("fallback.flac локальный файл", vec!["local:3"]),
            ("\u{FEFF}локальный файл\u{FEFF}", vec!["local:3"]),
            ("ночь", vec![]),
        ] {
            let first = index.page(query, 0, 1);
            assert_eq!(first.generation, 7);
            assert_eq!(first.library_total, 3);
            assert_eq!(first.total, ids.len(), "{query}");
            assert_eq!(
                first.items.first().map(|item| item.id.as_str()),
                ids.first().copied(),
                "{query}"
            );
            let later = index.page(query, 1, usize::MAX);
            assert_eq!(
                later
                    .items
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                ids.get(1..).unwrap_or_default(),
                "{query}"
            );
        }
    }

    #[test]
    fn cold_scan_runs_once_and_root_edits_keep_cache_and_generation_consistent() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root = temp_dir("roots");
        let one = root.join("one");
        let two = root.join("two");
        std::fs::create_dir(&one).unwrap();
        std::fs::create_dir(&two).unwrap();
        let first_track = one.join("First.mp3");
        std::fs::write(&first_track, []).unwrap();
        std::fs::write(two.join("Second.flac"), []).unwrap();
        let local_json = root.join("local.json");
        std::fs::write(
            &local_json,
            serde_json::json!({ "roots": [&one] }).to_string(),
        )
        .unwrap();
        std::fs::write(root.join("tracks.json"), "[broken").unwrap();
        let library = LocalLibrary::load(local_json.clone(), root.join("covers"));
        let events = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let scan = || {
                library
                    .ensure_scan(&|_| {
                        events.fetch_add(1, Ordering::Relaxed);
                    })
                    .unwrap()
                    .total
            };
            let first = scope.spawn(scan);
            let second = scope.spawn(scan);
            assert_eq!(first.join().unwrap(), 1);
            assert_eq!(second.join().unwrap(), 1);
        });
        assert_eq!(events.load(Ordering::Relaxed), 1);
        assert!(library.allows(first_track.to_str().unwrap()));
        assert!(library.allows(one.join(".").join("First.mp3").to_str().unwrap()));
        assert!(!library.allows(one.join("first.mp3").to_str().unwrap()));
        assert!(!library.allows(root.join("one-backup").join("First.mp3").to_str().unwrap()));

        let generation = library.status().unwrap().generation;
        std::fs::write(one.join("Added since scan.mp3"), []).unwrap();
        let added = library
            .add_root_and_scan(two.to_str().unwrap(), &|_| {})
            .unwrap();
        assert_eq!((added.found, added.status.total), (1, 2));
        assert!(library.search("", 0, 100, Some(generation)).is_err());
        let duplicate = library
            .add_root_and_scan(two.to_str().unwrap(), &|_| panic!("scanned twice"))
            .unwrap();
        assert_eq!(duplicate.status.generation, added.status.generation);

        let removed = library.remove_root(two.to_str().unwrap()).unwrap();
        assert_eq!(removed.roots, vec![one.to_str().unwrap()]);
        assert_eq!(removed.total, 1);
        assert!(!library.allows(two.join("Second.flac").to_str().unwrap()));

        let warm = LocalLibrary::load(local_json, root.join("covers"));
        let warm_status = warm.ensure_scan(&|_| panic!("walked warm cache")).unwrap();
        assert_eq!(warm_status.total, 1);
        assert_eq!(
            warm.search("first", 0, 100, Some(warm_status.generation))
                .unwrap()
                .total,
            1
        );
        assert_eq!(warm.scan(&|_| {}).unwrap().total, 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "synthetic 21,700-track timing and payload benchmark"]
    fn local_index_benchmark() {
        use std::time::Instant;
        const COUNT: usize = 21_700;
        let root = temp_dir("benchmark");
        let store_path = root.join("local.json");
        let music = root.join("Music").to_string_lossy().into_owned();
        std::fs::write(
            &store_path,
            serde_json::json!({ "roots": [&music] }).to_string(),
        )
        .unwrap();
        let mut tracks: Vec<_> = (0..COUNT)
            .map(|n| {
                let artist = format!("Исполнитель {:03}", n % 617);
                let album = format!("Альбом {:02}", n % 31);
                let title = format!("Трек {n:05} — длинное название композиции");
                let path = format!("{music}/{artist}/{album}/{title}.flac");
                LocalTrack {
                    id: format!("local:{path}"),
                    path,
                    title,
                    artist,
                    album,
                    duration: Some(185),
                    has_cover: n % 4 != 0,
                    root: music.clone(),
                }
            })
            .collect();
        sort_tracks(&mut tracks);
        let full_payload = serde_json::to_vec(&tracks).unwrap();
        std::fs::write(root.join("tracks.json"), &full_payload).unwrap();

        let start = Instant::now();
        let library = LocalLibrary::load(store_path, root.join("covers"));
        let status = library
            .ensure_scan(&|_| panic!("benchmark must not touch a music root"))
            .unwrap();
        let warm_index = start.elapsed();
        assert_eq!(status.total, COUNT);
        let first = library.search("", 0, 100, Some(status.generation)).unwrap();
        assert_eq!(first.items.len(), 100);
        let first_payload = serde_json::to_vec(&first).unwrap();
        let queries: Vec<_> = (0..30)
            .map(|n| format!("исполнитель {:03}", n * 17))
            .collect();
        let start = Instant::now();
        let indexed: Vec<_> = queries
            .iter()
            .map(|query| library.search(query, 0, 100, None).unwrap().total)
            .collect();
        let indexed_time = start.elapsed();
        let start = Instant::now();
        let linear: Vec<_> = queries
            .iter()
            .map(|query| {
                tracks
                    .iter()
                    .filter(|track| {
                        format!("{} {} {}", track.title, track.artist, track.album)
                            .to_lowercase()
                            .contains(query)
                    })
                    .count()
            })
            .collect();
        let linear_time = start.elapsed();
        assert_eq!(indexed, linear);

        let start = Instant::now();
        for offset in (0..COUNT).step_by(MAX_TRACK_PAGE) {
            let page = library
                .search("исполнитель", offset, usize::MAX, Some(status.generation))
                .unwrap();
            let end = (offset + MAX_TRACK_PAGE).min(COUNT);
            assert_eq!(page.total, COUNT);
            assert!(page
                .items
                .iter()
                .map(|item| &item.id)
                .eq(tracks[offset..end].iter().map(|item| &item.id)));
        }
        let elapsed = start.elapsed();
        println!(
            "{COUNT} tracks: cached index {warm_index:?}, 100-row IPC {} vs full {} bytes, 30 indexed filters {indexed_time:?} vs linear {linear_time:?}, all queue pages {elapsed:?}",
            first_payload.len(), full_payload.len(),
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;

    fn temp_library(tag: &str) -> (LocalLibrary, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("ytmusicdt-local-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let library = LocalLibrary::load(root.join("local.json"), root.join("covers"));
        (library, root)
    }

    fn playlist(id: &str, title: &str) -> ArchivedPlaylist {
        ArchivedPlaylist {
            id: id.into(),
            playlist_id: Some(id.into()),
            browse_id: Some(format!("VL{id}")),
            title: title.into(),
            subtitle: "Исполнитель".into(),
            thumbs: vec!["https://example.invalid/cover.jpg".into()],
            archived_at: 1,
        }
    }

    fn favorite(id: &str) -> Favorite {
        Favorite {
            id: format!("yt:{id}"),
            source: "yt".into(),
            video_id: Some(id.into()),
            title: id.into(),
            ..Favorite::default()
        }
    }

    #[test]
    fn sync_merge_preserves_local_files_and_late_toggles() {
        let (library, root) = temp_library("favorites-merge");
        let local = Favorite {
            id: "local:file.flac".into(),
            source: "local".into(),
            local_path: Some("file.flac".into()),
            title: "Local".into(),
            ..Favorite::default()
        };
        library.toggle_favorite(local.clone()).unwrap();
        library.toggle_favorite(favorite("AAAAAAAAAAA")).unwrap();
        let started = library.favorites();
        library.toggle_favorite(favorite("AAAAAAAAAAA")).unwrap();
        library.toggle_favorite(favorite("CCCCCCCCCCC")).unwrap();
        let merged = library
            .merge_synced_favorites(
                &started,
                vec![favorite("AAAAAAAAAAA"), favorite("BBBBBBBBBBB")],
                None,
                "@account",
            )
            .unwrap();
        let ids: std::collections::BTreeSet<String> =
            merged.into_iter().map(|favorite| favorite.id).collect();
        assert!(!ids.contains("yt:AAAAAAAAAAA"));
        assert!(ids.contains("yt:BBBBBBBBBBB"));
        assert!(ids.contains("yt:CCCCCCCCCCC"));
        assert!(ids.contains(&local.id));
        let reloaded = LocalLibrary::load(root.join("local.json"), root.join("covers"));
        assert_eq!(
            reloaded.favorites_account().unwrap().as_deref(),
            Some("@account")
        );
        assert_eq!(reloaded.favorites().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_merge_rejects_changed_owner_and_failed_writes_keep_memory() {
        let (library, root) = temp_library("favorites-failure");
        library.toggle_favorite(favorite("AAAAAAAAAAA")).unwrap();
        let before = library.favorites();
        assert!(library
            .merge_synced_favorites(&before, Vec::new(), Some("@wrong"), "@new")
            .is_err());
        std::fs::create_dir(root.join("local.tmp")).unwrap();
        assert!(library
            .merge_synced_favorites(&before, Vec::new(), None, "@new")
            .is_err());
        assert_eq!(
            library.favorites()[0].video_id.as_deref(),
            Some("AAAAAAAAAAA")
        );
        assert!(library.favorites_account().unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_files_never_become_remote_favorites_even_with_a_video_field() {
        let mut local = favorite("AAAAAAAAAAA");
        local.source = "local".into();
        assert!(youtube_favorite_id(&local).is_none());
        local.source = "yt".into();
        local.local_path = Some("file.flac".into());
        assert!(youtube_favorite_id(&local).is_none());
    }

    #[test]
    fn archive_keeps_newest_first_and_replaces_duplicates() {
        let (library, root) = temp_library("archive");
        library.archive_push(playlist("a", "Первый")).expect("push");
        library.archive_push(playlist("b", "Второй")).expect("push");
        let items = library
            .archive_push(playlist("a", "Первый заново"))
            .expect("push");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].title, "Первый заново");
        assert_eq!(items[1].id, "b");

        let reloaded = LocalLibrary::load(root.join("local.json"), root.join("covers"));
        assert_eq!(
            reloaded.archive().len(),
            2,
            "archive must survive a restart"
        );

        let items = library.archive_remove("a").expect("remove");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "b");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cover_must_be_an_image_and_is_served_back() {
        let (library, root) = temp_library("cover");
        let text = root.join("note.txt");
        std::fs::write(&text, b"not an image").expect("write");
        assert!(library
            .set_archive_cover(text.to_str().expect("path"))
            .is_err());
        assert!(library.archive_cover().is_none());

        let image = root.join("cover.png");
        let png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        std::fs::write(&image, png).expect("write");
        library
            .set_archive_cover(image.to_str().expect("path"))
            .expect("accept png");
        assert_eq!(library.archive_cover().as_deref(), Some(&png[..]));

        library.clear_archive_cover().expect("clear");
        assert!(library.archive_cover().is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
