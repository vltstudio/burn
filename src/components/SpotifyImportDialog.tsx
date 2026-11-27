import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ListMusic, X } from "lucide-react";
import { api, ApiFailure } from "../api";
import type { SpotifyImportProgress, SpotifyImportResult, SpotifyPlaylist } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: (result?: SpotifyImportResult, liked?: boolean) => void;
}

const STAGE_TEXT: Record<SpotifyImportProgress["stage"], string> = {
  fetch: "Читаем плейлист Spotify",
  match: "Ищем треки на YouTube Music",
  create: "Создаём плейлист",
  add: "Добавляем треки",
  cover: "Переносим обложку",
  done: "Готово",
};

function describe(progress: SpotifyImportProgress | null): string {
  const stage = progress ? STAGE_TEXT[progress.stage] : "Готовимся";
  if (!progress || progress.total === 0) return `${stage}…`;
  if (progress.stage !== "match" && progress.stage !== "add") return `${stage}…`;
  return `${stage} — ${progress.done} из ${progress.total}`;
}

export function SpotifyImportDialog({ open, onClose, onImported }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<SpotifyPlaylist | null>(null);
  const [result, setResult] = useState<SpotifyImportResult | null>(null);
  const [progress, setProgress] = useState<SpotifyImportProgress | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | "auth" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [spotifySignedIn, setSpotifySignedIn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const active = useRef<{ id: string; kind: "preview" | "import" | "auth"; dispatched: boolean; cancelRequested: boolean } | null>(null);
  const authRevision = useRef(0);
  const session = useRef(0);
  const listener = useRef<Promise<UnlistenFn> | null>(null);

  useEffect(() => {
    if (!open) return;
    const generation = ++session.current;
    const revision = authRevision.current;
    setUrl("");
    setPreview(null);
    setResult(null);
    setProgress(null);
    setBusy(null);
    setError(null);
    setNeedsAuth(false);
    setCancelling(false);
    setSpotifySignedIn(false);
    listener.current = listen<SpotifyImportProgress>("spotify-import", (event) => {
      if (session.current === generation && active.current?.kind === "import"
        && event.payload.requestId === active.current.id) {
        setProgress(event.payload);
      }
    });
    const subscribed = listener.current;
    void subscribed.catch((thrown) => {
      if (session.current === generation) setError(`Не удалось подключить прогресс импорта: ${String(thrown)}`);
    });
    void api
      .spotifyStatus()
      .then((status) => {
        if (session.current === generation && authRevision.current === revision) setSpotifySignedIn(status.signedIn);
      })
      .catch((thrown) => {
        if (session.current === generation && authRevision.current === revision) setError(String(thrown));
      });
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      ++session.current;
      const operation = active.current;
      active.current = null;
      if (operation?.kind === "import") void api.spotifyImportCancel(operation.id).catch(() => {});
      listener.current = null;
      void subscribed.then((dispose) => dispose()).catch(() => {});
      dialog?.close();
    };
  }, [open]);

  const begin = (kind: "preview" | "import" | "auth") => {
    if (active.current || !open) return null;
    if (kind === "auth") ++authRevision.current;
    const operation = { id: crypto.randomUUID(), kind, dispatched: false, cancelRequested: false };
    active.current = operation;
    setBusy(kind);
    setError(null);
    setNeedsAuth(false);
    setResult(null);
    setProgress(null);
    setCancelling(false);
    return operation.id;
  };

  const finish = (id: string) => {
    if (active.current?.id !== id) return;
    active.current = null;
    setBusy(null);
    setCancelling(false);
  };

  const fail = (thrown: unknown) => {
    const error = thrown instanceof ApiFailure ? thrown : null;
    setNeedsAuth(Boolean(error?.needsAuth && /Spotify/i.test(error.message)));
    if (error?.needsAuth && /Spotify/i.test(error.message)) {
      ++authRevision.current;
      setSpotifySignedIn(false);
    }
    setError(error ? error.message : String(thrown));
  };

  const check = async () => {
    if (!url.trim()) return;
    const id = begin("preview");
    if (!id) return;
    setPreview(null);
    try {
      const playlist = await api.spotifyPreview(url.trim());
      if (active.current?.id === id) setPreview(playlist);
    } catch (thrown) {
      if (active.current?.id === id) fail(thrown);
    } finally {
      finish(id);
    }
  };

  const run = async (liked = false) => {
    if (!liked && !url.trim()) return;
    const id = begin("import");
    if (!id) return;
    try {
      if (!listener.current) throw new Error("Прогресс импорта ещё не подключён");
      await listener.current;
      if (active.current?.id !== id) return;
      if (active.current.cancelRequested) throw new Error("Импорт отменён. Плейлист не создавался.");
      active.current.dispatched = true;
      const report = liked
        ? await api.spotifyImportLiked(null, null, false, id)
        : await api.spotifyImport(url.trim(), null, null, true, id);
      if (active.current?.id === id) setResult(report);
      onImported(report, liked);
    } catch (thrown) {
      if (active.current?.id === id) fail(thrown);
      onImported();
    } finally {
      finish(id);
    }
  };

  const cancel = async () => {
    const operation = active.current;
    if (operation?.kind !== "import" || cancelling) return;
    setCancelling(true);
    operation.cancelRequested = true;
    if (!operation.dispatched) return;
    try {
      const stopped = await api.spotifyImportCancel(operation.id);
      if (!stopped && active.current?.id === operation.id) {
        operation.cancelRequested = false;
        setCancelling(false);
        setError("Импорт ещё запускается или уже завершён. Если он продолжается, нажмите «Остановить» ещё раз.");
      }
    } catch (thrown) {
      if (active.current?.id === operation.id) {
        setCancelling(false);
        fail(thrown);
      }
    }
  };

  const signIn = async () => {
    const id = begin("auth");
    if (!id) return;
    try {
      const status = await api.spotifySignIn();
      if (active.current?.id !== id) return;
      if (!status.signedIn) throw new Error("Вход в Spotify не завершён");
      setNeedsAuth(false);
      setSpotifySignedIn(true);
    } catch (thrown) {
      if (active.current?.id === id) fail(thrown);
    } finally {
      finish(id);
    }
  };

  const percent =
    progress && progress.total > 0 && (progress.stage === "match" || progress.stage === "add")
      ? Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)))
      : null;

  return (
    <dialog ref={dialogRef} className="spotify-dialog" aria-labelledby="spotify-import-title" onCancel={(event) => {
      event.preventDefault();
      if (!active.current) onClose();
      else if (active.current.kind === "import") void cancel();
    }}>
      <header className="dialog-head">
        <div>
          <h2 id="spotify-import-title" className="dialog-title">Импорт из Spotify</h2>
        </div>
        <button className="icon-button settings-close" onClick={onClose} disabled={busy !== null} aria-label="Закрыть">
          <X size={18} />
        </button>
      </header>

      <div className="spotify-body">
        <p className="field-hint">
          Вставьте ссылку на плейлист Spotify. Для закрытого плейлиста нужен вход в Spotify. Приложение найдёт те же
          треки на YouTube Music и создаст копию с тем же названием и обложкой.
        </p>

        <div className="spotify-row">
          <input
            className="text-input"
            placeholder="https://open.spotify.com/playlist/…"
            value={url}
            disabled={busy !== null}
            spellCheck={false}
            onChange={(event) => {
              setUrl(event.target.value);
              setPreview(null);
              setResult(null);
              setError(null);
              setNeedsAuth(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void check();
            }}
          />
          <button className="ghost-button" onClick={check} disabled={busy !== null || !url.trim()}>
            {busy === "preview" ? "Читаем…" : "Проверить"}
          </button>
        </div>

        <div className="spotify-liked">
          <div className="spotify-liked-text">
            <strong>Любимые треки</strong>
            <span>
              Войдите в Spotify, чтобы перенести «Мне нравится» в отдельный плейлист YouTube Music.
            </span>
          </div>
          {spotifySignedIn ? (
            <button className="ghost-button" aria-label="Перенести любимые треки из Spotify" onClick={() => void run(true)} disabled={busy !== null}>
              {busy === "import" ? "Импортируем…" : "Перенести"}
            </button>
          ) : (
            <button className="ghost-button" onClick={signIn} disabled={busy !== null}>
              {busy === "auth" ? "Ждём вход в Spotify…" : "Войти в Spotify"}
            </button>
          )}
        </div>

        {error ? <div className="spotify-error" role="alert">{error}</div> : null}

        {needsAuth ? (
          <button className="solid-button" onClick={signIn} disabled={busy !== null}>
            {busy === "auth" ? "Ждём вход в Spotify…" : "Войти в Spotify"}
          </button>
        ) : null}

        {preview ? (
          <div className="spotify-preview">
            {preview.cover ? (
              <img className="spotify-cover" src={preview.cover} alt="" loading="lazy" />
            ) : (
              <div className="spotify-cover spotify-cover-empty">
                <ListMusic size={26} />
              </div>
            )}
            <div className="spotify-preview-text">
              <div className="spotify-name">{preview.name}</div>
              <div className="spotify-meta">
                {preview.tracks.length} треков
                {preview.cover ? " · обложка найдена" : " · без обложки"}
              </div>
              <div className="spotify-preview-list">
                {preview.tracks.slice(0, 5).map((track, index) => (
                  <div key={`${track.title}-${index}`}>
                    {track.title}
                    {track.artists.length > 0 ? ` — ${track.artists.join(", ")}` : ""}
                  </div>
                ))}
                {preview.tracks.length > 5 ? <div>и ещё {preview.tracks.length - 5}…</div> : null}
              </div>
            </div>
          </div>
        ) : null}

        {preview && !result ? (
          <button className="solid-button" onClick={() => void run()} disabled={busy !== null}>
            {busy === "import" ? "Импортируем…" : "Импортировать в YouTube Music"}
          </button>
        ) : null}

        {busy === "import" ? (
          <div className="spotify-progress" role="status" aria-live="polite">
            <div className="spotify-progress-text">{cancelling ? "Останавливаем импорт…" : describe(progress)}</div>
            {percent !== null ? (
              <div className="spotify-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Прогресс импорта">
                <span style={{ width: `${percent}%` }} />
              </div>
            ) : null}
            <button className="ghost-button" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? "Останавливаем…" : "Остановить"}
            </button>
            <p className="field-hint">До создания плейлиста отмена ничего не изменит. После создания сохранится уже добавленная часть; текущий запрос сначала завершится.</p>
          </div>
        ) : null}

        {result ? (
          <div className="spotify-result">
            <div className="spotify-name">
              Плейлист «{result.title}» создан: {result.added} из {result.total} треков
            </div>
            <div className="spotify-meta">
              {result.cover
                ? "Обложка перенесена"
                : result.coverError
                  ? `Обложку поставить не удалось: ${result.coverError}`
                  : "Без обложки"}
            </div>
            {result.unmatched.length > 0 ? (
              <div className="spotify-unmatched">
                <div className="spotify-meta">
                  Не нашлось на YouTube Music — {result.unmatched.length}:
                </div>
                {result.unmatched.slice(0, 12).map((track, index) => (
                  <div key={`${track.title}-${index}`}>
                    {track.title}
                    {track.artists.length > 0 ? ` — ${track.artists.join(", ")}` : ""}
                  </div>
                ))}
                {result.unmatched.length > 12 ? (
                  <div>и ещё {result.unmatched.length - 12}…</div>
                ) : null}
              </div>
            ) : (
              <div className="spotify-meta">Все треки нашлись.</div>
            )}
            <p className="field-hint">
              {result.added + result.unmatched.length < result.total ? "Повторяющиеся совпадения добавлены один раз. " : ""}
              Плейлист уже в библиотеке — обновите список в сайдбаре, если его там ещё нет.
            </p>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
