import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { UpdateNotice, UpdateSettings } from "./components/UpdateSettings";
import { UpdaterProvider, useUpdater, type AppUpdater } from "./updater";

const native = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  check: vi.fn<(options?: { timeout?: number }) => Promise<Update | null>>(),
  relaunch: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: native.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: native.relaunch }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function update(version = "0.2.0") {
  const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const downloadAndInstall = vi.fn<Update["downloadAndInstall"]>().mockResolvedValue(undefined);
  return {
    value: { version, currentVersion: "0.1.2", body: "Signed release notes", close, downloadAndInstall } as unknown as Update,
    close,
    downloadAndInstall,
  };
}

let host: HTMLDivElement;
let root: Root;
let current: AppUpdater;
let showPanel: (visible: boolean) => void;

function Harness() {
  const [visible, setVisible] = useState(true);
  showPanel = setVisible;
  current = useUpdater();
  return <><UpdateNotice onOpen={() => setVisible(true)} />{visible ? <UpdateSettings /> : null}</>;
}

async function mount(strict = false) {
  await act(async () => {
    const content = <UpdaterProvider><Harness /></UpdaterProvider>;
    root.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
  await act(async () => { vi.advanceTimersByTime(0); });
}

function button(text: string) {
  const target = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!target) throw new Error(`Missing button: ${text}`);
  return target;
}

async function click(text: string) {
  await act(async () => { button(text).click(); });
}

async function confirmInstall() {
  await click("Установить обновление");
  await click("Загрузить и установить");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PROD", true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/");
  native.isTauri.mockReset().mockReturnValue(true);
  native.check.mockReset().mockResolvedValue(null);
  native.relaunch.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("VLT Music updater", () => {
  it.each([
    { name: "browser", native: false, production: true, path: "/" },
    { name: "development", native: true, production: false, path: "/" },
    { name: "preview", native: true, production: true, path: "/preview.html" },
  ])("does not invoke updater in $name", async (mode) => {
    native.isTauri.mockReturnValue(mode.native);
    vi.stubEnv("PROD", mode.production);
    window.history.replaceState(null, "", mode.path);
    await mount();
    expect(current.supported).toBe(false);
    expect(native.check).not.toHaveBeenCalled();
    expect(button("Проверить обновления").disabled).toBe(true);
    expect(native.relaunch).not.toHaveBeenCalled();
  });

  it("checks once at startup in StrictMode and never installs automatically", async () => {
    const candidate = update();
    native.check.mockResolvedValue(candidate.value);
    await mount(true);
    expect(native.check).toHaveBeenCalledExactlyOnceWith({ timeout: 15_000 });
    expect(current.state.phase).toBe("available");
    expect(host.querySelector(".update-notice")?.textContent).toContain("0.2.0");
    expect(candidate.downloadAndInstall).not.toHaveBeenCalled();
    expect(native.relaunch).not.toHaveBeenCalled();
  });

  it("reports current only after a successful check with no update", async () => {
    await mount();
    expect(current.state.phase).toBe("current");
    expect(host.textContent).toContain("Установлена актуальная версия");
    expect(host.querySelector(".update-notice")).toBeNull();
  });

  it("keeps startup failures quiet but shows safe manual errors without claiming current", async () => {
    native.check.mockRejectedValue(new Error("404 Authorization: private-user-token@example.invalid"));
    await mount();
    expect(current.state.phase).toBe("idle");
    expect(current.state.error).toBeNull();
    expect(host.querySelector(".update-notice")).toBeNull();
    await click("Проверить обновления");
    expect(current.state.phase).toBe("error");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Не удалось проверить");
    expect(host.textContent).not.toContain("private-user-token");
    expect(host.textContent).not.toContain("актуальная версия");
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(native.check).toHaveBeenCalledTimes(2);
  });

  it("locks duplicate checks and releases resources from a canceled stale check", async () => {
    const pending = deferred<Update | null>();
    const stale = update("9.0.0");
    native.check.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
    await mount();
    await act(async () => { current.check(); current.check(); });
    expect(native.check).toHaveBeenCalledTimes(1);
    await click("Отменить проверку");
    await click("Проверить обновления");
    expect(current.state.phase).toBe("current");
    await act(async () => { pending.resolve(stale.value); });
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(current.state.info).toBeNull();
    expect(current.state.phase).toBe("current");
  });

  it("ends a stuck manual check and ignores its late update", async () => {
    await mount();
    const pending = deferred<Update | null>();
    const stale = update();
    native.check.mockReturnValueOnce(pending.promise);
    await click("Проверить обновления");
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(current.state.phase).toBe("error");
    expect(current.state.busy).toBe(false);
    await act(async () => { pending.resolve(stale.value); });
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(current.state.phase).toBe("error");
  });

  it("closes replaced and unmounted update resources", async () => {
    const first = update();
    const second = update("0.3.0");
    native.check.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    await mount();
    await click("Проверить обновления");
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(current.state.info?.version).toBe("0.3.0");
    await act(async () => { root.unmount(); });
    expect(second.close).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it("clears an old available version when a replacement check fails", async () => {
    const candidate = update();
    native.check.mockResolvedValueOnce(candidate.value).mockRejectedValueOnce(new Error("endpoint unavailable"));
    await mount();
    await click("Проверить обновления");
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(current.state.phase).toBe("error");
    expect(current.state.info).toBeNull();
    expect([...host.querySelectorAll("button")].some((item) => item.textContent?.includes("Установить обновление"))).toBe(false);
    expect(host.textContent).not.toContain("актуальная версия");
  });

  it("releases a check result that arrives after unmount", async () => {
    const pending = deferred<Update | null>();
    const candidate = update();
    native.check.mockReturnValue(pending.promise);
    await mount();
    await act(async () => { root.unmount(); });
    await act(async () => { pending.resolve(candidate.value); });
    expect(candidate.close).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it("requires install confirmation and keeps progress outside Settings", async () => {
    const candidate = update();
    const installing = deferred<void>();
    let progress!: (event: DownloadEvent) => void;
    candidate.downloadAndInstall.mockImplementation((handler) => { progress = handler!; return installing.promise; });
    native.check.mockResolvedValue(candidate.value);
    await mount();
    await act(async () => { button("Установить обновление").click(); button("Установить обновление").click(); });
    expect(candidate.downloadAndInstall).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Воспроизведение прервётся");
    await click("Отмена");
    expect(candidate.downloadAndInstall).not.toHaveBeenCalled();
    await confirmInstall();
    await act(async () => { current.install(); current.check(); });
    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(candidate.downloadAndInstall.mock.calls[0][1]).toEqual({ timeout: 120_000 });
    await act(async () => { progress({ event: "Started", data: { contentLength: 1024 } }); progress({ event: "Progress", data: { chunkLength: 512 } }); });
    expect(host.querySelector("progress")?.value).toBe(50);
    await act(async () => { showPanel(false); progress({ event: "Progress", data: { chunkLength: 256 } }); });
    expect(current.state.downloaded).toBe(768);
    expect(host.querySelector(".update-notice")).not.toBeNull();
    await act(async () => { showPanel(true); });
    expect(host.querySelector("progress")?.value).toBe(75);
    expect(host.querySelector(".updater-confirm")).toBeNull();
    await act(async () => { progress({ event: "Finished" }); });
    expect(current.state.phase).toBe("installing");
    await act(async () => { installing.resolve(); });
    expect(current.state.phase).toBe("installed");
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(native.relaunch).not.toHaveBeenCalled();
    await click("Перезапустить");
    expect(native.relaunch).not.toHaveBeenCalled();
    await click("Отмена");
    expect(native.relaunch).not.toHaveBeenCalled();
  });

  it("requires restart confirmation and locks duplicate relaunches", async () => {
    const candidate = update();
    const restarting = deferred<void>();
    native.check.mockResolvedValue(candidate.value);
    native.relaunch.mockReturnValue(restarting.promise);
    await mount();
    await confirmInstall();
    await click("Перезапустить");
    expect(native.relaunch).not.toHaveBeenCalled();
    await act(async () => { button("Перезапустить сейчас").click(); button("Перезапустить сейчас").click(); });
    expect(native.relaunch).toHaveBeenCalledTimes(1);
    await act(async () => { restarting.reject(new Error("sensitive local path")); });
    expect(current.state.phase).toBe("installed");
    expect(host.textContent).toContain("Не удалось перезапустить");
    expect(host.textContent).not.toContain("sensitive local path");
  });

  it("releases failed installs and does not automatically retry", async () => {
    const candidate = update();
    native.check.mockResolvedValue(candidate.value);
    candidate.downloadAndInstall.mockRejectedValue(new Error("signature or endpoint private details"));
    await mount();
    await confirmInstall();
    expect(current.state.phase).toBe("error");
    expect(current.state.info).toBeNull();
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("private details");
    await act(async () => { vi.advanceTimersByTime(240_000); });
    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(native.check).toHaveBeenCalledTimes(1);
  });

  it("ends a stuck restart spinner without sending a second relaunch", async () => {
    const candidate = update();
    const pending = deferred<void>();
    native.check.mockResolvedValue(candidate.value);
    native.relaunch.mockReturnValue(pending.promise);
    await mount();
    await confirmInstall();
    await click("Перезапустить");
    await click("Перезапустить сейчас");
    await act(async () => { vi.advanceTimersByTime(20_000); current.restart(); });
    expect(current.state.phase).toBe("error");
    expect(current.state.busy).toBe(true);
    expect(host.textContent).toContain("Перезапуск не ответил вовремя");
    expect(native.relaunch).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); });
  });

  it("replaces an indefinite install spinner with an honest warning without starting another install", async () => {
    const candidate = update();
    const pending = deferred<void>();
    let progress!: (event: DownloadEvent) => void;
    candidate.downloadAndInstall.mockImplementation((handler) => { progress = handler!; return pending.promise; });
    native.check.mockResolvedValue(candidate.value);
    await mount();
    await confirmInstall();
    await act(async () => { vi.advanceTimersByTime(180_000); });
    expect(current.state.phase).toBe("error");
    expect(current.state.busy).toBe(true);
    expect(host.querySelector("progress")).toBeNull();
    expect(host.textContent).toContain("Установка может продолжаться");
    await act(async () => { current.check(); current.install(); progress({ event: "Finished" }); });
    expect(native.check).toHaveBeenCalledTimes(1);
    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(current.state.phase).toBe("error");
    await act(async () => { pending.resolve(); });
    expect(current.state.phase).toBe("installed");
  });
});
