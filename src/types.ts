export type ItemKind = "song" | "video" | "album" | "artist" | "playlist" | "episode" | "unknown";

export interface ItemRef {
  name: string;
  browseId: string;
}

export interface MediaItem {
  kind: ItemKind;
  title: string;
  subtitle: string;
  videoId: string | null;
  browseId: string | null;
  playlistId: string | null;
  duration: string | null;
  year: string | null;
  thumbs: string[];
  artists: ItemRef[];
  album: ItemRef | null;
  /** Where the audio comes from; YouTube Music unless the file is local. */
  source?: "youtube" | "local";
  /** Absolute path for local files; the player reads it through localmedia://. */
  localPath?: string | null;
}

/** A scanned file on disk, as the backend reports it. */
export interface LocalTrack {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  hasCover: boolean;
  root: string;
}

/** An app-level favourite: any source, with the metadata needed to render it. */
export interface Favorite {
  /** Source-tagged: `yt:<videoId>` or `local:<absolute path>`. */
  id: string;
  title: string;
  subtitle: string;
  duration: number | null;
  source: "yt" | "local";
  videoId: string | null;
  localPath: string | null;
  thumb: string | null;
}

export interface FavoritesSyncReport {
  favorites: Favorite[];
  playlistId: string;
  uploaded: number;
  downloaded: number;
  removed: number;
}

export interface Section {
  title: string | null;
  layout: "carousel" | "grid" | "list";
  items: MediaItem[];
  continuation: string | null;
}

export interface DetailHeader {
  kind: ItemKind;
  title: string;
  subtitle: string;
  meta: string;
  description: string | null;
  thumbs: string[];
  browseId: string | null;
  playlistId: string | null;
  year: string | null;
  artists: ItemRef[];
}

export interface Detail {
  header: DetailHeader;
  sections: Section[];
}

export interface SearchResults {
  top: MediaItem | null;
  items: MediaItem[];
  continuation: string | null;
}

export interface Account {
  name: string;
  handle: string | null;
  photo: string | null;
}

export interface AuthStatus {
  signedIn: boolean;
  account: Account | null;
}

export interface AuthPoll {
  status: "pending" | "granted" | "denied";
  account: Account | null;
  message: string | null;
}

export interface Settings {
  language: string | null;
  palette: string | null;
}

export interface ApiErrorShape {
  message: string;
  needsAuth: boolean;
  needsPlayer: boolean;
}

export type SearchFilter = "all" | "songs" | "albums" | "artists" | "playlists" | "videos";

export type Route =
  | { name: "search" }
  | { name: "home" }
  | { name: "library"; tab?: LibraryTab }
  | { name: "detail"; browseId: string; kind: ItemKind | "unknown"; title: string };

/** A track read from a Spotify playlist, before it is matched. */
export interface SpotifyTrack {
  title: string;
  artists: string[];
  seconds: number | null;
}

/** A public Spotify playlist as the import reads it. */
export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string;
  cover: string | null;
  tracks: SpotifyTrack[];
}

/** One step of an import, pushed while it runs. */
export interface SpotifyImportProgress {
  requestId: string;
  stage: "fetch" | "match" | "create" | "add" | "cover" | "done";
  done: number;
  total: number;
  message: string | null;
  playlistId: string | null;
}

export interface SpotifyImportResult {
  playlistId: string;
  title: string;
  total: number;
  added: number;
  unmatched: Array<{ title: string; artists: string[] }>;
  cover: boolean;
  coverError: string | null;
}

/** Whether the app holds a Spotify web session. */
export interface SpotifyStatus {
  signedIn: boolean;
}

/** One line of lyrics with the moment it starts, in milliseconds. */
export interface LyricLine {
  text: string;
  startMs: number;
  endMs: number | null;
}

/** Lyrics as the backend found them: timed lines, or plain text only. */
export interface Lyrics {
  lines: LyricLine[];
  plain: string | null;
  source: "youtube" | "lrclib";
  attribution: string | null;
  timed: boolean;
}

/** Tabs of the library screen; the sidebar can deep-link into one. */
export type LibraryTab = "playlists" | "songs" | "spotify-favorites" | "favorites" | "local" | "albums" | "artists" | "archive";

/** A playlist moved to the local archive, with enough metadata to render it
 * without asking YouTube Music. */
export interface ArchivedPlaylist {
  id: string;
  playlistId: string | null;
  browseId: string | null;
  title: string;
  subtitle: string;
  thumbs: string[];
  archivedAt: number;
}

export interface ArchiveState {
  archived: ArchivedPlaylist[];
  hasCover: boolean;
}
