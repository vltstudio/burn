import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiFailure } from "../api";
import { Shelf } from "../components/Shelf";
import { LiquidWaveSpinner } from "../components/ui/liquid-spinner";
import { usePlayback } from "../player";
import type { MediaItem, Section } from "../types";

interface Props {
  onOpen: (item: MediaItem) => void;
}

export function HomeView({ onOpen }: Props) {
  const player = usePlayback();
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSections(null);
    setError(null);
    api
      .home()
      .then((data) => {
        if (!cancelled) setSections(data.filter((section) => section.items.length > 0));
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof ApiFailure ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  return (
    <div className="view home-view">
      <header className="view-head">
        <h1 className="view-title">Главная</h1>
        <button className="ghost-button" onClick={reload} disabled={!sections && !error}>
          <RefreshCw size={13} strokeWidth={1.8} /> Обновить
        </button>
      </header>

      {error ? (
        <div className="empty">
          <div className="empty-title">Не удалось загрузить подборки</div>
          <div className="empty-text">{error}</div>
          <button className="ghost-button" onClick={reload}>
            Попробовать снова
          </button>
        </div>
      ) : !sections ? (
        <LiquidWaveSpinner
          size="md"
          words={["Собираем подборки…", "Подбираем под вас…", "Почти готово…"]}
        />
      ) : sections.length === 0 ? (
        <div className="empty">
          <div className="empty-title">Подборок пока нет</div>
          <div className="empty-text">Попробуйте обновить эту страницу позже.</div>
        </div>
      ) : (
        sections.map((section, index) => (
          <section className="block" key={`${section.title ?? "section"}-${index}`}>
            {section.title ? (
              <div className="block-head">
                <h2>{section.title}</h2>
              </div>
            ) : null}
            <Shelf
              section={section}
              currentVideoId={player.current?.videoId ?? null}
              isPlaying={player.playing}
              onPlayList={player.playItems}
              onPlay={(item) => player.playItems([item], 0)}
              onOpen={onOpen}
              maxRows={8}
            />
          </section>
        ))
      )}
    </div>
  );
}
