import { ArrowLeft, Heart, Play, Shuffle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure } from "../api";
import { useBackdrop } from "../backdrop";
import { LiquidWaveSpinner } from "../components/ui/liquid-spinner";
import { Shelf } from "../components/Shelf";
import { useLibrary } from "../library";
import { usePlayback } from "../player";
import type { Detail, ItemKind, MediaItem } from "../types";
import { Cover } from "../ui/cover";
import { favoriteKey, kindLabels } from "../ui/format";
import { ArtistNames } from "../ui/artist-links";
import { LikedPlaylistCover } from "../components/LikedPlaylist";

interface Props {
  browseId: string;
  fallbackTitle: string;
  onOpen: (item: MediaItem) => void;
  onBack: () => void;
}

export function DetailView({ browseId, fallbackTitle, onOpen, onBack }: Props) {
  const player = usePlayback();
  const { favoriteIds, toggleFavorite } = useLibrary();
  const { setBackdrop } = useBackdrop();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<Set<number>>(new Set());
  const [moreErrors, setMoreErrors] = useState<Record<number, string | null>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
  const moreRequests = useRef(new Set<number>());

  useEffect(() => {
    const token = ++requestRef.current;
    setDetail(null);
    setError(null);
    setLoadingMore(new Set());
    setMoreErrors({});
    moreRequests.current.clear();
    api
      .browse(browseId)
      .then((data) => {
        if (requestRef.current === token) setDetail(data);
      })
      .catch((failure) => {
        if (requestRef.current === token) setError(failure instanceof ApiFailure ? failure.message : String(failure));
      });
    return () => {
      ++requestRef.current;
    };
  }, [browseId, reloadKey]);

  useEffect(() => {
    const thumbs = detail?.header.thumbs ?? [];
    setBackdrop(thumbs[thumbs.length - 1] ?? thumbs[0] ?? null);
    return () => setBackdrop(null);
  }, [detail, setBackdrop]);

  const sections = useMemo(() => {
    if (!detail) return [];
    const { header, sections } = detail;
    if (header.kind !== "album" || !header.thumbs.length) return sections;
    return sections.map((section) => section.layout === "list"
      ? {
          ...section,
          items: section.items.map((item) => item.videoId && !item.thumbs.length
            ? { ...item, thumbs: header.thumbs }
            : item),
        }
      : section);
  }, [detail]);

  const loadMore = useCallback(async (index: number, continuation: string) => {
    if (!continuation || moreRequests.current.has(index)) return;
    const token = requestRef.current;
    moreRequests.current.add(index);
    setLoadingMore(new Set(moreRequests.current));
    setMoreErrors((current) => ({ ...current, [index]: null }));
    try {
      const page = await api.browseMore(continuation);
      if (requestRef.current !== token) return;
      setDetail((current) =>
        current
          ? {
              ...current,
              sections: current.sections.map((section, sectionIndex) =>
                sectionIndex === index && section.continuation === continuation
                  ? {
                      ...section,
                      items: [...section.items, ...page.items],
                      continuation: page.continuation,
                    }
                  : section,
              ),
            }
          : current,
      );
    } catch (failure) {
      if (requestRef.current === token) {
        setMoreErrors((current) => ({ ...current, [index]: failure instanceof ApiFailure ? failure.message : String(failure) }));
      }
    } finally {
      if (requestRef.current === token) {
        moreRequests.current.delete(index);
        setLoadingMore(new Set(moreRequests.current));
      }
    }
  }, []);

  const back = (
    <button className="back-link" onClick={onBack}>
      <ArrowLeft size={14} strokeWidth={1.8} /> Назад
    </button>
  );

  if (error) {
    return (
      <div className="view">
        {back}
        <div className="empty">
          <div className="empty-title">Не удалось открыть страницу</div>
          <div className="empty-text">{error}</div>
          <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)}>
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="view">
        {back}
        <LiquidWaveSpinner
          size="md"
          words={[`Загружаем ${fallbackTitle}…`, "Собираем треки…", "Почти готово…"]}
        />
      </div>
    );
  }

  const header = detail.header;
  const kind = (header.kind === "unknown" ? "album" : header.kind) as ItemKind;
  const cover = header.thumbs[header.thumbs.length - 1] ?? header.thumbs[0] ?? "";
  const firstTracks = sections.find((section) =>
    section.layout === "list" && section.items.some((item) => item.videoId),
  )?.items.filter((item) => item.videoId) ?? [];
  const isLikedPage = browseId === "VLLM";
  const showAlbumColumn = kind !== "album";
  const heroItem = firstTracks[0] ?? null;
  const heroFavoriteId = heroItem ? favoriteKey(heroItem) : null;
  const heroLiked = heroFavoriteId !== null && favoriteIds.has(heroFavoriteId);

  return (
    <div className="view detail">
      {back}

      <div className={`detail-top ${isLikedPage ? "likes-playlist-top" : ""}`}>
        {isLikedPage ? <LikedPlaylistCover variant="youtube" className="hero-cover" /> : <Cover
          key={cover}
          className={`hero-cover ${kind === "artist" ? "round" : ""}`}
          src={cover}
        />}

        <div className="hero-info">
          <div className="hero-kind">{isLikedPage ? "Плейлист" : kindLabels[kind] ?? "Раздел"}</div>
          <h1 className="hero-title">{browseId === "VLLM" ? "Любимые треки YouTube" : header.title || fallbackTitle}</h1>
          <div className="hero-meta">
            {header.artists.map((artist, index) => (
              <span key={`${artist.browseId}-${index}`}>
                {artist.browseId ? <ArtistNames artists={[artist]} fallback={artist.name} /> : artist.name}
                {index < header.artists.length - 1 ? <span className="sep">, </span> : null}
              </span>
            ))}
            {header.year ? (
              <>
                {header.artists.length > 0 ? <span className="sep">·</span> : null}
                <span>{header.year}</span>
              </>
            ) : null}
            {header.meta ? (
              <>
                {header.artists.length > 0 || header.year ? <span className="sep">·</span> : null}
                <span>{header.meta}</span>
              </>
            ) : null}
          </div>

          <div className="hero-actions">
            <button
              className="solid-button"
              disabled={firstTracks.length === 0}
              onClick={() => player.playItems(firstTracks, 0)}
            >
              <Play size={13} fill="currentColor" /> Слушать
            </button>
            <button
              className="round-button"
              disabled={firstTracks.length === 0}
              title="Перемешать"
              aria-label="Перемешать"
              onClick={() => {
                const shuffled = [...firstTracks].sort(() => Math.random() - 0.5);
                player.playItems(shuffled, 0);
              }}
            >
              <Shuffle size={15} strokeWidth={1.7} />
            </button>
            {heroItem ? (
              <button
                className={`round-button ${heroLiked ? "active" : ""}`}
                title={heroLiked ? "Убрать из избранного" : "В избранное"}
                aria-label={heroLiked ? "Убрать из избранного" : "В избранное"}
                aria-pressed={heroLiked}
                onClick={() => toggleFavorite(heroItem)}
              >
                <Heart size={14} strokeWidth={1.8} fill={heroLiked ? "currentColor" : "none"} />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {header.description ? <p className="hero-description">{header.description}</p> : null}

      {sections.map((section, index) => {
        if (section.items.length === 0 && !section.continuation) return null;
        return (
          <section className="block" key={`${section.title ?? "section"}-${index}`}>
            {section.title ? (
              <div className="block-head">
                <h2>{section.title}</h2>
              </div>
            ) : null}
            <Shelf
              section={section}
              currentVideoId={player.current?.videoId ?? null}
              isPlaying={player.playing}
              onPlayList={player.playItems}
              onPlay={(item) => player.playItems([item], 0)}
              onOpen={onOpen}
              showAlbum={showAlbumColumn}
              onLoadMore={
                section.continuation
                  ? () => void loadMore(index, section.continuation ?? "")
                  : undefined
              }
              loadingMore={loadingMore.has(index)}
              loadMoreError={moreErrors[index]}
            />
          </section>
        );
      })}
    </div>
  );
}
