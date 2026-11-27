import { LocateFixed, Mic2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../api";
import type { Lyrics, LyricLine, MediaItem } from "../types";
import { activeLineIndex, clockToSeconds, lineProgress, wordProgress } from "../ui/lyrics";
import { smallThumb } from "../ui/format";

const SCROLL_MS = 520;

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

  const plain = lyrics?.plain?.trim();
  return (
    <section className="fp-karaoke" aria-labelledby="fp-lyrics-heading" aria-busy={!result}>
      <LyricGlow artwork={artwork} />
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
  const wordRefs = useRef(new Map<string, HTMLSpanElement>());
  const clock = useRef({ value: progress, at: performance.now() });
  const scrollFrame = useRef(0);
  const [anchorIndex, setAnchorIndex] = useState(() => activeLineIndex(lines, progress * 1000));
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
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
      const eased = 1 - Math.pow(1 - t, 3);
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
      if (index !== painted) {
        painted = index;
        setAnchorIndex(index);
        if (followingRef.current) glideTo(index, true);
      }
      const line = lines[index];
      if (line) {
        const lineElement = lineRefs.current.get(index);
        lineElement?.style.setProperty("--karaoke", `${lineProgress(line, positionMs) * 100}%`);
        if (line.words?.length) {
          for (let word = 0; word < line.words.length; word += 1) {
            const element = wordRefs.current.get(`${index}:${word}`);
            element?.style.setProperty("--karaoke", `${wordProgress(line.words[word], positionMs) * 100}%`);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [lines, playing, glideTo]);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  useLayoutEffect(() => {
    if (following) glideTo(activeLineIndex(lines, clock.current.value * 1000), false);
    // Position once on mount, before the first frame settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopFollowing = () => {
    cancelAnimationFrame(scrollFrame.current);
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
        <ol className="fp-karaoke-lines" ref={listRef}>
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
                <KaraokeText
                  line={line}
                  index={index}
                  active={index === activeIndex}
                  register={(word, element) => {
                    const key = `${index}:${word}`;
                    if (element) wordRefs.current.set(key, element);
                    else wordRefs.current.delete(key);
                  }}
                />
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

/** Words carry their own fill so the highlight follows the voice; a line
 * without word timings fills as a whole. */
function KaraokeText({
  line,
  index,
  active,
  register,
}: {
  line: LyricLine;
  index: number;
  active: boolean;
  register: (word: number, element: HTMLSpanElement | null) => void;
}) {
  if (!line.words?.length) return <span className="fp-karaoke-text">{line.text}</span>;
  return (
    <span className="fp-karaoke-text">
      {line.words.map((word, position) => (
        <span
          // Words are positional: the same text can repeat inside a line.
          key={`${index}-${position}`}
          className="fp-karaoke-word"
          data-active={active || undefined}
          ref={(element) => register(position, element)}
        >
          {word.text}
          {position < line.words!.length - 1 ? " " : null}
        </span>
      ))}
    </span>
  );
}
