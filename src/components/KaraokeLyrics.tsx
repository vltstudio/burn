import { LocateFixed, Mic2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../api";
import type { Lyrics, MediaItem } from "../types";
import { activeLineIndex, clockToSeconds } from "../ui/lyrics";

export function KaraokeLyrics({
  current,
  artistName,
  progress,
  onSeek,
}: {
  current: MediaItem;
  artistName: string;
  progress: number;
  onSeek: (seconds: number) => void;
}) {
  const [result, setResult] = useState<{ lyrics: Lyrics } | { error: string } | null>(null);
  const { videoId, title, duration } = current;
  const album = current.album?.name ?? null;

  useEffect(() => {
    let cancelled = false;
    api.trackLyrics(videoId, title, artistName, album, clockToSeconds(duration)).then(
      (lyrics) => {
        if (!cancelled) setResult({ lyrics });
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({ error: error instanceof ApiFailure ? error.message : "Не удалось загрузить текст." });
        }
      },
    );
    return () => { cancelled = true; };
  }, [videoId, title, artistName, album, duration]);

  const lyrics = result && "lyrics" in result ? result.lyrics : null;
  const attribution = lyrics?.attribution || (lyrics?.source === "lrclib" ? "LRCLIB" : "YouTube Music");
  if (lyrics?.timed && lyrics.lines.length) {
    return <TimedLyrics lyrics={lyrics} attribution={attribution} progress={progress} onSeek={onSeek} />;
  }

  const plain = lyrics?.plain?.trim();
  return (
    <section className="fp-karaoke" aria-labelledby="fp-lyrics-heading" aria-busy={!result}>
      <div className="fp-karaoke-head">
        <h2 id="fp-lyrics-heading">Текст песни</h2>
        {plain ? <span className="fp-karaoke-note">Без синхронизации</span> : null}
      </div>
      {plain ? (
        <div className="fp-karaoke-scroll fp-karaoke-plain" tabIndex={0} role="region" aria-label="Текст без синхронизации">
          {plain}
        </div>
      ) : (
        <div className="fp-karaoke-empty" role="status">
          <Mic2 size={25} aria-hidden="true" />
          <p>{!result ? "Загружаем текст…" : "error" in result ? result.error : "Текст для этого трека не найден."}</p>
        </div>
      )}
      {plain ? <div className="fp-karaoke-foot"><span>{attribution}</span></div> : null}
    </section>
  );
}

function TimedLyrics({
  lyrics, attribution, progress, onSeek,
}: {
  lyrics: Lyrics;
  attribution: string;
  progress: number;
  onSeek: (seconds: number) => void;
}) {
  const { lines } = lyrics;
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const didPosition = useRef(false);
  const autoScrollUntil = useRef(0);
  const [following, setFollowing] = useState(true);
  const positionMs = progress * 1000;
  const anchorIndex = activeLineIndex(lines, positionMs);
  const anchor = lines[anchorIndex];
  const activeIndex = anchor && (anchor.endMs === null || anchor.endMs <= anchor.startMs || positionMs < anchor.endMs) ? anchorIndex : -1;

  const centerLine = useCallback((animate: boolean) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const line = anchorRef.current;
    const offset = line
      ? viewport.scrollTop + line.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        - Math.max(0, (viewport.clientHeight - line.offsetHeight) / 2)
      : 0;
    const target = Math.min(Math.max(0, offset), viewport.scrollHeight - viewport.clientHeight);
    if (Math.abs(target - viewport.scrollTop) < 1) return;
    const smooth = animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    autoScrollUntil.current = performance.now() + (smooth ? 800 : 120);
    viewport.scrollTo({ top: target, behavior: smooth ? "smooth" : "instant" });
  }, []);

  useLayoutEffect(() => {
    if (!following) return;
    centerLine(didPosition.current);
    didPosition.current = true;
  }, [anchorIndex, following, centerLine]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!following || !viewport) return;
    const observer = new ResizeObserver(() => centerLine(false));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [following, centerLine]);

  const stopFollowing = () => {
    if (!following) return;
    const viewport = viewportRef.current;
    if (viewport && autoScrollUntil.current > performance.now()) {
      viewport.scrollTo({ top: viewport.scrollTop, behavior: "instant" });
    }
    autoScrollUntil.current = 0;
    setFollowing(false);
  };

  const resumeFollowing = () => {
    if (following) centerLine(true);
    setFollowing(true);
  };

  return (
    <section className="fp-karaoke" aria-labelledby="fp-lyrics-heading">
      <div className="fp-karaoke-head">
        <h2 id="fp-lyrics-heading">Текст песни</h2>
        <button
          type="button"
          className="fp-karaoke-follow"
          data-following={following}
          aria-label={following ? "К текущей строке" : "К текущей строке и возобновить автопрокрутку"}
          onClick={resumeFollowing}
          title="Вернуться к текущей строке"
        >
          <LocateFixed size={16} aria-hidden="true" />
          <span>К текущей строке</span>
        </button>
      </div>
      <div
        ref={viewportRef}
        className="fp-karaoke-scroll"
        role="region"
        aria-label="Синхронный текст"
        aria-describedby="fp-lyrics-help"
        tabIndex={0}
        onWheel={stopFollowing}
        onTouchMove={stopFollowing}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) stopFollowing();
        }}
        onScroll={() => {
          if (performance.now() > autoScrollUntil.current) setFollowing(false);
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === "PageUp" || event.key === "PageDown") {
            stopFollowing();
            return;
          }
          const row = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-line]");
          const index = row ? Number(row.dataset.line) : Math.max(0, anchorIndex);
          let next = index;
          switch (event.key) {
            case "ArrowUp": next = row ? index - 1 : index; break;
            case "ArrowDown": next = row ? index + 1 : index; break;
            case "Home": next = 0; break;
            case "End": next = lines.length - 1; break;
            default: return;
          }
          event.preventDefault();
          stopFollowing();
          listRef.current?.children[Math.min(Math.max(0, next), lines.length - 1)]?.querySelector("button")?.focus();
        }}
      >
        <ol className="fp-karaoke-lines" ref={listRef}>
          {lines.map((line, index) => (
            <li key={`${line.startMs}-${index}`}>
              <button
                type="button"
                ref={index === anchorIndex ? anchorRef : undefined}
                className="fp-karaoke-line"
                aria-current={index === activeIndex ? "true" : undefined}
                data-past={index < anchorIndex || (index === anchorIndex && index !== activeIndex) || undefined}
                data-line={index}
                tabIndex={-1}
                onClick={() => {
                  onSeek(line.startMs / 1000);
                  if (index === anchorIndex) centerLine(true);
                  setFollowing(true);
                }}
              >
                {line.text}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="fp-karaoke-foot">
        <span id="fp-lyrics-help">Выберите строку, чтобы перейти к ней</span>
        <span title={attribution}>{attribution}</span>
      </div>
    </section>
  );
}
