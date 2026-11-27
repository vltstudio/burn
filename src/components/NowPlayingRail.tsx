import { ChevronsUp, Heart, Maximize2, PanelRightClose, PanelRightOpen, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useLibrary } from "../library";
import { usePlayback } from "../player";
import type { MediaItem } from "../types";
import { loadArtist, type ArtistInfo } from "../ui/artist";
import { ArtistNames } from "../ui/artist-links";
import { Cover, TrackCover } from "../ui/cover";
import { favoriteKey } from "../ui/format";
import { PlaylistPicker } from "./PlaylistPicker";

interface Props {
  open: boolean;
  onToggle: () => void;
  onOpen: (item: MediaItem) => void;
}

/// The right column: what is playing, who made it, and what comes next.
export function NowPlayingRail({ open, onToggle, onOpen }: Props) {
  const { current, queue, upNext, jumpTo, setExpanded } = usePlayback();
  const { favoriteIds, toggleFavorite } = useLibrary();
  const [artistResult, setArtistResult] = useState<{ browseId: string; info: ArtistInfo | null } | null>(null);

  const artistRef = current?.artists[0] ?? null;
  const artist = artistResult?.browseId === artistRef?.browseId ? artistResult?.info : null;
  const artistId = artistRef?.browseId;
  const artistName = artistRef?.name;

  useEffect(() => {
    if (!open || !artistId || !artistName) return;
    let cancelled = false;
    loadArtist({ browseId: artistId, name: artistName }).then((info) => {
      if (!cancelled) setArtistResult({ browseId: artistId, info });
    });
    return () => {
      cancelled = true;
    };
  }, [open, artistId, artistName]);

  if (!open) {
    return (
      <aside className="rail closed" aria-label="Сейчас играет">
        <button className="rail-toggle" onClick={onToggle} title="Показать панель">
          <PanelRightOpen size={15} strokeWidth={1.7} />
        </button>
        {current ? (
          <button className="rail-mini" onClick={onToggle} title="Показать панель">
            <TrackCover item={current} className="rail-mini-cover" eager />
          </button>
        ) : null}
      </aside>
    );
  }

  const subtitle = current?.artists.map((item) => item.name).join(", ") || current?.subtitle || "";
  const favoriteId = current ? favoriteKey(current) : null;
  const isLiked = favoriteId ? favoriteIds.has(favoriteId) : false;
  const upcoming = upNext.slice(0, 3);
  const openArtist = (ref: NonNullable<typeof artistRef>) =>
    onOpen({
      kind: "artist",
      title: artist?.name ?? ref.name,
      subtitle: "",
      videoId: null,
      browseId: ref.browseId,
      playlistId: null,
      duration: null,
      year: null,
      thumbs: artist?.avatar ? [artist.avatar] : [],
      artists: [],
      album: null,
    });

  return (
    <aside className="rail" aria-label="Сейчас играет">
      {current ? (
        <TrackCover
          item={current}
          large
          eager
          className="rail-wash"
        />
      ) : null}

      <div className="rail-head">
        <button className="rail-toggle" onClick={onToggle} title="Скрыть панель">
          <PanelRightClose size={15} strokeWidth={1.7} />
        </button>
        <span className="rail-kicker">Сейчас играет</span>
      </div>

      {current ? (
        <div className="rail-scroll">
          <button
            className="rail-art player-artwork-expand"
            onClick={() => setExpanded(true)}
            title="Развернуть плеер"
            aria-label="Развернуть плеер"
            aria-haspopup="dialog"
          >
            <TrackCover item={current} className="rail-cover" large eager />
            <span className="player-artwork-expand-overlay" aria-hidden="true">
              <Maximize2 className="player-artwork-expand-icon" size={32} strokeWidth={1.8} />
            </span>
          </button>

          <div className="rail-now">
            <div className="rail-title">{current.title}</div>
            <div className="rail-sub">{subtitle}</div>
          </div>

          <div className="rail-actions">
            <button
              className={`rail-action ${isLiked ? "active" : ""}`}
              onClick={() => toggleFavorite(current)}
              title={isLiked ? "Убрать из избранного" : "В избранное"}
            >
              <Heart size={15} strokeWidth={1.7} fill={isLiked ? "currentColor" : "none"} />
            </button>
            {current.source !== "local" ? (
              <PlaylistPicker videoId={current.videoId ?? null} className="rail-picker" />
            ) : null}
            <button
              className="rail-action"
              onClick={() => setExpanded(true)}
              title="Развернуть плеер"
              aria-label="Развернуть плеер"
            >
              <ChevronsUp size={15} strokeWidth={1.7} />
            </button>
          </div>

          {current.album ? (
            <button
              className="rail-album"
              onClick={() =>
                current.album &&
                onOpen({
                  ...current,
                  kind: "album",
                  browseId: current.album.browseId,
                  title: current.album.name,
                })
              }
              title={current.album.name}
            >
              <span className="rail-album-kicker">Альбом</span>
              <span className="rail-album-name">{current.album.name}</span>
            </button>
          ) : null}

          {upcoming.length ? (
            <section className="rail-card">
              <h3 className="rail-card-title">Далее в очереди</h3>
              <div className="rail-queue">
                {upcoming.map((position) => {
                  const item = queue[position];
                  return (
                  <button
                    key={`${item.videoId ?? item.title}-${position}`}
                    className="rail-queue-item"
                    onClick={() => jumpTo(position)}
                  >
                    <TrackCover
                      className="rail-queue-cover"
                      item={item}
                    />
                    <span className="rail-queue-text">
                      <span className="rail-queue-title">{item.title}</span>
                      <ArtistNames
                        interactive={false}
                        className="rail-queue-sub"
                        artists={item.artists}
                        fallback={item.subtitle}
                      />
                    </span>
                    <span className="rail-queue-play">
                      <Play size={12} strokeWidth={1.8} fill="currentColor" />
                    </span>
                  </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {artistRef ? (
            <section className="rail-card">
              <h3 className="rail-card-title">Об исполнителе</h3>
              <button className="rail-artist" onClick={() => openArtist(artistRef)}>
                {artist?.avatar ? (
                  <Cover className="rail-avatar" src={artist.avatar} alt={artist.name} />
                ) : (
                  <span className="rail-avatar cover-fallback" aria-hidden />
                )}
                <span className="rail-artist-text">
                  <span className="rail-artist-name">{artist?.name ?? artistRef.name}</span>
                  <span className="rail-artist-meta">{artist?.listeners ?? "Исполнитель"}</span>
                </span>
              </button>
              <button className="rail-open" onClick={() => openArtist(artistRef)}>
                Открыть исполнителя
              </button>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="rail-empty">Включи трек — здесь появятся обложка и исполнитель.</div>
      )}
    </aside>
  );
}
