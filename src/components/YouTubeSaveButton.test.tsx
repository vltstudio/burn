import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MediaItem } from "../types";
import { YouTubeSaveButton } from "./YouTubeSaveButton";

const openUrl = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
vi.mock("../api", () => ({ api: { openUrl } }));

const track: MediaItem = {
  kind: "song", title: "Music track", subtitle: "Artist", videoId: "fixture0001",
  browseId: null, playlistId: null, duration: null, year: null, thumbs: [], artists: [], album: null,
};
let root: Root;
let host: HTMLDivElement;

async function render(item: MediaItem = track) {
  await act(async () => root.render(<YouTubeSaveButton item={item} />));
}

async function click(selector: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(selector)?.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  openUrl.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("offers official download options without calling the service before a choice", async () => {
  await render();
  await click("button");
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(openUrl).not.toHaveBeenCalled();
  await click(".youtube-save-body .solid-button");
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://music.youtube.com/watch?v=fixture0001");
  expect(host.querySelector("dialog")).toBeNull();
});

it("keeps the intended track if playback advances while the dialog is open", async () => {
  await render();
  await click("button");
  await render({ ...track, title: "Next track", videoId: "fixture0002" });
  expect(host.querySelector("strong")?.textContent).toBe("Music track");
  await click(".youtube-save-body .solid-button");
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://music.youtube.com/watch?v=fixture0001");
});

it("does not offer YouTube actions for local files or malformed IDs", async () => {
  await render({ ...track, source: "local", localPath: "/music.mp3" });
  expect(host.querySelector("button")).toBeNull();
  await render({ ...track, videoId: "bad#id" });
  expect(host.querySelector("button")).toBeNull();
  expect(openUrl).not.toHaveBeenCalled();
});
