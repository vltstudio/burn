import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Detail, MediaItem, Section } from "../types";
import { DetailView } from "./DetailView";

const api = vi.hoisted(() => ({
  browse: vi.fn<(browseId: string) => Promise<Detail>>(),
  browseReleases: vi.fn<(browseId: string, params: string) => Promise<Section>>(),
  browseMore: vi.fn<(continuation: string) => Promise<Section>>(),
  setBackdrop: vi.fn(),
}));

vi.mock("../api", () => ({ api, ApiFailure: class extends Error {} }));
vi.mock("../backdrop", () => ({ useBackdrop: () => ({ setBackdrop: api.setBackdrop }) }));
vi.mock("../components/ui/liquid-spinner", () => ({ LiquidWaveSpinner: () => null }));
vi.mock("../library", () => ({ useLibrary: () => ({ favoriteIds: new Set() }) }));
vi.mock("../player", () => ({ usePlayback: () => ({ current: null, playing: false }) }));

function release(browseId: string, title: string): MediaItem {
  return {
    kind: "album", browseId, title, subtitle: "", videoId: null, playlistId: null,
    duration: null, year: null, thumbs: [], artists: [], album: null,
  };
}

it("opens the full discography without a carousel token and loads subsequent releases", async () => {
  const first = release("first", "Первый релиз");
  const ep = release("ep", "Blood N Roll");
  const last = release("last", "Последний релиз");
  const previewOnly = release("preview", "Релиз из превью");
  const title = "Синглы и EP";
  api.browse.mockResolvedValue({
    header: { kind: "artist", title: "Clonnex", subtitle: "", meta: "", description: null,
      thumbs: [], browseId: "artist", playlistId: null, year: null, artists: [] },
    sections: [{ title, layout: "carousel", items: [first, previewOnly], continuation: null,
      moreEndpoint: { browseId: "discography", params: "singles" } }],
  });
  api.browseReleases.mockResolvedValue({ title, layout: "grid", items: [first, ep], continuation: "next" });
  api.browseMore.mockResolvedValue({ title, layout: "grid", items: [last], continuation: null });

  const host = document.createElement("div");
  const root = createRoot(host);
  const onOpen = vi.fn();
  const getButton = (label: string) => Array.from(host.querySelectorAll("button"))
    .find((button) => button.textContent === label);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(<DetailView browseId="artist" fallbackTitle="Clonnex" onOpen={onOpen} onBack={() => {}} />));
    expect(getButton(ep.title)).toBeUndefined();
    await act(async () => getButton("Показать все")!.click());
    expect(api.browseReleases).toHaveBeenCalledWith("discography", "singles");
    expect(host.querySelectorAll(".card-title")).toHaveLength(3);
    expect(getButton("Показать все")).toBeUndefined();
    await act(async () => getButton("Показать ещё")!.click());
    expect(api.browseMore).toHaveBeenCalledWith("next");
    expect(getButton(last.title)).toBeDefined();
    await act(async () => getButton(ep.title)!.click());
    expect(onOpen).toHaveBeenCalledWith(ep);
  } finally {
    await act(async () => root.unmount());
  }
});
