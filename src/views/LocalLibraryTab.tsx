import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ChevronLeft, ChevronRight, FolderOpen, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { TrackTable } from "../components/TrackTable";
import { LiquidWaveSpinner } from "../components/ui/liquid-spinner";
import { usePlayback } from "../player";
import type { LocalStatus, LocalTrackPage, MediaItem } from "../types";
import { localToItem } from "../ui/format";
import "./local-library.css";

const PAGE_SIZE = 100;
const QUEUE_BATCH = 256;
const QUEUE_CONCURRENCY = 4;
const FILTER_DELAY = 140;

interface SearchRequest {
  query: string;
  offset: number;
}

interface SearchResponse {
  request: SearchRequest;
  generation: number;
  page?: LocalTrackPage;
  error?: string;
}

interface Props {
  onOpen: (item: MediaItem) => void;
  onOpenLocalSettings: () => void;
}

export function LocalLibraryTab({ onOpen, onOpenLocalSettings }: Props) {
  const player = usePlayback();
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState("");
  const [request, setRequest] = useState<SearchRequest>({ query: "", offset: 0 });
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [queueState, setQueueState] = useState<{ total: number; error?: string } | null>(null);
  const playRequest = useRef(0);
  const header = useRef<HTMLDivElement>(null);
  const query = filter.trim();
  const generation = status?.generation;
  const hasTracks = Boolean(status?.total);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    void listen<{ done: boolean }>("local-scan", ({ payload }) => {
      if (active && payload.done) setRevision((value) => value + 1);
    }).then((dispose) => {
      if (active) unlisten = dispose;
      else return dispose();
    }).catch(() => undefined);
    return () => {
      active = false;
      ++playRequest.current;
      void Promise.resolve(unlisten?.()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let active = true;
    setStatusError(null);
    void api.localStatus().then((value) => {
      if (active) setStatus(value);
    }).catch((error) => {
      if (active) setStatusError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    if (query === request.query) return;
    if (query === "") {
      setRequest({ query, offset: 0 });
      return;
    }
    const timer = window.setTimeout(() => setRequest({ query, offset: 0 }), FILTER_DELAY);
    return () => window.clearTimeout(timer);
  }, [query, request.query]);

  useEffect(() => {
    if (generation === undefined || !hasTracks) return;
    let active = true;
    void api.localSearch(request.query, request.offset, PAGE_SIZE).then((page) => {
      if (!active) return;
      if (request.offset > 0 && page.total <= request.offset) {
        const offset = Math.max(0, Math.ceil(page.total / PAGE_SIZE) - 1) * PAGE_SIZE;
        setRequest({ ...request, offset });
      } else {
        setResponse({ request, generation, page });
      }
    }).catch((error) => {
      if (active) setResponse({ request, generation, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; };
  }, [generation, hasTracks, request]);

  const result = response?.request === request && response.generation === generation && query === request.query
    ? response : null;
  const page = result?.page;
  const items = useMemo(() => page?.items.map(localToItem) ?? [], [page]);
  const pageTotal = page?.total ?? (response?.generation === generation && response?.request.query === query
    ? response?.page?.total : undefined);

  const cancelQueue = () => {
    ++playRequest.current;
    setQueueState(null);
  };
  const changeFilter = (value: string) => {
    if (value.trim() !== query) cancelQueue();
    setFilter(value);
  };
  const goTo = (offset: number) => {
    if (!page) return;
    cancelQueue();
    setRequest({ ...request, offset });
    header.current?.scrollIntoView?.({ block: "nearest" });
  };

  const play = async (index: number) => {
    if (!page || !items[index]) return;
    const token = ++playRequest.current;
    if (items.length === page.total) {
      setQueueState(null);
      player.playItems(items, index);
      return;
    }

    setQueueState({ total: page.total });
    const queue = new Array<MediaItem>(page.total);
    const { offset } = request;
    const visibleEnd = offset + items.length;
    items.forEach((item, position) => { queue[offset + position] = item; });
    try {
      for (let cursor = 0; cursor < page.total;) {
        const batchRequests = [];
        while (cursor < page.total && batchRequests.length < QUEUE_CONCURRENCY) {
          if (cursor === offset) {
            cursor = visibleEnd;
            continue;
          }
          const start = cursor;
          const limit = Math.min(QUEUE_BATCH, (cursor < offset ? offset : page.total) - cursor);
          batchRequests.push(api.localSearch(request.query, start, limit, page.generation).then((batch) => {
            if (playRequest.current !== token) return;
            if (batch.generation !== page.generation || batch.total !== page.total || batch.items.length !== limit) {
              throw new Error("Локальная библиотека изменилась. Выберите трек ещё раз.");
            }
            batch.items.forEach((track, position) => { queue[start + position] = localToItem(track); });
          }));
          cursor += limit;
        }
        await Promise.all(batchRequests);
        if (playRequest.current !== token) return;
      }
      player.playItems(queue, offset + index);
      setQueueState(null);
    } catch (error) {
      if (playRequest.current === token) {
        ++playRequest.current;
        setQueueState({ total: page.total, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  if (statusError) {
    return (
      <div className="empty">
        <div className="empty-title">Не удалось загрузить библиотеку</div>
        <div className="empty-text" role="alert">{statusError}</div>
        <button className="ghost-button" onClick={() => setRevision((value) => value + 1)}>Попробовать снова</button>
      </div>
    );
  }
  if (!status) return <LiquidWaveSpinner size="md" words={["Сканируем папки…"]} />;
  if (!hasTracks) {
    return (
      <div className="empty">
        <FolderOpen size={26} strokeWidth={1.3} className="empty-glyph" />
        <div className="empty-title">Локальных треков пока нет</div>
        <div className="empty-text">
          {status.roots.length === 0
            ? "Добавьте папку с музыкой в настройках — приложение просканирует её и запомнит треки."
            : "Папки добавлены, но музыкальных файлов в них не нашлось."}
        </div>
        {status.roots.length === 0 ? (
          <button className="ghost-button" onClick={onOpenLocalSettings}>Настроить папки</button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="block-head local-tools" ref={header}>
        <h2>На этом компьютере</h2>
        <span className="block-count">
          {query ? (page ? `${page.total.toLocaleString("ru-RU")} из ${page.libraryTotal.toLocaleString("ru-RU")}` : "…")
            : (page?.libraryTotal ?? status.total).toLocaleString("ru-RU")}
        </span>
        <div className="local-filter-box">
          <Search size={16} aria-hidden />
          <input
            className="local-filter"
            value={filter}
            placeholder="Фильтр по локальным трекам"
            aria-label="Фильтр по названию, исполнителю или альбому"
            spellCheck={false}
            onChange={(event) => changeFilter(event.target.value)}
          />
          {filter ? (
            <button onClick={() => changeFilter("")} aria-label="Очистить фильтр"><X size={15} /></button>
          ) : null}
        </div>
      </div>
      {queueState ? (
        <div className="local-queue-status">
          {queueState.error ? <span role="alert">{queueState.error}</span>
            : <span role="status">Готовим очередь: {queueState.total.toLocaleString("ru-RU")} треков…</span>}
          <button className="ghost-button" onClick={cancelQueue}>{queueState.error ? "Закрыть" : "Отмена"}</button>
        </div>
      ) : null}
      {pageTotal !== undefined && pageTotal > PAGE_SIZE ? (
        <nav className="local-pages" aria-label="Страницы локальных треков" aria-busy={!page}>
          <span className="block-count" aria-live="polite">
            {(request.offset + 1).toLocaleString("ru-RU")}–{Math.min(request.offset + PAGE_SIZE, pageTotal).toLocaleString("ru-RU")} из {pageTotal.toLocaleString("ru-RU")}
          </span>
          <button className="ghost-button" disabled={request.offset === 0} aria-disabled={!page || request.offset === 0} onClick={() => goTo(request.offset - PAGE_SIZE)}>
            <ChevronLeft size={16} aria-hidden /> Назад
          </button>
          <button className="ghost-button" disabled={request.offset + PAGE_SIZE >= pageTotal} aria-disabled={!page || request.offset + PAGE_SIZE >= pageTotal} onClick={() => goTo(request.offset + PAGE_SIZE)}>
            Далее <ChevronRight size={16} aria-hidden />
          </button>
        </nav>
      ) : null}
      {!result ? <p className="local-page-loading field-hint" role="status">Загружаем треки…</p>
        : result.error ? (
          <div className="empty">
            <div className="empty-title">Не удалось загрузить треки</div>
            <div className="empty-text" role="alert">{result.error}</div>
            <button className="ghost-button" onClick={() => setRequest((value) => ({ ...value }))}>Попробовать снова</button>
          </div>
        ) : !page || page.total === 0 ? (
          <div className="empty">
            <div className="empty-title">Ничего не нашлось</div>
            <div className="empty-text">Попробуйте другой запрос.</div>
          </div>
        ) : (
          <TrackTable
            items={items}
            currentVideoId={player.current?.videoId ?? null}
            isPlaying={player.playing}
            onPlay={(index) => void play(index)}
            onOpen={onOpen}
          />
        )}
    </>
  );
}
