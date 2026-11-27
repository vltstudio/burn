import type { MediaItem } from "../types";

const googleCoverSize = /^(https:\/\/(?:yt3|lh3)\.googleusercontent\.com\/[^?]+)=w\d+-h\d+(?=-|$)/;
const youtubeThumbnail = /^https:\/\/(?:i\d*\.ytimg\.com|img\.youtube\.com)\/(?:vi|vi_webp)\//;

export function trackArtwork(item: MediaItem, large: boolean): string[] {
  const provided = [...new Set(item.thumbs.map((url) => url.trim()).filter(Boolean))];
  if (item.source === "local" || item.localPath) return provided;

  const id = item.videoId;
  const thumbnail = id && /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}` : undefined;
  const preferred = large ? provided.at(-1) : provided[0];
  const resized = large ? preferred?.replace(googleCoverSize, "$1=w1024-h1024") : preferred;
  const maxres = thumbnail && `${thumbnail}/maxresdefault.jpg`;
  const hq = thumbnail && `${thumbnail}/hqdefault.jpg`;
  return [...new Set([
    large && preferred && youtubeThumbnail.test(preferred) ? maxres : resized,
    ...(large ? provided.reverse() : provided),
    large ? maxres : undefined,
    hq,
  ].filter((url): url is string => Boolean(url)))];
}
