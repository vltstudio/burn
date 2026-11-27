import { useMemo, useState, type CSSProperties, type SyntheticEvent } from "react";
import type { MediaItem } from "../types";
import { trackArtwork } from "../ui/artwork";

type ArtworkStyle = CSSProperties & {
  "--fp-artwork-opacity": number;
  "--fp-artwork-rgb"?: string;
  "--tint-rgb"?: string;
  "--accent"?: string;
};

type Rgb = [number, number, number];

export function dominantArtworkColor(pixels: Uint8ClampedArray): Rgb | undefined {
  const buckets = new Map<number, { weight: number; total: number; rgb: Rgb }>();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const key = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
    const bucket = buckets.get(key) ?? { weight: 0, total: 0, rgb: [0, 0, 0] };
    bucket.weight += 0.5 + (Math.max(r, g, b) - Math.min(r, g, b)) / 128;
    bucket.total += 1;
    bucket.rgb[0] += r;
    bucket.rgb[1] += g;
    bucket.rgb[2] += b;
    buckets.set(key, bucket);
  }
  let dominant: { weight: number; total: number; rgb: Rgb } | undefined;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.weight > dominant.weight) dominant = bucket;
  }
  if (!dominant) return undefined;
  const { rgb: [r, g, b], total } = dominant;
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

function readArtworkColor(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 24;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return dominantArtworkColor(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

function accessibleAccent(rgb: Rgb) {
  const minimum = Math.min(...rgb);
  const chroma = Math.max(...rgb) - minimum;
  const vivid = Math.min(1, chroma / 48);
  const linear = rgb.map((channel) => {
    const srgb = channel / 255 * (1 - vivid) + (chroma ? (channel - minimum) / chroma * vivid : 0);
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  const white = luminance < .56 ? (.56 - luminance) / (1 - luminance) : 0;
  return linear.map((channel) => {
    const mixed = channel + (1 - channel) * white;
    return Math.round(255 * (mixed <= .0031308 ? mixed * 12.92 : 1.055 * mixed ** (1 / 2.4) - .055));
  });
}

export function useFullPlayerArtwork(item: MediaItem) {
  const artworkKey = useMemo(() => JSON.stringify(trackArtwork(item, true)), [item]);
  const [loaded, setLoaded] = useState<{ key: string; style: ArtworkStyle }>();

  const onLoad = (event: SyntheticEvent<HTMLDivElement>) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.naturalWidth) return;
    const src = image.currentSrc || image.src;
    if (/^https:\/\/i\d*\.ytimg\.com\/vi(?:_webp)?\/[^/]+\/maxresdefault\./.test(src) && image.naturalWidth <= 120) return;

    const update = (palette: Rgb | undefined) => {
      if (!image.isConnected || (image.currentSrc || image.src) !== src) return;
      const accent = palette && accessibleAccent(palette).join(", ");
      setLoaded({
        key: artworkKey,
        style: {
          "--fp-artwork-opacity": .6,
          "--fp-artwork-rgb": palette?.join(", "),
          "--tint-rgb": accent,
          "--accent": accent && `rgb(${accent})`,
        },
      });
    };

    try {
      update(readArtworkColor(image));
    } catch (error) {
      update(undefined);
      if (!(error instanceof DOMException) || error.name !== "SecurityError") return;
      const anonymous = new Image();
      anonymous.crossOrigin = "anonymous";
      anonymous.onload = () => {
        try {
          update(readArtworkColor(anonymous));
        } catch {
          return;
        }
      };
      anonymous.src = src;
    }
  };

  return { style: loaded?.key === artworkKey ? loaded.style : undefined, onLoad };
}
