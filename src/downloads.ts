import type { DownloadProgress, DownloadsSnapshot } from "./types";

const paths = new Map<string, string>();
const covers = new Set<string>();
const empty: DownloadsSnapshot = { items: [], count: 0, bytes: 0 };
let snapshot: DownloadsSnapshot = empty;

/** Keeps the module-level lookup in step with the backend's index; the player
 * reads it synchronously, before any render can happen. */
export function applyDownloads(next: DownloadsSnapshot): DownloadsSnapshot {
  paths.clear();
  covers.clear();
  for (const item of next.items) {
    paths.set(item.videoId, item.path);
    if (item.hasCover) covers.add(item.videoId);
  }
  snapshot = next;
  return snapshot;
}

export function downloadsSnapshot(): DownloadsSnapshot {
  return snapshot;
}

/** A favourite's own copy, preferred over the stream so it plays with no network. */
export function downloadedPath(videoId: string | null | undefined): string | null {
  return videoId ? paths.get(videoId) ?? null : null;
}

export function hasDownloadedCover(videoId: string | null | undefined): boolean {
  return videoId ? covers.has(videoId) : false;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace(".", ",")} ${units[unit]}`;
}

/** One line under the favourites header: how far the queue got, then what is
 * already kept and how much room it takes. */
export function downloadLine(
  count: number,
  bytes: number,
  progress: Record<string, DownloadProgress>,
): string {
  const running = Object.values(progress).filter((entry) => entry.state === "downloading");
  if (running.length > 0) {
    const received = running.reduce((sum, entry) => sum + entry.received, 0);
    const total = running.reduce((sum, entry) => sum + (entry.total ?? entry.received), 0);
    const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null;
    return percent === null ? `Скачиваем ${running.length}…` : `Скачиваем ${percent}%`;
  }
  if (count === 0) return "Скачается само, когда добавите трек в избранное";
  return `Скачано ${count} · ${formatBytes(bytes)} — играет без интернета`;
}
