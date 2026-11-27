import { api } from "../api";
import type { ItemRef } from "../types";

export interface ArtistInfo {
  name: string;
  listeners: string | null;
  avatar: string | null;
}

const cache = new Map<string, Promise<ArtistInfo | null>>();

export function loadArtist(ref: ItemRef): Promise<ArtistInfo | null> {
  if (!ref.browseId || !ref.name.trim()) return Promise.resolve(null);
  const cached = cache.get(ref.browseId);
  if (cached) return cached;
  const request = api
    .search(ref.name, "artists")
    .then((results) => {
      const pool = results.top ? [results.top, ...results.items] : results.items;
      const match = pool.find((item) => item.browseId === ref.browseId);
      if (!match) return null;
      const listeners = match.subtitle.split("•")[1]?.trim();
      return {
        name: match.title,
        listeners: listeners || null,
        avatar: match.thumbs.filter(Boolean).at(-1) ?? null,
      };
    })
    .catch(() => null)
    .then((info) => {
      if (!info && cache.get(ref.browseId) === request) cache.delete(ref.browseId);
      return info;
    });
  cache.set(ref.browseId, request);
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return request;
}
