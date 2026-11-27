import { Play, Shuffle } from "lucide-react";
import { useId } from "react";
import { usePlayback } from "../player";
import type { MediaItem } from "../types";

type Variant = "app" | "spotify" | "youtube";

export function LikedPlaylistCover({ variant, className = "" }: { variant: Variant; className?: string }) {
  const id = useId();
  const spotify = variant === "spotify";
  const app = variant === "app";
  return (
    <svg className={`liked-playlist-cover ${className}`} viewBox="0 0 240 240" fill="none" aria-hidden="true" focusable="false" data-variant={variant}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="12" y1="0" x2="222" y2="240" gradientUnits="userSpaceOnUse">
          <stop stopColor={app ? "#554035" : spotify ? "#434b35" : "#572b31"} />
          <stop offset=".58" stopColor={app ? "#28211e" : spotify ? "#242b22" : "#2d1c24"} />
          <stop offset="1" stopColor="#151211" />
        </linearGradient>
        <linearGradient id={`${id}-ink`} x1="56" y1="52" x2="184" y2="190" gradientUnits="userSpaceOnUse">
          <stop stopColor={app ? "#ffdfb9" : spotify ? "#d8d7ab" : "#ffc0ac"} />
          <stop offset="1" stopColor={app ? "#d38e62" : spotify ? "#91aa7a" : "#cf736b"} />
        </linearGradient>
      </defs>
      <rect width="240" height="240" rx="20" fill={`url(#${id}-bg)`} />
      {app ? (
        <>
          <path d="M-38 164 164-38M-12 200 200-12M24 236 236 24M60 272 272 60" stroke="#edc29d" strokeOpacity=".07" strokeWidth="22" />
          <circle cx="120" cy="117" r="82" stroke="#e4b58e" strokeOpacity=".18" />
          <circle cx="120" cy="117" r="70" stroke="#e4b58e" strokeOpacity=".09" />
          <path d="M120 169c-12-9-49-33-49-62 0-17 12-29 27-29 10 0 17 5 22 13 5-8 12-13 22-13 15 0 27 12 27 29 0 29-37 53-49 62Z" fill={`url(#${id}-ink)`} />
          <path d="M82 104c1-10 7-16 16-16" stroke="#fff0db" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
          <path d="M98 211h44" stroke="#d4a17a" strokeOpacity=".45" strokeLinecap="round" />
        </>
      ) : spotify ? (
        <>
          <path d="M-38 164 164-38M-12 200 200-12M24 236 236 24M60 272 272 60" stroke="#edc29d" strokeOpacity=".07" strokeWidth="22" />
          <circle cx="120" cy="120" r="80" fill="#1b211b" stroke="#c5cba6" strokeOpacity=".22" />
          <circle cx="120" cy="120" r="68" stroke="#c5cba6" strokeOpacity=".12" />
          <path d="M77 98c28-12 60-10 88 5M82 122c24-10 51-8 75 5M88 145c19-7 40-5 59 5" stroke={`url(#${id}-ink)`} strokeWidth="9" strokeLinecap="round" />
          <path d="M185 37c-3-5-12-4-12 3 0 6 8 12 12 15 4-3 12-9 12-15 0-7-9-8-12-3Z" fill="#c5cca0" fillOpacity=".7" />
        </>
      ) : (
        <>
          <path d="M0 32h240M0 56h240M0 184h240M0 208h240" stroke="#edb09c" strokeOpacity=".08" />
          <circle cx="120" cy="120" r="83" fill="#171215" stroke="#d89585" strokeOpacity=".25" />
          <circle cx="120" cy="120" r="71" stroke="#c58d80" strokeOpacity=".15" />
          <circle cx="120" cy="120" r="59" stroke="#c58d80" strokeOpacity=".15" />
          <path d="M57 94a68 68 0 0 1 89-37M94 183a68 68 0 0 0 89-89" stroke="#edb19c" strokeOpacity=".35" strokeWidth="2" strokeLinecap="round" />
          <rect x="80" y="91" width="80" height="58" rx="18" fill={`url(#${id}-ink)`} />
          <path d="m112 106 23 14-23 14v-28Z" fill="#3c2328" />
          <path d="M185 37c-3-5-12-4-12 3 0 6 8 12 12 15 4-3 12-9 12-15 0-7-9-8-12-3Z" fill="#e7a28c" fillOpacity=".7" />
        </>
      )}
      <rect x=".5" y=".5" width="239" height="239" rx="19.5" stroke="#ffe4cf" strokeOpacity=".12" />
    </svg>
  );
}

export function LikedPlaylistHeader({ variant, items, hasMore = false }: { variant: Variant; items: MediaItem[]; hasMore?: boolean }) {
  const player = usePlayback();
  const playable = items.filter((item) => Boolean(item.videoId));
  return (
    <div className={`liked-playlist-header liked-playlist-${variant}`}>
      <LikedPlaylistCover variant={variant} />
      <div className="liked-playlist-info">
        <div className="hero-kind">{variant === "app" ? "Сердечки в приложении" : variant === "spotify" ? "Импорт из Spotify" : "Лайки YouTube Music"}</div>
        <h2 className="liked-playlist-title">{variant === "app" ? "Избранные" : variant === "spotify" ? "Любимые треки Spotify" : "Любимые треки YouTube"}</h2>
        <div className="liked-playlist-meta">{variant === "app" ? "VLT Music" : "YouTube Music"}<span>·</span>Треков: {items.length}{hasMore ? "+" : ""}</div>
        <div className="hero-actions">
          <button className="solid-button" disabled={playable.length === 0} onClick={() => player.playItems(playable, 0)}>
            <Play size={13} fill="currentColor" /> Слушать
          </button>
          <button className="round-button" disabled={playable.length === 0} title="Перемешать" aria-label="Перемешать" onClick={() => {
            const shuffled = [...playable];
            for (let index = shuffled.length - 1; index > 0; index--) {
              const next = Math.floor(Math.random() * (index + 1));
              [shuffled[index], shuffled[next]] = [shuffled[next], shuffled[index]];
            }
            player.playItems(shuffled, 0);
          }}>
            <Shuffle size={15} strokeWidth={1.7} />
          </button>
        </div>
      </div>
    </div>
  );
}
