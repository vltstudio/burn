import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipMode } from "./ClipMode";

const api = vi.hoisted(() => ({
  resolveClip: vi.fn<(id: string, kind: string | null) => Promise<string | null>>(),
  startClipEmbed: vi.fn<(id: string, channel: string) => Promise<string>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));
vi.mock("../api", () => ({ api }));

const song = "9mWr4c_ig54";
const clip = "E0S4W34zFMA";
const origin = "http://127.0.0.1:5173";

describe("ClipMode", () => {
  let host: HTMLDivElement;
  let root: Root;
  let close: () => void;

  const render = (videoId = song) => act(async () => {
    root.render(<ClipMode videoId={videoId} kind="song" title="My track" onClose={close} />);
  });
  const message = (status: string, overrides: MessageEventInit = {}) => act(async () => {
    const channel = api.startClipEmbed.mock.calls.at(-1)?.[1];
    window.dispatchEvent(new MessageEvent("message", {
      origin,
      source: window,
      data: { channel, status, code: 150 },
      ...overrides,
    }));
  });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((name, options) => {
      const element = createElement(name, options);
      if (element instanceof HTMLIFrameElement) element.srcdoc = "";
      return element;
    });
    api.resolveClip.mockReset().mockResolvedValue(clip);
    api.startClipEmbed.mockReset().mockImplementation(async (_, channel) => `${origin}/clip/${channel}`);
    api.openUrl.mockReset().mockResolvedValue();
    close = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("does not start an embed or offer an unrelated video for an audio-only item", async () => {
    api.resolveClip.mockResolvedValue(null);
    await render();
    expect(host.textContent).toContain("нет доступного клипа");
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).not.toContain("Открыть на YouTube");
    expect(api.startClipEmbed).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")?.click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("isolates the hosted frame and authenticates player messages before accepting them", async () => {
    await render();
    const iframe = host.querySelector("iframe");
    const channel = api.startClipEmbed.mock.calls[0][1];
    expect(channel).toMatch(/^[a-f0-9]{32}$/);
    expect(iframe?.getAttribute("src")).toBe(`${origin}/clip/${channel}`);
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-top-navigation");

    await message("ready", { origin: "https://www.youtube.com" });
    await message("ready", { source: null });
    await message("ready", { data: { channel: "other", status: "ready" } });
    expect(host.querySelector("[role=status]")?.textContent).toBe("Загружаем плеер YouTube…");

    await message("ready");
    expect(host.querySelector("[role=status]")?.textContent).toBe("Клип");
    expect(host.querySelector("iframe")).toBe(iframe);
  });

  it("stops a blocked player and opens only the resolved clip on explicit request", async () => {
    await render();
    await message("ready");
    await message("error");
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("не разрешает встроенное воспроизведение");
    expect(api.openUrl).not.toHaveBeenCalled();
    const youtubeButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Открыть на YouTube"));
    expect(youtubeButton).toBeDefined();
    await act(async () => youtubeButton?.click());
    expect(api.openUrl).toHaveBeenCalledExactlyOnceWith(`https://www.youtube.com/watch?v=${clip}`);
  });

  it("does not navigate to a URL outside the validated loopback relay", async () => {
    api.startClipEmbed.mockResolvedValue("https://example.org/malicious");
    await render();
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Не удалось воспроизвести");
  });

  it("shows an explicit fallback when the isolated player never reports ready", async () => {
    vi.useFakeTimers();
    await render();
    expect(host.querySelector("iframe")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(16_000));
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Открыть на YouTube");
    expect(api.openUrl).not.toHaveBeenCalled();
  });

  it("ignores a counterpart lookup that completes after changing tracks", async () => {
    let resolvePrevious!: (id: string) => void;
    api.resolveClip.mockImplementationOnce(() => new Promise((resolve) => { resolvePrevious = resolve; }));
    await render();
    expect(host.textContent).toContain("Ищем клип");
    api.resolveClip.mockResolvedValue(null);
    await render("M7lc1UVf-VE");
    await act(async () => resolvePrevious(clip));
    expect(host.textContent).toContain("нет доступного клипа");
    expect(api.startClipEmbed).not.toHaveBeenCalled();
  });
});
