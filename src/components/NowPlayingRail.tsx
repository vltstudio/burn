import {
  ArrowUpRight, Disc3, Heart, ListMusic, Maximize2, Music2,
  PanelRightClose, PanelRightOpen, Play, RotateCw, UserRound,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLibrary } from "../library";
import { usePlayback } from "../player";
import type { ItemRef, MediaItem } from "../types";
import { loadArtist, type ArtistInfo } from "../ui/artist";
import { ArtistNames, useArtistNav } from "../ui/artist-links";
import { Cover, TrackCover } from "../ui/cover";
import { favoriteKey } from "../ui/format";
import { PlaylistPicker } from "./PlaylistPicker";
import "./NowPlayingRail.css";

interface Props {
  open: boolean;
  onToggle: () => void;
  onOpen: (item: MediaItem) => void;
}

type ArtistState =
  | { status: "idle" | "loading" | "unavailable" }
  | { status: "ready"; info: ArtistInfo };

function RailArtist({ artist }: { artist?: ItemRef }) {
  const labelId = useId();
  const metaId = useId();
  const navigate = useArtistNav();
  const routeRef = useRef<HTMLButtonElement>(null);
  const artistId = artist?.browseId.trim();
  const artistName = artist?.name.trim();
  const canLoad = Boolean(artistId && artistName);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ArtistState>({ status: canLoad ? "loading" : "idle" });

  useEffect(() => {
    if (!artistId || !artistName) return;
    let cancelled = false;
    const unavailable = () => {
      if (!cancelled) setState({ status: "unavailable" });
    };
    void loadArtist({ browseId: artistId, name: artistName }).then((info) => {
      if (cancelled) return;
      if (info) setState({ status: "ready", info });
      else unavailable();
    }, unavailable);
    return () => {
      cancelled = true;
    };
  }, [artistId, artistName, attempt]);

  const info = state.status === "ready" ? state.info : null;
  const name = info?.name || artistName || "Исполнитель не указан";
  const meta = state.status === "loading"
    ? "Загружаем сведения…"
    : state.status === "unavailable"
      ? "Сведения недоступны"
      : info?.listeners || (artistName ? "Исполнитель" : "");
  const identity = (
    <>
      <span className="npr-avatar" aria-hidden="true">
        <UserRound size={19} strokeWidth={1.6} />
        {info?.avatar ? <Cover className="npr-avatar-image" src={info.avatar} /> : null}
      </span>
      <span className="npr-artist-copy">
        <span className="npr-artist-name">{name}</span>
        {meta ? <span className="npr-artist-meta" id={metaId}>{meta}</span> : null}
      </span>
    </>
  );

  return (
    <section className="npr-artist" aria-labelledby={labelId}>
      <h3 className="npr-section-label" id={labelId}>Об исполнителе</h3>
      <div className="npr-artist-row">
        {artistId && navigate ? (
          <button
            type="button"
            className="npr-artist-identity npr-artist-route"
            ref={routeRef}
            aria-label={`Открыть исполнителя: ${name}`}
            aria-describedby={meta ? metaId : undefined}
            title={`Открыть исполнителя: ${name}`}
            onClick={() => navigate({ browseId: artistId, name })}
          >
            {identity}
            <span className="npr-artist-arrow">
              <ArrowUpRight size={17} strokeWidth={1.8} aria-hidden="true" />
            </span>
          </button>
        ) : (
          <div className="npr-artist-identity">{identity}</div>
        )}
        {state.status === "unavailable" ? (
          <button
            type="button"
            className="npr-icon-button npr-artist-retry"
            aria-label="Повторить загрузку сведений об исполнителе"
            title="Повторить загрузку"
            onClick={() => {
              routeRef.current?.focus();
              setState({ status: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCw size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <span className="npr-visually-hidden" role="status">{canLoad ? meta : ""}</span>
    </section>
  );
}

export function NowPlayingRail({ open, onToggle, onOpen }: Props) {
  const { current, queue, upNext, jumpTo, setExpanded } = usePlayback();
  const { favoriteIds, toggleFavorite } = useLibrary();
  const bodyId = useId();
  const trackLabelId = useId();
  const queueLabelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const favoriteId = current ? favoriteKey(current) : null;
  const isLiked = favoriteId ? favoriteIds.has(favoriteId) : false;
  const upcoming = upNext.slice(0, 3).flatMap((position) => {
    const item = queue[position];
    return item ? [{ item, position }] : [];
  });
  const artist = current?.artists.find((item) => item.name.trim() && item.browseId.trim())
    ?? current?.artists.find((item) => item.name.trim());
  const album = current?.album;
  const toggleLabel = open ? "Скрыть панель" : "Показать панель";

  return (
    <aside className={`rail now-playing-rail${open ? "" : " closed"}`} aria-label="Сейчас играет">
      <header className="npr-head">
        <button
          type="button"
          className="npr-icon-button npr-toggle"
          ref={toggleRef}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          {open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
        {open ? <span className="npr-kicker">Сейчас играет</span> : null}
      </header>
      {!open && current ? (
        <button
          type="button"
          className="npr-mini"
          aria-label="Показать панель с текущим треком"
          title="Показать панель"
          onClick={() => {
            toggleRef.current?.focus();
            onToggle();
          }}
        >
          <TrackCover item={current} className="npr-mini-cover" eager />
        </button>
      ) : null}

      <div className="npr-body" id={bodyId} hidden={!open}>
        {open && current ? (
          <>
            <section className="npr-current" aria-labelledby={trackLabelId}>
              <button
                type="button"
                className="npr-art player-artwork-expand"
                onClick={() => setExpanded(true)}
                title="Развернуть плеер"
                aria-label="Развернуть плеер"
                aria-haspopup="dialog"
              >
                <Music2 className="npr-art-placeholder" size={30} strokeWidth={1.5} aria-hidden="true" />
                <TrackCover item={current} className="npr-cover" large eager />
                <span className="npr-expand-badge" aria-hidden="true">
                  <Maximize2 size={13} strokeWidth={1.9} />
                </span>
                <span className="player-artwork-expand-overlay" aria-hidden="true">
                  <Maximize2 className="player-artwork-expand-icon" size={28} strokeWidth={1.8} />
                </span>
              </button>
              <div className="npr-track-copy">
                <h2 className="npr-track-title" id={trackLabelId}>{current.title}</h2>
                <ArtistNames className="npr-track-subtitle" artists={current.artists} fallback={current.subtitle} />
              </div>
              <div className="npr-tools">
                <button
                  type="button"
                  className="npr-icon-button npr-heart"
                  onClick={() => toggleFavorite(current)}
                  aria-label="Избранное"
                  aria-pressed={isLiked}
                  title={isLiked ? "Убрать из избранного" : "В избранное"}
                >
                  <Heart size={16} strokeWidth={1.8} fill={isLiked ? "currentColor" : "none"} />
                </button>
                {current.source !== "local" ? (
                  <PlaylistPicker videoId={current.videoId} className="npr-picker" />
                ) : null}
                {album?.browseId ? (
                  <button
                    type="button"
                    className="npr-album"
                    onClick={() => onOpen({ ...current, kind: "album", browseId: album.browseId, title: album.name })}
                    aria-label={`Открыть альбом: ${album.name}`}
                    title={album.name}
                  >
                    <Disc3 size={14} strokeWidth={1.7} aria-hidden="true" />
                    <span>{album.name}</span>
                  </button>
                ) : album?.name ? (
                  <span className="npr-album npr-album-static" title={album.name}>
                    <Disc3 size={14} strokeWidth={1.7} aria-hidden="true" />
                    <span>{album.name}</span>
                  </span>
                ) : null}
              </div>
            </section>

            {upcoming.length ? (
              <section className="npr-queue" aria-labelledby={queueLabelId}>
                <h3 className="npr-section-label" id={queueLabelId}>
                  <ListMusic size={14} strokeWidth={1.7} aria-hidden="true" />
                  Далее в очереди
                </h3>
                <ol className="npr-queue-list">
                  {upcoming.map(({ item, position }) => (
                    <li key={position}>
                      <button type="button" className="npr-queue-item" onClick={() => jumpTo(position)} title={item.title}>
                        <TrackCover className="npr-queue-cover" item={item} />
                        <span className="npr-queue-copy">
                          <span className="npr-queue-title">{item.title}</span>
                          <ArtistNames interactive={false} className="npr-queue-subtitle" artists={item.artists} fallback={item.subtitle} />
                        </span>
                        <Play className="npr-queue-play" size={12} fill="currentColor" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <RailArtist key={JSON.stringify([artist?.browseId, artist?.name])} artist={artist} />
          </>
        ) : open ? (
          <div className="npr-empty">
            <Music2 size={23} strokeWidth={1.5} aria-hidden="true" />
            <h2>Ничего не играет</h2>
            <p>Включите трек, чтобы увидеть обложку, очередь и сведения об исполнителе.</p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
