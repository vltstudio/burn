import { Download, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useUpdater, type UpdaterState } from "../updater";
import { SettingSection } from "./SettingSection";

function statusText(state: UpdaterState): string {
  switch (state.phase) {
    case "checking": return "Проверяем обновления…";
    case "current": return "Установлена актуальная версия BURN.";
    case "available": return `Доступна BURN ${state.info?.version ?? ""}`;
    case "downloading": return "Загружаем обновление BURN…";
    case "installing": return "Устанавливаем подписанное обновление…";
    case "installed": return "Обновление установлено. Перезапустите BURN.";
    case "restarting": return "Перезапускаем BURN…";
    case "error": return "Не удалось завершить проверку или обновление.";
    default: return "BURN проверяет обновления при запуске.";
  }
}

function downloadText(downloaded: number, total: number | null): string {
  const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return total ? `${size(downloaded)} из ${size(total)}` : size(downloaded);
}

export function UpdateSettings() {
  const updater = useUpdater();
  const { state, supported } = updater;
  const [confirmation, setConfirmation] = useState<"install" | "restart" | null>(null);
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : undefined;
  const confirmingInstall = confirmation === "install" && state.phase === "available";
  const confirmingRestart = confirmation === "restart" && state.phase === "installed";

  return (
    <SettingSection title="Обновления BURN">
      {!supported ? (
        <p className="field-hint">Обновления доступны только в установленной версии BURN. В превью и режиме разработки проверка отключена.</p>
      ) : (
        <div className="updater-status" role="status">{statusText(state)}</div>
      )}
      {state.info && state.phase === "available" ? (
        <div className="updater-version">{state.info.currentVersion} <span>→</span> {state.info.version}</div>
      ) : null}
      {state.error ? <p className="updater-error" role="alert">{state.error}</p> : null}
      {state.phase === "downloading" || state.phase === "installing" ? (
        <div className="updater-progress">
          <progress max={100} value={state.phase === "installing" ? 100 : percent} aria-label="Загрузка обновления" />
          <span>{downloadText(state.downloaded, state.total)}{percent !== undefined ? ` · ${percent}%` : ""}</span>
        </div>
      ) : null}
      {state.info?.notes ? (
        <details className="updater-notes">
          <summary>Что нового</summary>
          <p>{state.info.notes}</p>
        </details>
      ) : null}
      {confirmingInstall || confirmingRestart ? (
        <div className="updater-confirm" role="group" aria-label={confirmingInstall ? "Подтверждение установки обновления" : "Подтверждение перезапуска"}>
          <p>{confirmingInstall
            ? `Загрузить и установить BURN ${state.info?.version}? На Windows приложение закроется для установки и запустится снова. Воспроизведение прервётся.`
            : "Перезапустить BURN сейчас? Воспроизведение прервётся."}</p>
          <div className="actions-row">
            <button className="ghost-button" onClick={() => setConfirmation(null)} autoFocus>Отмена</button>
            <button className="solid-button" onClick={() => {
              setConfirmation(null);
              if (confirmingInstall) updater.install();
              else updater.restart();
            }}>{confirmingInstall ? "Загрузить и установить" : "Перезапустить сейчас"}</button>
          </div>
        </div>
      ) : (
        <div className="actions-row updater-actions">
          {state.phase === "available" ? (
            <button className="solid-button" onClick={() => setConfirmation("install")}>
              <Download size={14} /> Установить обновление
            </button>
          ) : null}
          {state.phase === "installed" ? (
            <button className="solid-button" onClick={() => setConfirmation("restart")}>Перезапустить</button>
          ) : null}
          {state.phase === "checking" ? (
            <button className="ghost-button" onClick={updater.cancelCheck}>Отменить проверку</button>
          ) : (
            <button className="ghost-button" disabled={!supported || state.busy || state.phase === "installed"} onClick={() => {
              setConfirmation(null);
              updater.check();
            }}><RefreshCw size={13} /> Проверить обновления</button>
          )}
        </div>
      )}
      <p className="field-hint updater-hint">Автоматическая проверка ничего не устанавливает. Загрузка, установка и перезапуск — только с вашего согласия.</p>
    </SettingSection>
  );
}

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const updater = useUpdater();
  if (!updater.noticeVisible) return null;
  return (
    <div className="update-notice" role="status">
      <Download size={14} aria-hidden />
      <span>{statusText(updater.state)}</span>
      <button className="link" onClick={onOpen}>Подробнее</button>
      <button className="icon-button" onClick={updater.dismissNotice} aria-label="Скрыть уведомление об обновлении" title="Скрыть уведомление">
        <X size={13} />
      </button>
    </div>
  );
}
