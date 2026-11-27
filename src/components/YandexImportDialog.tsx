import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ExternalLink, FileJson, X } from "lucide-react";
import { api } from "../api";
import type { YandexImportResult, YandexPreview, YandexProgress } from "../yandex";
import "./YandexImportDialog.css";

const ARCHIVE_URL = "https://id.yandex.ru/personal/data";
const HELP_URL = "https://yandex.ru/support/id/ru/data";
const STAGES: Record<YandexProgress["stage"], string> = {
  fetch: "Читаем список",
  match: "Ищем треки на YouTube Music",
  create: "Создаём закрытый плейлист",
  add: "Добавляем треки",
  cover: "Переносим обложку",
  done: "Готово",
};

interface Props {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

type Operation = { kind: "preview" } | { kind: "import"; id: string; started: boolean };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function YandexImportDialog({ open, onClose, onImported }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<Operation | null>(null);
  const [busy, setBusy] = useState<Operation["kind"] | null>(null);
  const [preview, setPreview] = useState<YandexPreview | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [results, setResults] = useState<YandexImportResult[] | null>(null);
  const [progress, setProgress] = useState<YandexProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(null);
    setPreview(null);
    setSelection(new Set());
    setResults(null);
    setProgress(null);
    setError(null);
    setStopping(false);
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      const operation = active.current;
      active.current = null;
      if (operation?.kind === "import" && operation.started) {
        void api.yandexImportCancel(operation.id).catch(() => {});
      }
      element?.close();
    };
  }, [open]);

  const parse = async (files: File[]) => {
    if (!open || active.current || files.length === 0) return;
    setError(null);
    setPreview(null);
    setSelection(new Set());
    setResults(null);
    if (files.length > 20 || files.reduce((size, file) => size + file.size, 0) > 16 * 1024 * 1024) {
      setError("Выберите не больше 20 файлов общим размером до 16 МБ.");
      return;
    }
    const operation = { kind: "preview" } as const;
    active.current = operation;
    setBusy("preview");
    try {
      const contents = await Promise.all(files.map(async (file) => ({
        name: file.name,
        text: await file.text(),
      })));
      if (active.current !== operation) return;
      const parsed = await api.yandexPreview(contents);
      if (active.current === operation) setPreview(parsed);
    } catch (thrown) {
      if (active.current === operation) setError(message(thrown));
    } finally {
      if (active.current === operation) {
        active.current = null;
        setBusy(null);
      }
    }
  };

  const run = async () => {
    const collections = preview?.collections.filter((collection) => selection.has(collection.id) && collection.tracks.length);
    if (!open || active.current || !collections?.length || results) return;
    const operation: Operation & { kind: "import" } = { kind: "import", id: crypto.randomUUID(), started: false };
    active.current = operation;
    setBusy("import");
    setError(null);
    setProgress(null);
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<YandexProgress>("yandex-import", ({ payload }) => {
        if (active.current === operation && payload.requestId === operation.id) setProgress(payload);
      });
      if (active.current !== operation) return;
      operation.started = true;
      const imported = await api.yandexImport(collections, operation.id);
      if (active.current === operation) setResults(imported);
    } catch (thrown) {
      if (active.current === operation) setError(message(thrown));
    } finally {
      unlisten?.();
      if (active.current === operation) {
        active.current = null;
        setBusy(null);
        setStopping(false);
      }
      if (operation.started) onImported();
    }
  };

  const stop = async () => {
    const operation = active.current;
    if (operation?.kind !== "import" || stopping) return;
    if (!operation.started) {
      active.current = null;
      setBusy(null);
      return;
    }
    setStopping(true);
    setError(null);
    try {
      const cancelled = await api.yandexImportCancel(operation.id);
      if (!cancelled && active.current === operation) {
        setStopping(false);
        setError("Импорт ещё запускается или уже завершён. Если он продолжается, попробуйте остановить его ещё раз.");
      }
    } catch (thrown) {
      if (active.current === operation) {
        setStopping(false);
        setError(message(thrown));
      }
    }
  };

  const openLink = (url: string) => void api.openUrl(url).catch((thrown) => setError(message(thrown)));
  const available = preview?.collections.filter((collection) => collection.tracks.length) ?? [];
  const canClose = busy !== "import";
  return (
    <dialog
      ref={dialog}
      className="spotify-dialog yandex-dialog"
      aria-labelledby="yandex-import-title"
      onCancel={(event) => {
        event.preventDefault();
        if (canClose) onClose();
        else void stop();
      }}
    >
      <header className="dialog-head">
        <h2 id="yandex-import-title" className="dialog-title">Импорт из Яндекс Музыки</h2>
        <button className="icon-button settings-close" type="button" onClick={onClose} disabled={!canClose} aria-label="Закрыть">
          <X size={18} />
        </button>
      </header>
      <div className="spotify-body">
        <p className="field-hint">
          Закажите архив в Яндекс ID: «Данные на сервисах» → «Музыка» → «Заказать архив с данными».
          Распакуйте архив отдельно и выберите только файлы со списками треков в JSON, например <code>likes.json</code> и <code>playlists.json</code>.
        </p>
        <div className="yandex-actions">
          <button className="ghost-button" type="button" onClick={() => openLink(ARCHIVE_URL)}>
            Открыть Яндекс ID <ExternalLink size={13} />
          </button>
          <button className="ghost-button" type="button" onClick={() => openLink(HELP_URL)}>
            Инструкция Яндекса <ExternalLink size={13} />
          </button>
        </div>
        <p className="field-hint">
          Вход в Яндекс внутри приложения не нужен. Файлы читаются на этом устройстве. Если в файле не хватает метаданных,
          приложение отправит только ID треков в открытый каталог Яндекса. Альбомы и подписки на исполнителей отдельно не переносятся.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void parse(files);
          }}
        />
        <button className="solid-button yandex-select" type="button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
          <FileJson size={17} /> {busy === "preview" ? "Читаем списки…" : "Выбрать файлы JSON"}
        </button>
        {busy === "preview" ? <p className="spotify-meta" role="status">Готовим предварительный просмотр…</p> : null}
        {error ? <div className="spotify-error" role="alert">{error}</div> : null}
        {preview?.warnings.length ? (
          <div className="yandex-warnings" role="status">
            <strong>Часть файлов или треков прочитать не удалось</strong>
            <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </div>
        ) : null}
        {preview && !results ? (
          <section className="yandex-preview" aria-label="Предварительный просмотр списков">
            <div className="yandex-preview-head">
              <strong>Списки для переноса</strong>
              {available.length > 1 ? (
                <button
                  className="ghost-button"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setSelection(selection.size === available.length ? new Set() : new Set(available.map(({ id }) => id)))}
                >
                  {selection.size === available.length ? "Снять выбор" : "Выбрать все"}
                </button>
              ) : null}
            </div>
            {preview.collections.map((collection) => (
              <label key={collection.id} className="spotify-liked yandex-collection">
                <input
                  type="checkbox"
                  checked={selection.has(collection.id)}
                  disabled={busy !== null || !collection.tracks.length}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelection((current) => {
                      const next = new Set(current);
                      if (checked) next.add(collection.id);
                      else next.delete(collection.id);
                      return next;
                    });
                  }}
                />
                <span className="spotify-liked-text">
                  <strong>{collection.name}</strong>
                  <span>
                    Треков: {collection.tracks.length}
                    {collection.skipped ? ` · пропущено: ${collection.skipped}` : ""}
                  </span>
                  {collection.tracks.length > 0 ? (
                    <span>{collection.tracks.slice(0, 3).map((track) => track.title).join(" · ")}</span>
                  ) : null}
                </span>
              </label>
            ))}
            {!available.length ? <p className="field-hint">Не найдено ни одного списка с данными треков.</p> : (
              <>
                <p className="field-hint">
                  Для каждого списка создаётся закрытый плейлист, а треки ищутся на YouTube Music по названиям и исполнителям.
                  Ваши лайки на YouTube Music не изменятся.
                </p>
                <button className="solid-button" type="button" onClick={() => void run()} disabled={!selection.size || busy !== null}>
                  {busy === "import" ? "Импортируем…" : `Импортировать в YouTube Music (${selection.size})`}
                </button>
              </>
            )}
          </section>
        ) : null}
        {busy === "import" ? (
          <div className="spotify-progress" role="status">
            <p className="spotify-progress-text">
              {stopping ? "Останавливаем импорт…" : progress
                ? `${progress.collectionIndex} из ${progress.collectionTotal} · ${progress.collectionName}: ${STAGES[progress.stage]}${progress.total > 0 && (progress.stage === "match" || progress.stage === "add") ? ` — ${progress.done} из ${progress.total}` : ""}`
                : "Готовим импорт…"}
            </p>
            {(progress?.stage === "match" || progress?.stage === "add") && progress.total > 0 ? (
              <progress max={progress.total} value={progress.done} aria-label="Прогресс текущего списка" />
            ) : null}
            <button className="ghost-button" type="button" onClick={() => void stop()} disabled={stopping}>Остановить</button>
            <p className="field-hint">Созданные плейлисты и уже добавленные треки сохранятся.</p>
          </div>
        ) : null}
        {results ? (
          <section className="yandex-preview" aria-label="Результаты импорта">
            <strong>Результаты импорта</strong>
            {results.map(({ id, name, skipped, report, error }) => (
              <div className="spotify-liked yandex-collection" key={id}>
                <div className="spotify-liked-text">
                  <strong>{name}</strong>
                  {error ? <span>{error}</span> : null}
                  {report ? <span>Добавлено {report.added} из {report.total + skipped} треков.</span> : null}
                  {skipped ? <span>Пропущено в исходном списке: {skipped}.</span> : null}
                  {report && report.added + report.unmatched.length < report.total ? <span>Совпадающие треки добавлены один раз.</span> : null}
                  {report?.unmatched.length ? (
                    <details>
                      <summary>Не нашлось на YouTube Music: {report.unmatched.length}</summary>
                      <ul>{report.unmatched.map((track, index) => (
                        <li key={index}>{track.title} — {track.artists.join(", ")}</li>
                      ))}</ul>
                    </details>
                  ) : null}
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </dialog>
  );
}
