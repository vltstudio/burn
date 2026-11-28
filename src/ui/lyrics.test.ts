import { describe, expect, it } from "vitest";
import type { LyricLine } from "../types";
import { activeLineIndex } from "./lyrics";

describe("lyric timing", () => {
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
