import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadsSnapshot, MediaItem } from "../types";
import { DownloadsProvider } from "../downloads-provider";
import { TrackTable } from "./TrackTable";

const kept: DownloadsSnapshot = {
  count: 1,
  bytes: 3_000_000,
  items: [{
    videoId: "kept0000001",
    title: "Kept",
    subtitle: "",
    duration: 180,
    thumb: null,
    path: "C:\\downloads\\kept.m4a",
    bytes: 3_000_000,
    hasCover: true,
  }],
};

vi.mock("../player", () => ({
  usePlayback: () => ({ enqueue: vi.fn(), toggle: vi.fn() }),
}));
vi.mock("../library", () => ({
  useLibrary: () => ({ favoriteIds: new Set<string>(), toggleFavorite: vi.fn() }),
}));
vi.mock("../api", () => ({
  api: {
    downloads: vi.fn(() => Promise.resolve(kept)),
    streamUrl: vi.fn(() => Promise.resolve("")),
    watchTrack: vi.fn(() => Promise.resolve(null)),
  },
}));
vi.mock("./PlaylistPicker", () => ({ PlaylistPicker: () => null }));

function track(videoId: string, title: string): MediaItem {
  return {
    kind: "song", title, subtitle: "Fixture", videoId, browseId: null, playlistId: null,
    duration: "3:00", year: null, thumbs: [], artists: [{ name: "Fixture", browseId: "" }], album: null,
  };
}

describe("TrackTable", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("marks a downloaded track and leaves the other rows plain", async () => {
    await act(async () => {
      root.render(
        <DownloadsProvider>
          <TrackTable
            items={[track("kept0000001", "Kept"), track("other000001", "Other")]}
            currentVideoId={null}
            isPlaying={false}
            onPlay={vi.fn()}
            onOpen={vi.fn()}
          />
        </DownloadsProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });

    const marks = host.querySelectorAll(".tr-offline");
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute("title")).toBe("Скачано — играет без интернета");
    expect(marks[0].closest(".tr")?.textContent).toContain("Kept");
    expect(marks[0].classList.contains("pending")).toBe(false);
  });
});
