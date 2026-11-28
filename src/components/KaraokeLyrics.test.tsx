import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyrics, MediaItem } from "../types";
import { KaraokeLyrics } from "./KaraokeLyrics";

const timing = vi.hoisted(() => ({ lyrics: null as Lyrics | null }));

vi.mock("../api", () => ({
  api: { trackLyrics: vi.fn(() => Promise.resolve(timing.lyrics)) },
  ApiFailure: class ApiFailure extends Error {},
}));

const track: MediaItem = {
  kind: "song", title: "Song", subtitle: "Artist", videoId: "aaaaaaaaaaa", browseId: null,
  playlistId: null, duration: "3:00", year: null, thumbs: ["https://example.invalid/cover.jpg"],
  artists: [{ name: "Artist", browseId: "" }], album: null,
};

const lyrics: Lyrics = {
  timed: true,
  plain: null,
  source: "lrclib",
  attribution: "LRCLIB",
  lines: [
    { text: "one two", startMs: 1_000, endMs: 4_000, words: [
      { text: "one", startMs: 1_000, endMs: 2_000 },
      { text: "two", startMs: 2_000, endMs: 4_000 },
    ] },
    { text: "three", startMs: 5_000, endMs: 8_000 },
    { text: "four", startMs: 9_000, endMs: 12_000 },
  ],
};

describe("KaraokeLyrics", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onSeek = vi.fn();

  beforeEach(() => {
    timing.lyrics = lyrics;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    onSeek.mockClear();
  });

  async function render(progress = 6) {
    await act(async () => {
      root.render(
        <KaraokeLyrics current={track} artistName="Artist" progress={progress} playing onSeek={onSeek} />,
      );
    });
    await act(async () => { await Promise.resolve(); });
  }

  it("keeps one bright line and moves to the line that was pressed", async () => {
    await render(6);
    const rows = host.querySelectorAll<HTMLElement>(".fp-karaoke-lines li");
    expect(rows).toHaveLength(3);
    const active = host.querySelectorAll('.fp-karaoke-lines li[data-state="active"]');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("three");

    const buttons = host.querySelectorAll<HTMLButtonElement>(".fp-karaoke-line");
    await act(async () => buttons[2].click());
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(9);
  });

  it("shows each line whole: no word spans, no fill to wait for", async () => {
    await render(1.5);
    expect(host.querySelectorAll(".fp-karaoke-word")).toHaveLength(0);
    const rows = host.querySelectorAll<HTMLElement>(".fp-karaoke-lines li");
    expect(rows[0].textContent).toContain("one two");
    expect(host.querySelector(".fp-karaoke-glow span")).not.toBeNull();
  });
});
