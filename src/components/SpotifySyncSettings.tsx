import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ListChecks, RefreshCw } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { useLibrary } from "../library";
import type { SpotifyImportProgress, SpotifySyncReport } from "../types";
import { playlistId, rememberSpotifyImport, useSpotifyLikedPlaylists } from "../ui/liked-playlists";
import { SettingSection } from "./SettingSection";
import { playlistChanged } from "../ui/playlist-changes";

export function SpotifySyncSettings({ signedIn, onGoogleSignIn, initialTarget }: {
  signedIn: boolean; onGoogleSignIn: () => void; initialTarget?: string;
}) {
  const { playlists, accountKey, favoriteSync, refreshPlaylists } = useLibrary();
  const sources = useSpotifyLikedPlaylists(accountKey, playlists);
  const destinations = useMemo(() => {
    const entries = new Map<string, string>();
    for (const [id, saved] of Object.entries(sources.imports ?? {})) {
      if (id !== "LM" && id !== favoriteSync.playlistId) entries.set(id, saved.title);
    }
    for (const item of playlists) {
      const id = playlistId(item);
      if (id && id !== "LM" && id !== favoriteSync.playlistId) entries.set(id, item.title);
    }
    return entries;
  }, [playlists, favoriteSync.playlistId, sources.imports]);
  const [selection, setSelection] = useState(initialTarget ?? "");
  const target = [selection, ...Object.keys(sources.imports ?? {}).reverse(), sources.playlistId]
    .find((id): id is string => Boolean(id && destinations.has(id))) ?? destinations.keys().next().value ?? "";
  const [spotify, setSpotify] = useState<boolean | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  useEffect(() => {
    let active = true;
    api.spotifyStatus().then((status) => { if (active) setSpotify(status.signedIn); })
      .catch((error) => { if (active) setAuthError(String(error)); });
    return () => { active = false; };
  }, []);
  const connect = async () => {
    setAuthBusy(true);
    setAuthError("");
    try {
      const status = spotify ? await api.spotifySignOut() : await api.spotifySignIn();
      setSpotify(status.signedIn);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };
  return <>
    <SettingSection title="Аккаунт Spotify">
      <div className="connection-row">
        <span className="status-line"><span className={`status-dot ${spotify ? "ok" : ""}`} />
          {authBusy ? "Ожидаем Spotify…" : spotify ? "Подключён" : "Для избранного и закрытых плейлистов"}
        </span>
        <button className="ghost-button" disabled={authBusy || (spotify === null && !authError)} onClick={() => void connect()}>
          {spotify ? "Выйти из Spotify" : "Войти в Spotify"}
        </button>
      </div>
      {authError && <p className="load-error" role="alert">{authError}</p>}
    </SettingSection>
    <SettingSection title="Проверка переноса">
      {!signedIn ? <button className="ghost-button" onClick={onGoogleSignIn}>Подключить YouTube Music</button> : <>
        <label className="field-group">Плейлист в YouTube Music
          <select className="text-input" value={target} onChange={(event) => setSelection(event.target.value)}>
            {!destinations.size && <option value="">Нет плейлистов</option>}
            {[...destinations].map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
        </label>
        {target ? <SpotifyComparison key={JSON.stringify([accountKey, target, spotify])} target={target} title={destinations.get(target) ?? target}
          knownSource={sources.imports?.[target]?.source ?? (sources.hiddenIds.has(target) ? "liked" : "")}
          account={accountKey} onChanged={refreshPlaylists} /> : <p className="field-hint">Перенесите плейлист через раздел «Библиотека».</p>}
      </>}
    </SettingSection>
  </>;
}

function SpotifyComparison({ target, title, knownSource, account, onChanged }: {
  target: string; title: string; knownSource: string; account: string; onChanged: () => void;
}) {
  const [source, setSource] = useState(knownSource);
  const [discovering, setDiscovering] = useState(!knownSource);
  const [report, setReport] = useState<SpotifySyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const current = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!knownSource) {
      // Older imports kept the source in the remote playlist description.
      api.browse(`VL${target}`).then(({ header }) => {
        if (!active) return;
        const value = header.description?.match(/(?:^|\n)Импортировано из Spotify:\s*(\S+)\s*$/i)?.[1] ?? "";
        if (value) setSource(value.includes("/collection/tracks") ? "liked" : value);
      }).catch(() => {}).finally(() => { if (active) setDiscovering(false); });
    } else { setDiscovering(false); }
    return () => { active = false; };
  }, [target, knownSource]);
  useEffect(() => () => {
    const id = current.current;
    current.current = null;
    if (id) void api.spotifyImportCancel(id).catch(() => {});
  }, []);
  const change = (value: string) => { setSource(value); setReport(null); setError(""); };
  const run = async (repair: boolean) => {
    if (current.current || !source.trim()) return;
    const id = crypto.randomUUID();
    current.current = id;
    setBusy(true);
    setProgress("Читаем плейлисты…");
    setError("");
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await listen<SpotifyImportProgress>("spotify-import", ({ payload }) => {
        if (payload.requestId !== id || current.current !== id) return;
        if (payload.total) setProgress(`${payload.stage === "add" ? "Переносим" : "Сверяем"} треки · ${payload.done} / ${payload.total}`);
      }).catch(() => undefined);
      if (current.current !== id) return;
      const result = await api.spotifySync(source.trim(), target, repair, id);
      if (current.current !== id) return;
      setReport(result);
      rememberSpotifyImport(account, target, source === "liked", source.trim(), title);
      if (result.added) { playlistChanged(target); onChanged(); }
    } catch (failure) {
      if (current.current === id) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setReport(null);
      }
    } finally {
      unsubscribe?.();
      if (current.current === id) { current.current = null; setBusy(false); }
    }
  };
  return <div className="sync-comparison">
    <label className="field-group">Источник в Spotify
      <select className="text-input" value={source === "liked" ? "liked" : "playlist"} disabled={busy || discovering}
        onChange={(event) => change(event.target.value === "liked" ? "liked" : "")}>
        <option value="playlist">Плейлист по ссылке</option><option value="liked">Любимые треки Spotify</option>
      </select>
    </label>
    {source !== "liked" && <input aria-label="Ссылка или идентификатор плейлиста Spotify" className="text-input" value={source} disabled={busy || discovering}
      placeholder="https://open.spotify.com/playlist/…" onChange={(event) => change(event.target.value)} />}
    <div className="actions-row">
      <button className="ghost-button" disabled={busy || discovering || !source.trim()} onClick={() => void run(false)}>
        <ListChecks size={16} /> Проверить перенос
      </button>
      {report && (report.missing.length > 0 || report.unmatched.length > 0) && <button className="solid-button" disabled={busy} onClick={() => void run(true)}>
        <RefreshCw size={15} /> Синхронизировать ещё раз
      </button>}
    </div>
    {busy && <p className="status-line" role="status"><span className="spinner" />{progress}</p>}
    {error && <p className="load-error" role="alert">{error}</p>}
    {report && !busy && <div className="sync-result" aria-live="polite">
      <strong>{report.present + report.repeats === report.total ? <><Check size={16} /> Все треки перенесены</> : "Перенос выполнен частично"}</strong>
      <p>В Spotify — {report.total}. В плейлисте — {report.present}.{report.repeats ? ` Повторных записей — ${report.repeats}.` : ""}
        {report.added ? ` Добавлено сейчас — ${report.added}.` : ""}</p>
      {([[report.missing, "Ещё не перенесены"], [report.unmatched, "Совпадений не найдено"]] as const).map(([rows, label]) =>
        rows.length > 0 && <details key={label}><summary>{label} · {rows.length}</summary>
          <ul>{rows.map((track, i) => <li key={i}>{track.title}{track.artists.length ? ` — ${track.artists.join(", ")}` : ""}</li>)}</ul>
        </details>)}
    </div>}
  </div>;
}
