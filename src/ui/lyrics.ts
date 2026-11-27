import type { LyricLine, LyricWord } from "../types";

/**
 * Which lyric line is playing at `positionMs`. Lines are ordered by start, so
 * the answer is the last line that has already begun (-1 before the first).
 */
export function activeLineIndex(lines: readonly LyricLine[], positionMs: number): number {
  if (!Number.isFinite(positionMs)) return -1;
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
  if (!value?.trim()) return null;
  const parts = value.split(":").map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isSafeInteger(seconds) && seconds <= 0xffffffff ? seconds : null;
}

/** How much of a line has been sung: 0 before it starts, 1 once it ends. */
export function lineProgress(line: LyricLine, positionMs: number): number {
  const end = line.endMs ?? line.words?.at(-1)?.endMs ?? line.startMs + 1000;
  return spanProgress(line.startMs, end, positionMs);
}

/** The same for one word of a line, so the fill can follow the voice. */
export function wordProgress(word: LyricWord, positionMs: number): number {
  return spanProgress(word.startMs, word.endMs, positionMs);
}

function spanProgress(startMs: number, endMs: number, positionMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs <= startMs) return 0;
  if (endMs <= startMs) return 1;
  return Math.min(1, (positionMs - startMs) / (endMs - startMs));
}
