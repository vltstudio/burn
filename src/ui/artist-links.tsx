import { createContext, useContext, type ReactNode } from "react";
import type { ItemRef } from "../types";

const ArtistNav = createContext<((ref: ItemRef) => void) | null>(null);

/// Lets any surface, the player bar included, open an artist page without
/// threading a callback through every component.
export function ArtistNavProvider({
  open,
  children,
}: {
  open: (ref: ItemRef) => void;
  children: ReactNode;
}) {
  return <ArtistNav.Provider value={open}>{children}</ArtistNav.Provider>;
}

export function useArtistNav() {
  return useContext(ArtistNav);
}

/// Artist names as buttons; falls back to plain text where the backend only
/// supplied a subtitle line.
export function ArtistNames({
  artists,
  fallback,
  className,
  interactive = true,
  onNavigate,
}: {
  artists: ItemRef[];
  fallback?: string;
  className?: string;
  interactive?: boolean;
  onNavigate?: () => void;
}) {
  const openArtist = useArtistNav();
  if (!artists.length || !openArtist || !interactive) {
    return <span className={className}>{artists.map((artist) => artist.name).join(", ") || fallback || ""}</span>;
  }
  return (
    <span className={className}>
      {artists.map((artist, index) => (
        <span key={`${artist.browseId}-${index}`}>
          {artist.browseId ? <button
            type="button"
            className="artist-link"
            title={`Открыть ${artist.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onNavigate?.();
              openArtist(artist);
            }}
          >
            {artist.name}
          </button> : artist.name}
          {index < artists.length - 1 ? ", " : null}
        </span>
      ))}
    </span>
  );
}
