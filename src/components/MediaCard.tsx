import { Play } from "lucide-react";
import type { MediaItem } from "../types";
import { Cover } from "../ui/cover";
import { bigThumb } from "../ui/format";
import { ArtistNames } from "../ui/artist-links";

interface Props {
  item: MediaItem;
  onOpen: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
}

export function MediaCard({ item, onOpen, onPlay }: Props) {
  const artists = item.artists.map((artist) => artist.name).join(", ");
  const sub = artists || item.year || item.subtitle;

  return (
    <div className="card">
      <div className={`card-cover ${item.kind === "artist" ? "round" : ""}`}>
        <button className="card-open" aria-label={`Открыть: ${item.title}`} onClick={() => onOpen(item)}>
          <Cover src={bigThumb(item)} alt="" />
        </button>
        {item.videoId ? (
          <button
            className="card-play"
            title="Слушать"
            onClick={(event) => {
              event.stopPropagation();
              onPlay(item);
            }}
          >
            <Play size={14} fill="currentColor" />
          </button>
        ) : null}
      </div>
      <div className="card-text">
        <button className="card-title" title={item.title} onClick={() => onOpen(item)}>{item.title}</button>
        {sub ? <div className="card-sub">
          {item.artists.length > 0 ? item.artists.map((artist, index) => (
            <span key={`${artist.browseId}-${index}`}>
              {artist.browseId ? <ArtistNames artists={[artist]} fallback={artist.name} /> : artist.name}
              {index < item.artists.length - 1 ? ", " : null}
            </span>
          )) : sub}
        </div> : null}
      </div>
    </div>
  );
}
