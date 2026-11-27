import { ListPlus, Plus } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const boxRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const width = Math.min(246, window.innerWidth - 16);
      const above = anchor.top - 16;
      const below = window.innerHeight - anchor.bottom - 16;
      const upward = placement === "up" ? above >= Math.min(275, below) : below < Math.min(275, above);
      panel.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
      panel.style.top = upward ? "auto" : `${anchor.bottom + 6}px`;
      panel.style.bottom = upward ? `${window.innerHeight - anchor.top + 6}px` : "auto";
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!boxRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    position();
    panelRef.current?.querySelector<HTMLElement>("button:not(:disabled), input")?.focus({ preventScroll: true });
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, placement]);

  useEffect(() => {
    if (!open) setDraft("");
  }, [open]);

  const disabled = !videoId;

  return (
    <div className={`picker ${className ?? ""}`} ref={boxRef}>
      <button
        className="ctl small"
        ref={triggerRef}
        title={disabled ? "Выберите трек" : (title ?? "Добавить в плейлист")}
        aria-label={title ?? "Добавить в плейлист"}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <ListPlus size={15} strokeWidth={1.7} />
      </button>

      {open && videoId ? createPortal(
        <div ref={panelRef} id={panelId} className="picker-panel picker-portal" role="dialog" aria-label="Добавить в плейлист" onClick={(event) => event.stopPropagation()}>
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
        </div>, document.body
      ) : null}
    </div>
  );
}
