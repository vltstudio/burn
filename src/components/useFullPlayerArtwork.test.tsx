import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../types";
import { TrackCover } from "../ui/cover";
import { dominantArtworkColor, useFullPlayerArtwork } from "./useFullPlayerArtwork";

function track(thumbs: string[]): MediaItem {
  return {
    kind: "song", title: "Track", subtitle: "", videoId: null, browseId: null,
    playlistId: null, duration: null, year: null, thumbs, artists: [], album: null,
  };
}

function Fixture({ item }: { item: MediaItem }) {
  const artwork = useFullPlayerArtwork(item);
  return (
    <dialog style={artwork.style}>
      <div onLoadCapture={artwork.onLoad}>
        <TrackCover item={item} large eager />
      </div>
    </dialog>
  );
}

function imageData(...pixels: number[][]) {
  return { data: new Uint8ClampedArray(pixels.flat()) };
}

describe("dominantArtworkColor", () => {
  it("averages the strongest color group and ignores transparent pixels", () => {
    const { data } = imageData(
      [25, 82, 195, 255], [31, 93, 213, 255], [20, 87, 203, 255],
      [245, 107, 5, 255], [255, 255, 255, 10],
    );
    expect(dominantArtworkColor(data)).toEqual([25, 87, 204]);
  });

  it("keeps a neutral palette when the artwork is grayscale", () => {
    expect(dominantArtworkColor(imageData([12, 12, 12, 255], [28, 28, 28, 255]).data))
      .toEqual([20, 20, 20]);
    expect(dominantArtworkColor(imageData([20, 20, 20, 0]).data)).toBeUndefined();
  });
});

describe("useFullPlayerArtwork", () => {
  let container: HTMLDivElement;
  let root: Root;
  const drawImage = vi.fn();
  const getImageData = vi.fn();

  const render = (thumbs: string[]) => act(async () => root.render(<Fixture item={track(thumbs)} />));
  const style = () => container.querySelector("dialog")!.style;
  const load = async () => {
    const img = container.querySelector("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 400 });
    await act(async () => img.dispatchEvent(new Event("load")));
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    getImageData.mockReturnValue(imageData([10, 25, 180, 255]));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      { drawImage, getImageData } as unknown as CanvasRenderingContext2D,
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses the displayed artwork's color and clears it as soon as the cover changes", async () => {
    await render(["/blue.png"]);
    await load();
    expect(style().getPropertyValue("--fp-artwork-rgb")).toBe("10, 25, 180");
    expect(style().getPropertyValue("--accent")).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(style().getPropertyValue("--fp-artwork-opacity")).toBe("0.6");

    await render(["/red.png"]);
    expect(style().getPropertyValue("--fp-artwork-rgb")).toBe("");
    getImageData.mockReturnValue(imageData([240, 40, 35, 255]));
    await load();
    expect(style().getPropertyValue("--fp-artwork-rgb")).toBe("240, 40, 35");

    await render([]);
    expect(style().getPropertyValue("--fp-artwork-opacity")).toBe("");
    expect(style().getPropertyValue("--accent")).toBe("");
  });

  it("keeps the artwork visible when pixel access is denied and ignores a late palette", async () => {
    const anonymous = document.createElement("img");
    vi.stubGlobal("Image", function () { return anonymous; });
    getImageData.mockImplementationOnce(() => { throw new DOMException("Tainted", "SecurityError"); });
    await render(["https://example.test/cover.png"]);
    await load();
    expect(style().getPropertyValue("--fp-artwork-opacity")).toBe("0.6");
    expect(style().getPropertyValue("--fp-artwork-rgb")).toBe("");
    expect(anonymous.crossOrigin).toBe("anonymous");

    await render([]);
    await act(async () => anonymous.dispatchEvent(new Event("load")));
    expect(style().getPropertyValue("--fp-artwork-opacity")).toBe("");
    expect(style().getPropertyValue("--fp-artwork-rgb")).toBe("");
  });
});
