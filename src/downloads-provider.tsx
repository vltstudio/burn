import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { applyDownloads, downloadLine } from "./downloads";
import type { DownloadProgress, DownloadsSnapshot } from "./types";

interface DownloadsApi {
  snapshot: DownloadsSnapshot;
  progress: Record<string, DownloadProgress>;
  error: string | null;
  /** The favourites header line: queue percentage, then what is kept on disk. */
  line: string;
}

const empty: DownloadsSnapshot = { items: [], count: 0, bytes: 0 };

const DownloadsContext = createContext<DownloadsApi>({
  snapshot: empty,
  progress: {},
  error: null,
  line: downloadLine(0, 0, {}),
});

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DownloadsSnapshot>(empty);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      api
        .downloads()
        .then((next) => {
          if (!active) return;
          setSnapshot(applyDownloads(next));
          setError(null);
        })
        .catch((failure) => {
          if (active) setError(failure instanceof Error ? failure.message : String(failure));
        });
    };
    refresh();
    const listeners: Array<Promise<() => void>> = [];
    if (isTauri()) {
      listeners.push(
        listen<DownloadProgress>("downloads:progress", (event) => {
          if (!active) return;
          const entry = event.payload;
          setProgress((current) => {
            const next = { ...current };
            if (entry.state === "downloading") next[entry.videoId] = entry;
            else delete next[entry.videoId];
            return next;
          });
          if (entry.state === "error") setError(entry.message ?? "Не удалось скачать трек");
          if (entry.state === "done") refresh();
        }),
      );
      listeners.push(listen("downloads:changed", () => refresh()));
    }
    return () => {
      active = false;
      for (const listener of listeners) {
        void listener.then((off) => off()).catch(() => undefined);
      }
    };
  }, []);

  const line = useMemo(
    () => downloadLine(snapshot.count, snapshot.bytes, progress),
    [snapshot, progress],
  );
  const value = useMemo(
    () => ({ snapshot, progress, error, line }),
    [snapshot, progress, error, line],
  );
  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloads(): DownloadsApi {
  return useContext(DownloadsContext);
}
