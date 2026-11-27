import type { LyricLine } from "../types";

/**
 * Which lyric line is playing at `positionMs`. Lines are ordered by start, so
 * the answer is the last line that has already begun (-1 before the first).
 */
export function activeLineIndex(lines: LyricLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].startMs <= positionMs) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active;
}

/** "3:45" from the track metadata as seconds, for the lyrics lookup. */
export function clockToSeconds(value: string | null): number | null {
  if (!value) return null;
  const parts = value.split(":").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
