import { ArrowDownToLine, Clock3, Heart, Play } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { api } from "../api";
import { useDownloads } from "../downloads-provider";
import type { MediaItem } from "../types";
import { useLibrary } from "../library";
import { usePlayback } from "../player";
import { Cover } from "../ui/cover";
import { favoriteKey, smallThumb } from "../ui/format";
import { ArtistNames } from "../ui/artist-links";
import { PlaylistPicker } from "./PlaylistPicker";

interface Props {
  items: MediaItem[];
  showAlbum?: boolean;
  showCover?: boolean;
  currentVideoId: string | null;
  isPlaying: boolean;
  onPlay: (index: number) => void;
  onOpen: (item: MediaItem) => void;
}

export function TrackTable({
  items,
  showAlbum = true,
  showCover = false,
  currentVideoId,
  isPlaying,
  onPlay,
  onOpen,
}: Props) {
  const { favoriteIds, toggleFavorite } = useLibrary();
  const player = usePlayback();
  const downloads = useDownloads();
  const offlineIds = useMemo(
    () => new Set(downloads.snapshot.items.map((entry) => entry.videoId)),
    [downloads.snapshot],
  );
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);

  const prefetch = (videoId: string | null) => {
    if (!videoId) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      void api.streamUrl(videoId).catch(() => undefined);
    }, 450);
  };
  const cancelPrefetch = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };

  if (items.length === 0) return null;

  return (
    <div className={`table ${showAlbum ? "" : "no-album"} ${showCover ? "with-cover" : ""}`}>
      <div className="table-head">
        <span className="th-title">Название</span>
        <span>Исполнитель</span>
        {showAlbum ? <span className="th-album">Альбом</span> : null}
        <span className="th-duration">
          <Clock3 size={12} strokeWidth={1.7} />
        </span>
        <span className="th-actions" />
      </div>

      {items.map((item, index) => {
        const playing = Boolean(item.videoId) && item.videoId === currentVideoId;
        const artists = item.artists.slice(0, 2);
        const videoId = item.videoId;
        const unavailable = !videoId && !item.browseId && !item.localPath;
        const favoriteId = favoriteKey(item);
        const liked = favoriteId !== null && favoriteIds.has(favoriteId);
        const artistNames = artists.length > 0 ? artists.map((artist, artistIndex) => (
          <span key={`${artist.browseId}-${artistIndex}`}>
            {artist.browseId ? <ArtistNames artists={[artist]} fallback={artist.name} /> : artist.name}
            {artistIndex < artists.length - 1 ? ", " : null}
          </span>
        )) : item.subtitle || "—";

        return (
          <div
            key={`${item.videoId ?? item.browseId ?? item.title}-${index}`}
            className={`tr ${playing ? "playing" : ""}`}
            onClick={() => item.videoId ? onPlay(index) : onOpen(item)}
            onDoubleClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button")) return;
              if (item.videoId) player.enqueue(item);
            }}
            onPointerEnter={() => { if (item.source !== "local") prefetch(videoId); }}
            onPointerLeave={cancelPrefetch}
          >
            <div className="td title-cell">
              <button
                className="tr-gutter"
                title={playing && isPlaying ? "Пауза" : "Играть"}
                aria-label={`${playing && isPlaying ? "Пауза" : "Играть"}: ${item.title}`}
                disabled={!videoId}
                onClick={(event) => {
                  event.stopPropagation();
                  if (playing) player.toggle();
                  else onPlay(index);
                }}
              >
                {playing && isPlaying ? (
                  <span className="bars">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <Play size={11} fill="currentColor" />
                )}
              </button>
              {showCover ? <Cover className="tr-cover" src={smallThumb(item)} alt="" /> : null}
              <div className="tr-title-group">
                <div className="tr-title-row">
                  <button className="tr-title" disabled={unavailable}
                    title={unavailable ? `${item.title} · Недоступно в YouTube Music` : item.title} onClick={(event) => {
                    event.stopPropagation();
                    if (item.videoId) onPlay(index);
                    else onOpen(item);
                  }}>{item.title}</button>
                  {videoId && offlineIds.has(videoId) ? (
                    <span className="tr-offline" title="Скачано — играет без интернета" role="img" aria-label="Скачано">
                      <ArrowDownToLine size={12} strokeWidth={2.2} aria-hidden />
                    </span>
                  ) : videoId && videoId in downloads.progress ? (
                    <span className="tr-offline pending" title="Скачивается…" role="img" aria-label="Скачивается">
                      <ArrowDownToLine size={12} strokeWidth={2.2} aria-hidden />
                    </span>
                  ) : null}
                </div>
                <div className="tr-mobile-artists">{artistNames}</div>
              </div>
            </div>

            <div className="td tr-artists">
              {artistNames}
            </div>

            {showAlbum ? (
              <div className="td tr-album">
                {item.album?.browseId ? (
                  <button
                    className="link"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen({
                        ...item,
                        kind: "album",
                        browseId: item.album?.browseId ?? null,
                        title: item.album?.name ?? "",
                        videoId: null,
                      });
                    }}
                  >
                    {item.album.name}
                  </button>
                ) : (
                  item.album?.name || "—"
                )}
              </div>
            ) : null}

            <div className="td tr-duration">{item.duration ?? "—"}</div>

            <div className="td tr-actions" onClick={(event) => event.stopPropagation()}>
              <button
                className={`row-action ${liked ? "active" : ""}`}
                title={liked ? "Убрать из избранного" : "В избранное"}
                aria-label={liked ? "Убрать из избранного" : "В избранное"}
                aria-pressed={liked}
                disabled={!favoriteId}
                onClick={() => toggleFavorite(item)}
              >
                <Heart size={14} strokeWidth={1.7} fill={liked ? "currentColor" : "none"} />
              </button>
              <PlaylistPicker videoId={item.source === "local" ? null : videoId} className="row-picker" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
