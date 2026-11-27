import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { YandexCollection, YandexFile, YandexImportResult, YandexPreview } from "./yandex";
import type {
  ApiErrorShape,
  ArchiveState,
  ArchivedPlaylist,
  AuthPoll,
  AuthStatus,
  Detail,
  DiscordActivity,
  DiscordPreferences,
  DownloadsSnapshot,
  DiscordPresenceView,
  Favorite,
  FavoritesSyncReport,
  LocalAddRootResult,
  LocalStatus,
  LocalTrackPage,
  Lyrics,
  MediaItem,
  SearchResults,
  Section,
  Settings,
  SpotifyImportResult,
  SpotifyPlaylist,
  SpotifyStatus,
} from "./types";

export class ApiFailure extends Error {
  readonly needsAuth: boolean;
  readonly needsPlayer: boolean;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.needsAuth = shape.needsAuth;
    this.needsPlayer = shape.needsPlayer;
  }
}

function normalize(error: unknown): ApiFailure {
  if (error && typeof error === "object" && "message" in error) {
    const shape = error as Partial<ApiErrorShape>;
    return new ApiFailure({
      message: String(shape.message ?? "Unknown error"),
      needsAuth: Boolean(shape.needsAuth),
      needsPlayer: Boolean(shape.needsPlayer),
    });
  }
  return new ApiFailure({ message: String(error), needsAuth: false, needsPlayer: false });
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalize(error);
  }
}

export const api = {
  search: (query: string, filter: string | null) =>
    call<SearchResults>("search", { query, filter }),
  watchTrack: (videoId: string) => call<MediaItem>("watch_track", { videoId }),
  resolveClip: (videoId: string, kind: string | null) => call<string | null>("resolve_clip", { videoId, kind }),
  startClipEmbed: (videoId: string, channel: string) => call<string>("start_clip_embed", { videoId, channel }),
  yandexPreview: (files: YandexFile[]) => call<YandexPreview>("yandex_preview", { files }),
  yandexImport: (collections: YandexCollection[], requestId: string) =>
    call<YandexImportResult[]>("yandex_import", { collections, requestId }),
  yandexImportCancel: (requestId: string) => call<boolean>("yandex_import_cancel", { requestId }),
  recommendations: (videoId: string) => call<MediaItem[]>("recommendations", { videoId }),
  localStatus: () => call<LocalStatus>("local_status"),
  localSearch: (query: string, offset: number, limit: number, generation?: number | null) =>
    call<LocalTrackPage>("local_search", { query, offset, limit, generation }),
  localAddRoot: (path: string) => call<LocalAddRootResult>("local_add_root", { path }),
  localRemoveRoot: (path: string) => call<LocalStatus>("local_remove_root", { path }),
  localRescan: () => call<LocalStatus>("local_rescan"),
  favorites: () => call<Favorite[]>("favorites_list"),
  favoritesSync: () => call<FavoritesSyncReport>("favorites_sync"),
  favoritesSyncPlaylist: () => call<string | null>("favorites_sync_playlist"),
  archiveState: () => call<ArchiveState>("archive_state"),
  archiveAdd: (playlist: ArchivedPlaylist) => call<ArchiveState>("archive_add", { playlist }),
  archiveRemove: (id: string) => call<ArchiveState>("archive_remove", { id }),
  archiveCoverSet: (path: string) => call<ArchiveState>("archive_cover_set", { path }),
  archiveCoverClear: () => call<ArchiveState>("archive_cover_clear"),
  toggleFavorite: (favorite: Favorite) => call<boolean>("favorite_toggle", { favorite }),
  searchMore: (continuation: string, query: string, filter: string | null) =>
    call<Section>("search_more", { continuation, query, filter }),
  suggestions: (query: string) => call<string[]>("suggestions", { query }),
  home: () => call<Section[]>("home"),
  browse: (browseId: string) => call<Detail>("browse", { browseId }),
  browseMore: (continuation: string) => call<Section>("browse_more", { continuation }),
  libraryPlaylists: () => call<Section[]>("library_playlists").then((sections) => sections.map((section) => ({
    ...section,
    items: section.items.map((item) => item.playlistId === "LM" || item.browseId === "VLLM"
      ? { ...item, title: "Любимые треки YouTube" }
      : item),
  }))),
  libraryAlbums: () => call<Section[]>("library_albums"),
  libraryArtists: () => call<Section[]>("library_artists"),
  likedSongs: () => call<Detail>("liked_songs"),
  history: () => call<Section[]>("history"),
  rateSong: (videoId: string, rating: "like" | "dislike" | "none") =>
    call<void>("rate_song", { videoId, rating }),
  trackLyrics: (
    videoId: string | null,
    title: string,
    artist: string,
    album: string | null,
    duration: number | null,
  ) => call<Lyrics>("track_lyrics", { videoId, title, artist, album, duration }),
  addToPlaylist: (playlistId: string, videoId: string) =>
    call<void>("add_to_playlist", { playlistId, videoId }),
  createPlaylist: (title: string, videoId: string | null) =>
    call<string>("create_playlist", { title, videoId }),
  deletePlaylist: (playlistId: string) => call<void>("playlist_delete", { playlistId }),
  spotifyStatus: () => call<SpotifyStatus>("spotify_status"),
  spotifySignIn: () => call<SpotifyStatus>("spotify_sign_in"),
  spotifySignOut: () => call<SpotifyStatus>("spotify_sign_out"),
  spotifyPreview: (url: string) => call<SpotifyPlaylist>("spotify_preview", { url }),
  spotifyImportLiked: (title: string | null, privacy: string | null, cover: boolean, requestId: string) =>
    call<SpotifyImportResult>("spotify_import_liked", { title, privacy, cover, requestId }),
  spotifyImport: (url: string, title: string | null, description: string | null, cover: boolean, requestId: string) =>
    call<SpotifyImportResult>("spotify_import", { url, title, description, cover, requestId }),
  spotifyImportCancel: (requestId: string) => call<boolean>("spotify_import_cancel", { requestId }),
  authStatus: (refresh = false) => call<AuthStatus>("auth_status", { refresh }),
  authOpenSignin: () => call<void>("auth_open_signin"),
  authPollSignin: () => call<AuthPoll>("auth_poll_signin"),
  authCancel: () => call<void>("auth_cancel"),
  authReset: () => call<void>("auth_reset"),
  authSignOut: () => call<void>("auth_sign_out"),
  settingsGet: () => call<Settings>("settings_get"),
  settingsSet: (settings: Settings) => call<Settings>("settings_set", { settings }),
  discordPresenceGet: () => call<DiscordPresenceView>("discord_presence_get"),
  discordPresenceConfigure: (preferences: DiscordPreferences) =>
    call<DiscordPreferences>("discord_presence_configure", { preferences }),
  discordPresenceSync: (activity: DiscordActivity | null) => call<void>("discord_presence_sync", { activity }),
  streamUrl: (videoId: string, refresh = false) => call<string>("stream_url", { videoId, refresh }),
  downloads: () => call<DownloadsSnapshot>("downloads_state"),
  openUrl: (url: string) => openUrl(url),
};

function localMediaBase(): string {
  return (isTauri() ? convertFileSrc("", "localmedia") : "http://localmedia.localhost").replace(/\/+$/, "");
}

/** The archive cover lives behind the same protocol as album art; the version
 * query keeps a replaced image out of the image cache. */
export function archiveCoverUrl(version: number): string {
  return `${localMediaBase()}/archive-cover?v=${version}`;
}

/** Local files are streamed by the backend's own protocol handler. */
export function localMediaUrl(path: string): string {
  return `${localMediaBase()}/${encodeURIComponent(path)}`;
}

/** The cover cached next to a downloaded favourite. */
export function downloadCoverUrl(videoId: string): string {
  return `${localMediaBase()}/download-cover/${encodeURIComponent(videoId)}`;
}

export function localCoverUrl(id: string): string {
  return `${localMediaBase()}/cover/${encodeURIComponent(id)}`;
}
