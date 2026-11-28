import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "./api";
import { applyDownloads } from "./downloads";
import { PlayerProvider, usePlayback, usePlayer } from "./player";
import type { MediaItem } from "./types";

const backend = vi.hoisted(() => ({
  streamUrl: vi.fn<(videoId: string, refresh?: boolean) => Promise<string>>(),
  recommendations: vi.fn<(videoId: string) => Promise<MediaItem[]>>(),
  watchTrack: vi.fn<(videoId: string) => Promise<MediaItem>>(),
}));

vi.mock("./api", () => ({
  api: backend,
  ApiFailure: class ApiFailure extends Error {
    readonly needsAuth: boolean;
    readonly needsPlayer: boolean;

    constructor(shape: { message: string; needsAuth: boolean; needsPlayer: boolean }) {
      super(shape.message);
      this.needsAuth = shape.needsAuth;
      this.needsPlayer = shape.needsPlayer;
    }
  },
  localMediaUrl: (path: string) => `http://localmedia.localhost/${encodeURIComponent(path)}`,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  private position = 0;
  duration = 180;
  paused = true;
  ended = false;
  volume = 1;
  muted = false;
  preload = "";
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  onended: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playOverride: (() => Promise<void>) | null = null;

  constructor() {
    FakeAudio.instances.push(this);
  }

  get currentTime() {
    return this.position;
  }

  set currentTime(value: number) {
    this.position = value;
    if (value < this.duration) this.ended = false;
  }

  play = vi.fn((): Promise<void> => {
    this.paused = false;
    this.ended = false;
    if (this.playOverride) return this.playOverride();
    this.onloadedmetadata?.();
    this.onplay?.();
    return Promise.resolve();
  });

  pause = vi.fn(() => {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.onpause?.();
  });

  load = vi.fn();

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  finish() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.onended?.();
  }
}

function track(videoId: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    kind: "song",
    title: videoId,
    subtitle: "Fixture artist",
    videoId,
    browseId: null,
    playlistId: null,
    duration: "3:00",
    year: null,
    thumbs: [],
    artists: [{ name: "Fixture artist", browseId: "fixture-artist" }],
    album: null,
    ...overrides,
  };
}

const seed = track("seed0000001");
const queued = track("queue000001");
const novel = track("novel000001");
const later = track("later000001");
const manual = track("manual00001");
const local = track("local-track", { videoId: null, source: "local", localPath: "C:/fixture/song.mp3" });
const onToast = vi.fn();
let player: ReturnType<typeof usePlayer>;
let playback: ReturnType<typeof usePlayback>;
let playbackRenders: number;
let root: Root | null;
let host: HTMLDivElement;

function TransportProbe() {
  player = usePlayer();
  return null;
}

function PlaybackProbe() {
  playback = usePlayback();
  playbackRenders++;
  return null;
}

async function update(action: () => void = () => {}) {
  await act(async () => {
    action();
  });
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function audio() {
  const current = FakeAudio.instances.at(-1);
  if (!current) throw new Error("No audio element was created");
  return current;
}

function ids() {
  return player.queue.map((item) => item.videoId);
}

async function start(items: MediaItem[] = [seed], index = 0) {
  await update(() => player.playItems(items, index));
}

async function end() {
  await update(() => audio().finish());
}

function expectStopped() {
  expect(player.playing).toBe(false);
  expect(player.loading).toBe(false);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Audio", FakeAudio);
  window.localStorage.clear();
  FakeAudio.instances = [];
  playbackRenders = 0;
  onToast.mockReset();
  backend.streamUrl.mockReset().mockImplementation(async (videoId) => `https://fixture.invalid/${videoId}`);
  backend.recommendations.mockReset().mockResolvedValue([]);
  backend.watchTrack.mockReset().mockImplementation(async (videoId) => track(videoId));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await update(() => root!.render(
    <StrictMode>
      <PlayerProvider onToast={onToast}>
        <TransportProbe />
        <PlaybackProbe />
      </PlayerProvider>
    </StrictMode>,
  ));
});

afterEach(async () => {
  await update(() => root?.unmount());
  root = null;
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("clip audio handoff", () => {
  it("keeps playing until takeover, then resumes at the last clip position", async () => {
    await start();
    const source = audio();
    source.currentTime = 43;
    const handoff = player.createClipHandoff();
    expect(source.paused).toBe(false);
    expect(handoff.snapshot()).toMatchObject({ position: 43, playing: true });
    let lease!: NonNullable<ReturnType<typeof handoff.takeOver>>;
    source.currentTime = 61;
    await update(() => { lease = handoff.takeOver()!; });
    expect(source.paused).toBe(true);
    await update(() => player.toggle());
    expect(source.paused).toBe(true);
    await update(() => lease.sync(89.6));
    expect(player.progress).toBe(89.6);
    expect(source.currentTime).toBe(61);
    await update(() => lease.sync(89.6, { playing: false, duration: 205 }));
    expect(player.clipPlayback).toEqual({ playing: false, duration: 205 });
    await update(lease.release);
    expect(audio()).toBe(source);
    expect(source.currentTime).toBe(89.6);
    expect(player.playing).toBe(true);
    expect(player.clipPlayback).toBeNull();
  });

  it("does not start previously paused audio when leaving a clip", async () => {
    await start();
    await update(() => player.toggle());
    let release!: () => void;
    await update(() => { release = player.createClipHandoff().takeOver()!.release; });
    await update(release);
    expectStopped();
  });

  it("does not revive the previous track after a queue change", async () => {
    await start();
    const old = audio();
    const handoff = player.createClipHandoff();
    let release!: () => void;
    await update(() => { release = handoff.takeOver()!.release; });
    await start([queued]);
    expect(handoff.snapshot()).toBeNull();
    expect(handoff.takeOver()).toBeNull();
    await update(release);
    expect(old.paused).toBe(true);
    expect(player.current).toBe(queued);
    expect(player.playing).toBe(true);
  });
});

describe("queue and stream regressions", () => {
  it("selects the original requested row after filtering unplayable items", async () => {
    await start([track("invalid", { videoId: null }), seed, queued], 2);
    expect(player.current).toBe(queued);
    expect(player.index).toBe(1);
    expect(backend.streamUrl).toHaveBeenCalledWith(queued.videoId);
  });

  it("keeps duplicate object references at the requested original queue position", async () => {
    await start([seed, queued, seed], 2);
    expect(player.index).toBe(2);
    expect(player.current).toBe(seed);
  });

  it("advances rapidly without running playback side effects in state updaters", async () => {
    await update(() => {
      player.playItems([seed, queued, novel], 0);
      player.next();
      player.next();
    });
    expect(player.current).toBe(novel);
    expect(FakeAudio.instances).toHaveLength(3);
    expect(FakeAudio.instances.map((item) => item.play.mock.calls.length)).toEqual([0, 0, 1]);
    expect(FakeAudio.instances[0].src).toBe("");
    expect(FakeAudio.instances[1].src).toBe("");
    expect(player.playing).toBe(true);
  });

  it("ignores out-of-order stream responses and stops old audio immediately", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    backend.streamUrl.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await start([seed, queued]);
    const old = audio();
    await update(() => player.next());
    const active = audio();
    expect(old.paused).toBe(true);
    expect(old.src).toBe("");
    await update(() => second.resolve("fixture:active"));
    await update(() => first.resolve("fixture:stale"));
    expect(active.src).toBe("fixture:active");
    expect(active.play).toHaveBeenCalledTimes(1);
    expect(old.play).not.toHaveBeenCalled();
    expect(player.current).toBe(queued);
    expect(player.playing).toBe(true);
  });

  it("does not autoplay when paused while stream lookup is pending", async () => {
    const stream = deferred<string>();
    backend.streamUrl.mockReturnValueOnce(stream.promise);
    await start();
    await update(() => player.toggle());
    await update(() => stream.resolve("fixture:paused"));
    expectStopped();
    expect(audio().play).not.toHaveBeenCalled();
    await update(() => player.toggle());
    expect(audio().play).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(true);
  });

  it("ignores a superseded audio.play rejection instead of reloading its track", async () => {
    const stream = deferred<string>();
    const play = deferred<void>();
    backend.streamUrl.mockReturnValueOnce(stream.promise);
    await start([seed, queued]);
    audio().playOverride = () => play.promise;
    await update(() => stream.resolve("fixture:old"));
    await update(() => player.next());
    const requests = backend.streamUrl.mock.calls.length;
    await update(() => play.reject(new DOMException("Obsolete source", "NotSupportedError")));
    expect(player.current).toBe(queued);
    expect(player.playing).toBe(true);
    expect(backend.streamUrl).toHaveBeenCalledTimes(requests);
    expect(onToast).not.toHaveBeenCalled();
  });

  it("ignores old media callbacks after a new queue replaces the source", async () => {
    await start();
    const old = audio();
    const callbacks = [old.ontimeupdate, old.ondurationchange, old.onended, old.onplay, old.onpause, old.onerror];
    await start([manual]);
    old.currentTime = 99;
    old.duration = 999;
    await update(() => callbacks.forEach((callback) => callback?.()));
    expect(player.current).toBe(manual);
    expect(player.progress).toBe(0);
    expect(player.duration).toBe(180);
    expect(player.playing).toBe(true);
    expect(ids()).toEqual([manual.videoId]);
  });

  it("does not apply stale metadata enrichment to a replacement queue", async () => {
    const full = deferred<MediaItem>();
    backend.watchTrack.mockReturnValueOnce(full.promise);
    const incomplete = track(seed.videoId!, { artists: [] });
    await start([incomplete]);
    await start([manual]);
    await update(() => full.resolve(seed));
    expect(player.queue).toEqual([manual]);
    expect(player.current).toBe(manual);
  });

  it("plays local files without stream or online recommendation calls", async () => {
    await start([local]);
    expect(audio().src).toBe("http://localmedia.localhost/C%3A%2Ffixture%2Fsong.mp3");
    expect(player.playing).toBe(true);
    await end();
    expectStopped();
    expect(backend.streamUrl).not.toHaveBeenCalled();
    expect(backend.recommendations).not.toHaveBeenCalled();
  });

  it("plays a favourited track from its downloaded copy without asking for a stream", async () => {
    applyDownloads({
      count: 1,
      bytes: 4_000_000,
      items: [{
        videoId: seed.videoId!,
        title: seed.title,
        subtitle: "",
        duration: 180,
        thumb: null,
        path: "C:/downloads/seed.webm",
        bytes: 4_000_000,
        hasCover: true,
      }],
    });
    await start([seed]);
    expect(audio().src).toBe("http://localmedia.localhost/C%3A%2Fdownloads%2Fseed.webm");
    expect(backend.streamUrl).not.toHaveBeenCalled();
    applyDownloads({ count: 0, bytes: 0, items: [] });
  });

  it("clamps valid controls and ignores non-finite seek or volume values", async () => {
    await start();
    await update(() => {
      player.setVolume(0.4);
      player.setVolume(Number.NaN);
      player.seek(Number.POSITIVE_INFINITY);
    });
    expect(player.volume).toBe(0.4);
    expect(player.progress).toBe(0);
    await update(() => player.seek(999));
    expect(player.progress).toBe(180);
    await update(() => player.setVolume(9));
    expect(player.volume).toBe(1);
  });

  it("bounds a stalled stream startup and ignores its late response", async () => {
    const stream = deferred<string>();
    backend.streamUrl.mockReturnValueOnce(stream.promise);
    await start();
    const pendingAudio = audio();
    await advanceTime(29_999);
    expect(player.loading).toBe(true);
    await advanceTime(1);
    expectStopped();
    expect(pendingAudio.src).toBe("");
    expect(onToast).toHaveBeenCalledWith("Превышено время ожидания воспроизведения.", "error");
    await update(() => stream.resolve("fixture:late"));
    expect(pendingAudio.play).not.toHaveBeenCalled();
    expectStopped();
  });

  it("bounds a hanging audio.play and prevents late completion from reviving it", async () => {
    const stream = deferred<string>();
    const play = deferred<void>();
    backend.streamUrl.mockReturnValueOnce(stream.promise);
    await start();
    const pendingAudio = audio();
    pendingAudio.playOverride = () => play.promise;
    await update(() => stream.resolve("fixture:stalled"));
    await advanceTime(30_000);
    expectStopped();
    expect(pendingAudio.src).toBe("");
    await update(() => play.resolve(undefined));
    expectStopped();
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  it("clears startup and prefetch timers on unmount and ignores late results", async () => {
    const stream = deferred<string>();
    const radio = deferred<MediaItem[]>();
    backend.streamUrl.mockReturnValueOnce(stream.promise);
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    const pendingAudio = audio();
    await update(() => root!.unmount());
    root = null;
    await update(() => {
      stream.resolve("fixture:unmounted");
      radio.resolve([novel]);
    });
    expect(pendingAudio.play).not.toHaveBeenCalled();
    expect(pendingAudio.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe("stable playback subscriptions", () => {
  it("does not notify playback consumers for progress, duration, volume, or mute", async () => {
    await start();
    const stable = playback;
    const renders = playbackRenders;
    const media = audio();
    media.currentTime = 12;
    await update(() => media.ontimeupdate?.());
    media.duration = 210;
    await update(() => media.ondurationchange?.());
    await update(() => player.setVolume(0.4));
    await update(() => player.toggleMute());
    expect(player.progress).toBe(12);
    expect(player.duration).toBe(210);
    expect(player.volume).toBe(0.4);
    expect(player.muted).toBe(true);
    expect(playback).toBe(stable);
    expect(playbackRenders).toBe(renders);
    expect(playback).not.toHaveProperty("progress");
    expect(playback).not.toHaveProperty("duration");
    expect(playback).not.toHaveProperty("volume");
    expect(playback).not.toHaveProperty("muted");
  });

  it("does notify playback consumers when the selected queue item changes", async () => {
    await start([seed, queued]);
    const stable = playback;
    const renders = playbackRenders;
    await update(() => playback.next());
    expect(playback.current).toBe(queued);
    expect(playback).not.toBe(stable);
    expect(playbackRenders).toBeGreaterThan(renders);
  });
});

describe("natural-end recommendation continuation", () => {
  it("prefetches recommendations without starting them before natural ended", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    expect(backend.recommendations).toHaveBeenCalledExactlyOnceWith(seed.videoId);
    expect(player.loading).toBe(false);
    await update(() => radio.resolve([novel, later]));
    await advanceTime(1000);
    expect(ids()).toEqual([seed.videoId]);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(audio().play).toHaveBeenCalledTimes(1);
    expect(backend.streamUrl).not.toHaveBeenCalledWith(novel.videoId);
    expect(player.playing).toBe(true);
    await end();
    expect(ids()).toEqual([seed.videoId, novel.videoId]);
    expect(player.current).toBe(novel);
    expect(player.playing).toBe(true);
    expect(player.loading).toBe(false);
  });

  it("appends one novel recommendation at each successive natural tail end", async () => {
    backend.recommendations.mockImplementation(async (videoId) => {
      if (videoId === seed.videoId) return [seed, novel, later];
      if (videoId === novel.videoId) return [seed, novel, later];
      return [];
    });
    await start();
    await end();
    expect(ids()).toEqual([seed.videoId, novel.videoId]);
    expect(player.current).toBe(novel);
    await end();
    expect(ids()).toEqual([seed.videoId, novel.videoId, later.videoId]);
    expect(player.current).toBe(later);
    expect(player.playing).toBe(true);
    expect(backend.recommendations.mock.calls.map(([videoId]) => videoId)).toEqual([seed.videoId, novel.videoId, later.videoId]);
  });

  it("does not request radio before queued manual tracks have been reached", async () => {
    backend.recommendations.mockResolvedValueOnce([novel]);
    await start([seed, queued]);
    expect(backend.recommendations).not.toHaveBeenCalled();
    await end();
    expect(player.current).toBe(queued);
    expect(ids()).toEqual([seed.videoId, queued.videoId]);
    expect(backend.recommendations).toHaveBeenCalledExactlyOnceWith(queued.videoId);
    expect(backend.streamUrl).not.toHaveBeenCalledWith(novel.videoId);
    await end();
    expect(player.current).toBe(novel);
  });

  it("does not use manual next at the tail to start a recommendation", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await update(() => player.next());
    await update(() => radio.resolve([novel]));
    expect(ids()).toEqual([seed.videoId]);
    expectStopped();
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it("rejects seed, current, earlier queued, local, and missing-id candidates", async () => {
    backend.recommendations.mockResolvedValueOnce([
      seed, queued, manual, local,
      track("missing", { videoId: null }),
      track("local-id", { source: "local" }),
      novel, novel, later,
    ]);
    await start([seed, manual, queued], 2);
    await end();
    expect(ids()).toEqual([seed.videoId, manual.videoId, queued.videoId, novel.videoId]);
    expect(player.current).toBe(novel);
    expect(backend.streamUrl).not.toHaveBeenCalledWith(later.videoId);
    expect(backend.streamUrl).not.toHaveBeenCalledWith("local-id");
  });

  it("stops when every subsequent recommendation is already in the queue", async () => {
    backend.recommendations.mockResolvedValueOnce([novel, novel]).mockResolvedValueOnce([seed, novel, novel]);
    await start();
    await end();
    await end();
    expect(ids()).toEqual([seed.videoId, novel.videoId]);
    expectStopped();
    const calls = backend.recommendations.mock.calls.length;
    await advanceTime(60_000);
    expect(backend.recommendations).toHaveBeenCalledTimes(calls);
  });

  it.each(["enqueue", "playNext"] as const)("prioritizes %s added while recommendation prefetch is pending", async (action) => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await update(() => player[action](manual));
    expect(player.current).toBe(seed);
    await update(() => radio.resolve([novel]));
    await end();
    expect(player.current).toBe(manual);
    expect(ids()).toEqual([seed.videoId, manual.videoId]);
    expect(player.playing).toBe(true);
  });

  it.each([
    { action: "enqueue" as const, shuffle: false },
    { action: "playNext" as const, shuffle: false },
    { action: "enqueue" as const, shuffle: true },
    { action: "playNext" as const, shuffle: true },
  ])("prioritizes $action during a tail lookup with shuffle=$shuffle", async ({ action, shuffle }) => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    if (shuffle) await update(() => player.toggleShuffle());
    await start();
    await end();
    expect(player.loading).toBe(true);
    await update(() => player[action](manual));
    expect(player.current).toBe(manual);
    expect(player.playing).toBe(true);
    expect(player.loading).toBe(false);
    await update(() => radio.resolve([novel]));
    expect(ids()).toEqual([seed.videoId, manual.videoId]);
    expect(player.current).toBe(manual);
    expect(player.playing).toBe(true);
  });

  it("honors a manual insertion in the same turn that a tail lookup resolves", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await end();
    await update(() => {
      radio.resolve([novel]);
      player.playNext(manual);
    });
    expect(ids()).toEqual([seed.videoId, manual.videoId]);
    expect(player.current).toBe(manual);
    expect(player.playing).toBe(true);
  });
});

describe("repeat and shuffle semantics", () => {
  it("repeat-one reuses the same source and never requests radio", async () => {
    await update(() => {
      player.cycleRepeat();
      player.cycleRepeat();
    });
    await start();
    const repeated = audio();
    await end();
    expect(player.repeat).toBe("one");
    expect(player.upNext).toEqual([]);
    expect(player.current).toBe(seed);
    expect(repeated.currentTime).toBe(0);
    expect(repeated.play).toHaveBeenCalledTimes(2);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(backend.recommendations).not.toHaveBeenCalled();
    expect(player.playing).toBe(true);
  });

  it("repeat-all wraps the manual queue instead of requesting radio", async () => {
    await update(() => player.cycleRepeat());
    await start([seed, queued], 1);
    expect(player.upNext[0]).toBe(0);
    await end();
    expect(player.current).toBe(seed);
    expect(ids()).toEqual([seed.videoId, queued.videoId]);
    expect(backend.recommendations).not.toHaveBeenCalled();
    expect(player.playing).toBe(true);
  });

  it.each([1, 2])("switching repeat mode with %i cycle(s) cancels a pending tail result", async (cycles) => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await end();
    await update(() => {
      for (let count = 0; count < cycles; count++) player.cycleRepeat();
    });
    await update(() => radio.resolve([novel]));
    expect(ids()).toEqual([seed.videoId]);
    expectStopped();
    expect(backend.recommendations).toHaveBeenCalledTimes(1);
  });

  it("extends the actual shuffle tail, preserving traversal and previous order", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    backend.recommendations.mockResolvedValueOnce([novel]);
    await update(() => player.toggleShuffle());
    await start([seed, queued, manual]);
    const order = [player.index, ...player.upNext];
    expect(new Set(order).size).toBe(3);
    for (const expected of order.slice(1)) {
      await end();
      expect(player.index).toBe(expected);
    }
    const tail = player.current;
    expect(backend.recommendations).toHaveBeenCalledExactlyOnceWith(tail?.videoId);
    await end();
    expect(player.current).toBe(novel);
    expect(player.index).toBe(3);
    expect(ids()).toEqual([seed.videoId, queued.videoId, manual.videoId, novel.videoId]);
    await update(() => player.previous());
    expect(player.current).toBe(tail);
    await update(() => player.next());
    expect(player.current).toBe(novel);
  });

  it("shuffle with repeat-all follows its wrapped preview without radio", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await update(() => {
      player.toggleShuffle();
      player.cycleRepeat();
    });
    await start([seed, queued, manual]);
    for (let count = 0; count < 4; count++) {
      const expected = player.upNext[0];
      await end();
      expect(player.index).toBe(expected);
    }
    expect(backend.recommendations).not.toHaveBeenCalled();
    expect(player.queue).toHaveLength(3);
  });
});

describe("cancellation and bounded radio lookup", () => {
  it.each(["pause", "seek", "previous"] as const)("ignores a queued ended callback after %s changes playback intent", async (action) => {
    backend.recommendations.mockResolvedValueOnce([novel]);
    await start();
    const media = audio();
    const ended = media.onended;
    await update(() => {
      media.currentTime = media.duration;
      media.paused = true;
      media.ended = true;
      media.onpause?.();
    });
    await update(() => {
      if (action === "pause") player.toggle();
      else if (action === "seek") player.seek(42);
      else player.previous();
    });
    const requests = backend.recommendations.mock.calls.length;
    await update(() => ended?.());
    expect(ids()).toEqual([seed.videoId]);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(backend.recommendations).toHaveBeenCalledTimes(requests);
    expectStopped();
    const source = media.src;
    const streamRequests = backend.streamUrl.mock.calls.length;
    await update(() => player.toggle());
    expect(player.current).toBe(seed);
    expect(ids()).toEqual([seed.videoId]);
    expect(audio()).toBe(media);
    expect(media.src).toBe(source);
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(media.paused).toBe(false);
    expect(player.playing).toBe(true);
    expect(player.loading).toBe(false);
    expect(backend.streamUrl).toHaveBeenCalledTimes(streamRequests);
    expect(backend.streamUrl).not.toHaveBeenCalledWith(novel.videoId);
    if (action === "seek") expect(media.currentTime).toBe(42);
    if (action === "previous") expect(media.currentTime).toBe(0);
    await update(() => ended?.());
    expect(ids()).toEqual([seed.videoId]);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(player.current).toBe(seed);
    expect(player.playing).toBe(true);
  });

  it("pausing a pending tail lookup prevents late recommendations from reviving playback", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await end();
    expect(player.loading).toBe(true);
    await update(() => player.toggle());
    expectStopped();
    await update(() => radio.resolve([novel]));
    await advanceTime(60_000);
    expectStopped();
    expect(ids()).toEqual([seed.videoId]);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(backend.recommendations).toHaveBeenCalledTimes(1);
    expect(onToast).not.toHaveBeenCalled();
  });

  it("a new playItems session cannot be replaced by the old pending recommendation", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await end();
    await start([manual]);
    await update(() => radio.resolve([novel]));
    expect(ids()).toEqual([manual.videoId]);
    expect(player.current).toBe(manual);
    expect(player.playing).toBe(true);
    expect(player.loading).toBe(false);
  });

  it.each(["jump", "previous", "rewind", "seek"] as const)("%s cancels a pending recommendation without late autoplay", async (action) => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start([seed, queued], 1);
    await end();
    if (action === "previous") audio().currentTime = 2;
    await update(() => {
      if (action === "jump") player.jumpTo(0);
      else if (action === "seek") player.seek(42);
      else player.previous();
    });
    const selected = player.current;
    const playing = player.playing;
    const created = FakeAudio.instances.length;
    await update(() => radio.resolve([novel]));
    expect(ids()).toEqual([seed.videoId, queued.videoId]);
    expect(player.current).toBe(selected);
    expect(player.playing).toBe(playing);
    expect(player.loading).toBe(false);
    expect(FakeAudio.instances).toHaveLength(created);
    if (action === "seek") expect(player.progress).toBe(42);
    if (action === "jump" || action === "previous") expect(player.current).toBe(seed);
    else expectStopped();
  });

  it("unmount cancels a waiting lookup, removes timers, and ignores late callbacks", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    const media = audio();
    const ended = media.onended;
    await end();
    await update(() => root!.unmount());
    root = null;
    const instances = FakeAudio.instances.length;
    await update(() => {
      ended?.();
      radio.resolve([novel]);
    });
    await advanceTime(60_000);
    expect(FakeAudio.instances).toHaveLength(instances);
    expect(media.src).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(onToast).not.toHaveBeenCalled();
  });

  it("bounds a pending radio lookup at 15 seconds with no spinner or retry loop", async () => {
    const radio = deferred<MediaItem[]>();
    backend.recommendations.mockReturnValueOnce(radio.promise);
    await start();
    await end();
    await advanceTime(14_999);
    expect(player.loading).toBe(true);
    expect(player.playing).toBe(false);
    await advanceTime(1);
    expectStopped();
    expect(onToast).toHaveBeenCalledWith("Превышено время ожидания рекомендаций YouTube Music.", "error");
    await update(() => radio.resolve([novel]));
    await advanceTime(60_000);
    expectStopped();
    expect(ids()).toEqual([seed.videoId]);
    expect(backend.recommendations).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  it("a prefetch timeout does not interrupt the current track or restart the lookup on ended", async () => {
    backend.recommendations.mockReturnValueOnce(deferred<MediaItem[]>().promise);
    await start();
    await advanceTime(15_000);
    expect(player.playing).toBe(true);
    expect(player.loading).toBe(false);
    expect(onToast).not.toHaveBeenCalled();
    await end();
    expectStopped();
    expect(backend.recommendations).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledTimes(1);
    await advanceTime(60_000);
    expect(backend.recommendations).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "failure", "api failure"] as const)("exits %s recommendations without a spinner or automatic retry", async (outcome) => {
    if (outcome === "empty") backend.recommendations.mockResolvedValueOnce([]);
    else if (outcome === "failure") backend.recommendations.mockRejectedValueOnce(new Error("Offline"));
    else backend.recommendations.mockRejectedValueOnce(new ApiFailure({ message: "Fixture radio denied", needsAuth: false, needsPlayer: true }));
    await start();
    expect(onToast).not.toHaveBeenCalled();
    await end();
    expectStopped();
    expect(ids()).toEqual([seed.videoId]);
    await advanceTime(60_000);
    expect(backend.recommendations).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(1);
    if (outcome === "empty") expect(onToast).not.toHaveBeenCalled();
    else expect(onToast).toHaveBeenCalledTimes(1);
    if (outcome === "api failure") expect(onToast).toHaveBeenCalledWith("Fixture radio denied", "error");
  });
});
