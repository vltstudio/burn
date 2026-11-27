import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { RepeatMode } from "./player";
import type { MediaItem } from "./types";

export const QUICK_WINDOW = "quick-player";
export const QUICK_VISIBILITY = "vlt-quick-visibility";
export const QUICK_STATE = "vlt-quick-state";
export const QUICK_REQUEST = "vlt-quick-request";

export interface QuickPlacement {
  edge: "top" | "right" | "bottom" | "left";
  arrow: number;
}

export interface QuickState {
  current: MediaItem | null;
  playing: boolean;
  loading: boolean;
  progress: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  favorite: boolean;
}

export type QuickRequest =
  | { action: "snapshot" | "toggle" | "previous" | "next" | "mute" | "shuffle" | "repeat" | "favorite" }
  | { action: "seek" | "volume"; value: number }
  | { action: "play" | "enqueue"; item: MediaItem };

export const quickRequest = (request: QuickRequest) => emitTo("main", QUICK_REQUEST, request);
export const quickWindow = (action: "status" | "expand" | "compact" | "hide" | "open_main") =>
  invoke<QuickPlacement | null>("quick_window", { action });

export function subscribeQuick<T>(label: string, event: string, callback: (value: T) => void) {
  let active = true;
  const subscription = listen<T>(event, ({ payload }) => {
    if (active) callback(payload);
  }, { target: label });
  return {
    ready: subscription.then(() => undefined),
    dispose: () => {
      active = false;
      void subscription.then((unlisten) => unlisten(), () => undefined);
    },
  };
}
