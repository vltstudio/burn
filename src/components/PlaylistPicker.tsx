import { ListPlus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library";

interface Props {
  videoId: string | null;
  /** Which way the panel opens relative to the trigger. */
  placement?: "up" | "down";
  className?: string;
  title?: string;
}

/**
 * Trigger plus a small panel listing the person's playlists. Any track can be
 * sent to one of them, or a fresh playlist can be created around the track.
 */
export function PlaylistPicker({ videoId, placement = "down", className, title }: Props) {
  const { playlists, addToPlaylist, createPlaylistWith } = useLibrary();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [upward, setUpward] = useState(placement === "up");
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setDraft("");
  }, [open]);

  const disabled = !videoId;

  return (
    <div className={`picker ${className ?? ""}`} ref={boxRef}>
      <button
        className="ctl small"
        title={disabled ? "Выберите трек" : (title ?? "Добавить в плейлист")}
        disabled={disabled}
        onClick={() => {
          // Panels are clipped by the scrolling list, so flip them when the
          // trigger sits too close to the bottom of the window.
          const rect = boxRef.current?.getBoundingClientRect();
          if (rect) setUpward(rect.bottom + 280 > window.innerHeight);
          setOpen((value) => !value);
        }}
      >
        <ListPlus size={15} strokeWidth={1.7} />
      </button>

      {open && videoId ? (
        <div className={`picker-panel ${upward ? "up" : "down"}`} role="menu">
          <div className="picker-head">В плейлист</div>
          <div className="picker-list">
            {playlists.map((playlist) => (
              <button
                key={playlist.browseId ?? playlist.title}
                className="picker-item"
                disabled={busy}
                onClick={async () => {
                  if (!playlist.playlistId && !playlist.browseId) return;
                  setBusy(true);
                  const id = playlist.playlistId ?? playlist.browseId ?? "";
                  const done = await addToPlaylist(videoId, id);
                  setBusy(false);
                  if (done) setOpen(false);
                }}
              >
                <span className="picker-item-title">{playlist.title}</span>
              </button>
            ))}
            {playlists.length === 0 ? (
              <div className="picker-empty">Плейлистов пока нет</div>
            ) : null}
          </div>

          <div className="picker-new">
            <input
              value={draft}
              placeholder="Новый плейлист"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={async (event) => {
                if (event.key !== "Enter") return;
                setBusy(true);
                const done = await createPlaylistWith(draft, videoId);
                setBusy(false);
                if (done) setOpen(false);
              }}
            />
            <button
              className="picker-new-go"
              disabled={busy || !draft.trim()}
              title="Создать и добавить"
              onClick={async () => {
                setBusy(true);
                const done = await createPlaylistWith(draft, videoId);
                setBusy(false);
                if (done) setOpen(false);
              }}
            >
              <Plus size={14} strokeWidth={1.9} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}