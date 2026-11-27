import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown, ChevronLeft, ChevronRight, ListMusic, Maximize, Mic2, Minimize, Pause, Play,
  Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Video, Volume2, VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePlayer, type ClipAudioHandoff } from "../player";
import type { MediaItem } from "../types";
import { TrackCover } from "../ui/cover";
import { ArtistNames } from "../ui/artist-links";
import { formatTime } from "../ui/format";
import { Slider } from "../ui/slider";
import { KaraokeLyrics } from "./KaraokeLyrics";
import { ClipMode } from "./ClipMode";
import { WindowControls } from "./WindowControls";
import { useFullPlayerArtwork } from "./useFullPlayerArtwork";
import "./full-player.css";

type Pane = "meta" | "queue" | "lyrics";

const queuePageSize = 60;

type FullscreenSession = {
  mounted: boolean;
  busy: boolean;
  restore?: () => Promise<void>;
};

export function FullPlayer({ current, onClose }: { current: MediaItem; onClose: () => void }) {
  const player = usePlayer();
  const { playing, loading, progress, duration, shuffle, repeat, muted, volume, queue, index } = player;
  const artwork = useFullPlayerArtwork(current);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fullscreenSession = useRef<FullscreenSession>(null);
  const [pane, setPane] = useState<Pane>("meta");
  const [clipTarget, setClipTarget] = useState<{ key: string; audio: ClipAudioHandoff } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const clipId = current.localPath || current.source === "local" || current.kind === "episode" ? null : current.videoId;
  const clipKey = clipId ? `${index}:${clipId}` : null;
  const clipSession = clipTarget?.key === clipKey && clipTarget.audio.snapshot() ? clipTarget : null;
  const clipActive = clipSession !== null;
  const closeClip = useCallback(() => setClipTarget(null), []);
  const fullscreenTitle = fullscreen ? "Выйти из полноэкранного режима" : "На весь экран";
  const next = queue[player.upNext[0]];
  const artistName = current.artists[0]?.name ?? current.subtitle;
  const repeatTitle = repeat === "one" ? "Повтор трека" : repeat === "all" ? "Повтор очереди" : "Повтор выключен";
  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const session: FullscreenSession = { mounted: true, busy: false };
    fullscreenSession.current = session;
    const sync = async () => {
      try {
        const active = isTauri() ? await getCurrentWindow().isFullscreen() : Boolean(document.fullscreenElement);
        if (!session.mounted || session.busy) return;
        if (!active) session.restore = undefined;
        setFullscreen(active);
      } catch {
        return;
      }
    };
    void sync();
    window.addEventListener("resize", sync);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      session.mounted = false;
      window.removeEventListener("resize", sync);
      document.removeEventListener("fullscreenchange", sync);
      dialog?.close();
      if (!session.busy) void session.restore?.().catch(() => undefined);
    };
  }, []);

  const toggleFullscreen = async () => {
    const session = fullscreenSession.current;
    if (!session?.mounted || session.busy) return;
    session.busy = true;
    try {
      const native = isTauri() ? getCurrentWindow() : null;
      const active = native ? await native.isFullscreen() : Boolean(document.fullscreenElement);
      if (!session.mounted) return;
      if (native) {
        await native.setFullscreen(!active);
        session.restore = active ? undefined : () => native.setFullscreen(false);
      } else if (active) {
        await document.exitFullscreen();
        session.restore = undefined;
      } else {
        const root = document.documentElement;
        await root.requestFullscreen();
        session.restore = async () => {
          if (document.fullscreenElement === root) await document.exitFullscreen();
        };
      }
      if (session.mounted) setFullscreen(!active);
    } catch {
      return;
    } finally {
      session.busy = false;
      if (!session.mounted) void session.restore?.().catch(() => undefined);
    }
  };

  useEffect(() => {
    if (!clipSession) setClipTarget(null);
  }, [clipSession]);

  return (
    <dialog
      ref={dialogRef}
      className="full-player"
      style={artwork.style}
      aria-labelledby="fp-heading"
      data-tauri-drag-region
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <WindowControls />
      <div className="fp-artwork" aria-hidden onLoadCapture={artwork.onLoad}>
        <TrackCover item={current} large eager />
      </div>
      <div className="fp-shell" data-tauri-drag-region>
        <header className="fp-head" data-tauri-drag-region>
          <button className="fp-collapse" aria-label="Свернуть плеер" onClick={close} autoFocus>
            <ChevronDown size={20} /> <span>Свернуть</span>
          </button>
          <p className="fp-kicker" id="fp-heading" data-tauri-drag-region>{clipActive ? "Видео" : "Сейчас играет"}</p>
          <div className="fp-head-actions" data-tauri-drag-region>
            <button
              className={`fp-queue-toggle ${pane === "queue" ? "active" : ""}`}
              aria-label="Очередь"
              aria-pressed={!clipActive && pane === "queue"}
              onClick={() => {
                setClipTarget(null);
                setPane((previous) => !clipActive && previous === "queue" ? "meta" : "queue");
              }}
            >
              <ListMusic size={18} /> <span>Очередь</span>
            </button>
            <button
              className={`fp-queue-toggle ${pane === "lyrics" ? "active" : ""}`}
              aria-label="Текст песни"
              aria-pressed={!clipActive && pane === "lyrics"}
              onClick={() => {
                setClipTarget(null);
                setPane((previous) => !clipActive && previous === "lyrics" ? "meta" : "lyrics");
              }}
            >
              <Mic2 size={18} /> <span>Текст</span>
            </button>
            {clipId ? (
              <button
                className={`fp-queue-toggle ${clipActive ? "active" : ""}`}
                aria-label={clipActive ? "Закрыть клип" : "Клип"}
                aria-pressed={clipActive}
                title={clipActive ? "Вернуться к музыке" : "Найти клип на YouTube"}
                onClick={() => setClipTarget(clipActive || !clipKey ? null : { key: clipKey, audio: player.createClipHandoff() })}
              >
                <Video size={18} /> <span>Клип</span>
              </button>
            ) : null}
            {isTauri() || document.fullscreenEnabled ? (
              <button
                className={`fp-queue-toggle fp-fullscreen-toggle ${fullscreen ? "active" : ""}`}
                aria-label={fullscreenTitle}
                title={fullscreenTitle}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
              </button>
            ) : null}
          </div>
        </header>

        {clipSession && clipId ? (
          <div className="fp-stage fp-stage--clip">
            <ClipMode videoId={clipId} title={current.title} kind={current.kind} audio={clipSession.audio} onClose={closeClip} />
          </div>
        ) : (
        <div className={`fp-stage ${pane !== "meta" ? "fp-stage--split" : ""}`}>
          <div className="fp-now">
            <div className="fp-art">
              <TrackCover item={current} large eager className="fp-cover" alt={`Обложка: ${current.title}`} />
            </div>
            <div className="fp-meta">
              <h2 className="fp-title" title={current.title}>{current.title}</h2>
              <p className="fp-sub" title={current.subtitle}>
                <ArtistNames artists={current.artists} fallback={current.subtitle} onNavigate={close} />
              </p>
            </div>
          </div>
          {pane === "queue" ? <QueuePane queue={queue} index={index} onJump={player.jumpTo} /> : null}
          {pane === "lyrics" ? (
            <KaraokeLyrics
              key={JSON.stringify([current.videoId, current.localPath, current.title, artistName, current.album?.name, current.duration])}
              current={current}
              artistName={artistName}
              progress={progress}
              onSeek={player.seek}
            />
          ) : null}
        </div>
        )}

        {!clipActive ? <footer className="fp-footer">
          <div className="fp-seek">
            <span>{formatTime(progress)}</span>
            <Slider value={progress} max={duration} onChange={player.seek} ariaLabel="Позиция трека" />
            <span>{formatTime(duration)}</span>
          </div>
          <div className="fp-footer-actions">
              <div className="fp-controls">
                <button
                  className={`ctl ${shuffle ? "active" : ""}`}
                  onClick={player.toggleShuffle}
                  aria-label="Перемешивание"
                  aria-pressed={shuffle}
                  title="Перемешивание"
                >
                  <Shuffle size={19} />
                </button>
                <button className="ctl" onClick={player.previous} aria-label="Предыдущий" title="Предыдущий">
                  <SkipBack size={22} fill="currentColor" />
                </button>
                <button
                  className="ctl play fp-play"
                  onClick={player.toggle}
                  aria-label={loading ? "Отменить загрузку" : playing ? "Пауза" : "Играть"}
                  title={loading ? "Отменить загрузку" : playing ? "Пауза" : "Играть"}
                >
                  {loading ? <span className="spinner" /> : playing
                    ? <Pause size={25} fill="currentColor" />
                    : <Play size={25} fill="currentColor" />}
                </button>
                <button className="ctl" onClick={player.next} aria-label="Следующий" title="Следующий">
                  <SkipForward size={22} fill="currentColor" />
                </button>
                <button
                  className={`ctl ${repeat !== "off" ? "active" : ""}`}
                  onClick={player.cycleRepeat}
                  aria-label={repeatTitle}
                  title={repeatTitle}
                >
                  {repeat === "one" ? <Repeat1 size={19} /> : <Repeat size={19} />}
                </button>
              </div>
            {pane === "meta" && next ? (
              <button className="fp-next" onClick={player.next} title={next.title}>
                <TrackCover item={next} className="fp-mini-cover" />
                <span className="fp-queue-text"><span>Далее</span><strong>{next.title}</strong></span>
                <SkipForward size={15} />
              </button>
            ) : null}
            <div className="fp-volume">
              <button className="ctl small" onClick={player.toggleMute} aria-label={muted ? "Включить звук" : "Выключить звук"}>
                {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <input
                aria-label="Громкость"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(event) => player.setVolume(Number(event.target.value))}
              />
            </div>
          </div>
        </footer> : null}
      </div>
    </dialog>
  );
}

function QueuePane({ queue, index, onJump }: { queue: MediaItem[]; index: number; onJump: (index: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<{ index: number; start: number }>();
  const maxStart = Math.max(0, queue.length - queuePageSize);
  const start = page?.index === index
    ? Math.min(page.start, maxStart)
    : Math.min(Math.max(0, index - Math.floor(queuePageSize / 2)), maxStart);
  const end = Math.min(start + queuePageSize, queue.length);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = activeRowRef.current;
    list.scrollTop = active ? active.offsetTop - (list.clientHeight - active.offsetHeight) / 2 : 0;
  }, [index, start]);

  return (
    <section className="fp-queue" aria-labelledby="fp-queue-heading">
      <div className="fp-queue-head">
        <h2 id="fp-queue-heading">Очередь</h2>
        {queue.length > queuePageSize ? (
          <div className="fp-queue-page">
            <span aria-live="polite">{start + 1}–{end} из {queue.length.toLocaleString("ru-RU")}</span>
            <button className="ctl small" disabled={start === 0} onClick={() => setPage({ index, start: Math.max(0, start - queuePageSize) })} aria-label="Раньше в очереди">
              <ChevronLeft size={16} />
            </button>
            <button className="ctl small" disabled={end === queue.length} onClick={() => setPage({ index, start: Math.min(maxStart, end) })} aria-label="Дальше в очереди">
              <ChevronRight size={16} />
            </button>
          </div>
        ) : <span>{queue.length.toLocaleString("ru-RU")}</span>}
      </div>
      <div ref={listRef} className="fp-queue-list">
        {queue.slice(start, end).map((item, offset) => {
          const position = start + offset;
          return (
            <button
              className={`fp-queue-item ${position === index ? "active" : ""}`}
              key={position}
              ref={position === index ? activeRowRef : undefined}
              aria-current={position === index ? "true" : undefined}
              onClick={() => onJump(position)}
            >
              <TrackCover item={item} className="fp-mini-cover" />
              <span className="fp-queue-text">
                <strong>{item.title}</strong>
                <span>{item.subtitle}</span>
              </span>
              <span className="fp-queue-time">{item.duration}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
