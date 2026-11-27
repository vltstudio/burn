import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { usePlayer } from "./player";
import type { DiscordActivity, DiscordPreferences, DiscordPresenceStatus, MediaItem } from "./types";
import { bigThumb } from "./ui/format";

export function useDiscordPresence() {
  const supported = isTauri() && !/Android|iPhone|iPad/i.test(navigator.userAgent)
    && !location.pathname.endsWith("/preview.html");
  const [preferences, setPreferences] = useState<DiscordPreferences | null>(null);
  const [status, setStatus] = useState<DiscordPresenceStatus>("idle");
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((value) => value + 1);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    let gotStatus = false;
    const subscription = listen<DiscordPresenceStatus>("discord-presence-status", ({ payload }) => {
      if (alive) {
        gotStatus = true;
        setStatus(payload);
      }
    }, { target: "main" });
    setLoadError(false);
    void subscription.catch(() => undefined).then(() => api.discordPresenceGet()).then((view) => {
      if (!alive) return;
      setPreferences(view.preferences);
      if (!gotStatus) setStatus(view.status);
    }).catch(() => {
      if (alive) setLoadError(true);
    });
    return () => {
      alive = false;
      void subscription.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [supported, attempt]);

  const configure = useCallback(async (next: DiscordPreferences) => {
    setPreferences(await api.discordPresenceConfigure(next));
  }, []);

  return { supported, preferences, status, loadError, retry, configure };
}

const absolutePath = /^(?:[/\\]|[a-z]:[/\\]|file:)/i;

export function discordTrackActivity(item: MediaItem, position: number, duration: number, shareLocal: boolean, now: number): DiscordActivity | null {
  const local = item.source === "local" || Boolean(item.localPath);
  if (local && !shareLocal) return null;
  let title = item.title.trim();
  if (local && (title === item.localPath || absolutePath.test(title))) {
    const separator = Math.max(title.lastIndexOf("/"), title.lastIndexOf("\\"));
    title = separator >= 0 ? title.slice(separator + 1).trim() : "";
  }
  if (!title) return null;
  const names = item.artists.map(({ name }) => name.trim()).filter((name) => name && (!local || !absolutePath.test(name)));
  const fallback = local ? "" : item.subtitle.split(/\s+[·•]\s+/)[0].trim();
  const total = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null;
  const elapsed = Number.isFinite(position) ? Math.max(0, Math.round(position * 1000)) : 0;
  const startMs = Math.max(0, now - (total === null ? elapsed : Math.min(total, elapsed)));
  const videoId = item.videoId;
  const coverUrl = local ? null : bigThumb(item)
    || (videoId && /^[\w-]{11}$/.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);
  return { title, artist: [...new Set(names)].join(", ") || fallback || null, coverUrl, startMs, endMs: total === null ? null : startMs + total, local };
}

type Snapshot = { index: number; track: string | null; activity: DiscordActivity };

function sameDiscordTrack(left: Snapshot | null, right: Snapshot | null): boolean {
  if (!left || !right) return left === right;
  const a = left.activity;
  const b = right.activity;
  return left.index === right.index && left.track === right.track && a.title === b.title && a.artist === b.artist
    && a.coverUrl === b.coverUrl && a.local === b.local && Math.abs(a.startMs - b.startMs) < 1500
    && (a.endMs === null ? null : a.endMs - a.startMs) === (b.endMs === null ? null : b.endMs - b.startMs);
}

export function DiscordPresenceBridge({ shareLocal }: { shareLocal: boolean }) {
  const { current, index, playing, loading, progress, duration, clipPlayback } = usePlayer();
  const active = clipPlayback?.playing ?? (playing && !loading);
  const total = clipPlayback?.duration ?? duration;
  const sent = useRef<Snapshot | null>(null);

  useEffect(() => {
    const activity = current && active
      ? discordTrackActivity(current, progress, total, shareLocal, Date.now())
      : null;
    const next = activity ? { index, track: current?.videoId ?? null, activity } : null;
    if (sameDiscordTrack(sent.current, next)) return;
    sent.current = next;
    void api.discordPresenceSync(activity).catch(() => undefined);
  }, [current, index, active, progress, total, shareLocal]);

  return null;
}
