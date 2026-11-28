import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, downloadCoverUrl } from "../api";
import { Archive, ArchiveRestore, ExternalLink, ImagePlus, ListMusic, RefreshCw } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Shelf } from "../components/Shelf";
import { hasDownloadedCover } from "../downloads";
import { useDownloads } from "../downloads-provider";
import { useLibrary } from "../library";
import { LiquidWaveSpinner } from "../components/ui/liquid-spinner";
import { SpotifyImportDialog } from "../components/SpotifyImportDialog";
import { YandexImportDialog } from "../components/YandexImportDialog";
import { usePlayback } from "../player";
import type { ArchivedPlaylist, AuthStatus, Detail, LibraryTab, MediaItem, Section } from "../types";
import { favoriteToItem } from "../ui/format";
import { Cover } from "../ui/cover";
import { LikedPlaylistHeader } from "../components/LikedPlaylist";
import { isSpecialLikedPlaylist, useSpotifyLikedPlaylists } from "../ui/liked-playlists";
import { onPlaylistChange } from "../ui/playlist-changes";
import { LocalLibraryTab } from "./LocalLibraryTab";

type Tab = LibraryTab;

const TABS = [
  { value: "playlists", label: "Плейлисты" },
  { value: "local", label: "Локальные" },
  { value: "albums", label: "Альбомы" },
  { value: "artists", label: "Исполнители" },
  { value: "archive", label: "Архив" },
] as const;

/** An archived playlist, back in the shape the shelves render. */
function archivedToItem(entry: ArchivedPlaylist): MediaItem {
  const storedId = [entry.playlistId, entry.browseId, entry.id]
    .map((id) => id?.trim()).find((id) => Boolean(id));
  const playlistId = storedId?.replace(/^VL/, "") || null;
  return {
    kind: "playlist",
    title: entry.title,
    subtitle: entry.subtitle,
    videoId: null,
    browseId: playlistId ? `VL${playlistId}` : null,
    playlistId,
    duration: null,
    year: null,
    thumbs: entry.thumbs,
    artists: [],
    album: null,
  };
}

interface Props {
  auth: AuthStatus | null;
  /** Which tab the sidebar asked for; the view is remounted per tab. */
  initialTab?: Tab;
  onOpen: (item: MediaItem) => void;
  onRequestSignIn: () => void;
  onOpenLocalSettings: () => void;
  onCheckTransfer: (id: string) => void;
}

export function LibraryView({
  auth,
  initialTab,
  onOpen,
  onRequestSignIn,
  onOpenLocalSettings,
  onCheckTransfer,
}: Props) {
  const player = usePlayback();
  const downloads = useDownloads();
  const {
    archivedItems,
    archivedIds,
    restorePlaylist,
    playlists,
    favorites,
    syncFavorites,
    refreshPlaylists,
    archiveCover,
    setArchiveCover,
    clearArchiveCover,
    favoriteSync,
    accountKey: sourceAccount,
  } = useLibrary();
  const [tab, setTab] = useState<Tab>(initialTab ?? "playlists");
  const [library, setLibrary] = useState<{
    account: string;
    shelves: Partial<Record<Tab, Section[]>>;
    liked: Detail | null;
    spotify: { browseId: string; detail: Detail } | null;
  }>({ account: "", shelves: {}, liked: null, spotify: null });
  const [error, setError] = useState<{ tab: Tab; account: string; message: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const moreGeneration = useRef(0);
  const morePending = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const [yandexOpen, setYandexOpen] = useState(false);

  const signedIn = Boolean(auth?.signedIn);
  const accountKey = signedIn ? JSON.stringify([auth?.account?.handle, auth?.account?.name]) : "";
  const shelves = library.account === accountKey ? library.shelves : {};
  const liked = library.account === accountKey ? library.liked : null;
  const spotifySources = useSpotifyLikedPlaylists(sourceAccount, [
    ...playlists,
    ...(shelves.playlists?.flatMap((section) => section.items) ?? []),
  ]);
  const spotifyId = spotifySources.playlistId;
  const spotifyBrowseId = spotifyId ? `VL${spotifyId}` : null;
  const spotify = library.account === accountKey && library.spotify?.browseId === spotifyBrowseId
    ? library.spotify.detail : null;
  const activeShelves = shelves[tab];
  const loading = tab === "songs" ? !liked : tab === "spotify-favorites" ? Boolean(spotifyBrowseId) && !spotify : !activeShelves;
  const openImport = () => setImportOpen(true);

  useEffect(() => onPlaylistChange((id) => {
    if (id === spotifyId || id === "LM") {
      setLibrary((current) => ({ ...current, ...(id === "LM" ? { liked: null } : { spotify: null }) }));
      setReloadKey((key) => key + 1);
    }
  }), [spotifyId]);

  useEffect(() => {
    ++moreGeneration.current;
    morePending.current = false;
    setLoadingMore(false);
    setMoreError(null);
    return () => { ++moreGeneration.current; };
  }, [tab, accountKey, reloadKey, spotifyBrowseId]);

  useEffect(() => {
    if (!signedIn) {
      setLibrary({ account: "", shelves: {}, liked: null, spotify: null });
      setError(null);
      return;
    }
    if (tab === "local" || tab === "archive" || tab === "favorites") return;
    setError(null);
    if (tab === "spotify-favorites" && (!spotifyBrowseId || spotify)) return;
    if (tab === "songs" ? liked : activeShelves) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = tab === "songs" ? await api.likedSongs()
          : tab === "spotify-favorites" && spotifyBrowseId ? await api.browse(spotifyBrowseId)
          : tab === "playlists" ? await api.libraryPlaylists()
          : tab === "albums" ? await api.libraryAlbums() : await api.libraryArtists();
        if (cancelled) return;
        setLibrary((current) => {
          const cache = current.account === accountKey ? current : { account: accountKey, shelves: {}, liked: null, spotify: null };
          return Array.isArray(data)
            ? { ...cache, shelves: { ...cache.shelves, [tab]: data } }
            : tab === "spotify-favorites" && spotifyBrowseId ? { ...cache, spotify: { browseId: spotifyBrowseId, detail: data } }
            : { ...cache, liked: data };
        });
      } catch (failure) {
        if (!cancelled) setError({ tab, account: accountKey, message: failure instanceof ApiFailure ? failure.message : String(failure) });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [tab, signedIn, accountKey, activeShelves, liked, spotify, spotifyBrowseId, reloadKey]);

  const sourceDetail = tab === "spotify-favorites" ? spotify : liked;
  const likedTracks: MediaItem[] =
    sourceDetail?.sections.filter((section) => section.layout === "list").flatMap((section) => section.items) ?? [];
  const specialPlaylist = tab === "songs" || tab === "spotify-favorites";
  const onlineSections = specialPlaylist ? sourceDetail?.sections ?? [] : activeShelves ?? [];
  const continuationIndex = onlineSections.findIndex((section) =>
    Boolean(section.continuation) && (!specialPlaylist || section.layout === "list"),
  );
  const continuation = onlineSections[continuationIndex]?.continuation ?? null;

  const loadMore = async () => {
    if (!continuation || morePending.current) return;
    const generation = moreGeneration.current;
    morePending.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.browseMore(continuation);
      if (moreGeneration.current !== generation) return;
      setLibrary((current) => {
        if (current.account !== accountKey) return current;
        const sections = tab === "songs" ? current.liked?.sections
          : tab === "spotify-favorites" && current.spotify?.browseId === spotifyBrowseId ? current.spotify.detail.sections
          : current.shelves[tab];
        if (sections?.[continuationIndex]?.continuation !== continuation) return current;
        const updated = sections.map((section, index) => index === continuationIndex
          ? { ...section, items: [...section.items, ...page.items], continuation: page.continuation }
          : section);
        return tab === "songs" && current.liked
          ? { ...current, liked: { ...current.liked, sections: updated } }
          : tab === "spotify-favorites" && current.spotify ? { ...current, spotify: { ...current.spotify, detail: { ...current.spotify.detail, sections: updated } } }
          : { ...current, shelves: { ...current.shelves, [tab]: updated } };
      });
    } catch (failure) {
      if (moreGeneration.current === generation) {
        setMoreError(failure instanceof ApiFailure ? failure.message : String(failure));
      }
    } finally {
      if (moreGeneration.current === generation) {
        morePending.current = false;
        setLoadingMore(false);
      }
    }
  };

  const renderContent = () => {
    if (tab === "local") return <LocalLibraryTab onOpen={onOpen} onOpenLocalSettings={onOpenLocalSettings} />;
    const onlineTab = tab !== "archive" && tab !== "favorites";
    if (onlineTab && !signedIn) {
      return (
        <div className="signin-card">
          <h2>Подключите аккаунт Google</h2>
          <p>Войдите, чтобы открыть плейлисты и лайки YouTube Music. Избранные, локальные треки и архив доступны без входа.</p>
          <button className="solid-button" onClick={onRequestSignIn}>Войти через Google</button>
        </div>
      );
    }
    const activeError = onlineTab && error?.tab === tab && error.account === accountKey ? error.message : null;
    if (activeError) {
      return (
        <div className="empty">
          <div className="empty-title">Не удалось загрузить библиотеку</div>
          <div className="empty-text">{activeError}</div>
          <button className="ghost-button" onClick={() => setReloadKey((key) => key + 1)}>
            Попробовать снова
          </button>
        </div>
      );
    }
    if (onlineTab && loading) {
      return (
        <LiquidWaveSpinner
          size="md"
          words={["Загружаем библиотеку…", "Читаем плейлисты…", "Собираем альбомы…"]}
        />
      );
    }

    if (tab === "favorites") {
      // A downloaded favourite carries its cover on disk, so the list still
      // renders when there is no network.
      const items = favorites.map((favorite) => {
        const item = favoriteToItem(favorite);
        return hasDownloadedCover(item.videoId)
          ? { ...item, thumbs: [downloadCoverUrl(item.videoId!), ...item.thumbs] }
          : item;
      });
      const remoteId = favoriteSync.playlistId?.replace(/^VL/, "");
      return (
        <>
          <LikedPlaylistHeader variant="app" items={items} />
          <div className="favorites-tools">
            {signedIn ? (
              <>
                {favoriteSync.state === "error" ? (
                  <details className="favorites-sync-details">
                    <summary>Не удалось синхронизировать</summary>
                    <div className="load-error" role="alert">{favoriteSync.message}</div>
                  </details>
                ) : (
                  <span className="favorites-sync" role="status" title={favoriteSync.message}>
                    {favoriteSync.state === "syncing" ? "Синхронизация…" : favoriteSync.message || "Сохранено в приложении"}
                  </span>
                )}
                <button className="link favorites-sync-button" onClick={syncFavorites} disabled={favoriteSync.state === "syncing"}>
                  <RefreshCw size={12} aria-hidden />{favoriteSync.state === "error" ? "Повторить" : "Синхронизировать"}
                </button>
                {remoteId ? (
                  <button className="link favorites-cloud-link" title="Открыть облачную копию избранного" aria-label="Открыть облачную копию избранного" onClick={() => onOpen({
                    kind: "playlist", title: "Любимые треки", subtitle: "BURN", videoId: null,
                    browseId: `VL${remoteId}`, playlistId: remoteId, duration: null, year: null,
                    thumbs: [], artists: [], album: null,
                  })}>
                    <ExternalLink size={12} aria-hidden />YouTube Music
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <span className="favorites-sync">Сохранено на устройстве</span>
                <button className="link favorites-sync-button" onClick={onRequestSignIn}>Войти для синхронизации</button>
              </>
            )}
            <span className="favorites-source" role="status">{downloads.line}</span>
          </div>
          {items.length === 0 ? (
            <div className="empty">
              <div className="empty-title">Здесь будут любимые треки</div>
              <div className="empty-text">Нажмите сердечко у трека в приложении, чтобы добавить его сюда.</div>
            </div>
          ) : (
            <Shelf
              section={{ title: null, layout: "list", items, continuation: null }}
              currentVideoId={player.current?.videoId ?? null}
              isPlaying={player.playing}
              onPlayList={player.playItems}
              onPlay={(item) => player.playItems([item], 0)}
              onOpen={onOpen}
            />
          )}
        </>
      );
    }

    if (tab === "archive") {
      const pickCover = async () => {
        const selected = await openFileDialog({
          multiple: false,
          filters: [{ name: "Картинка", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
        });
        if (typeof selected === "string") await setArchiveCover(selected);
      };
      return (
        <>
          <div className="archive-hero">
            {archiveCover ? (
              <img className="archive-hero-cover" src={archiveCover} alt="" />
            ) : (
              <div className="archive-hero-cover archive-hero-default">
                <Archive size={30} strokeWidth={1.5} />
              </div>
            )}
            <div className="archive-hero-text">
              <h2>Архив</h2>
              <p>
                {archivedItems.length} плейлистов.
                Открывайте плейлисты прямо отсюда, не возвращая их в боковой список.
              </p>
              <p>
                Ссылки сохранены локально, треки не скачиваются. Для просмотра и
                прослушивания плейлистов нужен интернет.
              </p>
              <div className="archive-hero-actions">
                <button className="ghost-button" onClick={() => void pickCover()}>
                  <ImagePlus size={14} />
                  {archiveCover ? "Сменить обложку" : "Поставить обложку"}
                </button>
                {archiveCover ? (
                  <button className="ghost-button" onClick={() => void clearArchiveCover()}>
                    Сбросить
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {archivedItems.length === 0 ? (
            <div className="empty">
              <div className="empty-title">Архив пока пуст</div>
              <div className="empty-text">
                Уберите плейлист в архив из списка слева. Он останется здесь, и его можно
                будет открыть без возвращения в боковой список.
              </div>
            </div>
          ) : null}

          {archivedItems.length > 0 ? (
            <>
              <div className="block-head">
                <h2>Плейлисты</h2>
                <span className="block-count">{archivedItems.length}</span>
              </div>
              <div className="archive-grid">
                {archivedItems.map((entry) => {
                  const item = archivedToItem(entry);
                  return (
                    <div className="archive-card" key={entry.id}>
                      <button
                        className="archive-open"
                        disabled={!item.browseId}
                        onClick={() => onOpen(item)}
                        aria-label={`Открыть треки: ${entry.title}`}
                      >
                        <Cover className="archive-playlist-cover" src={entry.thumbs[entry.thumbs.length - 1]} />
                        <span className="card-text">
                          <span className="card-title">{entry.title}</span>
                          {entry.subtitle ? <span className="card-sub">{entry.subtitle}</span> : null}
                        </span>
                        <span className="archive-open-label"><ListMusic size={12} /> Открыть треки</span>
                      </button>
                      {!item.browseId ? <div className="load-error">Ссылка на плейлист не сохранилась.</div> : null}
                      <button
                        className="archive-restore"
                        onClick={() => void restorePlaylist(entry.id)}
                        title="Вернуть в боковой список и убрать из архива"
                        aria-label={`Вернуть из архива: ${entry.title}`}
                      >
                        <ArchiveRestore size={12} strokeWidth={1.8} />
                        Вернуть
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

        </>
      );
    }

    if (specialPlaylist) {
      const spotifySource = tab === "spotify-favorites";
      return (
        <>
          <LikedPlaylistHeader variant={spotifySource ? "spotify" : "youtube"} items={likedTracks} hasMore={Boolean(continuation)} playlistId={spotifySource ? spotifyId : "LM"} />
          {likedTracks.length === 0 && !continuation ? (
            <div className="empty">
              <div className="empty-title">{spotifySource ? spotifyBrowseId ? "В плейлисте пока нет треков" : "Любимые треки Spotify ещё не импортированы" : "Пока нет понравившихся треков"}</div>
              <div className="empty-text">{spotifySource ? "Перенесите любимые треки из Spotify в YouTube Music." : "Ставьте лайки на YouTube Music — они появятся здесь."}</div>
              {spotifySource ? <button className="ghost-button" onClick={openImport}>Импортировать любимые треки</button> : null}
            </div>
          ) : (
            <Shelf
              section={{ title: null, layout: "list", items: likedTracks, continuation }}
              onLoadMore={continuation ? () => void loadMore() : undefined}
              loadingMore={loadingMore}
              loadMoreError={moreError}
              currentVideoId={player.current?.videoId ?? null}
              isPlaying={player.playing}
              onPlayList={player.playItems}
              onPlay={(item) => player.playItems([item], 0)}
              onOpen={onOpen}
            />
          )}
        </>
      );
    }

    const items = (shelves[tab] ?? [])
      .flatMap((section) => section.items)
      .filter(
        (item) => item.kind !== "playlist" || !archivedIds.has(item.playlistId ?? item.browseId ?? "")
          && !isSpecialLikedPlaylist(item, favoriteSync.playlistId, spotifySources.hiddenIds),
      );
    if (items.length === 0 && !continuation) {
      return (
        <div className="empty">
          <div className="empty-title">Здесь пока пусто</div>
          <div className="empty-text">Добавляйте музыку в библиотеку на YouTube Music.</div>
        </div>
      );
    }

    return (
      <Shelf
        section={{ title: null, layout: "grid", items, continuation }}
        onLoadMore={continuation ? () => void loadMore() : undefined}
        loadingMore={loadingMore}
        loadMoreError={moreError}
        currentVideoId={player.current?.videoId ?? null}
        isPlaying={player.playing}
        onPlayList={player.playItems}
        onPlay={(item) => player.playItems([item], 0)}
        onOpen={onOpen}
      />
    );
  };

  return (
    <div className="view library-view">
      {!specialPlaylist && tab !== "favorites" ? <header className="view-head library-head">
        <h1 className="view-title">Библиотека</h1>
        <div className="tabs library-tabs" role="group" aria-label="Разделы библиотеки">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              className={`tab ${tab === value ? "active" : ""}`}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="library-import library-import-group" aria-label="Импорт плейлистов">
          <button className="ghost-button" onClick={openImport}>
            <ListMusic size={15} /> Импорт из Spotify
          </button>
          <button className="ghost-button" onClick={() => setYandexOpen(true)}>
            <ListMusic size={15} /> Импорт из Яндекс Музыки
          </button>
        </div>
      </header> : null}
      {renderContent()}
      <SpotifyImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCheckTransfer={(id) => { setImportOpen(false); onCheckTransfer(id); }}
        onImported={() => {
          void refreshPlaylists();
          setLibrary((current) => ({ ...current, shelves: {}, liked: null, spotify: null }));
          setReloadKey((key) => key + 1);
        }}
      />
      <YandexImportDialog
        open={yandexOpen}
        onClose={() => setYandexOpen(false)}
        onImported={() => {
          void refreshPlaylists();
          setLibrary((current) => ({ ...current, shelves: {}, liked: null, spotify: null }));
          setReloadKey((key) => key + 1);
        }}
      />
    </div>
  );
}
