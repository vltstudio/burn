import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "installed" | "restarting" | "error";

interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdaterState {
  phase: Phase;
  info: UpdateInfo | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  busy: boolean;
}

export interface AppUpdater {
  supported: boolean;
  state: UpdaterState;
  noticeVisible: boolean;
  check: () => void;
  cancelCheck: () => void;
  install: () => void;
  restart: () => void;
  dismissNotice: () => void;
}

const initialState: UpdaterState = { phase: "idle", info: null, downloaded: 0, total: null, error: null, busy: false };

function release(update: Update | null) {
  if (update) void update.close().catch(() => {});
}

export function updaterSupported(): boolean {
  return import.meta.env.PROD && typeof window !== "undefined" && isTauri()
    && !window.location.pathname.endsWith("/preview.html");
}

export function useAppUpdater(): AppUpdater {
  const supported = updaterSupported();
  const [state, setState] = useState<UpdaterState>(initialState);
  const [dismissed, setDismissed] = useState(false);
  const active = useRef(false);
  const serial = useRef(0);
  const operation = useRef<{ id: number; kind: "check" | "install" | "restart"; timedOut?: boolean } | null>(null);
  const resource = useRef<Update | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const checkUpdates = useCallback(async (manual: boolean) => {
    if (!supported || !active.current || operation.current) return;
    const id = ++serial.current;
    operation.current = { id, kind: "check" };
    release(resource.current);
    resource.current = null;
    setState({ ...initialState, phase: "checking", busy: true });
    const deadline = window.setTimeout(() => {
      if (!active.current || operation.current?.id !== id) return;
      operation.current = null;
      timer.current = null;
      setState({ ...initialState, phase: manual ? "error" : "idle", error: manual ? "Проверка обновлений не ответила вовремя. Попробуйте позже." : null });
    }, 20_000);
    timer.current = deadline;
    try {
      const update = await check({ timeout: 15_000 });
      if (!active.current || operation.current?.id !== id) {
        release(update);
        return;
      }
      operation.current = null;
      resource.current = update;
      setState({
        ...initialState,
        phase: update ? "available" : "current",
        info: update ? { version: update.version, currentVersion: update.currentVersion, notes: update.body?.trim() || null } : null,
      });
      if (update) setDismissed(false);
    } catch {
      if (!active.current || operation.current?.id !== id) return;
      operation.current = null;
      setState({ ...initialState, phase: manual ? "error" : "idle", error: manual ? "Не удалось проверить обновления. Проверьте подключение и попробуйте снова." : null });
    } finally {
      if (timer.current === deadline) clearTimer();
    }
  }, [supported, clearTimer]);

  const cancelCheck = useCallback(() => {
    if (operation.current?.kind !== "check") return;
    operation.current = null;
    clearTimer();
    setState(initialState);
  }, [clearTimer]);

  const install = useCallback(async () => {
    const update = resource.current;
    if (!supported || !active.current || operation.current || !update) return;
    const id = ++serial.current;
    operation.current = { id, kind: "install" };
    setDismissed(false);
    setState((current) => ({ ...current, phase: "downloading", downloaded: 0, total: null, error: null, busy: true }));
    const deadline = window.setTimeout(() => {
      if (!active.current || operation.current?.id !== id) return;
      operation.current.timedOut = true;
      timer.current = null;
      setState((current) => ({ ...current, phase: "error", error: "Обновление не ответило вовремя. Установка может продолжаться; не запускайте её повторно.", busy: true }));
    }, 180_000);
    timer.current = deadline;
    try {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (!active.current || operation.current?.id !== id || operation.current.timedOut) return;
        if (event.event === "Started") {
          downloaded = 0;
          setState((current) => ({ ...current, downloaded: 0, total: event.data.contentLength && event.data.contentLength > 0 ? event.data.contentLength : null }));
        } else if (event.event === "Progress") {
          downloaded += Math.max(0, event.data.chunkLength);
          setState((current) => ({ ...current, downloaded }));
        } else {
          setState((current) => ({ ...current, phase: "installing" }));
        }
      }, { timeout: 120_000 });
      if (!active.current || operation.current?.id !== id) return;
      operation.current = null;
      resource.current = null;
      release(update);
      setState((current) => ({ ...current, phase: "installed", error: null, busy: false }));
    } catch {
      if (!active.current || operation.current?.id !== id) return;
      operation.current = null;
      resource.current = null;
      release(update);
      setState({ ...initialState, phase: "error", error: "Не удалось завершить обновление. Проверьте подключение и повторите проверку обновлений." });
    } finally {
      if (timer.current === deadline) clearTimer();
    }
  }, [supported, clearTimer]);

  const restart = useCallback(async () => {
    if (!supported || !active.current || operation.current || state.phase !== "installed") return;
    const id = ++serial.current;
    operation.current = { id, kind: "restart" };
    setState((current) => ({ ...current, phase: "restarting", error: null, busy: true }));
    const deadline = window.setTimeout(() => {
      if (!active.current || operation.current?.id !== id) return;
      operation.current.timedOut = true;
      timer.current = null;
      setState((current) => ({ ...current, phase: "error", error: "Перезапуск не ответил вовремя. Закройте и откройте BURN вручную.", busy: true }));
    }, 20_000);
    timer.current = deadline;
    try {
      await relaunch();
      if (!active.current || operation.current?.id !== id) return;
      operation.current = null;
      setState((current) => ({ ...current, phase: "installed", error: "Запрос на перезапуск отправлен. Если окно осталось открытым, перезапустите BURN вручную.", busy: false }));
    } catch {
      if (!active.current || operation.current?.id !== id) return;
      operation.current = null;
      setState((current) => ({ ...current, phase: "installed", error: "Не удалось перезапустить BURN. Закройте и откройте приложение вручную.", busy: false }));
    } finally {
      if (timer.current === deadline) clearTimer();
    }
  }, [supported, state.phase, clearTimer]);

  useEffect(() => {
    active.current = true;
    const startup = supported ? window.setTimeout(() => { void checkUpdates(false); }, 0) : null;
    return () => {
      active.current = false;
      operation.current = null;
      if (startup !== null) window.clearTimeout(startup);
      clearTimer();
      release(resource.current);
      resource.current = null;
    };
  }, [supported, checkUpdates, clearTimer]);

  return {
    supported,
    state,
    noticeVisible: !dismissed && (Boolean(state.info) || state.phase === "error" || state.busy && state.phase !== "checking"),
    check: () => { void checkUpdates(true); },
    cancelCheck,
    install: () => { void install(); },
    restart: () => { void restart(); },
    dismissNotice: () => setDismissed(true),
  };
}

const UpdaterContext = createContext<AppUpdater | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const updater = useAppUpdater();
  return <UpdaterContext.Provider value={updater}>{children}</UpdaterContext.Provider>;
}

export function useUpdater(): AppUpdater {
  const updater = useContext(UpdaterContext);
  if (!updater) throw new Error("UpdaterProvider is missing");
  return updater;
}
