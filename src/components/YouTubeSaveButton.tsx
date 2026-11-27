import { Download, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { MediaItem } from "../types";
import "./youtube-save.css";

export function YouTubeSaveButton({ item }: { item: MediaItem }) {
  const [selected, setSelected] = useState<{ title: string; videoId: string } | null>(null);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const videoId = item.source !== "local" && !item.localPath && /^[\w-]{11}$/.test(item.videoId ?? "") ? item.videoId : null;

  useEffect(() => {
    const element = dialog.current;
    if (!element || !selected) return;
    element.showModal();
    return () => element.close();
  }, [selected]);

  const close = () => {
    setSelected(null);
    setError(false);
  };
  const openSite = async (url: string) => {
    try {
      await api.openUrl(url);
      close();
    } catch {
      setError(true);
    }
  };

  return (
    <>
      {videoId ? <button type="button" className="ctl small" aria-label="Варианты скачивания" title="Варианты скачивания" aria-haspopup="dialog" onClick={() => setSelected({ title: item.title, videoId })}>
        <Download size={15} strokeWidth={1.7} aria-hidden />
      </button> : null}
      {selected ? (
        <dialog ref={dialog} className="youtube-save-dialog" aria-label="Скачивание трека" onCancel={(event) => {
          event.preventDefault();
          close();
        }}>
          <header className="dialog-head">
            <h2 className="dialog-title">Скачивание</h2>
            <button type="button" aria-label="Закрыть" className="icon-button settings-close" autoFocus onClick={close}><X size={18} /></button>
          </header>
          <div className="youtube-save-body">
            <strong>{selected.title}</strong>
            <p>Если скачивание доступно для вашего аккаунта, YouTube Music сохранит трек офлайн внутри сервиса. Обычные треки каталога не сохраняются на диск как аудиофайлы.</p>
            <button type="button" className="solid-button" onClick={() => void openSite(`https://music.youtube.com/watch?v=${selected.videoId}`)}>
              <ExternalLink size={14} aria-hidden /> Открыть в YouTube Music
            </button>
            <p>Если это ваше видео, его можно скачать файлом из раздела «Контент» в YouTube Studio.</p>
            <button type="button" className="ghost-button" onClick={() => void openSite("https://studio.youtube.com/")}>
              <ExternalLink size={14} aria-hidden /> Открыть YouTube Studio
            </button>
            {error ? <p className="load-error" role="alert">Не удалось открыть страницу. Проверьте браузер и попробуйте снова.</p> : null}
          </div>
        </dialog>
      ) : null}
    </>
  );
}
