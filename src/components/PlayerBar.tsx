import {
  Heart,
  ListMusic,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { ArtistNames } from "../ui/artist-links";
import { TrackCover } from "../ui/cover";
import { favoriteKey, formatTime } from "../ui/format";
import { Slider } from "../ui/slider";
import { FullPlayer } from "./FullPlayer";
import { PlaylistPicker } from "./PlaylistPicker";
import VolumeSlider from "./ui/volume-slider";

export function PlayerBar() {
  const player = usePlayer();
  const { favoriteIds, toggleFavorite } = useLibrary();
  const {
    current,
    playing,
    loading,
    progress,
    duration,
    volume,
    muted,
    shuffle,
    repeat,
    queue,
    index: currentIndex,
  } = player;
  const [queueOpen, setQueueOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeCloseTimer = useRef<number | null>(null);

  // The pointer has to cross the gap between the icon and the panel, so the
  // panel closes on a short delay instead of on the first pointerleave.
  const openVolume = () => {
    if (volumeCloseTimer.current) window.clearTimeout(volumeCloseTimer.current);
    setVolumeOpen(true);
  };
  const closeVolumeSoon = () => {
    if (volumeCloseTimer.current) window.clearTimeout(volumeCloseTimer.current);
    volumeCloseTimer.current = window.setTimeout(() => setVolumeOpen(false), 180);
  };
  useEffect(() => () => {
    if (volumeCloseTimer.current) window.clearTimeout(volumeCloseTimer.current);
  }, []);
  const favoriteId = current ? favoriteKey(current) : null;
  const isLiked = favoriteId ? favoriteIds.has(favoriteId) : false;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        target?.closest("button, a, input, textarea, select, [role='button'], [role='slider'], [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [player.toggle]);

  useEffect(() => {
    if (queue.length === 0) setQueueOpen(false);
  }, [queue.length]);

  return (
    <footer className={`player ${current ? "" : "idle"}`} aria-hidden={current ? undefined : true}>
      <div className="player-inner">
        <div className="player-track">
          <button
            className="pb-cover-button player-artwork-expand"
            title="Развернуть плеер"
            aria-label="Развернуть плеер"
            aria-haspopup="dialog"
            disabled={!current}
            onClick={() => player.setExpanded(true)}
          >
            {current ? <TrackCover item={current} className="pb-cover" eager /> : null}
            <span className="player-artwork-expand-overlay" aria-hidden="true">
              <Maximize2 className="player-artwork-expand-icon" size={18} strokeWidth={1.8} />
            </span>
          </button>
          <div className="pb-text">
            <div className="pb-title">{current?.title ?? ""}</div>
            <div className="pb-sub">
              <ArtistNames artists={current?.artists ?? []} fallback={current?.subtitle} />
            </div>
          </div>
          <button
            className={`ctl small pb-like ${isLiked ? "active" : ""}`}
            onClick={() => current && toggleFavorite(current)}
            disabled={!current}
            title={isLiked ? "Убрать из избранного" : "В избранное"}
          >
            <Heart size={15} strokeWidth={1.7} fill={isLiked ? "currentColor" : "none"} />
          </button>
        </div>

        <div className="player-controls">
          <button className="ctl" onClick={player.previous} disabled={!current} title="Предыдущий">
            <SkipBack size={15} strokeWidth={1.7} fill="currentColor" />
          </button>
          <button
            className="ctl play"
            onClick={player.toggle}
            disabled={!current}
            title={playing ? "Пауза" : "Играть"}
          >
            {loading ? (
              <span className="spinner" />
            ) : playing ? (
              <Pause size={15} strokeWidth={1.8} fill="currentColor" />
            ) : (
              <Play size={15} strokeWidth={1.8} fill="currentColor" />
            )}
          </button>
          <button className="ctl" onClick={player.next} disabled={!current} title="Следующий">
            <SkipForward size={15} strokeWidth={1.7} fill="currentColor" />
          </button>
        </div>

        <div className="player-actions">
          <button
            className={`ctl small ${shuffle ? "active" : ""}`}
            onClick={player.toggleShuffle}
            title={shuffle ? "Перемешивание включено" : "Перемешивать"}
          >
            <Shuffle size={14} strokeWidth={1.7} />
          </button>
          <button
            className={`ctl small ${repeat !== "off" ? "active" : ""}`}
            onClick={player.cycleRepeat}
            title={
              repeat === "one"
                ? "Повтор трека"
                : repeat === "all"
                  ? "Повтор очереди"
                  : "Повтор выключен"
            }
          >
            {repeat === "one" ? (
              <Repeat1 size={14} strokeWidth={1.7} />
            ) : (
              <Repeat size={14} strokeWidth={1.7} />
            )}
          </button>
          {current?.source !== "local" ? <PlaylistPicker videoId={current?.videoId ?? null} placement="up" /> : null}
          <button
            className={`ctl small ${queueOpen ? "active" : ""}`}
            onClick={() => setQueueOpen((value) => !value)}
            disabled={queue.length === 0}
            title="Очередь"
          >
            <ListMusic size={15} strokeWidth={1.7} />
          </button>
          <button
            className="ctl small"
            onClick={() => player.setExpanded(true)}
            disabled={!current}
            title="Развернуть плеер"
            aria-label="Развернуть плеер"
            aria-haspopup="dialog"
          >
            <Maximize2 size={14} strokeWidth={1.7} />
          </button>
          <div
            className="volume-wrap"
            onPointerEnter={openVolume}
            onPointerLeave={closeVolumeSoon}
          >
            <button
              className="ctl small"
              onClick={player.toggleMute}
              title={muted ? "Включить звук" : "Без звука"}
            >
              {muted || volume === 0 ? (
                <VolumeX size={15} strokeWidth={1.7} />
              ) : (
                <Volume2 size={15} strokeWidth={1.7} />
              )}
            </button>
            {volumeOpen ? (
              <div className="volume-popover">
                <VolumeSlider
                  value={muted ? 0 : volume}
                  onChange={(next) => player.setVolume(next)}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="player-line">
        <span className="time">{formatTime(progress)}</span>
        <Slider
          className="seek"
          value={progress}
          max={duration || 0}
          onChange={(value) => player.seek(value)}
          ariaLabel="Позиция"
        />
        <span className="time">{formatTime(duration)}</span>
      </div>

      {player.expanded && current ? <FullPlayer current={current} onClose={() => player.setExpanded(false)} /> : null}

      {queueOpen ? (
        <div className="queue-panel">
          <div className="queue-head">
            <span>Очередь</span>
            <span className="queue-count">{queue.length}</span>
          </div>
          <div className="queue-list">
            {queue.map((item, index) => {
              const active = index === currentIndex;
              return (
                <button
                  key={`${item.videoId ?? item.title}-${index}`}
                  className={`queue-item ${active ? "active" : ""}`}
                  onClick={() => player.jumpTo(index)}
                >
                  <span className="queue-index">{active ? "♪" : index + 1}</span>
                  <span className="queue-text">
                    <span className="queue-title">{item.title}</span>
                    <ArtistNames
                      interactive={false}
                      className="queue-sub"
                      artists={item.artists}
                      fallback={item.subtitle}
                    />
                  </span>
                  <span className="queue-duration">{item.duration ?? ""}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </footer>
  );
}
