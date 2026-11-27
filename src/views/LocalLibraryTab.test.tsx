import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalStatus, LocalTrack, LocalTrackPage, MediaItem } from "../types";
import { LocalLibraryTab } from "./LocalLibraryTab";

const fixture = vi.hoisted(() => ({
  status: vi.fn<() => Promise<LocalStatus>>(),
  search: vi.fn<(query: string, offset: number, size: number, generation?: number | null) => Promise<LocalTrackPage>>(),
  play: vi.fn<(queue: MediaItem[], position: number) => void>(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: fixture.listen }));
vi.mock("../api", () => ({
  api: { localStatus: fixture.status, localSearch: fixture.search },
  localCoverUrl: (id: string) => id,
}));
vi.mock("../player", () => ({
  usePlayback: () => ({ current: null, playing: false, playItems: fixture.play }),
}));
vi.mock("../components/ui/liquid-spinner", () => ({
  LiquidWaveSpinner: () => <div role="status">Индексируем</div>,
}));
vi.mock("../components/TrackTable", () => ({
  TrackTable: ({ items, onPlay }: { items: MediaItem[]; onPlay: (index: number) => void }) =>
    <div>{items.map((item, index) => (
      <button className="fixture-track" key={item.videoId} onClick={() => onPlay(index)}>{item.title}</button>
    ))}</div>,
}));

const COUNT = 21_700;
const MUSIC = "C:/test/Music";

function track(index: number, artist = "Жанна"): LocalTrack {
  const path = `${MUSIC}/${artist}/${index}.flac`;
  return { id: `local:${path}`, path, title: `Трек ${index}`, artist, album: "Альбом", duration: 180, hasCover: false, root: MUSIC };
}

function response(offset: number, limit: number, total: number, generation = 1): LocalTrackPage {
  return {
    items: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => track(offset + index)),
    total,
    libraryTotal: COUNT,
    generation,
  };
}

describe("local library pages", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    fixture.status.mockReset().mockResolvedValue({ roots: [MUSIC], total: COUNT, generation: 1 });
    fixture.search.mockReset().mockImplementation(async (_, offset, size) => response(offset, size, COUNT));
    fixture.listen.mockReset().mockResolvedValue(() => undefined);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  const mount = () => act(async () => root.render(<LocalLibraryTab onOpen={() => {}} onOpenLocalSettings={() => {}} />));
  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(150); });
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>(".fixture-track")];
  const click = (label: string) => act(async () => {
    host.querySelectorAll("button").forEach((button) => {
      if (button.textContent?.trim() === label) button.click();
    });
  });
  const changeQuery = (value: string) => act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("renders only 100 rows and requests only the visible page when browsing", async () => {
    await mount();
    expect(rows()).toHaveLength(100);
    expect(fixture.search.mock.calls).toEqual([["", 0, 100]]);
    await click("Далее");
    expect(rows()).toHaveLength(100);
    expect(rows()[0].textContent).toBe("Трек 100");
    expect(fixture.search.mock.calls.at(-1)).toEqual(["", 100, 100]);
    await click("Назад");
    expect(rows()[0].textContent).toBe("Трек 0");
  });

  it("debounces typing, ignores stale query results, and resets to the first page", async () => {
    let resolveStale!: (page: LocalTrackPage) => void;
    fixture.search.mockImplementation((query, offset, size) => query === "жа"
      ? new Promise((resolve) => { resolveStale = resolve; })
      : Promise.resolve(response(offset, size, query ? 5 : COUNT)));
    await mount();
    await click("Далее");
    await changeQuery("ж");
    await changeQuery("жа");
    expect(fixture.search).toHaveBeenCalledTimes(2);
    await tick();
    expect(fixture.search.mock.calls.at(-1)).toEqual(["жа", 0, 100]);
    await changeQuery(" Жанна ");
    await tick();
    expect(fixture.search.mock.calls.at(-1)).toEqual(["Жанна", 0, 100]);
    expect(rows()).toHaveLength(5);
    await act(async () => resolveStale(response(0, 100, 80)));
    expect(rows()).toHaveLength(5);
    expect(rows()[0].textContent).toBe("Трек 0");
  });

  it("plays the exact track from page two in the full filtered queue", async () => {
    const matched = 718;
    fixture.search.mockImplementation(async (query, offset, size) => response(offset, size, query ? matched : COUNT));
    await mount();
    await changeQuery("Жанна");
    await tick();
    await click("Далее");
    await act(async () => rows()[9].click());
    expect(fixture.search.mock.calls.slice(-5)).toEqual([
      ["Жанна", 100, 100],
      ["Жанна", 0, 100, 1],
      ["Жанна", 200, 256, 1],
      ["Жанна", 456, 256, 1],
      ["Жанна", 712, 6, 1],
    ]);
    const [queue, position] = fixture.play.mock.calls[0];
    expect(position).toBe(109);
    expect(queue.map((item) => item.videoId)).toEqual(Array.from({ length: matched }, (_, index) => track(index).id));
    expect(queue[position].source).toBe("local");
    expect(rows()).toHaveLength(100);
  });

  it("does not start a partial or mismatched queue when the index changes", async () => {
    fixture.search.mockImplementation(async (_, offset, size, generation) =>
      response(offset, size, COUNT, generation ? 2 : 1));
    await mount();
    await act(async () => rows()[0].click());
    expect(fixture.play).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alert]")?.textContent).toContain("библиотека изменилась");
  });
});
