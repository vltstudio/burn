import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QuickPlacement, QuickState } from "../quick-player";
import type { MediaItem, SearchResults } from "../types";
import QuickPlayer from "./QuickPlayer";

const fake = vi.hoisted(() => ({
  send: vi.fn(), window: vi.fn(), search: vi.fn(), localSearch: vi.fn(),
  events: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../quick-player", () => ({
  QUICK_WINDOW: "quick-player", QUICK_VISIBILITY: "visibility", QUICK_STATE: "state",
  quickWindow: fake.window, quickRequest: fake.send,
  subscribeQuick: (_label: string, event: string, callback: (value: unknown) => void) => {
    fake.events.set(event, callback);
    return { ready: Promise.resolve(), dispose: () => fake.events.delete(event) };
  },
}));
vi.mock("../api", () => ({ api: { search: fake.search, localSearch: fake.localSearch } }));

const track: MediaItem = {
  kind: "song", title: "Liquid light", subtitle: "VLT", videoId: "test-track1",
  browseId: null, playlistId: null, duration: "4:00", year: null, thumbs: [], artists: [], album: null,
};
const placement: QuickPlacement = { edge: "bottom", arrow: 81 };
let host: HTMLDivElement;
let root: Root;
const mount = () => act(async () => root.render(<QuickPlayer />));
const button = (label: string) => [...host.querySelectorAll("button")]
  .find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
const click = (label: string) => act(async () => button(label)?.click());
const input = (value: string) => act(async () => {
  const field = host.querySelector(".quick-input input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  fake.send.mockReset().mockResolvedValue(undefined);
  fake.window.mockReset().mockResolvedValue(placement);
  fake.search.mockReset().mockResolvedValue({ top: track, items: [track], continuation: null });
  fake.localSearch.mockReset().mockResolvedValue({ items: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("shows the main player's state and sends controls back to that player", async () => {
  await mount();
  const state: QuickState = {
    current: track, playing: true, loading: false, progress: 72, duration: 240,
    volume: 0.7, muted: false, shuffle: false, repeat: "off", favorite: true,
  };
  await act(async () => fake.events.get("state")?.(state));
  expect(host.textContent).toContain("1:12");
  expect(button("Избранное")?.getAttribute("aria-pressed")).toBe("true");
  await click("Пауза");
  await click("Следующий трек");
  await click("Избранное");
  expect(fake.send.mock.calls.map(([payload]) => payload.action)).toEqual(["snapshot", "toggle", "next", "favorite"]);
});

it("expands at the tray anchor and lets a result play or join the same queue", async () => {
  await mount();
  fake.window.mockResolvedValue({ edge: "right", arrow: 34 });
  await click("Найти трек");
  expect(fake.window).toHaveBeenLastCalledWith("expand");
  expect(host.querySelector(".quick-frame")?.getAttribute("data-edge")).toBe("right");
  await input(" light ");
  expect(fake.search).not.toHaveBeenCalled();
  await tick();
  expect(fake.search).toHaveBeenCalledExactlyOnceWith("light", "songs");
  expect(host.querySelectorAll(".quick-result")).toHaveLength(1);
  await click("Играть: Liquid light");
  await click("В очередь: Liquid light");
  expect(fake.send.mock.calls.slice(-2)).toEqual([[{ action: "play", item: track }], [{ action: "enqueue", item: track }]]);
});

it("drops stale responses after changing source and hides when focus leaves", async () => {
  let resolveOld!: (result: SearchResults) => void;
  fake.search.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  await mount();
  await click("Найти трек");
  await input("light");
  await tick();
  await click("На компьютере");
  await tick();
  expect(fake.localSearch).toHaveBeenCalledExactlyOnceWith("light", 0, 7);
  await act(async () => resolveOld({ top: track, items: [], continuation: null }));
  expect(host.querySelector(".quick-results")?.textContent).toBe("Ничего не нашлось.");
  await act(async () => fake.events.get("visibility")?.(null));
  expect(host.childElementCount).toBe(0);
});

const playing: QuickState = {
  current: track, playing: true, loading: false, progress: 26, duration: 119,
  volume: 0.7, muted: false, shuffle: false, repeat: "off", favorite: false,
};
const broadcast = (patch: Partial<QuickState>) => act(async () => fake.events.get("state")?.({ ...playing, ...patch }));
const timeline = () => host.querySelector<HTMLInputElement>(".quick-timeline input")!;
const seekTo = (value?: string) => act(async () => {
  const field = timeline();
  field.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
  if (value === undefined) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const releaseTimeline = () => act(async () => {
  timeline().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
});
const elapsed = () => host.querySelector(".quick-timeline")?.textContent;

it("seeks at once on a press and keeps the pressed position through a stale update", async () => {
  await mount();
  await broadcast({});

  await seekTo("72");
  expect(fake.send).toHaveBeenLastCalledWith({ action: "seek", value: 72 });
  expect(elapsed()).toContain("1:12");

  await releaseTimeline();
  expect(fake.send).toHaveBeenLastCalledWith({ action: "seek", value: 72 });

  // The player's own progress is still one round trip behind: the thumb must
  // hold the pressed position instead of falling back and jumping again.
  await broadcast({ progress: 27 });
  expect(elapsed()).toContain("1:12");

  await broadcast({ progress: 72.4 });
  await broadcast({ progress: 80 });
  expect(elapsed()).toContain("1:20");
});

it("sends every move of a drag and drops the pressed position if the seek is refused", async () => {
  await mount();
  await broadcast({});

  await seekTo("40");
  await seekTo("60");
  expect(fake.send.mock.calls.filter(([payload]) => payload.action === "seek")).toEqual([
    [{ action: "seek", value: 40 }],
    [{ action: "seek", value: 60 }],
  ]);

  await releaseTimeline();
  await tick();
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(elapsed()).toContain("0:26");
});
