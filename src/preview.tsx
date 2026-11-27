import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import album from "./preview/fixtures/album.json";
import artist from "./preview/fixtures/artist.json";
import home from "./preview/fixtures/home.json";
import playlist from "./preview/fixtures/playlist.json";
import search from "./preview/fixtures/search.json";

const details: Record<string, unknown> = {
  MPREb_99mXCzrVmLg: album,
  UCrPe3hLA51968GwxHSZ1llw: artist,
  VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5: playlist,
  "UC4DGncXvX-32aG7obY5dF1w": artist,
};

const sidePlaylists = {
  title: null,
  layout: "grid",
  continuation: null,
  items: [
    { kind: "playlist", title: "Pure Fire!! 🔥", browseId: "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5", playlistId: "PLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5" },
    { kind: "playlist", title: "Inspired 💜", browseId: "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5", playlistId: "PLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5" },
    { kind: "playlist", title: "Nostalgia", browseId: "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5", playlistId: "PLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5" },
    { kind: "playlist", title: "Calm", browseId: "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5", playlistId: "PLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5" },
    { kind: "playlist", title: "Archive", browseId: "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5", playlistId: "PLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5" },
  ].map((item) => ({
    ...item,
    subtitle: "",
    videoId: null,
    duration: null,
    year: null,
    thumbs: [],
    artists: [],
    album: null,
  })),
};

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  search: ({ filter }) =>
    filter === "artists" ? { top: search.top, items: [search.top], continuation: null } : search,
  watch_track: ({ videoId }) => {
    const track = search.items.find((item) => item.videoId === videoId);
    if (!track) throw new Error("Трека нет в демонстрационных данных");
    return track;
  },
  search_more: () => ({ title: null, layout: "list", items: [], continuation: null }),
  suggestions: () => ["nirvana unplugged", "nirvana come as you are", "nirvana heart shaped box"],
  home: () => home,
  browse: (args) => details[String(args.browseId)] ?? album,
  browse_more: () => ({ title: null, layout: "list", items: [], continuation: null }),
  library_playlists: () => [sidePlaylists],
  library_albums: () => [sidePlaylists],
  library_artists: () => [sidePlaylists],
  liked_songs: () => playlist,
  favorites_list: () => [],
  favorites_sync: () => ({ favorites: [], playlistId: "PLpreviewfavorites", uploaded: 0, downloaded: 0, removed: 0 }),
  favorites_sync_playlist: () => "PLpreviewfavorites",
  recommendations: () => [],
  rate_song: () => null,
  track_lyrics: () => ({
    lines: [
      { text: "It's close to midnight", startMs: 58870, endMs: 62140 },
      { text: "And something evil's lurking in the dark", startMs: 62140, endMs: 68120 },
      { text: "Under the moonlight", startMs: 68120, endMs: 71230 },
      { text: "You see a sight that almost stops your heart", startMs: 71230, endMs: 76400 },
      { text: "You try to scream", startMs: 76400, endMs: 79220 },
      { text: "But terror takes the sound before you make it", startMs: 79220, endMs: 84100 },
      { text: "You start to freeze", startMs: 84100, endMs: 87020 },
      { text: "As horror looks you right between the eyes", startMs: 87020, endMs: 92280 },
      { text: "You're paralyzed", startMs: 92280, endMs: 95030 },
    ],
    plain: null,
    source: "youtube",
    attribution: "LyricFind",
    timed: true,
  }),
  add_to_playlist: () => null,
  create_playlist: () => "PLpreviewplaylist",
  spotify_status: () => ({ signedIn: true }),
  spotify_sign_in: () => ({ signedIn: true }),
  spotify_sign_out: () => ({ signedIn: false }),
  spotify_preview: () => ({
    id: "37i9dQZF1DX4UtSsGT1Sbe",
    name: "All Out 80s",
    description: "The biggest songs of the 1980s. Cover: Duran Duran",
    cover: "https://i.scdn.co/image/ab67706f00000002ffe80c69d2e795ea01e63447",
    signedIn: true,
    tracks: [
      { title: "Hungry Like the Wolf - 2009 Remaster", artists: ["Duran Duran"], seconds: 221 },
      { title: "Heaven", artists: ["Bryan Adams"], seconds: 243 },
      { title: "Heaven Is A Place On Earth", artists: ["Belinda Carlisle"], seconds: 247 },
      { title: "Sweet Dreams (Are Made of This)", artists: ["Eurythmics"], seconds: 217 },
      { title: "Take on Me", artists: ["a-ha"], seconds: 225 },
      { title: "Total Eclipse of the Heart", artists: ["Bonnie Tyler"], seconds: 330 },
      { title: "Africa", artists: ["TOTO"], seconds: 295 },
      { title: "Everybody Wants to Rule the World", artists: ["Tears for Fears"], seconds: 251 },
    ],
  }),
  spotify_import: () => ({
    playlistId: "PLpreviewplaylist",
    title: "All Out 80s",
    total: 150,
    added: 147,
    cover: true,
    coverError: null,
    unmatched: [
      { title: "Some Rare Edit", artists: ["Unknown Artist"] },
      { title: "Live at Wembley", artists: ["A Band"] },
      { title: "Another B-Side", artists: ["Someone"] },
    ],
  }),
  auth_status: () => ({
    signedIn: true,
    account: { name: "Nikolay", handle: "@nick", photo: null },
  }),
  auth_open_signin: () => null,
  auth_poll_signin: () => ({
    status: "granted",
    account: { name: "Nikolay", handle: "@nick", photo: null },
    message: null,
  }),
  auth_cancel: () => null,
  auth_sign_out: () => null,
  settings_get: () => ({ language: "ru", palette: null }),
  settings_set: (args) => args.settings,
  stream_url: () => "https://example.invalid/audio.webm",
};

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, unknown> = {}) =>
      handlers[command]?.(args) ?? null,
    transformCallback: (callback: unknown) => callback,
  },
});

const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const initialRoute =
  view === "album"
    ? { name: "detail" as const, browseId: "MPREb_99mXCzrVmLg", kind: "album" as const, title: "MTV Unplugged In New York" }
    : view === "playlist"
      ? { name: "detail" as const, browseId: "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5", kind: "playlist" as const, title: "Nirvana - In Utero" }
      : view === "artist"
        ? { name: "detail" as const, browseId: "UC4DGncXvX-32aG7obY5dF1w", kind: "artist" as const, title: "Nirvana" }
        : view === "home"
          ? { name: "home" as const }
          : undefined;

createRoot(document.getElementById("root") as HTMLElement).render(
  <App initialRoute={initialRoute} initialQuery={params.get("q") ?? ""} />,
);
