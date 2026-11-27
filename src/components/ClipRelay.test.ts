import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const channel = "a".repeat(32);
const videoId = "dQw4w9WgXcQ";
const html = readFileSync("src-tauri/src/clip.html", "utf8");
const source = html.match(/<script nonce="__CLIP_CHANNEL__">([\s\S]*?)<\/script>/)?.[1];
if (!source) throw new Error("Missing clip relay script");
const runRelay = new Function("window", "document", "YT", "performance", source
  .replaceAll("__CLIP_CHANNEL__", channel)
  .replaceAll("__CLIP_ID__", videoId));

function fixture() {
  const youtube = {
    getCurrentTime: () => time,
    getDuration: () => 100,
    loadVideoById: vi.fn(),
    cueVideoById: vi.fn(),
    seekTo: vi.fn(),
    setVolume: vi.fn(),
    mute: vi.fn(),
    unMute: vi.fn(),
  };
  let time = 0;
  let tick = () => {};
  let receive!: (event: { source: object; data: object }) => void;
  let events!: {
    onReady: (event: { target: typeof youtube }) => void;
    onStateChange: (event: { data: number }) => void;
    onAutoplayBlocked: () => void;
  };
  const parent = { postMessage: vi.fn() };
  const frame = {
    parent,
    onYouTubeIframeAPIReady: () => {},
    addEventListener: (_type: string, callback: typeof receive) => { receive = callback; },
    setInterval: (callback: () => void) => { tick = callback; return 1; },
  };
  runRelay(frame, { createElement: () => ({}), head: { append: vi.fn() } }, {
    Player: class {
      constructor(_id: string, options: { events: typeof events }) { events = options.events; }
    },
    PlayerState: { PLAYING: 1, ENDED: 0 },
  }, { now: () => 0 });
  frame.onYouTubeIframeAPIReady();
  events.onReady({ target: youtube });
  return {
    youtube,
    events,
    send: (command: string, position: number, playing?: boolean, from = parent) =>
      receive({ source: from, data: { channel, command, position, playing, volume: .7, muted: false } }),
    sample: (position: number) => { time = position; tick(); },
    reports: () => parent.postMessage.mock.calls.map(([event]) => event),
  };
}

describe("YouTube iframe relay", () => {
  it("cues on autoplay refusal, then corrects the initial seek using the latest audio time", () => {
    const clip = fixture();
    clip.send("prepare", 1, true, { postMessage: vi.fn() });
    expect(clip.youtube.loadVideoById).not.toHaveBeenCalled();
    clip.send("prepare", 42, true);
    expect(clip.youtube.loadVideoById).toHaveBeenCalledExactlyOnceWith({ videoId, startSeconds: 42 });
    clip.events.onAutoplayBlocked();
    expect(clip.youtube.cueVideoById).toHaveBeenCalledExactlyOnceWith({ videoId, startSeconds: 42 });
    expect(clip.reports()).toEqual([
      { channel, status: "ready" },
      { channel, status: "autoplay-blocked" },
    ]);

    clip.sample(42);
    clip.events.onStateChange({ data: 1 });
    expect(clip.reports().at(-1)).toEqual({ channel, status: "playing", position: 42 });
    clip.send("synchronize", 59.5);
    expect(clip.youtube.seekTo).toHaveBeenCalledExactlyOnceWith(59.5, true);
    clip.sample(43);
    expect(clip.reports().at(-1)).toEqual({ channel, status: "playing", position: 42 });
    clip.sample(59.5);
    expect(clip.reports().at(-1)).toEqual({ channel, status: "time", position: 59.5 });
    clip.sample(88.3);
    expect(clip.reports().at(-1)).toEqual({ channel, status: "time", position: 88.3 });
  });

  it("cues a paused track and never seeks beyond the clip's duration", () => {
    const clip = fixture();
    clip.send("prepare", 27, false);
    expect(clip.youtube.loadVideoById).not.toHaveBeenCalled();
    expect(clip.youtube.cueVideoById).toHaveBeenCalledExactlyOnceWith({ videoId, startSeconds: 27 });
    clip.events.onStateChange({ data: 1 });
    clip.send("synchronize", 120);
    expect(clip.youtube.seekTo).toHaveBeenCalledExactlyOnceWith(99.75, true);
  });
});
