import { emitTo } from "@tauri-apps/api/event";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { QUICK_REQUEST, QUICK_STATE, QUICK_VISIBILITY, QUICK_WINDOW, subscribeQuick, type QuickRequest, type QuickState } from "../quick-player";
import { favoriteKey } from "../ui/format";

export function QuickPlayerBridge() {
  const player = usePlayer();
  const library = useLibrary();
  const visible = useRef(false);
  const key = player.current ? favoriteKey(player.current) : null;
  const favorite = key !== null && library.favoriteIds.has(key);
  const controls = useRef({ player, toggleFavorite: library.toggleFavorite, favorite });
  const publish = () => {
    const { player: p, favorite } = controls.current;
    const state: QuickState = {
      palette: document.documentElement.dataset.palette,
      current: p.current, playing: p.playing, loading: p.loading, progress: p.progress, duration: p.duration,
      volume: p.volume, muted: p.muted, shuffle: p.shuffle, repeat: p.repeat, favorite,
    };
    void emitTo(QUICK_WINDOW, QUICK_STATE, state).catch(() => undefined);
  };

  useLayoutEffect(() => {
    controls.current = { player, toggleFavorite: library.toggleFavorite, favorite };
    if (visible.current) publish();
  }, [player, library.toggleFavorite, favorite]);

  useEffect(() => {
    const visibility = subscribeQuick<boolean>("main", QUICK_VISIBILITY, (open) => {
      visible.current = open;
      if (open) publish();
    });
    const requests = subscribeQuick<QuickRequest>("main", QUICK_REQUEST, (request) => {
      if (request.action === "snapshot") {
        publish();
        return;
      }
      if (!visible.current) return;
      const { player: p, toggleFavorite } = controls.current;
      switch (request.action) {
        case "toggle": p.toggle(); break;
        case "previous": p.previous(); break;
        case "next": p.next(); break;
        case "mute": p.toggleMute(); break;
        case "shuffle": p.toggleShuffle(); break;
        case "repeat": p.cycleRepeat(); break;
        case "favorite": if (p.current) toggleFavorite(p.current); break;
        case "seek": if (Number.isFinite(request.value)) p.seek(Math.max(0, Math.min(p.duration, request.value))); break;
        case "volume": if (Number.isFinite(request.value)) p.setVolume(Math.max(0, Math.min(1, request.value))); break;
        case "play": p.playItems([request.item], 0); break;
        case "enqueue": p.enqueue(request.item); break;
      }
    });
    void Promise.all([visibility.ready, requests.ready]).catch(() => undefined);
    return () => {
      visible.current = false;
      visibility.dispose();
      requests.dispose();
    };
  }, []);

  return null;
}
