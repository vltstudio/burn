import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    const sync = async () => {
      const next = await getCurrentWindow().isMaximized();
      if (!disposed) setMaximized(next);
    };
    const onResize = () => void sync().catch(() => undefined);
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const act = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow[action]();
      if (action === "toggleMaximize") setMaximized(await appWindow.isMaximized());
    } catch {
      return;
    }
  };

  const maximizeLabel = maximized ? "Восстановить окно" : "Развернуть окно";
  return (
    <div className="window-corner" role="group" aria-label="Управление окном">
      <div className="window-controls">
        <button type="button" onClick={() => void act("minimize")} aria-label="Свернуть окно" title="Свернуть окно">
          <Minus size={15} strokeWidth={1.4} aria-hidden />
        </button>
        <button type="button" onClick={() => void act("toggleMaximize")} aria-label={maximizeLabel} title={maximizeLabel}>
          {maximized ? <Copy size={12} strokeWidth={1.4} aria-hidden /> : <Square size={11} strokeWidth={1.4} aria-hidden />}
        </button>
        <button className="window-close" type="button" onClick={() => void act("close")} aria-label="Закрыть окно" title="Закрыть окно">
          <X size={15} strokeWidth={1.4} aria-hidden />
        </button>
      </div>
    </div>
  );
}
