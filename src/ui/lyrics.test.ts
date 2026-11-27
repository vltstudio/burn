import { describe, expect, it } from "vitest";
import type { LyricLine } from "../types";
import { activeLineIndex, lineProgress, wordProgress, wordSpans } from "./lyrics";

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

describe("word spans", () => {
  it("keeps the source's own timings when it has them", () => {
    expect(wordSpans(line)).toBe(line.words);
  });

  it("splits a line that only has line timings across its span", () => {
    const plain: LyricLine = { text: "я не помню как звучит", startMs: 2_000, endMs: 6_000, words: null };
    const spans = wordSpans(plain);
    expect(spans).toHaveLength(5);
    expect(spans[0].startMs).toBe(2_000);
    expect(spans.at(-1)!.endMs).toBe(6_000);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index].startMs).toBeGreaterThanOrEqual(spans[index - 1].startMs);
      expect(spans[index].startMs).toBe(spans[index - 1].endMs);
    }
    // Words fill front to back, so the highlight follows the voice: at any
    // moment the earlier words are at least as far along as the later ones.
    const fills = [2_500, 3_500, 4_500, 5_500].map((position) =>
      spans.map((word) => wordProgress(word, position)),
    );
    for (const row of fills) {
      expect(row).toEqual([...row].sort((left, right) => right - left));
    }
  });

  it("still gives a share to a line with no end", () => {
    const open: LyricLine = { text: "один два", startMs: 1_000, endMs: null };
    const spans = wordSpans(open);
    expect(spans).toHaveLength(2);
    expect(spans[1].endMs).toBeGreaterThan(spans[1].startMs);
  });
});
