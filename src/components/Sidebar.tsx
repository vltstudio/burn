import { Archive, House, Library, ListMusic, Plus, Search } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useLibrary } from "../library";
import type { MediaItem, Route } from "../types";
import { Cover } from "../ui/cover";
import { smallThumb } from "../ui/format";
import { LikedPlaylistCover } from "./LikedPlaylist";
import { isSpecialLikedPlaylist, useSpotifyLikedPlaylists } from "../ui/liked-playlists";

interface Props {
  route: Route;
  onNavigate: (route: Route) => void;
  onOpen: (item: MediaItem) => void;
}

export function Sidebar({ route, onNavigate, onOpen }: Props) {
  const {
    playlists,
    archivedIds,
    archivePlaylist,
    createPlaylistWith,
    favoriteSync,
    accountKey,
  } = useLibrary();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const spotifySources = useSpotifyLikedPlaylists(accountKey, playlists);
  const youtubeActive = route.name === "library" && route.tab === "songs"
    || route.name === "detail" && route.browseId === "VLLM";

  const openPlaylist = useCallback((item: MediaItem) => onOpen(item), [onOpen]);

  const isCurrentPlaylist = (item: MediaItem) => {
    if (route.name !== "detail") return false;
    const browseId = item.playlistId ? `VL${item.playlistId}` : item.browseId;
    return Boolean(browseId) && route.browseId === browseId;
  };

  const visible = playlists.filter(
    (item) => !archivedIds.has(item.playlistId ?? item.browseId ?? "")
      && !isSpecialLikedPlaylist(item, favoriteSync.playlistId, spotifySources.hiddenIds),
  );

  const commitDraft = async () => {
    if (draft === null) return;
    const title = draft.trim();
    setDraft(null);
    if (!title) return;
    setBusy(true);
    await createPlaylistWith(title, null);
    setBusy(false);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar" data-tauri-drag-region>
        <button
          className={`archive-toggle ${route.name === "library" && route.tab === "archive" ? "active" : ""}`}
          aria-label="Открыть архив"
          aria-current={route.name === "library" && route.tab === "archive" ? "page" : undefined}
          title="Архив"
          onClick={() => onNavigate({ name: "library", tab: "archive" })}
        >
          <Archive size={15} strokeWidth={1.7} />
        </button>
      </div>

      <nav className="nav" aria-label="Основные разделы">
        <button
          className={`nav-item ${route.name === "home" ? "active" : ""}`}
          aria-current={route.name === "home" ? "page" : undefined}
          onClick={() => onNavigate({ name: "home" })}
        >
          <House size={16} strokeWidth={1.7} />
          <span>Главная</span>
        </button>
        <button
          className={`nav-item ${route.name === "search" ? "active" : ""}`}
          aria-current={route.name === "search" ? "page" : undefined}
          onClick={() => onNavigate({ name: "search" })}
        >
          <Search size={16} strokeWidth={1.7} />
          <span>Поиск</span>
        </button>
        <button
          className={`nav-item ${route.name === "library" && !["archive", "favorites", "songs", "spotify-favorites"].includes(route.tab ?? "") ? "active" : ""}`}
          aria-current={route.name === "library" && !["archive", "favorites", "songs", "spotify-favorites"].includes(route.tab ?? "") ? "page" : undefined}
          onClick={() => onNavigate({ name: "library" })}
        >
          <Library size={16} strokeWidth={1.7} />
          <span>Библиотека</span>
        </button>
      </nav>

      <div className="side-section side-favorites">
        <button
          className={`side-item side-favorite ${route.name === "library" && route.tab === "favorites" ? "active" : ""}`}
          aria-current={route.name === "library" && route.tab === "favorites" ? "page" : undefined}
          onClick={() => onNavigate({ name: "library", tab: "favorites" })}
          title="Избранные — сердечки в приложении"
        >
          <LikedPlaylistCover variant="app" className="side-favorite-cover" />
          <span className="side-name">Избранные</span>
        </button>
        <button
          className={`side-item side-favorite ${route.name === "library" && route.tab === "spotify-favorites" ? "active" : ""}`}
          aria-current={route.name === "library" && route.tab === "spotify-favorites" ? "page" : undefined}
          onClick={() => onNavigate({ name: "library", tab: "spotify-favorites" })}
          title="Любимые треки Spotify"
        >
          <LikedPlaylistCover variant="spotify" className="side-favorite-cover" />
          <span className="side-name">Любимые треки Spotify</span>
        </button>
        <button
          className={`side-item side-favorite ${youtubeActive ? "active" : ""}`}
          aria-current={youtubeActive ? "page" : undefined}
          onClick={() => onNavigate({ name: "library", tab: "songs" })}
          title="Любимые треки YouTube — лайки YouTube Music"
        >
          <LikedPlaylistCover variant="youtube" className="side-favorite-cover" />
          <span className="side-name">Любимые треки YouTube</span>
        </button>
      </div>

      <div className="side-section side-playlists">
        <div className="side-label">
          <span>Плейлисты</span>
          <button
            className="side-add"
            title="Создать плейлист"
            disabled={busy}
            onClick={() => {
              setDraft("");
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>

        <div className="side-list">
          {draft !== null ? (
            <input
              ref={inputRef}
              className="side-input"
              value={draft}
              placeholder="Название плейлиста"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commitDraft()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitDraft();
                if (event.key === "Escape") setDraft(null);
              }}
            />
          ) : null}

          {visible.map((playlist, index) => {
            const id = playlist.playlistId ?? playlist.browseId ?? "";
            return (
              <div className="side-row" key={`${id}-${index}`}>
                <button
                  className={`side-item ${isCurrentPlaylist(playlist) ? "active" : ""}`}
                  onClick={() => openPlaylist(playlist)}
                  title={playlist.title}
                >
                  <Cover className="side-cover" src={smallThumb(playlist)} alt="" />
                  <span className="side-name">{playlist.title}</span>
                </button>
                <button
                  className="side-hide"
                  title="В архив"
                  onClick={() => void archivePlaylist(playlist)}
                >
                  <Archive size={12} strokeWidth={1.7} />
                </button>
              </div>
            );
          })}

          {visible.length === 0 && draft === null ? (
            <button className="side-item muted" onClick={() => onNavigate({ name: "library" })}>
              <ListMusic size={13} strokeWidth={1.7} /> Нет плейлистов
            </button>
          ) : null}
        </div>
      </div>

    </aside>
  );
}
