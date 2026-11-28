import { describe, expect, it } from "vitest";
import { applyDownloads, downloadLine, downloadedPath, formatBytes, hasDownloadedCover } from "./downloads";
import type { DownloadsSnapshot } from "./types";

const kept: DownloadsSnapshot = {
  count: 2,
  bytes: 26_000_000,
  items: [
    {
      videoId: "aaaaaaaaaaa", title: "A", subtitle: "", duration: 200, thumb: null,
      path: "C:\music\a.webm", bytes: 13_000_000, hasCover: true,
    },
    {
      videoId: "bbbbbbbbbbb", title: "B", subtitle: "", duration: null, thumb: null,
      path: "C:\music\b.m4a", bytes: 13_000_000, hasCover: false,
    },
  ],
};

describe("downloaded favourites", () => {
  it("remembers which track has a copy on disk", () => {
    applyDownloads(kept);
    expect(downloadedPath("aaaaaaaaaaa")).toBe("C:\music\a.webm");
    expect(hasDownloadedCover("aaaaaaaaaaa")).toBe(true);
    expect(hasDownloadedCover("bbbbbbbbbbb")).toBe(false);
    expect(downloadedPath("ccccccccccc")).toBeNull();
    expect(downloadedPath(null)).toBeNull();
  });

  it("forgets tracks that are no longer kept", () => {
    applyDownloads(kept);
    applyDownloads({ count: 0, bytes: 0, items: [] });
    expect(downloadedPath("aaaaaaaaaaa")).toBeNull();
    expect(hasDownloadedCover("aaaaaaaaaaa")).toBe(false);
  });

  it("reads sizes the way a person does", () => {
    expect(formatBytes(0)).toBe("0 Б");
    expect(formatBytes(999)).toBe("999 Б");
    expect(formatBytes(1536)).toBe("1,5 КБ");
    expect(formatBytes(26_000_000)).toBe("24,8 МБ");
    expect(formatBytes(Number.NaN)).toBe("0 Б");
  });

  it("describes the queue while it runs and the space once it is done", () => {
    expect(downloadLine(0, 0, {})).toBe("Скачается само, когда добавите трек в избранное");
    expect(downloadLine(2, 26_000_000, {})).toBe("Скачано 2 · 24,8 МБ — играет без интернета");
    expect(downloadLine(2, 26_000_000, {
      aaaaaaaaaaa: { videoId: "aaaaaaaaaaa", state: "downloading", received: 50, total: 100, message: null },
    })).toBe("Скачиваем 50%");
  });
});
