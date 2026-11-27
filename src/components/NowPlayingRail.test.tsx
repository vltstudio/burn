import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayback } from "../player";
import type { MediaItem } from "../types";
import { loadArtist, type ArtistInfo } from "../ui/artist";
import { ArtistNavProvider } from "../ui/artist-links";
import { NowPlayingRail } from "./NowPlayingRail";

vi.mock("../player", () => ({ usePlayback: vi.fn() }));
vi.mock("../library", () => ({
  useLibrary: () => ({ favoriteIds: new Set(), toggleFavorite: vi.fn() }),
}));
vi.mock("../ui/artist", () => ({ loadArtist: vi.fn() }));
vi.mock("./PlaylistPicker", () => ({ PlaylistPicker: () => null }));

function track(title: string, name = title, browseId = name): MediaItem {
  return {
    kind: "song", title, subtitle: "", videoId: title, browseId: null, playlistId: null,
    duration: null, year: null, thumbs: [], artists: [{ name, browseId }], album: null,
  };
}

describe("NowPlayingRail", () => {
  let container: HTMLDivElement;
  let root: Root;
  const openArtist = vi.fn();
  const jumpTo = vi.fn();
  const setExpanded = vi.fn();

  function render(current: MediaItem, queue = [current], upNext: number[] = []) {
    vi.mocked(usePlayback, { partial: true }).mockReturnValue({
      current, queue, upNext, jumpTo, setExpanded,
    });
    return act(async () => {
      root.render(
        <ArtistNavProvider open={openArtist}>
          <NowPlayingRail open onToggle={vi.fn()} onOpen={vi.fn()} />
        </ArtistNavProvider>,
      );
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(loadArtist).mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it("keeps the artist route available during lookup and ignores a late response for another artist", async () => {
    let finish!: (info: ArtistInfo) => void;
    vi.mocked(loadArtist)
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ name: "New artist", listeners: "Now listening", avatar: null });

    await render(track("Track A", "First", "artist-a"));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Загружаем сведения…");
    container.querySelector<HTMLButtonElement>(".npr-artist-route")?.click();
    expect(openArtist).toHaveBeenCalledWith({ name: "First", browseId: "artist-a" });

    await render(track("Track B", "Second", "artist-b"));
    await act(() => finish({ name: "Old artist", listeners: "Out of date", avatar: null }));
    expect(container.querySelector(".npr-artist-name")?.textContent).toBe("New artist");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Now listening");
  });

  it("retries unavailable metadata and keeps keyboard focus on the artist route", async () => {
    vi.mocked(loadArtist)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ name: "Artist", listeners: null, avatar: null });

    await render(track("Track", "Artist"));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Сведения недоступны");
    const retry = container.querySelector<HTMLButtonElement>(".npr-artist-retry")!;
    retry.focus();
    await act(async () => retry.click());

    expect(loadArtist).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(container.querySelector(".npr-artist-route"));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Исполнитель");
    expect(container.querySelector(".npr-artist-retry")).toBeNull();
  });

  it("renders non-linkable artists as text and keeps queue and cover actions independent", async () => {
    const current = track("Local track", "Local artist", "");
    await render(current, [current, track("First"), track("Second")], [2, 1]);

    expect(loadArtist).not.toHaveBeenCalled();
    expect(container.querySelector(".npr-artist-name")?.textContent).toBe("Local artist");
    expect(container.querySelector(".npr-artist-route")).toBeNull();
    expect(container.querySelector("button button")).toBeNull();
    container.querySelector<HTMLButtonElement>(".npr-queue-item")?.click();
    container.querySelector<HTMLButtonElement>(".npr-art")?.click();
    expect(jumpTo).toHaveBeenCalledWith(2);
    expect(setExpanded).toHaveBeenCalledWith(true);
  });
});
