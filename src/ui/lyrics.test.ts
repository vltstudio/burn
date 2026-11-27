import { describe, expect, it } from "vitest";
import type { LyricLine } from "../types";
import { activeLineIndex, lineProgress, wordProgress } from "./lyrics";

const line: LyricLine = {
  text: "hold me tight",
  startMs: 10_000,
  endMs: 14_000,
  words: [
    { text: "hold", startMs: 10_000, endMs: 11_000 },
    { text: "me", startMs: 11_000, endMs: 12_000 },
    { text: "tight", startMs: 12_000, endMs: 14_000 },
  ],
};

describe("lyric timing", () => {
  it("fills a line from its own span", () => {
    expect(lineProgress(line, 9_000)).toBe(0);
    expect(lineProgress(line, 10_000)).toBe(0);
    expect(lineProgress(line, 12_000)).toBeCloseTo(0.5);
    expect(lineProgress(line, 20_000)).toBe(1);
  });

  it("falls back to the last word when a line has no end", () => {
    const open: LyricLine = { text: "open", startMs: 1_000, endMs: null, words: line.words };
    expect(lineProgress(open, 13_000)).toBeCloseTo(0.92, 1);
    expect(lineProgress(open, 14_000)).toBe(1);
  });

  it("fills a word inside its own span so the highlight follows the voice", () => {
    expect(wordProgress(line.words![0], 10_000)).toBe(0);
    expect(wordProgress(line.words![0], 10_500)).toBeCloseTo(0.5);
    expect(wordProgress(line.words![0], 11_500)).toBe(1);
  });

  it("survives a zero-length span", () => {
    expect(wordProgress({ text: "x", startMs: 5_000, endMs: 5_000 }, 5_000)).toBe(0);
    expect(wordProgress({ text: "x", startMs: 5_000, endMs: 5_000 }, 6_000)).toBe(1);
    expect(lineProgress({ text: "x", startMs: 5_000, endMs: 5_000 }, 4_000)).toBe(0);
  });

  it("picks the line that is playing", () => {
    const lines: LyricLine[] = [
      { text: "a", startMs: 0, endMs: 2_000 },
      { text: "b", startMs: 2_000, endMs: 4_000 },
      { text: "c", startMs: 6_000, endMs: 8_000 },
    ];
    expect(activeLineIndex(lines, 500)).toBe(0);
    expect(activeLineIndex(lines, 2_000)).toBe(1);
    expect(activeLineIndex(lines, 5_000)).toBe(1);
    expect(activeLineIndex(lines, 7_000)).toBe(2);
  });
});
