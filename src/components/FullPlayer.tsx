import {
  ChevronDown, ListMusic, Mic2, Pause, Play, Repeat, Repeat1, Shuffle,
  SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure } from "../api";
import { usePlayer } from "../player";
import type { Lyrics, MediaItem } from "../types";
import { TrackCover } from "../ui/cover";
import { ArtistNames } from "../ui/artist-links";
import { formatTime } from "../ui/format";
import { activeLineIndex, clockToSeconds } from "../ui/lyrics";
import { Slider } from "../ui/slider";
import { WindowControls } from "./WindowControls";

type Pane = "meta" | "queue" | "lyrics";

export function FullPlayer({ current, onClose }: { current: MediaItem; onClose: () => void }) {
  const player = usePlayer();
  const { playing, loading, progress, duration, shuffle, repeat, muted, volume, queue, index } = player;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const activeLyricRef = useRef<HTMLButtonElement>(null);
  const lastManualScroll = useRef(0);
  // A smooth programmatic scroll fires scroll events too; without this guard
  // it would look like the person scrolling and stop the follow-along.
  const programmaticScrollUntil = useRef(0);
  const [pane, setPane] = useState<Pane>("meta");
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [lyricsError, setLyricsError] = useState<string | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [loadedLyricsKey, setLoadedLyricsKey] = useState("");
  const next = queue[player.upNext[0]];
  const artistName = current.artists[0]?.name ?? current.subtitle;
  const lyricsKey = JSON.stringify([current.videoId, current.localPath, current.title, artistName, current.album?.name, current.duration]);
  const repeatTitle = repeat === "one" ? "Повтор трека" : repeat === "all" ? "Повтор очереди" : "Повтор выключен";
  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (pane === "queue") activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [index, pane]);

  // Lyrics are fetched when the pane is opened and on every track change
  // while it stays open; the backend caches the result per track.
  useEffect(() => {
    if (pane !== "lyrics") return;
    let cancelled = false;
    setLyrics(null);
    setLyricsError(null);
    setLyricsLoading(true);
    setLoadedLyricsKey(lyricsKey);
    lastManualScroll.current = 0;
    programmaticScrollUntil.current = 0;
    api
      .trackLyrics(
        current.videoId,
        current.title,
        artistName,
        current.album?.name ?? null,
        clockToSeconds(current.duration),
      )
      .then((data) => {
        if (!cancelled) setLyrics(data);
      })
      .catch((failure) => {
        if (!cancelled) {
          setLyricsError(failure instanceof ApiFailure ? failure.message : String(failure));
        }
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pane, lyricsKey]);

  const activeLine = useMemo(() => {
    if (loadedLyricsKey !== lyricsKey || !lyrics?.timed || lyrics.lines.length === 0) return -1;
    return activeLineIndex(lyrics.lines, progress * 1000);
  }, [loadedLyricsKey, lyricsKey, lyrics, progress]);

  // A hand-scrolled list keeps its place for a few seconds instead of being
  // pulled back to the current line on the next time update.
  useEffect(() => {
    if (pane !== "lyrics" || activeLine < 0) return;
    if (Date.now() - lastManualScroll.current < 4000) return;
    programmaticScrollUntil.current = Date.now() + 900;
    activeLyricRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLine, pane]);

  const renderLyrics = () => {
    if (lyricsLoading || loadedLyricsKey !== lyricsKey) {
      return <div className="fp-lyrics-state">Загружаем текст…</div>;
    }
    if (lyricsError) {
      return <div className="fp-lyrics-state">{lyricsError}</div>;
    }
    if (!lyrics) return null;
    if (!lyrics.timed) {
      return (
        <section className="fp-lyrics" aria-label="Текст песни">
          <div className="fp-lyrics-head">
            <h2>Текст</h2>
            <span>без синхронизации</span>
          </div>
          <div className="fp-lyrics-scroll">
            <div className="fp-lyrics-plain">{lyrics.plain}</div>
          </div>
        </section>
      );
    }
    return (
      <section className="fp-lyrics" aria-label="Текст песни">
        <div className="fp-lyrics-head">
          <h2>Текст</h2>
          {lyrics.attribution ? <span>{lyrics.attribution}</span> : null}
        </div>
        <div
          className="fp-lyrics-scroll"
          onScroll={() => {
            if (Date.now() > programmaticScrollUntil.current) {
              lastManualScroll.current = Date.now();
            }
          }}
        >
          {lyrics.lines.map((line, position) => (
            <button
              key={`${line.startMs}-${position}`}
              ref={position === activeLine ? activeLyricRef : undefined}
              className={`fp-lyric ${position === activeLine ? "active" : ""}`}
              aria-current={position === activeLine ? "true" : undefined}
              onClick={() => player.seek(line.startMs / 1000)}
            >
              {line.text}
            </button>
          ))}
        </div>
      </section>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="full-player"
      aria-labelledby="fp-heading"
      data-tauri-drag-region
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <WindowControls />
      <TrackCover item={current} className="fp-wash" />
      <div className="fp-shell" data-tauri-drag-region>
        <header className="fp-head" data-tauri-drag-region>
          <button className="fp-collapse" aria-label="Свернуть плеер" onClick={close} autoFocus>
            <ChevronDown size={20} /> <span>Свернуть</span>
          </button>
          <p className="fp-kicker" id="fp-heading" data-tauri-drag-region>Сейчас играет</p>
          <div className="fp-head-actions" data-tauri-drag-region>
            <button
              className={`fp-queue-toggle ${pane === "queue" ? "active" : ""}`}
              aria-label="Очередь"
              aria-pressed={pane === "queue"}
              onClick={() => setPane(pane === "queue" ? "meta" : "queue")}
            >
              <ListMusic size={18} /> <span>Очередь</span>
            </button>
            <button
              className={`fp-queue-toggle ${pane === "lyrics" ? "active" : ""}`}
              aria-label="Текст песни"
              aria-pressed={pane === "lyrics"}
              onClick={() => setPane(pane === "lyrics" ? "meta" : "lyrics")}
            >
              <Mic2 size={18} /> <span>Текст</span>
            </button>
          </div>
        </header>

        <div className="fp-stage">
          <div className="fp-art">
            <TrackCover
              item={current}
              large
              eager
              className="fp-cover"
              alt={`Обложка: ${current.title}`}
            />
          </div>

          <div className="fp-deck">
            {pane === "queue" ? (
              <section className="fp-queue" aria-label="Треки в очереди">
                <div className="fp-queue-head">
                  <h2>Очередь</h2>
                  <span>{queue.length.toLocaleString("ru-RU")}</span>
                </div>
                <div className="fp-queue-list">
                  {queue.map((item, position) => (
                    <button
                      className={`fp-queue-item ${position === index ? "active" : ""}`}
                      key={`${item.videoId}-${position}`}
                      ref={position === index ? activeRowRef : undefined}
                      aria-current={position === index ? "true" : undefined}
                      onClick={() => player.jumpTo(position)}
                    >
                      <TrackCover item={item} className="fp-mini-cover" />
                      <span className="fp-queue-text">
                        <strong>{item.title}</strong>
                        <span>{item.subtitle}</span>
                      </span>
                      <span className="fp-queue-time">{item.duration}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : pane === "lyrics" ? (
              renderLyrics()
            ) : (
              <div className="fp-meta">
                <h2 className="fp-title" title={current.title}>{current.title}</h2>
                <p className="fp-sub" title={current.subtitle}>
                  <ArtistNames artists={current.artists} fallback={current.subtitle} onNavigate={close} />
                </p>
              </div>
            )}

            <div className="fp-transport">
              <div className="fp-seek">
                <Slider value={progress} max={duration} onChange={player.seek} ariaLabel="Позиция трека" />
                <div className="fp-times">
                  <span>{formatTime(progress)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

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
                  disabled={loading}
                  aria-label={loading ? "Загрузка" : playing ? "Пауза" : "Играть"}
                  title={playing ? "Пауза" : "Играть"}
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
            </div>

            <div className="fp-bottom">
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
              {pane === "meta" && next ? (
                <button className="fp-next" onClick={player.next} title={next.title}>
                  <TrackCover item={next} className="fp-mini-cover" />
                  <span className="fp-queue-text"><span>Далее</span><strong>{next.title}</strong></span>
                  <SkipForward size={15} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
