import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveCoverUrl, localCoverUrl, localMediaUrl } from "./api";

const native = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  convertFileSrc: vi.fn<(path: string, protocol?: string) => string>(),
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: native.isTauri,
  convertFileSrc: native.convertFileSrc,
  invoke: native.invoke,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: native.openUrl }));

const platforms = [
  { name: "Windows native", native: true, base: "http://localmedia.localhost" },
  { name: "macOS native", native: true, base: "localmedia://localhost" },
  { name: "browser preview", native: false, base: "http://localmedia.localhost" },
];

const mediaPaths = [
  { name: "absolute Windows slash path", path: "C:/Music/song.mp3", encoded: "C%3A%2FMusic%2Fsong.mp3" },
  {
    name: "absolute Windows backslash path with Unicode and reserved characters",
    path: String.raw`C:\Music\Песня #1 & 100%.mp3`,
    encoded: "C%3A%5CMusic%5C%D0%9F%D0%B5%D1%81%D0%BD%D1%8F%20%231%20%26%20100%25.mp3",
  },
  { name: "absolute Unix path", path: "/Users/fixture/Music/track.mp3", encoded: "%2FUsers%2Ffixture%2FMusic%2Ftrack.mp3" },
  {
    name: "absolute Unix path with Unicode and reserved characters",
    path: "/Музыка/夜 #&%.flac",
    encoded: "%2F%D0%9C%D1%83%D0%B7%D1%8B%D0%BA%D0%B0%2F%E5%A4%9C%20%23%26%25.flac",
  },
  { name: "literal percent escape sequences", path: "/Music/literal%2Fname%20.flac", encoded: "%2FMusic%2Fliteral%252Fname%2520.flac" },
];

beforeEach(() => {
  native.isTauri.mockReset().mockReturnValue(false);
  native.convertFileSrc.mockReset().mockReturnValue("http://localmedia.localhost/");
  native.invoke.mockReset();
  native.openUrl.mockReset();
});

afterEach(() => {
  expect(native.invoke).not.toHaveBeenCalled();
  expect(native.openUrl).not.toHaveBeenCalled();
});

describe.each(platforms)("local-media URL helpers on $name", (platform) => {
  beforeEach(() => {
    native.isTauri.mockReturnValue(platform.native);
    native.convertFileSrc.mockReturnValue(`${platform.base}/`);
  });

  afterEach(() => {
    if (platform.native) {
      expect(native.convertFileSrc).toHaveBeenCalled();
      for (const args of native.convertFileSrc.mock.calls) expect(args).toEqual(["", "localmedia"]);
    } else {
      expect(native.convertFileSrc).not.toHaveBeenCalled();
    }
  });

  it.each(mediaPaths)("encodes $name exactly once without changing the protocol", ({ path, encoded }) => {
    const url = localMediaUrl(path);
    expect(url).toBe(`${platform.base}/${encoded}`);
    expect(decodeURIComponent(url.slice(platform.base.length + 1))).toBe(path);
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("");
  });

  it("keeps the cover/ routing prefix literal and encodes only its identifier", () => {
    const id = "a/b\\c#&%20 夜";
    const url = localCoverUrl(id);
    const route = url.slice(platform.base.length + 1);
    expect(url).toBe(`${platform.base}/cover/a%2Fb%5Cc%23%26%2520%20%E5%A4%9C`);
    expect(route.startsWith("cover/")).toBe(true);
    expect(decodeURIComponent(route.slice("cover/".length))).toBe(id);
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("");
  });

  it("does not confuse a cover identifier containing cover/ with the literal route", () => {
    expect(localCoverUrl("cover/item%2Fvalue")).toBe(`${platform.base}/cover/cover%2Fitem%252Fvalue`);
  });

  it.each([0, 17, 1_712_345_678_901])("preserves archive-cover routing and version %i", (version) => {
    const url = archiveCoverUrl(version);
    expect(url).toBe(`${platform.base}/archive-cover?v=${version}`);
    expect(new URL(url).pathname).toBe("/archive-cover");
    expect(new URL(url).searchParams.get("v")).toBe(String(version));
    expect(new URL(url).hash).toBe("");
  });

  it.each(["", "/", "///"])("joins all literal routes with one slash after converter suffix '%s'", (suffix) => {
    native.convertFileSrc.mockReturnValue(`${platform.base}${suffix}`);
    expect(localMediaUrl("/track.mp3")).toBe(`${platform.base}/%2Ftrack.mp3`);
    expect(localCoverUrl("folder/id")).toBe(`${platform.base}/cover/folder%2Fid`);
    expect(archiveCoverUrl(4)).toBe(`${platform.base}/archive-cover?v=4`);
  });
});

it("never calls the native converter in browser preview", () => {
  native.isTauri.mockReturnValue(false);
  native.convertFileSrc.mockImplementation(() => { throw new Error("No native bridge in preview"); });
  expect(localMediaUrl("C:\\song.mp3")).toBe("http://localmedia.localhost/C%3A%5Csong.mp3");
  expect(localCoverUrl("artist/#&%")).toBe("http://localmedia.localhost/cover/artist%2F%23%26%25");
  expect(archiveCoverUrl(42)).toBe("http://localmedia.localhost/archive-cover?v=42");
  expect(native.convertFileSrc).not.toHaveBeenCalled();
});
