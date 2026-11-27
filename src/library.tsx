import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiFailure, archiveCoverUrl } from "./api";
import { toFavorite } from "./ui/format";
import type { ArchiveState, ArchivedPlaylist, AuthStatus, Favorite, MediaItem } from "./types";

/// Older builds kept the archive as playlist ids in localStorage; it is now a
/// real local list, and those ids are migrated once the playlists load.
const LEGACY_ARCHIVE_KEY = "ytmusicdt.archived";

function readLegacyArchive(): string[] {
  try {
    const raw = window.localStorage.getItem(LEGACY_ARCHIVE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function toArchived(item: MediaItem, id: string): ArchivedPlaylist {
  return {
    id,
    playlistId: item.playlistId ?? null,
    browseId: item.browseId ?? null,
    title: item.title,
    subtitle: item.subtitle ?? "",
    thumbs: item.thumbs ?? [],
    archivedAt: Math.floor(Date.now() / 1000),
  };
}

interface LibraryApi {
  accountKey: string;
  playlists: MediaItem[];
  /** The single local archive: playlists moved out of the YouTube list. */
  archivedItems: ArchivedPlaylist[];
  /** Ids of archived playlists, for filtering the sidebar list. */
  archivedIds: Set<string>;
  /** Cover of the archive, or null while it uses the built-in one. */
  archiveCover: string | null;
  /** Favourites from every source, newest first; they live in the archive too. */
  favorites: Favorite[];
  /** Favourite ids, for the hearts: `yt:<videoId>` or `local:<path>`. */
  favoriteIds: Set<string>;
  toggleFavorite: (item: MediaItem) => void;
  addToPlaylist: (videoId: string, playlistId: string) => Promise<boolean>;
  createPlaylistWith: (title: string, videoId: string | null) => Promise<boolean>;
  refreshPlaylists: () => void;
  syncFavorites: () => void;
  favoriteSync: { state: "idle" | "syncing" | "error"; message: string; playlistId: string | null };
  archivePlaylist: (item: MediaItem) => Promise<void>;
  restorePlaylist: (id: string) => Promise<void>;
  setArchiveCover: (path: string) => Promise<void>;
  clearArchiveCover: () => Promise<void>;
}

const LibraryContext = createContext<LibraryApi | null>(null);

export function useLibrary(): LibraryApi {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary must be used inside LibraryProvider");
  return value;
}

type ToastFn = (message: string, kind?: "info" | "error") => void;

interface Props {
  auth: AuthStatus | null;
  onToast: ToastFn;
  children: ReactNode;
}

export function LibraryProvider({ auth, onToast, children }: Props) {
  const [playlists, setPlaylists] = useState<MediaItem[]>([]);
  const playlistRequest = useRef(0);
  const favoriteRequests = useRef(new Set<string>());
  const favoriteVersion = useRef(0);
  const favoritesLoaded = useRef(false);
  const syncRunning = useRef(false);
  const syncAgain = useRef(false);
  const syncTimer = useRef<number | undefined>(undefined);
  const syncSchedule = useRef<() => void>(() => {});
  const lastSync = useRef(0);
  const accountKey = auth?.signedIn ? auth.account?.handle ?? null : null;
  const currentAccount = useRef(accountKey);
  currentAccount.current = accountKey;
  const [favoriteSync, setFavoriteSync] = useState<LibraryApi["favoriteSync"]>({ state: "idle", message: "", playlistId: null });
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [archivedItems, setArchivedItems] = useState<ArchivedPlaylist[]>([]);
  const [archiveHasCover, setArchiveHasCover] = useState(false);
  const [archiveVersion, setArchiveVersion] = useState(() => Date.now());

  const applyArchive = useCallback((state: ArchiveState) => {
    setArchivedItems(state.archived);
    setArchiveHasCover(state.hasCover);
    setArchiveVersion(Date.now());
  }, []);

  useEffect(() => {
    api.archiveState().then(applyArchive).catch(() => undefined);
  }, [applyArchive]);

  useEffect(() => {
    api
      .favorites()
      .then((items) => { if (favoriteVersion.current === 0) setFavorites(items); })
      .catch(() => undefined)
      .finally(() => {
        favoritesLoaded.current = true;
        syncSchedule.current();
      });
  }, []);

  const favoriteIds = useMemo(() => new Set(favorites.map((item) => item.id)), [favorites]);

  const toggleFavorite = useCallback(
    (item: MediaItem) => {
      const favorite = toFavorite(item);
      if (!favorite) return;
      if (favoriteRequests.current.has(favorite.id)) return;
      favoriteRequests.current.add(favorite.id);
      const version = ++favoriteVersion.current;
      const wasFavorite = favoriteIds.has(favorite.id);
      // The list updates at once; the write lands behind it and rolls back if
      // the command fails.
      setFavorites((current) =>
        wasFavorite
          ? current.filter((entry) => entry.id !== favorite.id)
          : [favorite, ...current],
      );
      api
        .toggleFavorite(favorite)
        .then(async (liked) => {
          setFavorites((current) => liked
            ? [favorite, ...current.filter((entry) => entry.id !== favorite.id)]
            : current.filter((entry) => entry.id !== favorite.id));
          const items = await api.favorites().catch(() => null);
          if (items && favoriteVersion.current === version) setFavorites(items);
          if (favorite.source === "yt") syncSchedule.current();
        })
        .catch(() => {
          setFavorites((current) =>
            wasFavorite
              ? [favorite, ...current]
              : current.filter((entry) => entry.id !== favorite.id),
          );
          onToast("Не удалось сохранить избранное", "error");
        })
        .finally(() => favoriteRequests.current.delete(favorite.id));
    },
    [favoriteIds, onToast],
  );

  const refreshPlaylists = useCallback(() => {
    const request = ++playlistRequest.current;
    if (!auth?.signedIn) {
      setPlaylists([]);
      return;
    }
    api
      .libraryPlaylists()
      .then((sections) => {
        if (request !== playlistRequest.current) return;
        setPlaylists(
          sections
            .flatMap((section) => section.items)
            .filter((item) => item.kind === "playlist" && item.browseId),
        );
      })
      .catch((error) => {
        if (request !== playlistRequest.current) return;
        onToast(error instanceof Error ? error.message : "Не удалось загрузить плейлисты", "error");
      });
  }, [auth?.signedIn, auth?.account?.handle, auth?.account?.name, onToast]);

  useEffect(refreshPlaylists, [refreshPlaylists]);

  const syncFavorites = useCallback(async () => {
    if (!accountKey) {
      if (auth?.signedIn) setFavoriteSync({ state: "error", message: "YouTube Music не вернул адрес канала. Повторите проверку аккаунта в настройках перед синхронизацией.", playlistId: null });
      return;
    }
    if (!favoritesLoaded.current || syncRunning.current) {
      syncAgain.current = true;
      return;
    }
    syncRunning.current = true;
    syncAgain.current = false;
    const version = favoriteVersion.current;
    setFavoriteSync((current) => ({ ...current, state: "syncing", message: "Синхронизация с YouTube Music…" }));
    try {
      const report = await api.favoritesSync();
      if (currentAccount.current !== accountKey) return;
      if (favoriteVersion.current === version && favoriteRequests.current.size === 0) {
        setFavorites(report.favorites);
      } else {
        syncAgain.current = true;
      }
      lastSync.current = Date.now();
      setFavoriteSync({ state: "idle", message: "Синхронизировано с плейлистом «Любимые треки»", playlistId: report.playlistId });
      refreshPlaylists();
    } catch (error) {
      if (currentAccount.current !== accountKey) return;
      setFavoriteSync((current) => ({ ...current, state: "error", message: `${error instanceof Error ? error.message : String(error)} Местные сердечки сохранены.` }));
    } finally {
      syncRunning.current = false;
      if (syncAgain.current) syncSchedule.current();
    }
  }, [accountKey, auth?.signedIn, refreshPlaylists]);

  syncSchedule.current = () => {
    window.clearTimeout(syncTimer.current);
    if (accountKey) syncTimer.current = window.setTimeout(() => void syncFavorites(), 1500);
  };

  useEffect(() => {
    setFavoriteSync({ state: "idle", message: "", playlistId: null });
    lastSync.current = 0;
    if (accountKey) void api.favoritesSyncPlaylist().then((playlistId) => {
      if (playlistId && currentAccount.current === accountKey) {
        setFavoriteSync((current) => ({ ...current, playlistId }));
      }
    }).catch(() => undefined);
    syncSchedule.current();
    const online = () => syncSchedule.current();
    const focus = () => { if (Date.now() - lastSync.current > 60_000) syncSchedule.current(); };
    window.addEventListener("online", online);
    window.addEventListener("focus", focus);
    return () => {
      window.clearTimeout(syncTimer.current);
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focus);
    };
  }, [accountKey]);

  const addToPlaylist = useCallback(
    async (videoId: string, playlistId: string) => {
      try {
        await api.addToPlaylist(playlistId, videoId);
        return true;
      } catch (error) {
        onToast(error instanceof ApiFailure ? error.message : String(error), "error");
        return false;
      }
    },
    [onToast],
  );

  const createPlaylistWith = useCallback(
    async (title: string, videoId: string | null) => {
      const name = title.trim();
      if (!name) {
        onToast("Назовите плейлист", "error");
        return false;
      }
      try {
        await api.createPlaylist(name, videoId);
        refreshPlaylists();
        onToast(`Плейлист «${name}» создан`);
        return true;
      } catch (error) {
        onToast(error instanceof ApiFailure ? error.message : String(error), "error");
        return false;
      }
    },
    [onToast, refreshPlaylists],
  );

  const archivePlaylist = useCallback(
    async (item: MediaItem) => {
      const id = item.playlistId ?? item.browseId ?? "";
      if (!id) return;
      try {
        applyArchive(await api.archiveAdd(toArchived(item, id)));
        onToast("Плейлист убран в локальный архив");
      } catch (error) {
        onToast(error instanceof ApiFailure ? error.message : String(error), "error");
      }
    },
    [applyArchive, onToast],
  );

  const restorePlaylist = useCallback(
    async (id: string) => {
      try {
        applyArchive(await api.archiveRemove(id));
        onToast("Плейлист вернулся из архива");
      } catch (error) {
        onToast(error instanceof ApiFailure ? error.message : String(error), "error");
      }
    },
    [applyArchive, onToast],
  );

  const setArchiveCover = useCallback(
    async (path: string) => {
      try {
        applyArchive(await api.archiveCoverSet(path));
        onToast("Обложка архива обновлена");
      } catch (error) {
        onToast(error instanceof ApiFailure ? error.message : String(error), "error");
      }
    },
    [applyArchive, onToast],
  );

  const clearArchiveCover = useCallback(async () => {
    try {
      applyArchive(await api.archiveCoverClear());
      onToast("У архива снова стандартная обложка");
    } catch (error) {
      onToast(error instanceof ApiFailure ? error.message : String(error), "error");
    }
  }, [applyArchive, onToast]);

  // Move whatever the browser kept from older builds into the local archive.
  useEffect(() => {
    if (playlists.length === 0) return;
    const legacy = readLegacyArchive();
    if (legacy.length === 0) return;
    let cancelled = false;
    void (async () => {
      const byId = new Map(
        playlists.map((item) => [item.playlistId ?? item.browseId ?? "", item]),
      );
      let state: ArchiveState | null = null;
      for (const id of legacy) {
        const item = byId.get(id);
        if (!item) continue;
        state = await api.archiveAdd(toArchived(item, id));
      }
      if (cancelled) return;
      if (state) applyArchive(state);
      window.localStorage.removeItem(LEGACY_ARCHIVE_KEY);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [playlists, applyArchive]);

  const archivedIds = useMemo(
    () => new Set(archivedItems.map((entry) => entry.id)),
    [archivedItems],
  );
  const archiveCover = archiveHasCover ? archiveCoverUrl(archiveVersion) : null;

  const value = useMemo<LibraryApi>(
    () => ({
      accountKey: accountKey ?? "",
      playlists,
      archivedItems,
      archivedIds,
      archiveCover,
      favorites,
      favoriteIds,
      toggleFavorite,
      addToPlaylist,
      createPlaylistWith,
      refreshPlaylists,
      syncFavorites: () => { void syncFavorites(); },
      favoriteSync,
      archivePlaylist,
      restorePlaylist,
      setArchiveCover,
      clearArchiveCover,
    }),
    [
      accountKey,
      playlists,
      archivedItems,
      archivedIds,
      archiveCover,
      favorites,
      favoriteIds,
      toggleFavorite,
      addToPlaylist,
      createPlaylistWith,
      refreshPlaylists,
      syncFavorites,
      favoriteSync,
      archivePlaylist,
      restorePlaylist,
      setArchiveCover,
      clearArchiveCover,
    ],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}
