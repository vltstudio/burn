import {
  ArrowUpRight, ChevronUp, Heart, LoaderCircle, Music2, Pause, Play, Plus, Repeat, Repeat1,
  Search, Shuffle, SkipBack, SkipForward, Volume2, VolumeX, X,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import burnIcon from "../../assets/icon.png";
import { api } from "../api";
import { applyPalette } from "../theme";
import { QUICK_STATE, QUICK_VISIBILITY, QUICK_WINDOW, quickRequest, quickWindow, subscribeQuick, type QuickPlacement, type QuickRequest, type QuickState } from "../quick-player";
import type { MediaItem } from "../types";
import { TrackCover } from "../ui/cover";
import { formatTime, localToItem } from "../ui/format";
import "./quick-player.css";

const blank: QuickState = {
  current: null, playing: false, loading: false, progress: 0, duration: 0,
  volume: 0.85, muted: false, shuffle: false, repeat: "off", favorite: false,
};

type Source = "youtube" | "local";

export default function QuickPlayer() {
  const [placement, setPlacement] = useState<QuickPlacement | null>(null);
  const [state, setState] = useState(blank);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>("youtube");
  const [search, setSearch] = useState<{ key: string; items: MediaItem[]; error?: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [seek, setSeek] = useState<number | null>(null);
  const dragging = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const windowAction = useRef(0);
  const expandedRef = useRef(false);

  useEffect(() => { applyPalette(state.palette); }, [state.palette]);

  useEffect(() => {
    let active = true;
    let visibilityReceived = false;
    const snapshot = () => void quickRequest({ action: "snapshot" }).catch(() => undefined);
    const states = subscribeQuick<QuickState>(QUICK_WINDOW, QUICK_STATE, setState);
    const visibility = subscribeQuick<QuickPlacement | null>(QUICK_WINDOW, QUICK_VISIBILITY, (next) => {
      visibilityReceived = true;
      ++windowAction.current;
      setPlacement(next);
      expandedRef.current = false;
      setExpanded(false);
      setSeek(null);
      setNotice("");
      setQuery("");
      setSearch(null);
      if (next) void states.ready.then(snapshot, () => undefined);
    });
    void Promise.all([states.ready, visibility.ready]).then(async () => {
      const next = await quickWindow("status");
      if (active && !visibilityReceived && next) {
        setPlacement(next);
        snapshot();
      }
    }).catch(() => undefined);
    return () => {
      active = false;
      states.dispose();
      visibility.dispose();
      window.clearTimeout(timer.current);
    };
  }, []);

  const openSearch = (next: boolean) => {
    const request = ++windowAction.current;
    expandedRef.current = next;
    if (!next) {
      setExpanded(false);
      searchButton.current?.focus();
    }
    void quickWindow(next ? "expand" : "compact").then((geometry) => {
      if (request !== windowAction.current || !geometry) return;
      setPlacement(geometry);
      setExpanded(next);
    }).catch(() => setNotice("Не удалось изменить размер окна."));
  };

  useEffect(() => {
    if (expanded) input.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (!placement) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (expandedRef.current) openSearch(false);
        else void quickWindow("hide").catch(() => undefined);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [placement]);

  const term = query.trim();
  const searchKey = `${source}:${term}`;
  useEffect(() => {
    if (!expanded || !term) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      const lookup = source === "local"
        ? api.localSearch(term, 0, 7).then(({ items }) => items.map(localToItem))
        : api.search(term, "songs").then(({ top, items }) => {
          const seen = new Set<string>();
          return [top, ...items].filter((item): item is MediaItem => {
            if (!item?.videoId || !["song", "video"].includes(item.kind) || seen.has(item.videoId)) return false;
            seen.add(item.videoId);
            return true;
          }).slice(0, 7);
        });
      void lookup.then((items) => {
        if (active) setSearch({ key: searchKey, items });
      }).catch(() => {
        if (active) setSearch({ key: searchKey, items: [], error: true });
      });
    }, 230);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [expanded, searchKey, source, term]);

  const send = (request: QuickRequest) => void quickRequest(request).catch(() => setNotice("Нет связи с плеером."));
  // The pressed position outlives the gesture: the main player answers one
  // round trip later, and dropping it on release snapped the thumb back to the
  // old position and forward again.
  useEffect(() => {
    if (seek === null || dragging.current) return;
    if (Math.abs(state.progress - seek) < 1) setSeek(null);
  }, [seek, state.progress]);

  useEffect(() => {
    if (seek === null) return;
    const timeout = window.setTimeout(() => setSeek(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [seek]);

  const current = state.current;
  const activeSearch = search?.key === searchKey ? search : null;
  const progress = Math.max(0, Math.min(state.duration, seek ?? state.progress));
  const volume = state.muted ? 0 : state.volume;
  const controlLabel = state.loading ? "Отменить загрузку" : state.playing ? "Пауза" : "Играть";
  const repeatLabel = state.repeat === "one" ? "Повтор трека" : state.repeat === "all" ? "Повтор очереди" : "Повтор выключен";
  const add = (item: MediaItem) => {
    window.clearTimeout(timer.current);
    void quickRequest({ action: "enqueue", item }).then(() => {
      setNotice(`В очереди: ${item.title}`);
      timer.current = window.setTimeout(() => setNotice(""), 2300);
    }).catch(() => setNotice("Не удалось добавить трек."));
  };

  if (!placement) return null;

  return (
    <main
      className="quick-frame"
      data-edge={placement.edge}
      style={{ "--quick-anchor": `${placement.arrow}%` } as CSSProperties}
      aria-label="Быстрый плеер BURN"
    >
      <span className="quick-tail" aria-hidden />
      <section className="quick-sheet">
        <div className="quick-header">
          <span className="quick-brand"><img src={burnIcon} width="16" height="16" alt="" /> BURN</span>
          <button ref={searchButton} className="quick-icon" aria-label={expanded ? "Свернуть поиск" : "Найти трек"} aria-expanded={expanded} onClick={() => openSearch(!expanded)}>
            {expanded ? <ChevronUp size={16} /> : <Search size={16} />}
          </button>
          <button className="quick-icon" aria-label="Открыть BURN" onClick={() => void quickWindow("open_main").catch(() => undefined)}>
            <ArrowUpRight size={17} />
          </button>
          <button className="quick-icon" aria-label="Закрыть мини-плеер" onClick={() => void quickWindow("hide").catch(() => undefined)}>
            <X size={16} />
          </button>
        </div>

        <div className="quick-current">
          {current ? <TrackCover item={current} className="quick-cover" eager /> : <span className="quick-cover quick-cover-empty"><Music2 size={23} /></span>}
          <div className="quick-metadata">
            <strong title={current?.title}>{current?.title ?? "Ничего не играет"}</strong>
            <span title={current?.subtitle}>{current?.subtitle || "Найди трек, чтобы начать"}</span>
          </div>
          <button className="quick-icon quick-heart" disabled={!current} aria-label="Избранное" aria-pressed={state.favorite} onClick={() => send({ action: "favorite" })}>
            <Heart size={18} fill={state.favorite ? "currentColor" : "none"} />
          </button>
        </div>

        <div className="quick-timeline">
          <span>{formatTime(progress)}</span>
          <input
            type="range" min="0" max={state.duration || 1} step=".1" value={progress}
            aria-label="Перемотка" aria-valuetext={formatTime(progress)}
            style={{ "--quick-fill": `${state.duration ? 100 * progress / state.duration : 0}%` } as CSSProperties}
            disabled={!state.duration}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              setSeek(value);
              send({ action: "seek", value });
            }}
            onPointerDown={(event) => {
              if (!state.duration) return;
              dragging.current = true;
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerUp={(event) => {
              dragging.current = false;
              if (state.duration) send({ action: "seek", value: Number(event.currentTarget.value) });
            }}
            onPointerCancel={() => { dragging.current = false; }}
            onLostPointerCapture={() => { dragging.current = false; }}
          />
          <span>{formatTime(state.duration)}</span>
        </div>

        <div className="quick-controls">
          <button className="quick-icon" disabled={!current} aria-label="Перемешать" aria-pressed={state.shuffle} onClick={() => send({ action: "shuffle" })}><Shuffle size={15} /></button>
          <button className="quick-icon" disabled={!current} aria-label="Предыдущий трек" onClick={() => send({ action: "previous" })}><SkipBack size={17} fill="currentColor" /></button>
          <button className="quick-icon quick-play" disabled={!current} aria-label={controlLabel} onClick={() => send({ action: "toggle" })}>
            {state.loading ? <LoaderCircle className="quick-spin" size={19} /> : state.playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
          </button>
          <button className="quick-icon" disabled={!current} aria-label="Следующий трек" onClick={() => send({ action: "next" })}><SkipForward size={17} fill="currentColor" /></button>
          <button className="quick-icon" disabled={!current} aria-label={repeatLabel} aria-pressed={state.repeat !== "off"} onClick={() => send({ action: "repeat" })}>
            {state.repeat === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
          </button>
          <div className="quick-volume">
            <button className="quick-icon" aria-label={state.muted ? "Включить звук" : "Выключить звук"} onClick={() => send({ action: "mute" })}>
              {state.muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <input type="range" min="0" max="1" step=".01" value={volume} aria-label="Громкость"
              style={{ "--quick-fill": `${volume * 100}%` } as CSSProperties}
              onChange={(event) => send({ action: "volume", value: Number(event.currentTarget.value) })}
            />
          </div>
        </div>

        {expanded ? (
          <section className="quick-search" aria-label="Поиск треков">
            <label className="quick-input">
              <Search size={15} aria-hidden />
              <input ref={input} value={query} maxLength={160} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Название или исполнитель" aria-label="Название или исполнитель" />
              {query ? <button className="quick-icon" aria-label="Очистить поиск" onClick={() => { setQuery(""); input.current?.focus(); }}><X size={14} /></button> : null}
            </label>
            <div className="quick-sources" role="group" aria-label="Где искать">
              <button aria-pressed={source === "youtube"} onClick={() => setSource("youtube")}>YouTube Music</button>
              <button aria-pressed={source === "local"} onClick={() => setSource("local")}>На компьютере</button>
            </div>
            <div className="quick-results" aria-busy={Boolean(term && !activeSearch)}>
              {!term ? <p className="quick-empty">Введи название трека или имя исполнителя.</p>
                : !activeSearch ? <p className="quick-empty" role="status">Ищем треки…</p>
                : activeSearch.error ? <p className="quick-empty" role="alert">Поиск сейчас недоступен.</p>
                : activeSearch.items.length === 0 ? <p className="quick-empty">Ничего не нашлось.</p>
                : activeSearch.items.map((item) => (
                  <div className="quick-result" key={item.videoId}>
                    <button onClick={() => send({ action: "play", item })} aria-label={`Играть: ${item.title}`}>
                      <TrackCover item={item} className="quick-result-cover" />
                      <span><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                      <span className="quick-result-time">{item.duration}</span>
                    </button>
                    <button className="quick-icon" aria-label={`В очередь: ${item.title}`} onClick={() => add(item)}><Plus size={16} /></button>
                  </div>
                ))}
            </div>
          </section>
        ) : null}
        <div className="quick-feedback" role="status" hidden={!notice}>{notice}</div>
      </section>
    </main>
  );
}
