import type { MediaItem, Section } from "../types";
import { MediaCard } from "./MediaCard";
import { TrackTable } from "./TrackTable";

interface Props {
  section: Section;
  currentVideoId?: string | null;
  isPlaying: boolean;
  onPlayList: (items: MediaItem[], index: number) => void;
  onOpen: (item: MediaItem) => void;
  onPlay: (item: MediaItem) => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  loadMoreError?: string | null;
  maxRows?: number;
  showAlbum?: boolean;
}

export function Shelf({
  section,
  currentVideoId,
  isPlaying,
  onPlayList,
  onOpen,
  onPlay,
  onLoadMore,
  loadingMore,
  loadMoreError,
  maxRows,
  showAlbum = true,
}: Props) {
  const more = onLoadMore && (section.moreEndpoint || section.continuation) ? (
    <div className="load-more" aria-busy={loadingMore}>
      {loadMoreError ? <div className="load-error" role="alert">{loadMoreError}</div> : null}
      <button className="ghost-button" onClick={onLoadMore} disabled={loadingMore}>
        {loadingMore ? "Загрузка…" : loadMoreError ? "Попробовать снова" : section.moreEndpoint ? "Показать все" : "Показать ещё"}
      </button>
    </div>
  ) : null;
  if (section.layout === "list") {
    const items = maxRows ? section.items.slice(0, maxRows) : section.items;
    const playableItems = section.items.filter((item) => Boolean(item.videoId));
    let position = 0;
    const positions = section.items.map((item) => item.videoId ? position++ : -1);

    return (
      <div>
        <TrackTable
          items={items}
          showAlbum={showAlbum}
          currentVideoId={currentVideoId ?? null}
          isPlaying={isPlaying}
          onPlay={(index) => {
            if (positions[index] >= 0) onPlayList(playableItems, positions[index]);
            else onOpen(items[index]);
          }}
          onOpen={onOpen}
        />
        {more}
      </div>
    );
  }

  return (
    <div>
      <div className={section.layout === "carousel" ? "carousel" : "grid"}>
        {section.items.map((item, index) => (
          <MediaCard
            key={`${item.browseId ?? item.videoId ?? item.title}-${index}`}
            item={item}
            onOpen={onOpen}
            onPlay={() => onPlay(item)}
          />
        ))}
      </div>
      {more}
    </div>
  );
}
