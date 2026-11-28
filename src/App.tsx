import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { api, ApiFailure } from "./api";
import { BackdropProvider, BackdropWash } from "./backdrop";
import { DownloadsProvider } from "./downloads-provider";
import { LibraryProvider } from "./library";
import { PlayerBar } from "./components/PlayerBar";
import { QuickPlayerBridge } from "./components/QuickPlayerBridge";
import { SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { NowPlayingRail } from "./components/NowPlayingRail";
import { Sidebar } from "./components/Sidebar";
import { Toasts, type ToastItem } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { WindowControls } from "./components/WindowControls";
import { PlayerProvider } from "./player";
import { applyPalette } from "./theme";
import { ArtistNavProvider } from "./ui/artist-links";
import type { AuthStatus, ItemRef, MediaItem, Route, SearchFilter } from "./types";
import { DetailView } from "./views/DetailView";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { SearchView } from "./views/SearchView";
import { UpdaterProvider } from "./updater";
import { UpdateNotice } from "./components/UpdateSettings";
import { DiscordPresenceBridge, useDiscordPresence } from "./discord-presence";

type ToastFn = (message: string, kind?: "info" | "error") => void;

export default function App({
  initialRoute,
  initialQuery = "",
}: {
  initialRoute?: Route;
  initialQuery?: string;
} = {}) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  const toast = useCallback<ToastFn>((message, kind = "info") => {
    const id = ++toastId.current;
    setToasts((current) => [
      ...current.filter((item) => item.message !== message || item.kind !== kind), { id, message, kind },
    ]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 5200);
  }, []);

  return (
    <UpdaterProvider>
      <PlayerProvider onToast={toast}>
        <Shell toast={toast} initialRoute={initialRoute} initialQuery={initialQuery} />
        <Toasts items={toasts} />
      </PlayerProvider>
    </UpdaterProvider>
  );
}

function Shell({
  toast,
  initialRoute,
  initialQuery,
}: {
  toast: ToastFn;
  initialRoute?: Route;
  initialQuery: string;
}) {
  const [stack, setStack] = useState<Route[]>([initialRoute ?? { name: "search" }]);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [transferTarget, setTransferTarget] = useState("");
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [railOpen, setRailOpen] = useState(
    () => window.localStorage.getItem("ytmusicdt.rail") !== "closed",
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  const discord = useDiscordPresence();

  const route = stack[stack.length - 1];
  const routeKey = route.name === "detail" ? `detail-${route.browseId}`
    : route.name === "library" ? `library-${route.tab ?? "playlists"}` : route.name;

  // Views ask YouTube Music for their data once, on mount. Signing in changes
  // every answer, so the content area is remounted when that flips.
  const [dataEpoch, setDataEpoch] = useState(0);
  const identityRef = useRef<string | null>(null);
  const authRequest = useRef(0);

  const refreshAuth = useCallback((confirmed?: AuthStatus) => {
    const request = ++authRequest.current;
    const apply = (next: AuthStatus) => {
      if (request !== authRequest.current) return;
      const identity = next.signedIn ? `${next.account?.handle ?? next.account?.name ?? "connected"}` : "signed-out";
      if (identityRef.current !== identity) {
        identityRef.current = identity;
        setDataEpoch((value) => value + 1);
      }
      setAuth(next);
    };
    if (confirmed) {
      apply(confirmed);
      return;
    }
    void api
      .authStatus(true)
      .then(apply)
      .catch((error) => {
        if (request !== authRequest.current) return;
        if (error instanceof ApiFailure && error.needsAuth) apply({ signedIn: false, account: null });
        toast(error instanceof Error ? error.message : String(error), "error");
      });
  }, [toast]);

  useEffect(() => {
    refreshAuth();
    const reconnect = () => { refreshAuth(); setDataEpoch((value) => value + 1); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [refreshAuth]);

  useEffect(() => {
    api
      .settingsGet()
      .then((settings) => applyPalette(settings.palette))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [routeKey]);

  const navigate = useCallback((next: Route) => setStack([next]), []);

  const openItem = useCallback((item: MediaItem) => {
    if (!item.browseId || item.kind === "song" || item.kind === "video" || item.kind === "episode") {
      return;
    }
    const browseId =
      item.kind === "playlist" && item.playlistId ? `VL${item.playlistId}` : item.browseId;
    setStack((current) => [
      ...current,
      { name: "detail", browseId, kind: item.kind, title: item.title },
    ]);
  }, []);

  const openArtist = useCallback((ref: ItemRef) => {
    setStack((current) => [
      ...current,
      { name: "detail", browseId: ref.browseId, kind: "artist", title: ref.name },
    ]);
  }, []);

  const back = useCallback(
    () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)),
    [],
  );

  const toggleRail = useCallback(() => {
    setRailOpen((value) => {
      window.localStorage.setItem("ytmusicdt.rail", value ? "closed" : "open");
      return !value;
    });
  }, []);

  const submitSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setFilter("all");
    setStack([{ name: "search" }]);
  }, []);

  return (
    <BackdropProvider>
      {discord.preferences?.enabled ? (
        <DiscordPresenceBridge key={String(discord.preferences.shareLocal)} shareLocal={discord.preferences.shareLocal} />
      ) : null}
      <ArtistNavProvider open={openArtist}>
        <DownloadsProvider>
          <LibraryProvider auth={auth} onToast={toast}>
          {isTauri() && /Windows/i.test(navigator.userAgent) ? <QuickPlayerBridge /> : null}
          <div className="app">
          <Sidebar route={route} onNavigate={navigate} onOpen={openItem} />

          <main className="main">
            <BackdropWash />
            <TopBar
              auth={auth}
              query={searchQuery}
              onSubmit={submitSearch}
              onOpenSettings={() => setSettingsTab("account")}
              onNavigate={navigate}
            />

            <UpdateNotice onOpen={() => setSettingsTab("updates")} />
            <div className="content" ref={contentRef} key={dataEpoch}>
              <div className="route-surface" key={routeKey}>
              {route.name === "search" ? (
                <SearchView
                  query={searchQuery}
                  filter={filter}
                  onFilterChange={setFilter}
                  onOpen={openItem}
                />
              ) : null}
              {route.name === "home" ? <HomeView onOpen={openItem} /> : null}
              {route.name === "library" ? (
                <LibraryView
                  initialTab={route.tab}
                  auth={auth}
                  onOpen={openItem}
                  onRequestSignIn={() => setSettingsTab("account")}
                  onOpenLocalSettings={() => setSettingsTab("local")}
                  onCheckTransfer={(id) => { setTransferTarget(id); setSettingsTab("spotify"); }}
                />
              ) : null}
              {route.name === "detail" ? (
                <DetailView
                  browseId={route.browseId}
                  fallbackTitle={route.title}
                  onOpen={openItem}
                  onBack={back}
                />
              ) : null}
              </div>
            </div>
          </main>

          <NowPlayingRail open={railOpen} onToggle={toggleRail} onOpen={openItem} />
          <WindowControls />

          <PlayerBar />

          <SettingsDialog
            open={settingsTab !== null}
            initialTab={settingsTab ?? "account"}
            transferTarget={transferTarget}
            auth={auth}
            onClose={() => { setSettingsTab(null); setTransferTarget(""); }}
            onAuthChanged={refreshAuth}
            onToast={toast}
            discord={discord}
          />
        </div>
          </LibraryProvider>
        </DownloadsProvider>
      </ArtistNavProvider>
    </BackdropProvider>
  );
}
