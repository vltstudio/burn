import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiFailure, localMediaUrl } from "./api";
import type { MediaItem } from "./types";

export type RepeatMode = "off" | "all" | "one";

interface ClipPlayback {
  playing: boolean;
  duration: number | null;
}

export interface ClipAudioHandoff {
  snapshot: () => { position: number; playing: boolean; volume: number; muted: boolean } | null;
  takeOver: () => { sync: (position: number, playback?: ClipPlayback) => void; release: () => void } | null;
}

interface PlayerApi {
  queue: MediaItem[];
  index: number;
  current: MediaItem | null;
  upNext: number[];
  playing: boolean;
  loading: boolean;
  progress: number;
  duration: number;
  clipPlayback: ClipPlayback | null;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  playItems: (items: MediaItem[], startIndex: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  playNext: (item: MediaItem) => void;
  enqueue: (item: MediaItem) => void;
  jumpTo: (index: number) => void;
  expanded: boolean;
  setExpanded: (value: boolean) => void;
  createClipHandoff: () => ClipAudioHandoff;
}

const PlayerContext = createContext<PlayerApi | null>(null);
type PlaybackApi = Omit<PlayerApi, "progress" | "duration" | "clipPlayback" | "volume" | "muted">;
const PlaybackContext = createContext<PlaybackApi | null>(null);

export function usePlayer(): PlayerApi {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer must be used inside PlayerProvider");
  return value;
}

export function usePlayback(): PlaybackApi {
  const value = useContext(PlaybackContext);
  if (!value) throw new Error("usePlayback must be used inside PlayerProvider");
  return value;
}

interface Props {
  children: ReactNode;
  onToast: (message: string, kind?: "info" | "error") => void;
}

interface RadioLookup {
  token: number;
  promise: Promise<{ items: MediaItem[]; error?: string }>;
  cancel: () => void;
}

export function PlayerProvider({ children, onToast }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestRef = useRef(0);
  const endedRef = useRef<() => void>(() => {});
  const disposeAudioRef = useRef<(() => void) | null>(null);
  const playRequestedRef = useRef(false);
  const queueRef = useRef<MediaItem[]>([]);
  const indexRef = useRef(-1);
  const shuffleRef = useRef(false);
  const repeatRef = useRef<RepeatMode>("off");
  const shuffleOrderRef = useRef<number[]>([]);
  const shufflePositionRef = useRef(0);
  const radioRef = useRef<RadioLookup | null>(null);
  const waitingForRadioRef = useRef<RadioLookup | null>(null);
  const clipLeaseRef = useRef<object | null>(null);

  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [clipPlayback, setClipPlayback] = useState<ClipPlayback | null>(null);
  const [volume, setVolumeState] = useState(() => {
    const stored = Number(window.localStorage.getItem("ytmusicdt.volume") ?? 0.85);
    return Number.isFinite(stored) && stored >= 0 ? Math.min(stored, 1) : 0.85;
  });
  const [muted, setMuted] = useState(volume === 0);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const lastAudibleVolume = useRef(volume || 0.85);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [expanded, setExpanded] = useState(false);

  const current = index >= 0 && index < queue.length ? queue[index] : null;

  const cancelRadio = useCallback(() => {
    radioRef.current?.cancel();
    radioRef.current = null;
    if (waitingForRadioRef.current) {
      waitingForRadioRef.current = null;
      playRequestedRef.current = false;
      setLoading(false);
      setPlaying(false);
    }
  }, []);

  const getRadio = useCallback((item: MediaItem): RadioLookup | null => {
    if (!item.videoId || item.localPath || item.source === "local") return null;
    const token = requestRef.current;
    if (radioRef.current?.token === token) return radioRef.current;
    radioRef.current?.cancel();
    let finish!: (result: { items: MediaItem[]; error?: string }) => void;
    const promise = new Promise<{ items: MediaItem[]; error?: string }>((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => finish({ items: [], error: "Превышено время ожидания рекомендаций YouTube Music." }), 15_000);
      finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      };
      void Promise.resolve().then(() => api.recommendations(item.videoId!)).then(
        (items) => finish({ items }),
        (error) => finish({ items: [], error: error instanceof ApiFailure ? error.message : "Не удалось получить рекомендации YouTube Music." }),
      );
    });
    const lookup = { token, promise, cancel: () => finish({ items: [] }) };
    radioRef.current = lookup;
    return lookup;
  }, []);

  useEffect(() => () => {
    ++requestRef.current;
    radioRef.current?.cancel();
    radioRef.current = null;
    waitingForRadioRef.current = null;
    clipLeaseRef.current = null;
    playRequestedRef.current = false;
    disposeAudioRef.current?.();
    audioRef.current = null;
  }, []);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
    window.localStorage.setItem("ytmusicdt.volume", String(volume));
  }, [volume, muted]);

  const load = useCallback(
    async (item: MediaItem) => {
      if (!item.videoId && !item.localPath) return;
      const token = ++requestRef.current;
      clipLeaseRef.current = null;
      setClipPlayback(null);
      cancelRadio();
      disposeAudioRef.current?.();
      const audio = new Audio();
      audio.preload = "auto";
      audio.volume = volumeRef.current;
      audio.muted = mutedRef.current;
      audioRef.current = audio;
      playRequestedRef.current = true;
      let starting = true;
      const startupTimer = window.setTimeout(() => {
        if (requestRef.current !== token) return;
        ++requestRef.current;
        playRequestedRef.current = false;
        disposeAudioRef.current?.();
        audioRef.current = null;
        setPlaying(false);
        setLoading(false);
        onToast("Превышено время ожидания воспроизведения.", "error");
      }, 30_000);
      audio.ontimeupdate = () => {
        if (requestRef.current === token && !clipLeaseRef.current) setProgress(audio.currentTime);
      };
      audio.onloadedmetadata = audio.ondurationchange = () => {
        if (requestRef.current === token) {
          setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
        }
      };
      audio.onended = () => {
        if (requestRef.current === token && audio.ended && playRequestedRef.current) {
          setPlaying(false);
          endedRef.current();
        }
      };
      audio.onplay = () => {
        if (requestRef.current !== token || !playRequestedRef.current) audio.pause();
        else setPlaying(true);
      };
      audio.onpause = () => {
        if (requestRef.current === token && audio.paused) {
          if (!starting && !audio.ended) playRequestedRef.current = false;
          setPlaying(false);
        }
      };
      audio.onerror = () => {
        if (requestRef.current === token) {
          if (!starting) playRequestedRef.current = false;
          setPlaying(false);
        }
      };
      disposeAudioRef.current = () => {
        window.clearTimeout(startupTimer);
        audio.ontimeupdate = audio.onloadedmetadata = audio.ondurationchange = null;
        audio.onended = audio.onplay = audio.onpause = audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      };
      setPlaying(false);
      setLoading(true);
      setProgress(0);
      setDuration(0);
      try {
        const url = item.localPath ? localMediaUrl(item.localPath) : await api.streamUrl(item.videoId!);
        if (requestRef.current !== token) return;
        audio.src = url;
        audio.currentTime = 0;
        try {
          if (playRequestedRef.current) await audio.play();
        } catch (error) {
          if (requestRef.current !== token) return;
          if (!playRequestedRef.current) return;
          if (item.localPath || !(error instanceof DOMException) || error.name !== "NotSupportedError") {
            throw error;
          }
          const refreshed = await api.streamUrl(item.videoId!, true);
          if (requestRef.current !== token) return;
          audio.src = refreshed;
          if (playRequestedRef.current) await audio.play();
        }
        if (requestRef.current !== token) return;
        if (!item.localPath && item.videoId && item.artists.length === 0) {
          void api
            .watchTrack(item.videoId)
            .then((full) => {
              if (requestRef.current !== token) return;
              const entries = queueRef.current.map((entry) =>
                !entry.localPath && entry.videoId === full.videoId && entry.artists.length === 0
                  ? { ...entry, artists: full.artists, album: entry.album ?? full.album }
                  : entry,
              );
              queueRef.current = entries;
              setQueue(entries);
            })
            .catch(() => undefined);
        }
      } catch (error) {
        if (requestRef.current !== token) return;
        playRequestedRef.current = false;
        disposeAudioRef.current?.();
        audioRef.current = null;
        setPlaying(false);
        const failure = error instanceof ApiFailure ? error : null;
        onToast(
          failure?.message ??
            "Не удалось воспроизвести трек.",
          "error",
        );
      } finally {
        window.clearTimeout(startupTimer);
        starting = false;
        if (requestRef.current === token && !waitingForRadioRef.current) setLoading(false);
      }
    },
    [cancelRadio, onToast],
  );

  const resetShuffle = useCallback((selected: number, length: number) => {
    const remaining = Array.from({ length }, (_, position) => position).filter((position) => position !== selected);
    for (let position = remaining.length - 1; position > 0; position--) {
      const target = Math.floor(Math.random() * (position + 1));
      [remaining[position], remaining[target]] = [remaining[target], remaining[position]];
    }
    shuffleOrderRef.current = selected >= 0 ? [selected, ...remaining] : remaining;
    shufflePositionRef.current = 0;
  }, []);

  const upNext = useMemo(() => {
    if (!current || repeat === "one") return [];
    const order = shuffle ? shuffleOrderRef.current : queue.map((_, position) => position);
    const position = shuffle ? shufflePositionRef.current : index;
    const upcoming = order.slice(position + 1);
    return repeat === "all" ? [...upcoming, ...order.slice(0, position + 1)] : upcoming;
  }, [current, index, queue, repeat, shuffle]);

  useEffect(() => {
    if (!current || repeat !== "off" || upNext.length > 0 || current.localPath || current.source === "local") {
      cancelRadio();
      return;
    }
    if (playRequestedRef.current) getRadio(current);
  }, [current?.videoId, current?.localPath, current?.source, index, queue.length, upNext.length, repeat, playing, loading, cancelRadio, getRadio]);

  useEffect(() => {
    const upcoming = queue[upNext[0]];
    if (!current || !upcoming?.videoId || upcoming.localPath || upcoming.videoId === current.videoId) return;
    const videoId = upcoming.videoId;
    const timer = window.setTimeout(() => {
      void api.streamUrl(videoId).catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [current?.videoId, queue, upNext]);

  const playItems = useCallback(
    (items: MediaItem[], startIndex: number) => {
      const tracks = items.filter((item) => Boolean(item.videoId || item.localPath));
      if (tracks.length === 0) {
        onToast("Здесь нечего воспроизводить", "error");
        return;
      }
      const requested = Number.isFinite(startIndex) ? Math.trunc(startIndex) : 0;
      const selected = Math.min(Math.max(requested, 0), items.length - 1);
      const before = items.slice(0, selected).filter((item) => Boolean(item.videoId || item.localPath)).length;
      const safeIndex = Math.min(before, tracks.length - 1);
      queueRef.current = tracks;
      indexRef.current = safeIndex;
      resetShuffle(safeIndex, tracks.length);
      setQueue(tracks);
      setIndex(safeIndex);
      void load(tracks[safeIndex]);
    },
    [load, onToast, resetShuffle],
  );

  const advance = useCallback(
    (step: 1 | -1) => {
      const entries = queueRef.current;
      const currentIndex = indexRef.current;
      if (currentIndex < 0 || entries.length === 0) return;
      const order = shuffleRef.current ? shuffleOrderRef.current : entries.map((_, position) => position);
      const position = shuffleRef.current ? shufflePositionRef.current : currentIndex;
      let nextPosition = position + step;
      if (nextPosition >= order.length || nextPosition < 0) {
        if (repeatRef.current === "all") {
          nextPosition = nextPosition >= order.length ? 0 : order.length - 1;
        } else {
          cancelRadio();
          if (step === -1) {
            if (audioRef.current) audioRef.current.currentTime = 0;
            setProgress(0);
          } else {
            playRequestedRef.current = false;
            audioRef.current?.pause();
            setPlaying(false);
          }
          return;
        }
      }
      const nextIndex = order[nextPosition];
      shufflePositionRef.current = nextPosition;
      indexRef.current = nextIndex;
      setIndex(nextIndex);
      void load(entries[nextIndex]);
    },
    [cancelRadio, load],
  );

  const continueRadio = useCallback(async () => {
    if (waitingForRadioRef.current) return;
    const item = queueRef.current[indexRef.current];
    if (!item) return;
    const lookup = getRadio(item);
    if (!lookup) {
      advance(1);
      return;
    }
    waitingForRadioRef.current = lookup;
    playRequestedRef.current = true;
    setLoading(true);
    try {
      const result = await lookup.promise;
      if (waitingForRadioRef.current !== lookup || requestRef.current !== lookup.token || !playRequestedRef.current || repeatRef.current !== "off") return;
      const entries = queueRef.current;
      const position = shuffleRef.current ? shufflePositionRef.current : indexRef.current;
      const length = shuffleRef.current ? shuffleOrderRef.current.length : entries.length;
      if (position + 1 < length) {
        advance(1);
        return;
      }
      const playedIds = new Set(entries.map((entry) => entry.videoId));
      const candidate = result.items.find((entry) => entry.videoId && !entry.localPath && entry.source !== "local" && !playedIds.has(entry.videoId));
      if (!candidate) {
        if (result.error) onToast(result.error, "error");
        return;
      }
      const updated = [...entries, candidate];
      queueRef.current = updated;
      shuffleOrderRef.current.push(updated.length - 1);
      setQueue(updated);
      advance(1);
    } finally {
      if (waitingForRadioRef.current === lookup) {
        waitingForRadioRef.current = null;
        radioRef.current = null;
        lookup.cancel();
        playRequestedRef.current = false;
        setLoading(false);
        setPlaying(false);
      }
    }
  }, [advance, getRadio, onToast]);

  const next = useCallback(() => advance(1), [advance]);

  const enqueue = useCallback(
    (item: MediaItem) => {
      if (!item.videoId && !item.localPath) return;
      const entries = [...queueRef.current, item];
      queueRef.current = entries;
      shuffleOrderRef.current.push(entries.length - 1);
      setQueue(entries);
      if (indexRef.current < 0) {
        indexRef.current = 0;
        setIndex(0);
        void load(item);
      } else if (waitingForRadioRef.current) {
        advance(1);
      }
    },
    [advance, load],
  );

  const playNext = useCallback(
    (item: MediaItem) => {
      if (!item.videoId && !item.localPath) return;
      const currentIndex = indexRef.current;
      if (currentIndex < 0) {
        enqueue(item);
        return;
      }
      const entries = [...queueRef.current];
      const inserted = currentIndex + 1;
      entries.splice(inserted, 0, item);
      queueRef.current = entries;
      const order = shuffleOrderRef.current.map((position) => position >= inserted ? position + 1 : position);
      order.splice(shufflePositionRef.current + 1, 0, inserted);
      shuffleOrderRef.current = order;
      setQueue(entries);
      if (waitingForRadioRef.current) advance(1);
    },
    [advance, enqueue],
  );

  const jumpTo = useCallback(
    (target: number) => {
      if (!Number.isInteger(target)) return;
      const item = queueRef.current[target];
      if (!item) return;
      indexRef.current = target;
      shufflePositionRef.current = shuffleOrderRef.current.indexOf(target);
      setIndex(target);
      void load(item);
    },
    [load],
  );

  endedRef.current = () => {
    if (repeatRef.current === "one") {
      const audio = audioRef.current;
      if (audio) {
        playRequestedRef.current = true;
        audio.currentTime = 0;
        const token = requestRef.current;
        void audio.play().catch(() => {
          if (requestRef.current === token) setPlaying(false);
        });
      }
      return;
    }
    const position = shuffleRef.current ? shufflePositionRef.current : indexRef.current;
    const length = shuffleRef.current ? shuffleOrderRef.current.length : queueRef.current.length;
    if (repeatRef.current === "off" && position + 1 >= length) void continueRadio();
    else advance(1);
  };

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (!clipLeaseRef.current && audio && audio.currentTime > 3) {
      cancelRadio();
      if (audio.ended) playRequestedRef.current = false;
      audio.currentTime = 0;
      setProgress(0);
      return;
    }
    advance(-1);
  }, [advance, cancelRadio]);

  const toggle = useCallback(() => {
    if (clipLeaseRef.current) return;
    const audio = audioRef.current;
    const item = queueRef.current[indexRef.current];
    if (!item) return;
    if (waitingForRadioRef.current) {
      cancelRadio();
      return;
    }
    if (playRequestedRef.current) {
      playRequestedRef.current = false;
      audio?.pause();
      setPlaying(false);
      return;
    }
    playRequestedRef.current = true;
    if (audio?.src) {
      const token = requestRef.current;
      void audio.play().catch(() => {
        if (requestRef.current === token && playRequestedRef.current) void load(item);
      });
    } else if (!audio) {
      void load(item);
    }
  }, [cancelRadio, load]);

  const createClipHandoff = useCallback((): ClipAudioHandoff => {
    const token = requestRef.current;
    const positionOf = () => audioRef.current?.currentTime ?? 0;
    const wantsAudio = () => playRequestedRef.current && !audioRef.current?.ended && !waitingForRadioRef.current;
    return {
      snapshot: () => requestRef.current === token ? {
        position: positionOf(),
        playing: wantsAudio(),
        volume: volumeRef.current,
        muted: mutedRef.current,
      } : null,
      takeOver: () => {
        if (requestRef.current !== token || clipLeaseRef.current) return null;
        const lease = {};
        const audio = audioRef.current;
        const resume = wantsAudio();
        let position = positionOf();
        clipLeaseRef.current = lease;
        cancelRadio();
        playRequestedRef.current = false;
        audio?.pause();
        setPlaying(false);
        setClipPlayback({ playing: true, duration: null });
        return {
          sync: (seconds, playback) => {
            if (clipLeaseRef.current !== lease || !Number.isFinite(seconds) || seconds < 0) return;
            position = audio && Number.isFinite(audio.duration) ? Math.min(seconds, audio.duration) : seconds;
            setProgress(seconds);
            if (playback) {
              setClipPlayback((current) => current?.playing === playback.playing && current.duration === playback.duration
                ? current : playback);
            }
          },
          release: () => {
            if (clipLeaseRef.current !== lease) return;
            clipLeaseRef.current = null;
            setClipPlayback(null);
            if (!audio || requestRef.current !== token || audioRef.current !== audio) return;
            if (audio.src) {
              if (position !== audio.currentTime) audio.currentTime = position;
              setProgress(audio.currentTime);
            }
            if (!resume) return;
            if (Number.isFinite(audio.duration) && audio.duration > 0 && position >= audio.duration) {
              endedRef.current();
              return;
            }
            playRequestedRef.current = true;
            if (audio.src) void audio.play().catch(() => {
              if (requestRef.current === token && !clipLeaseRef.current && audio.paused) {
                playRequestedRef.current = false;
                setPlaying(false);
              }
            });
          },
        };
      },
    };
  }, [cancelRadio]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (clipLeaseRef.current || !audio || !Number.isFinite(seconds) || !Number.isFinite(audio.duration)) return;
    if (waitingForRadioRef.current) cancelRadio();
    if (audio.ended) playRequestedRef.current = false;
    audio.currentTime = Math.min(Math.max(seconds, 0), audio.duration);
    setProgress(audio.currentTime);
  }, [cancelRadio]);

  const setVolume = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    const next = Math.min(Math.max(value, 0), 1);
    if (next > 0) lastAudibleVolume.current = next;
    volumeRef.current = next;
    mutedRef.current = next === 0;
    setVolumeState(next);
    setMuted(next === 0);
  }, []);

  const toggleMute = useCallback(() => {
    if (volumeRef.current === 0) {
      volumeRef.current = lastAudibleVolume.current;
      mutedRef.current = false;
      setVolumeState(volumeRef.current);
    } else {
      mutedRef.current = !mutedRef.current;
    }
    setMuted(mutedRef.current);
  }, []);

  const toggleShuffle = useCallback(() => {
    cancelRadio();
    shuffleRef.current = !shuffleRef.current;
    resetShuffle(indexRef.current, queueRef.current.length);
    setShuffle(shuffleRef.current);
  }, [cancelRadio, resetShuffle]);

  const cycleRepeat = useCallback(
    () => {
      cancelRadio();
      const value = repeatRef.current;
      repeatRef.current = value === "off" ? "all" : value === "all" ? "one" : "off";
      setRepeat(repeatRef.current);
    },
    [cancelRadio],
  );

  const playback = useMemo<PlaybackApi>(
    () => ({
      queue,
      index,
      current,
      upNext,
      playing,
      loading,
      shuffle,
      repeat,
      playItems,
      toggle,
      next,
      previous,
      seek,
      setVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
      playNext,
      enqueue,
      jumpTo,
      expanded,
      setExpanded,
      createClipHandoff,
    }),
    [
      queue,
      index,
      current,
      upNext,
      playing,
      loading,
      shuffle,
      repeat,
      playItems,
      toggle,
      next,
      previous,
      seek,
      setVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
      playNext,
      enqueue,
      jumpTo,
      expanded,
      createClipHandoff,
    ],
  );

  const value = useMemo<PlayerApi>(
    () => ({ ...playback, progress, duration, clipPlayback, volume, muted }),
    [playback, progress, duration, clipPlayback, volume, muted],
  );

  return (
    <PlayerContext.Provider value={value}>
      <PlaybackContext.Provider value={playback}>{children}</PlaybackContext.Provider>
    </PlayerContext.Provider>
  );
}
