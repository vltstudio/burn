import { useState } from "react";
import type { useDiscordPresence } from "../discord-presence";
import type { DiscordPreferences, DiscordPresenceStatus } from "../types";
import { SettingSection } from "./SettingSection";
import "./discord-settings.css";

const statusText: Record<DiscordPresenceStatus, string> = {
  idle: "Статус появится при воспроизведении трека.",
  connecting: "Подключаемся к Discord…",
  active: "Discord получил текущий трек.",
  unavailable: "Открой настольный Discord. BURN подключится автоматически.",
  rejected: "Discord не принял статус BURN.",
};

export function DiscordSettings({ preferences, status, loadError, retry, configure }: ReturnType<typeof useDiscordPresence>) {
  return (
    <SettingSection title="Discord">
      <p className="field-hint">
        BURN показывает название, исполнителя, обложку и время воспроизведения.
        Видимость определяют твои настройки приватности в Discord.
      </p>
      {preferences ? (
        <DiscordForm preferences={preferences} status={status} configure={configure} />
      ) : loadError ? (
        <div className="field-group">
          <p className="field-hint" role="alert">Не удалось загрузить настройки Discord.</p>
          <button className="ghost-button" onClick={retry}>Попробовать снова</button>
        </div>
      ) : (
        <p className="field-hint" role="status">Загружаем настройки Discord…</p>
      )}
    </SettingSection>
  );
}

function DiscordForm({ preferences, status, configure }: {
  preferences: DiscordPreferences;
  status: DiscordPresenceStatus;
  configure: (preferences: DiscordPreferences) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (next: DiscordPreferences) => {
    setSaving(true);
    setError("");
    try {
      await configure(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки Discord.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="discord-controls">
      <label className="settings-soft-row discord-check">
        <input
          type="checkbox"
          role="switch"
          checked={preferences.enabled}
          disabled={saving}
          onChange={(event) => void save({ ...preferences, enabled: event.target.checked })}
        />
        <strong>Показывать музыку в Discord</strong>
      </label>
      <label className="discord-check">
        <input
          type="checkbox"
          checked={preferences.shareLocal}
          disabled={saving || !preferences.enabled}
          onChange={(event) => void save({ ...preferences, shareLocal: event.target.checked })}
        />
        Показывать и локальные треки
      </label>
      <p className="field-hint">Локальные обложки и пути к файлам не отправляются.</p>
      <p className="status-line" role="status">
        {preferences.enabled ? statusText[status] : "Показ музыки выключен."}
      </p>
      {error ? <p className="field-hint" role="alert">{error}</p> : null}
    </div>
  );
}
