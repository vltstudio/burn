import { Heart, Play, Shuffle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { useLibrary } from "../library";
import { usePlayback } from "../player";
import type { MediaItem } from "../types";

interface Props {
  items: MediaItem[];
  playlistId?: string | null;
  hasMore?: boolean;
  children?: ReactNode;
}

export function PlaylistActions({ items, playlistId, hasMore, children }: Props) {
  const { playItems } = usePlayback();
  const { addFavorites } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    setBusy(false);
    setMessage("");
    pending.current = false;
    return () => { ++generation.current; };
  }, [playlistId]);

  const run = async (action: "play" | "shuffle" | "like") => {
    if (pending.current) return;
    const token = generation.current;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    setMessage("");
    try {
      const rows = playlistId && (action === "like" || hasMore) ? await api.playlistTracks(playlistId) : items;
      if (token !== generation.current) return;
      const tracks = rows.filter((item) => item.videoId || item.localPath);
      if (!tracks.length) {
        setMessage("В плейлисте нет доступных треков");
        return;
      }
      if (action === "like") {
        const added = await addFavorites(tracks);
        if (token === generation.current) {
          const skipped = rows.length - tracks.length;
          setMessage((added ? `Добавлено в избранное: ${added}` : "Все доступные треки уже в избранном")
            + (skipped ? ` · Недоступно: ${skipped}` : ""));
        }
        return;
      }
      if (action === "shuffle") {
        for (let i = tracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
        }
      }
      playItems(tracks, 0);
    } catch (error) {
      if (token === generation.current) {
        setFailed(true);
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (token === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const disabled = busy || (!hasMore && !items.some((item) => item.videoId || item.localPath));
  return <>
    <div className="hero-actions" aria-busy={busy}>
      <button className="solid-button" disabled={disabled} onClick={() => void run("play")}>
        <Play size={14} fill="currentColor" /> Слушать
      </button>
      <button className="round-button" disabled={disabled} title="Перемешать" aria-label="Перемешать" onClick={() => void run("shuffle")}>
        <Shuffle size={16} />
      </button>
      {playlistId && <button className="ghost-button" disabled={disabled} onClick={() => void run("like")}>
        <Heart size={15} /> Все треки в избранное
      </button>}
      {children}
    </div>
    {(busy || message) && <p className={failed ? "load-error" : "field-hint playlist-feedback"} role={failed ? "alert" : "status"}>
      {busy ? "Загружаем треки…" : message}
    </p>}
  </>;
}
