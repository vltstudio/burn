import { Play, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../api";
import { MediaCard } from "../components/MediaCard";
import { Shelf } from "../components/Shelf";
import { LiquidWaveSpinner } from "../components/ui/liquid-spinner";
import { usePlayback } from "../player";
import type { MediaItem, SearchFilter, SearchResults } from "../types";
import { Cover, TrackCover } from "../ui/cover";
import { bigThumb, groupByKind, kindSections } from "../ui/format";
import { youtubeVideoId } from "../ui/youtube-link";
import { ArtistNames } from "../ui/artist-links";

const FILTERS: Array<{ value: SearchFilter; label: string }> = [
  { value: "all", label: "Всё" },
  { value: "songs", label: "Треки" },
  { value: "albums", label: "Альбомы" },
  { value: "artists", label: "Исполнители" },
  { value: "playlists", label: "Плейлисты" },
  { value: "videos", label: "Видео" },
];

const HISTORY_KEY = "ytmusicdt.searchHistory";
const HISTORY_LIMIT = 8;

function readHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberQuery(term: string) {
  const next = [term, ...readHistory().filter((item) => item !== term)].slice(0, HISTORY_LIMIT);
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {}
}

interface Props {
  query: string;
  filter: SearchFilter;
  onFilterChange: (filter: SearchFilter) => void;
  onOpen: (item: MediaItem) => void;
}

export function SearchView({ query, filter, onFilterChange, onOpen }: Props) {
  const player = usePlayback();
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);
  const moreRequestRef = useRef<number | null>(null);
  const term = query.trim();
  const videoId = youtubeVideoId(term);

  const runSearch = useCallback(
    (value: string, activeFilter: SearchFilter, id: string | null, token: number) => {
      setLoading(true);
      setResults(null);
      setError(null);
      setLoadingMore(false);
      setMoreError(null);
      moreRequestRef.current = null;
      const request = id
        ? api.watchTrack(id).then((track) => ({ top: track, items: [], continuation: null }))
        : api.search(value, activeFilter === "all" ? null : activeFilter);
      request
        .then((data) => {
          if (requestRef.current === token) {
            setResults(data);
            if (!id) rememberQuery(value);
          }
        })
        .catch((failure) => {
          if (requestRef.current === token) {
            setResults(null);
            setError(failure instanceof ApiFailure ? failure.message : String(failure));
          }
        })
        .finally(() => {
          if (requestRef.current === token) setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    const token = ++requestRef.current;
    if (!term) {
      setResults(null);
      setError(null);
      setMoreError(null);
      setLoading(false);
      setLoadingMore(false);
      moreRequestRef.current = null;
    } else {
      runSearch(term, filter, videoId, token);
    }
    return () => { ++requestRef.current; };
  }, [term, filter, videoId, runSearch, reloadKey]);

  const loadMore = useCallback(async () => {
    if (videoId || !results?.continuation || moreRequestRef.current !== null) return;
    const token = requestRef.current;
    const continuation = results.continuation;
    moreRequestRef.current = token;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.searchMore(
        continuation,
        term,
        filter === "all" ? null : filter,
      );
      if (token !== requestRef.current) return;
      setResults((current) =>
        current && current.continuation === continuation
          ? {
              ...current,
              items: [...current.items, ...page.items],
              continuation: page.continuation,
            }
          : current,
      );
    } catch (failure) {
      if (token === requestRef.current) {
        setMoreError(failure instanceof ApiFailure ? failure.message : String(failure));
      }
    } finally {
      if (token === requestRef.current) {
        moreRequestRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [filter, results?.continuation, term, videoId]);

  const groups = results ? groupByKind(results.items) : [];
  const top = results?.top ?? null;

  return (
    <div className="view search-view">
      {!videoId ? <div className="chips" role="group" aria-label="Фильтры поиска">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            className={`chip ${filter === option.value ? "active" : ""}`}
            aria-pressed={filter === option.value}
            onClick={() => onFilterChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div> : null}

      {!term ? (
        <div className="empty">
          <Search size={23} strokeWidth={1.4} className="empty-glyph" />
          <div className="empty-title">Что послушаем?</div>
          <div className="empty-text">Введите название или вставьте ссылку на трек.</div>
        </div>
      ) : loading ? (
        <LiquidWaveSpinner
          size="md"
          words={videoId ? ["Открываем трек…"] : ["Ищем музыку…", "Просматриваем результаты…"]}
        />
      ) : error ? (
        <div className="empty">
          <div className="empty-title">{videoId ? "Не удалось открыть ссылку" : "Поиск не удался"}</div>
          <div className="empty-text">{error}</div>
          <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)}>
            Попробовать снова
          </button>
        </div>
      ) : results && results.items.length === 0 && !top ? (
        <div className="empty">
          <div className="empty-title">Ничего не нашлось</div>
          <div className="empty-text">Попробуйте другую формулировку или другой фильтр.</div>
        </div>
      ) : (
        <>
          {top ? (
            <div
              className={videoId ? "top-result link-result" : "top-result"}
            >
              <button
                className="top-result-open"
                aria-label={`${top.videoId && ["song", "video", "episode"].includes(top.kind) ? "Слушать" : "Открыть"}: ${top.title}`}
                onClick={() => {
                  if (top.videoId && ["song", "video", "episode"].includes(top.kind)) {
                    player.playItems([top], 0);
                  } else onOpen(top);
                }}
              />
              {videoId ? <TrackCover item={top} className="top-result-cover" /> : (
                <Cover
                  className={`top-result-cover ${top.kind === "artist" ? "round" : ""}`}
                  src={bigThumb(top)}
                />
              )}
              <div className="top-result-text">
                <div className="top-result-kind">{videoId ? "Трек по ссылке" : "Лучший результат"}</div>
                <div className="top-result-title">{top.title}</div>
                <div className="top-result-sub">
                  {top.artists.length > 0 ? top.artists.map((artist, index) => (
                    <span key={`${artist.browseId}-${index}`}>
                      {artist.browseId ? <ArtistNames artists={[artist]} fallback={artist.name} /> : artist.name}
                      {index < top.artists.length - 1 ? ", " : null}
                    </span>
                  )) : top.subtitle}
                </div>
              </div>
              {videoId ? <Play className="link-result-play" size={18} fill="currentColor" aria-hidden /> : null}
            </div>
          ) : null}

          {groups.map((group) => {
            const isTrackGroup =
              group.kind === "song" || group.kind === "video" || group.kind === "episode";
            return (
              <section className="block" key={group.kind}>
                <div className="block-head">
                  <h2>{kindSections[group.kind] ?? "Результаты"}</h2>
                  <span className="block-count">{group.items.length}</span>
                </div>
                {isTrackGroup ? (
                  <Shelf
                    section={{
                      title: null,
                      layout: "list",
                      items: group.items,
                      continuation: null,
                    }}
                    currentVideoId={player.current?.videoId ?? null}
                    isPlaying={player.playing}
                    onPlayList={player.playItems}
                    onPlay={(item) => player.playItems([item], 0)}
                    onOpen={onOpen}
                    showAlbum
                  />
                ) : (
                  <div className="grid">
                    {group.items.map((item, index) => (
                      <MediaCard
                        key={`${item.browseId ?? item.title}-${index}`}
                        item={item}
                        onOpen={onOpen}
                        onPlay={() => player.playItems([item], 0)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          {results?.continuation ? (
            <div className="load-more">
              {moreError ? <div className="load-error" role="alert">{moreError}</div> : null}
              <button className="ghost-button" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Загружаем…" : moreError ? "Попробовать снова" : "Показать ещё"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
