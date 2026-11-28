import { LocateFixed, Mic2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../api";
import type { Lyrics, MediaItem } from "../types";
import { activeLineIndex, clockToSeconds } from "../ui/lyrics";
import { smallThumb } from "../ui/format";

const SCROLL_MS = 620;

export function KaraokeLyrics({
  current,
  artistName,
  progress,
  playing,
  onSeek,
}: {
  current: MediaItem;
  artistName: string;
  progress: number;
  playing: boolean;
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
  const artwork = smallThumb(current) ?? null;

  if (lyrics?.timed && lyrics.lines.length) {
    return (
      <TimedLyrics
        lyrics={lyrics}
        attribution={attribution}
        progress={progress}
        playing={playing}
        artwork={artwork}
        onSeek={onSeek}
      />
    );
  }

  const plainLines = (lyrics?.plain ?? "")
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const plain = plainLines.length > 0;
  return (
    <section className="fp-karaoke" aria-labelledby="fp-lyrics-heading" aria-busy={!result}>
      <LyricGlow artwork={artwork} />
      <div className="fp-karaoke-head">
        <h2 id="fp-lyrics-heading">Текст песни</h2>
        {plain ? <span className="fp-karaoke-note">Без синхронизации</span> : null}
      </div>
      {plain ? (
        <div className="fp-karaoke-scroll fp-karaoke-plain" tabIndex={0} role="region" aria-label="Текст без синхронизации">
          <ol className="fp-karaoke-plain-lines">
            {plainLines.map((line, index) => (
              <li key={`${index}-${line.slice(0, 12)}`}>{line}</li>
            ))}
          </ol>
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

/** The cover, blurred into the panel so the lyrics sit on the track's own colours. */
function LyricGlow({ artwork }: { artwork: string | null }) {
  return (
    <div className="fp-karaoke-glow" aria-hidden="true">
      {artwork ? <span style={{ backgroundImage: `url("${artwork.replace(/"/g, "")}")` }} /> : null}
    </div>
  );
}

function TimedLyrics({
  lyrics, attribution, progress, playing, artwork, onSeek,
}: {
  lyrics: Lyrics;
  attribution: string;
  progress: number;
  playing: boolean;
  artwork: string | null;
  onSeek: (seconds: number) => void;
}) {
  const { lines } = lyrics;
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const lineRefs = useRef(new Map<number, HTMLLIElement>());
  const clock = useRef({ value: progress, at: performance.now() });
  const scrollFrame = useRef(0);
  const [anchorIndex, setAnchorIndex] = useState(() => activeLineIndex(lines, progress * 1000));
  const [padding, setPadding] = useState(0);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const manualAt = useRef(0);
  const anchor = lines[anchorIndex];
  const activeIndex = anchor ? anchorIndex : -1;

  followingRef.current = following;

  useEffect(() => {
    clock.current = { value: progress, at: performance.now() };
  }, [progress]);

  const lineCenter = useCallback((index: number) => {
    const viewport = viewportRef.current;
    const item = lineRefs.current.get(index);
    if (!viewport || !item) return 0;
    const target = item.offsetTop - (viewport.clientHeight - item.offsetHeight) / 2;
    return Math.min(Math.max(0, target), Math.max(0, viewport.scrollHeight - viewport.clientHeight));
  }, []);

  // A scroll is eased by hand: `scrollTo({behavior: "smooth"})` on every line
  // stacks animations and reads as a jump on long gaps.
  const glideTo = useCallback((index: number, animate: boolean) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = lineCenter(index);
    cancelAnimationFrame(scrollFrame.current);
    const from = viewport.scrollTop;
    if (!animate || Math.abs(target - from) < 1) {
      viewport.scrollTop = target;
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / SCROLL_MS);
      const eased = 1 - Math.pow(1 - t, 5);
      viewport.scrollTop = from + (target - from) * eased;
      if (t < 1) scrollFrame.current = requestAnimationFrame(step);
    };
    scrollFrame.current = requestAnimationFrame(step);
  }, [lineCenter]);

  // One frame loop drives both the karaoke fill and the position: the player
  // reports four times a second, which is far too coarse for a word fill.
  useEffect(() => {
    let frame = 0;
    let painted = -1;
    const tick = (now: number) => {
      const position = playing ? clock.current.value + (now - clock.current.at) / 1000 : clock.current.value;
      const positionMs = position * 1000;
      const index = activeLineIndex(lines, positionMs);
      if (!followingRef.current && performance.now() - manualAt.current > 6000) {
        setFollowing(true);
      }
      if (index !== painted) {
        painted = index;
        setAnchorIndex(index);
        if (followingRef.current) glideTo(index, true);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lines, playing, glideTo]);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  // Half the pane, so the top and bottom lines can sit in the middle as well.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setPadding(Math.round(viewport.clientHeight / 2));
    measure();
    const observer = new ResizeObserver(() => {
      measure();
      if (followingRef.current) glideTo(activeLineIndex(lines, clock.current.value * 1000), false);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [glideTo, lines]);

  useLayoutEffect(() => {
    if (following) glideTo(activeLineIndex(lines, clock.current.value * 1000), false);
    // Position once on mount, before the first frame settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A stray wheel notch should not park the text off-centre for the rest of
  // the track: following picks itself up again after a short pause.
  const stopFollowing = () => {
    cancelAnimationFrame(scrollFrame.current);
    manualAt.current = performance.now();
    setFollowing(false);
  };

  return (
    <section className="fp-karaoke" aria-labelledby="fp-lyrics-heading">
      <LyricGlow artwork={artwork} />
      <div className="fp-karaoke-head">
        <h2 id="fp-lyrics-heading">Текст песни</h2>
        <button
          type="button"
          className="fp-karaoke-follow"
          data-following={following}
          aria-label={following ? "К текущей строке" : "К текущей строке и возобновить автопрокрутку"}
          onClick={() => {
            setFollowing(true);
            glideTo(activeLineIndex(lines, clock.current.value * 1000), true);
          }}
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
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (event.key === "PageUp" || event.key === "PageDown") {
            stopFollowing();
            return;
          }
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-line]");
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
          listRef.current?.children[Math.min(Math.max(0, next), lines.length - 1)]
            ?.querySelector<HTMLButtonElement>("button")?.focus();
        }}
      >
        <ol
          className="fp-karaoke-lines"
          ref={listRef}
          style={{ paddingTop: padding, paddingBottom: padding }}
        >
          {lines.map((line, index) => (
            <li
              key={`${line.startMs}-${index}`}
              data-line={index}
              data-state={index === activeIndex ? "active" : index < activeIndex ? "past" : "upcoming"}
              data-distance={Math.min(4, Math.abs(index - activeIndex))}
              ref={(element) => {
                if (element) lineRefs.current.set(index, element);
                else lineRefs.current.delete(index);
              }}
            >
              <button
                type="button"
                className="fp-karaoke-line"
                aria-current={index === activeIndex ? "true" : undefined}
                data-line={index}
                tabIndex={-1}
                onClick={() => {
                  onSeek(line.startMs / 1000);
                  setFollowing(true);
                  glideTo(index, true);
                }}
              >
                <span className="fp-karaoke-text">{line.text}</span>
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
