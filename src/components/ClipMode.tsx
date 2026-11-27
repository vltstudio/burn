import { ExternalLink, Music2, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import "./clip-mode.css";

interface ClipModeProps {
  videoId: string;
  title: string;
  kind?: string;
  onClose: () => void;
}

type Relay = { url: string; origin: string; channel: string; videoId: string };
type ClipState =
  | { status: "searching" | "unavailable" }
  | { status: "connecting" | "ready"; relay: Relay }
  | { status: "error"; message: string; videoId?: string };

const validVideoId = /^[\w-]{11}$/;
const embedTimeout = 16_000;

function errorMessage(code: unknown): string {
  switch (code) {
    case 100: return "Видео удалено или недоступно.";
    case 101:
    case 150: return "YouTube не разрешает встроенное воспроизведение этого клипа.";
    case 153: return "Не удалось запустить встроенный плеер YouTube.";
    default: return "Не удалось воспроизвести клип здесь.";
  }
}

export function ClipMode(props: ClipModeProps) {
  return <ClipSession key={JSON.stringify([props.videoId, props.kind])} {...props} />;
}

function ClipSession({ videoId, title, kind, onClose }: ClipModeProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<ClipState>({ status: "searching" });
  const [externalError, setExternalError] = useState(false);

  useEffect(() => {
    let active = true;
    let timeout: number | undefined;
    let relay: Relay | undefined;

    const fail = (code?: unknown) => {
      window.clearTimeout(timeout);
      setState({ status: "error", message: errorMessage(code), videoId: relay?.videoId });
      relay = undefined;
    };
    const receive = (event: MessageEvent) => {
      const source = iframe.current?.contentWindow;
      if (!active || !relay || !source || event.source !== source || event.origin !== relay.origin
          || event.data?.channel !== relay.channel) return;
      if (event.data.status === "ready") {
        window.clearTimeout(timeout);
        setState({ status: "ready", relay });
      } else if (event.data.status === "error") {
        fail(event.data.code);
      }
    };

    async function load() {
      let resolvedId: string | undefined;
      try {
        const id = await api.resolveClip(videoId, kind ?? null);
        if (!active) return;
        if (id === null) {
          setState({ status: "unavailable" });
          return;
        }
        if (typeof id !== "string" || id.length !== 11 || !validVideoId.test(id)) throw new Error();
        resolvedId = id;
        const channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
        const url = new URL(await api.startClipEmbed(id, channel));
        if (!active) return;
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
            || url.username || url.password || url.pathname !== `/clip/${channel}` || url.search || url.hash) {
          throw new Error();
        }
        relay = { url: url.href, origin: url.origin, channel, videoId: id };
        setState({ status: "connecting", relay });
        timeout = window.setTimeout(() => fail(), embedTimeout);
      } catch {
        if (!active) return;
        setState({
          status: "error",
          message: resolvedId ? errorMessage(undefined) : "Не удалось проверить, есть ли клип. Попробуйте ещё раз.",
          videoId: resolvedId,
        });
      }
    }

    window.addEventListener("message", receive);
    void load();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [videoId, kind]);

  const player = state.status === "connecting" || state.status === "ready" ? state.relay : null;
  const waiting = state.status === "searching" || state.status === "connecting";
  const statusText = state.status === "searching" ? "Ищем клип…"
    : state.status === "connecting" ? "Загружаем плеер YouTube…"
    : state.status === "unavailable" ? "У этого трека нет доступного клипа."
    : state.status === "error" ? state.message
    : "Клип";
  const externalId = state.status === "error" ? state.videoId : undefined;

  return (
    <section className="clip-mode" aria-label="Клип YouTube">
      {player && (
        <iframe
          className="clip-mode__player"
          ref={iframe}
          src={player.url}
          title={`Клип: ${title}`}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          allow="encrypted-media; fullscreen"
          allowFullScreen
        />
      )}
      <div className="clip-mode__footer">
        <p className="clip-mode__status" role="status">
          {waiting ? <span className="clip-mode__spinner" aria-hidden="true" />
            : !player ? <VideoOff size={18} aria-hidden="true" />
            : null}
          {statusText}
        </p>
        <div className="clip-mode__actions">
          {externalId && (
            <button
              type="button"
              onClick={() => {
                setExternalError(false);
                void api.openUrl(`https://www.youtube.com/watch?v=${externalId}`).catch(() => setExternalError(true));
              }}
            >
              <ExternalLink size={16} aria-hidden="true" /> Открыть на YouTube
            </button>
          )}
          <button type="button" onClick={onClose}>
            <Music2 size={16} aria-hidden="true" /> Вернуться к музыке
          </button>
        </div>
        {externalError && <p role="alert" className="clip-mode__status">Не удалось открыть браузер.</p>}
      </div>
    </section>
  );
}

export default ClipMode;
