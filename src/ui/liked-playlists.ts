import type { MediaItem } from "../types";
import { useEffect, useMemo, useState } from "react";

interface SpotifySources {
  selected: string | null;
  liked: string[];
  ordinary: string[];
}

const sourceCache = new Map<string, SpotifySources>();
const sourceEvent = "ytmusicdt:spotify-liked-source";

function readSources(account: string): SpotifySources {
  const cached = sourceCache.get(account);
  if (cached) return cached;
  try {
    const value = JSON.parse(window.localStorage.getItem(`ytmusicdt.spotifyLiked:${account}`) ?? "null");
    if (value && Array.isArray(value.liked) && Array.isArray(value.ordinary)) {
      const sources = {
        selected: typeof value.selected === "string" ? value.selected : null,
        liked: value.liked.filter((id: unknown): id is string => typeof id === "string"),
        ordinary: value.ordinary.filter((id: unknown): id is string => typeof id === "string"),
      };
      sourceCache.set(account, sources);
      return sources;
    }
  } catch {}
  return { selected: null, liked: [], ordinary: [] };
}

export function rememberSpotifyImport(account: string | null, id: string, liked: boolean) {
  const normalized = id.trim().replace(/^VL/, "");
  if (!account || !normalized) return;
  const current = readSources(account);
  const next = liked ? {
    selected: normalized,
    liked: [...new Set([...current.liked, normalized])],
    ordinary: current.ordinary.filter((entry) => entry !== normalized),
  } : {
    ...current,
    ordinary: [...new Set([...current.ordinary, normalized])],
  };
  sourceCache.set(account, next);
  try {
    window.localStorage.setItem(`ytmusicdt.spotifyLiked:${account}`, JSON.stringify(next));
  } catch {}
  window.dispatchEvent(new Event(sourceEvent));
}

export function playlistId(item: Pick<MediaItem, "playlistId" | "browseId">): string | null {
  return (item.playlistId?.trim() || item.browseId?.trim())?.replace(/^VL/, "") || null;
}

export function isSpotifyLikedPlaylist(item: MediaItem): boolean {
  return item.kind === "playlist" && item.title.trim() === "Любимые треки Spotify" && Boolean(playlistId(item));
}

export function useSpotifyLikedPlaylists(account: string | null, items: MediaItem[]) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    const stored = () => { sourceCache.clear(); changed(); };
    window.addEventListener(sourceEvent, changed);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(sourceEvent, changed);
      window.removeEventListener("storage", stored);
    };
  }, []);
  const sources = useMemo(() => account ? readSources(account) : { selected: null, liked: [], ordinary: [] }, [account, revision]);
  const candidates = [...new Set(items.filter((item) => isSpotifyLikedPlaylist(item)
    && !sources.ordinary.includes(playlistId(item) ?? "")).map((item) => playlistId(item)!))];
  const selected = account ? sources.selected ?? (candidates.length === 1 ? candidates[0] : null) : null;
  useEffect(() => {
    if (account && selected && !sources.selected) rememberSpotifyImport(account, selected, true);
  }, [account, selected, sources.selected]);
  return { playlistId: selected, hiddenIds: new Set([...sources.liked, ...(selected ? [selected] : [])]) };
}

export function isSpecialLikedPlaylist(item: MediaItem, servicePlaylistId: string | null, spotifyIds: ReadonlySet<string>): boolean {
  if (item.kind !== "playlist") return false;
  const id = playlistId(item);
  return id === "LM" || Boolean(id && spotifyIds.has(id))
    || Boolean(id && servicePlaylistId && id === servicePlaylistId.trim().replace(/^VL/, ""));
}
