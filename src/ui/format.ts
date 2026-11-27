import { localCoverUrl } from "../api";
import type { Favorite, LocalTrack, MediaItem } from "../types";

export function smallThumb(item: { thumbs: string[] }): string | undefined {
  return item.thumbs[0];
}

export function bigThumb(item: { thumbs: string[] }): string | undefined {
  return item.thumbs[item.thumbs.length - 1];
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function parseDuration(text: string | null): number {
  if (!text) return 0;
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export const kindLabels: Record<string, string> = {
  song: "Трек",
  video: "Видео",
  album: "Альбом",
  artist: "Исполнитель",
  playlist: "Плейлист",
  episode: "Эпизод",
  unknown: "",
};

export const kindSections: Record<string, string> = {
  song: "Треки",
  video: "Видео",
  album: "Альбомы",
  artist: "Исполнители",
  playlist: "Плейлисты",
  episode: "Эпизоды",
  unknown: "Другое",
};

export const sectionOrder = ["artist", "song", "video", "album", "playlist", "episode", "unknown"];

/** Tracks that can be handed to the player. */
export function playable(items: MediaItem[]): MediaItem[] {
  return items.filter((item) => Boolean(item.videoId));
}

export function groupByKind(items: MediaItem[]): Array<{ kind: string; items: MediaItem[] }> {
  const groups = new Map<string, MediaItem[]>();
  for (const item of items) {
    const key = item.kind === "unknown" ? "unknown" : item.kind;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return [...groups.entries()]
    .sort((a, b) => sectionOrder.indexOf(a[0]) - sectionOrder.indexOf(b[0]))
    .map(([kind, groupItems]) => ({ kind, items: groupItems }));
}

/** A scanned file shaped like every other playable item. */
export function localToItem(track: LocalTrack): MediaItem {
  return {
    kind: "song",
    title: track.title || track.path,
    subtitle: track.artist || "Локальный файл",
    // The id doubles as the playable key: the player sends localPath through
    // the localmedia protocol, so no YouTube video id is involved.
    videoId: track.id,
    browseId: null,
    playlistId: null,
    duration: track.duration ? formatTime(track.duration) : null,
    year: null,
    thumbs: track.hasCover ? [localCoverUrl(track.id)] : [],
    artists: track.artist ? [{ name: track.artist, browseId: "" }] : [],
    album: track.album ? { name: track.album, browseId: "" } : null,
    source: "local",
    localPath: track.path,
  };
}

/** The favourites key for an item, or null when it cannot be favourited. */
export function favoriteKey(item: MediaItem): string | null {
  if (item.source === "local") return item.videoId || null;
  return item.videoId ? `yt:${item.videoId}` : null;
}

export function toFavorite(item: MediaItem): Favorite | null {
  const id = favoriteKey(item);
  if (!id) return null;
  const source = item.source === "local" ? "local" : "yt";
  return {
    id,
    title: item.title,
    subtitle: item.subtitle,
    duration: item.duration ? parseDuration(item.duration) : null,
    source,
    videoId: source === "yt" ? item.videoId : null,
    localPath: source === "local" ? (item.localPath ?? null) : null,
    thumb: item.thumbs[0] ?? null,
  };
}

export function favoriteToItem(favorite: Favorite): MediaItem {
  return {
    kind: "song",
    title: favorite.title,
    subtitle: favorite.subtitle,
    videoId: favorite.videoId ?? favorite.id,
    browseId: null,
    playlistId: null,
    duration: favorite.duration ? formatTime(favorite.duration) : null,
    year: null,
    thumbs: favorite.thumb ? [favorite.thumb] : [],
    artists: favorite.subtitle ? [{ name: favorite.subtitle, browseId: "" }] : [],
    album: null,
    source: favorite.source === "local" ? "local" : "youtube",
    localPath: favorite.localPath,
  };
}
