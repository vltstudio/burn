import { useState } from "react";
import type { MediaItem } from "../types";
import { trackArtwork } from "./artwork";

interface CoverProps {
  className?: string;
  alt?: string;
  eager?: boolean;
}

const failedImages = new Map<string, number>();

function rememberFailure(src: string) {
  failedImages.delete(src);
  failedImages.set(src, Date.now() + 60_000);
  if (failedImages.size > 256) failedImages.delete(failedImages.keys().next().value!);
}

export function Cover({
  src,
  fallbacks = [],
  className,
  alt = "",
  eager = false,
}: CoverProps & {
  src?: string;
  fallbacks?: readonly string[];
}) {
  const sources = [...new Set([src, ...fallbacks].filter((url): url is string => Boolean(url)))];
  return <CoverImage key={JSON.stringify(sources)} sources={sources} className={className} alt={alt} eager={eager} />;
}

function CoverImage({ sources, className, alt, eager }: CoverProps & { sources: string[] }) {
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const activeSrc = sources.find((url) => !failedSources.includes(url) && (failedImages.get(url) ?? 0) <= Date.now());
  const fail = () => {
    if (!activeSrc) return;
    rememberFailure(activeSrc);
    setFailedSources((previous) => previous.includes(activeSrc) ? previous : [...previous, activeSrc]);
  };
  if (!activeSrc) {
    return <div className={`${className ?? ""} cover-fallback`} aria-hidden />;
  }
  return (
    <img
      key={activeSrc}
      className={className}
      src={activeSrc}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={fail}
      onLoad={(event) => {
        if (/^https:\/\/i\d*\.ytimg\.com\/vi(?:_webp)?\/[^/]+\/maxresdefault\./.test(activeSrc) && event.currentTarget.naturalWidth <= 120) {
          fail();
        }
      }}
    />
  );
}

export function TrackCover({
  item,
  large = false,
  ...props
}: CoverProps & { item: MediaItem; large?: boolean }) {
  const [src, ...fallbacks] = trackArtwork(item, large);
  return <Cover src={src} fallbacks={fallbacks} {...props} />;
}
