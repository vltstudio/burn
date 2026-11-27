import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordPresenceBridge, discordTrackActivity } from "./discord-presence";
import type { DiscordActivity, MediaItem } from "./types";

const fake = vi.hoisted(() => ({
  sync: vi.fn<(activity: DiscordActivity | null) => Promise<void>>(),
  player: vi.fn(),
}));
vi.mock("./api", () => ({ api: { discordPresenceSync: fake.sync } }));
vi.mock("./player", () => ({ usePlayer: fake.player }));

const track: MediaItem = {
  kind: "song", title: "Glass Horizon", subtitle: "Artist • Album", videoId: "example0001",
  browseId: null, playlistId: null, duration: "3:20", year: null,
  thumbs: [
    "https://lh3.googleusercontent.com/artwork=w120-h120",
    "https://lh3.googleusercontent.com/artwork=w540-h540",
  ],
  artists: [{ name: "Artist", browseId: "private-id-not-shared" }], album: null,
};
const local: MediaItem = {
  ...track, source: "local", localPath: "C:\\Music\\sample.flac", title: "C:\\Music\\sample.flac",
  videoId: "local:C:\\Music\\sample.flac", artists: [],
};

describe("Discord track presence", () => {
  let host: HTMLDivElement;
  let root: Root;
  let now: number;
  let player: {
    current: MediaItem | null;
    playing: boolean;
    loading: boolean;
    index: number;
    duration: number;
    progress: number;
    clipPlayback: { playing: boolean; duration: number } | null;
  };
  const render = (shareLocal = false) => act(async () => root.render(<DiscordPresenceBridge shareLocal={shareLocal} />));

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fake.sync.mockReset().mockResolvedValue(undefined);
    player = { current: track, playing: true, loading: false, index: 0, duration: 200, progress: 20, clipPlayback: null };
    fake.player.mockImplementation(() => player);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("publishes a stable timeline, updates on a seek, and clears on pause", async () => {
    await render();
    expect(fake.sync).toHaveBeenCalledExactlyOnceWith({
      title: "Glass Horizon", artist: "Artist", coverUrl: track.thumbs[1], startMs: now - 20_000, endMs: now + 180_000, local: false,
    });
    now += 500;
    player.progress += 0.5;
    await render();
    expect(fake.sync).toHaveBeenCalledTimes(1);
    player.progress = 78;
    await render();
    expect(fake.sync.mock.lastCall?.[0]?.startMs).toBe(now - 78_000);
    player.playing = false;
    await render();
    expect(fake.sync).toHaveBeenLastCalledWith(null);
    player.playing = true;
    await render();
    expect(fake.sync).toHaveBeenLastCalledWith(expect.objectContaining({ startMs: now - 78_000 }));
  });

  it("keeps a clip visible only while its video plays", async () => {
    player.playing = false;
    player.clipPlayback = { playing: true, duration: 204 };
    await render();
    expect(fake.sync.mock.lastCall?.[0]?.endMs).toBe(now + 184_000);
    player.clipPlayback = { playing: false, duration: 204 };
    await render();
    expect(fake.sync).toHaveBeenLastCalledWith(null);
  });

  it("never publishes an opted-out local track or sends its path", async () => {
    player.current = local;
    await render();
    expect(fake.sync).not.toHaveBeenCalled();
    await render(true);
    expect(fake.sync).toHaveBeenCalledExactlyOnceWith({
      title: "sample.flac", artist: null, coverUrl: null, startMs: now - 20_000, endMs: now + 180_000, local: true,
    });
    await render();
    expect(fake.sync).toHaveBeenLastCalledWith(null);
    expect(discordTrackActivity({ ...local, title: "file:private-metadata" }, 0, 0, true, now)).toBeNull();
  });

  it("replaces artwork when metadata updates and uses a video thumbnail when no cover is listed", async () => {
    await render();
    player.current = { ...track, thumbs: ["https://yt3.googleusercontent.com/changed=w600-h600"] };
    await render();
    expect(fake.sync).toHaveBeenLastCalledWith(expect.objectContaining({ coverUrl: player.current.thumbs[0] }));
    player.current = { ...track, thumbs: [] };
    await render();
    expect(fake.sync).toHaveBeenLastCalledWith(expect.objectContaining({
      coverUrl: "https://i.ytimg.com/vi/example0001/hqdefault.jpg",
    }));
  });

  it("does not publish a track until playback starts", async () => {
    player.loading = true;
    await render();
    expect(fake.sync).not.toHaveBeenCalled();
    player.loading = false;
    await render();
    expect(fake.sync).toHaveBeenCalledTimes(1);
  });
});
