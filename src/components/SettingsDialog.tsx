import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { Check, FolderOpen, Globe2, ListMusic, MessagesSquare, Palette, Plus, RefreshCw, SlidersHorizontal, UserRound, Volume2, VolumeX, X } from "lucide-react";
import { api, ApiFailure } from "../api";
import { usePlayer } from "../player";
import { applyPalette, PALETTES, paletteOf } from "../theme";
import type { AuthStatus, LocalStatus, Settings } from "../types";
import { SettingSection } from "./SettingSection";
import { UpdateSettings } from "./UpdateSettings";
import { DiscordSettings } from "./DiscordSettings";
import { SpotifySyncSettings } from "./SpotifySyncSettings";
import type { useDiscordPresence } from "../discord-presence";

interface Props {
  open: boolean;
  initialTab: SettingsTab;
  transferTarget?: string;
  auth: AuthStatus | null;
  onClose: () => void;
  onAuthChanged: (status?: AuthStatus) => void;
  onToast: (message: string, kind?: "info" | "error") => void;
  discord: ReturnType<typeof useDiscordPresence>;
}

const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
  { value: "pl", label: "Polski" },
  { value: "tr", label: "Türkçe" },
  { value: "uk", label: "Українська" },
];

const SETTINGS_TABS = [
  { id: "account", label: "Аккаунт", icon: UserRound },
  { id: "spotify", label: "Spotify", icon: ListMusic },
  { id: "appearance", label: "Оформление", icon: Palette },
  { id: "local", label: "Локальная музыка", icon: FolderOpen },
  { id: "playback", label: "Воспроизведение", icon: SlidersHorizontal },
  { id: "discord", label: "Discord", icon: MessagesSquare },
  { id: "catalog", label: "Язык каталога", icon: Globe2 },
  { id: "updates", label: "Обновления", icon: RefreshCw },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

function PlaybackSettings() {
  const { muted, volume, toggleMute, setVolume } = usePlayer();
  return (
    <SettingSection title="Воспроизведение">
      <p className="field-hint">Онлайн-треки играют напрямую, без дополнительных программ.</p>
      <div className="settings-volume">
        <label htmlFor="settings-volume">Громкость</label>
        <output htmlFor="settings-volume">{Math.round((muted ? 0 : volume) * 100)}%</output>
        <button
          className="icon-button"
          onClick={toggleMute}
          aria-label={muted ? "Включить звук" : "Выключить звук"}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          id="settings-volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(event) => setVolume(Number(event.target.value))}
        />
      </div>
    </SettingSection>
  );
}

export function SettingsDialog({ open, initialTab, transferTarget, auth, onClose, onAuthChanged, onToast, discord }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [pending, setPending] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState("Ожидаем входа…");
  const authOperation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [settings, setSettings] = useState<Settings>({ language: null, palette: null });
  const [language, setLanguage] = useState("ru");
  const [palette, setPalette] = useState(paletteOf(null).id);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [scanProgress, setScanProgress] = useState<number | null>(null);
  const [localRevision, setLocalRevision] = useState(0);
  const roots = localStatus?.roots ?? [];
  const localCount = scanProgress ?? localStatus?.total ?? null;
  const scanning = localPending || scanProgress !== null;

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    void api
      .settingsGet()
      .then((current) => {
        setSettings(current);
        setLanguage(current.language ?? "ru");
        setPalette(paletteOf(current.palette).id);
      })
      .catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "local") return;
    let cancelled = false;
    setLocalError(null);
    void api.localStatus().then((status) => {
      if (!cancelled) setLocalStatus(status);
    }).catch((error) => {
      if (!cancelled) setLocalError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [open, tab, localRevision]);

  useEffect(() => {
    if (!open || tab !== "local") {
      setScanProgress(null);
      return;
    }
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<{ found: number; done: boolean }>("local-scan", ({ payload }) => {
      if (cancelled) return;
      setScanProgress(payload.done ? null : payload.found);
      if (payload.done) setLocalRevision((value) => value + 1);
    }).then((dispose) => {
      if (cancelled) return dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      void Promise.resolve(unlisten?.()).catch(() => undefined);
    };
  }, [open, tab]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const operation = authOperation.current;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const result = await api.authPollSignin();
        if (cancelled || operation !== authOperation.current) return;
        if (result.status === "granted") {
          setPending(false);
          onToast("Аккаунт Google проверен и подключён");
          onAuthChanged({ signedIn: true, account: result.account });
        } else if (result.status === "denied") {
          setPending(false);
          setFailure(result.message ?? "Вход отменён");
          return;
        } else {
          setAuthMessage(result.message ?? "Ожидаем входа…");
        }
        if (result.status === "pending") timer = window.setTimeout(() => void tick(), 1000);
      } catch (error) {
        if (cancelled || operation !== authOperation.current) return;
        setPending(false);
        setFailure(error instanceof ApiFailure ? error.message : String(error));
      }
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, onAuthChanged, onToast]);

  if (!open) return null;

  const startAuth = async () => {
    const operation = ++authOperation.current;
    setBusy(true);
    setFailure(null);
    try {
      await api.authOpenSignin();
      if (operation !== authOperation.current) return;
      setAuthMessage("Завершите вход в окне Google");
      setPending(true);
    } catch (error) {
      if (operation !== authOperation.current) return;
      setFailure(error instanceof ApiFailure ? error.message : String(error));
    } finally {
      if (operation === authOperation.current) setBusy(false);
    }
  };

  const cancelAuth = async () => {
    ++authOperation.current;
    setPending(false);
    setBusy(true);
    try { await api.authCancel(); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const verifyAuth = async () => {
    const operation = ++authOperation.current;
    setChecking(true);
    setFailure(null);
    try {
      const result = await api.authStatus(true);
      if (operation !== authOperation.current) return;
      onAuthChanged(result);
      onToast(result.signedIn ? "YouTube Music подтвердил вход" : "Сохранённого входа нет");
    } catch (error) {
      if (operation !== authOperation.current) return;
      if (error instanceof ApiFailure && error.needsAuth) onAuthChanged({ signedIn: false, account: null });
      setFailure(error instanceof Error ? error.message : String(error));
    } finally { setChecking(false); }
  };

  const signOut = async () => {
    ++authOperation.current;
    setPending(false);
    setBusy(true);
    setFailure(null);
    try {
      await api.authSignOut();
      onAuthChanged({ signedIn: false, account: null });
      onToast("Вы вышли из аккаунта Google");
    } catch (error) {
      onAuthChanged();
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resetAuth = async () => {
    ++authOperation.current;
    setPending(false);
    setFailure(null);
    setBusy(true);
    try {
      await api.authReset();
      onAuthChanged({ signedIn: false, account: null });
      onToast("Вход сброшен, можно войти заново");
    } catch (error) {
      onAuthChanged();
      setFailure(error instanceof ApiFailure ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const addFolder = async () => {
    let picked: string | string[] | null = null;
    try {
      picked = await openFolderDialog({
        directory: true,
        multiple: false,
        title: "Выберите папку с музыкой",
      });
    } catch (error) {
      onToast(error instanceof ApiFailure ? error.message : String(error), "error");
      return;
    }
    if (typeof picked !== "string") return;
    setLocalPending(true);
    try {
      const { status, found } = await api.localAddRoot(picked);
      setLocalStatus(status);
      onToast(
        found
          ? `Найдено треков: ${found.toLocaleString("ru-RU")}`
          : "В этой папке не нашлось музыкальных файлов",
        found ? "info" : "error",
      );
    } catch (error) {
      onToast(error instanceof ApiFailure ? error.message : String(error), "error");
    } finally {
      setLocalPending(false);
    }
  };

  const removeFolder = async (path: string) => {
    setLocalPending(true);
    try {
      setLocalStatus(await api.localRemoveRoot(path));
    } catch (error) {
      onToast(error instanceof ApiFailure ? error.message : String(error), "error");
    } finally {
      setLocalPending(false);
    }
  };

  const rescan = async () => {
    setLocalPending(true);
    try {
      const status = await api.localRescan();
      setLocalStatus(status);
      onToast(`Просканировано треков: ${status.total.toLocaleString("ru-RU")}`);
    } catch (error) {
      onToast(error instanceof ApiFailure ? error.message : String(error), "error");
    } finally {
      setLocalPending(false);
    }
  };

  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const saveSettings = async (patch: Partial<Settings>) => {
    const next: Settings = { ...settings, ...patch };
    setSettings(next);
    try {
      const saved = await api.settingsSet(next);
      setSettings(saved);
    } catch (error) {
      onToast(error instanceof ApiFailure ? error.message : String(error), "error");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog settings-dialog"
      aria-labelledby="settings-title"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-head">
        <div>
          <h2 className="dialog-title" id="settings-title">Настройки</h2>
          {version ? <span className="settings-build">BURN {version}</span> : null}
        </div>
        <button className="icon-button settings-close" onClick={close} aria-label="Закрыть настройки" title="Закрыть" autoFocus>
          <X size={19} />
        </button>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Разделы настроек">
          {SETTINGS_TABS.filter(({ id }) => id !== "discord" || discord.supported).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className="settings-nav-item"
              aria-current={tab === id ? "true" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={17} strokeWidth={1.7} /> <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="dialog-body" key={tab}>
          {tab === "account" ? (
            <SettingSection title="Аккаунт Google">
              {!pending && <button className="ghost-button verify-account" onClick={() => void verifyAuth()} disabled={checking || busy}>
                <RefreshCw size={14} /> {checking ? "Проверяем вход…" : "Проверить подключение"}
              </button>}
              {auth?.signedIn ? (
                <div className="field-group">
                  <div className="settings-account">
                    <div className="settings-account-mark">
                      {auth.account?.photo ? <img src={auth.account.photo} alt="" /> : <UserRound size={23} />}
                    </div>
                    <div>
                      <strong>{auth.account?.name ?? "Вы вошли в Google"}</strong>
                      <span>{auth.account?.handle ?? "YouTube Music подключён"}</span>
                    </div>
                    <Check size={18} className="settings-check" aria-label="Аккаунт подключён" />
                  </div>
                  <p className="field-hint">
                    Библиотека, понравившиеся треки и плейлисты читаются из вашего аккаунта YouTube
                    Music.
                  </p>
                  <div className="actions-row">
                    <button className="ghost-button" onClick={() => void signOut()} disabled={busy}>
                      Выйти из аккаунта
                    </button>
                    <button className="ghost-button" onClick={() => void resetAuth()} disabled={busy}>
                      Полный сброс входа
                    </button>
                  </div>
                  <p className="field-hint">
                    Сброс стирает сохранённую сессию и все cookie Google в приложении — пригодится,
                    если вход завис или Google не отдаёт доступ.
                  </p>
                </div>
              ) : pending ? (
                <div className="field-group">
                  <p className="field-hint">
                    Мы открыли отдельное окно Google. Выберите аккаунт и войдите — как только
                    вернётесь на YouTube Music, приложение подхватит сессию само.
                  </p>
                  <div className="status-line">
                    <span className="spinner" />
                    {authMessage}
                  </div>
                  <div className="actions-row">
                    <button className="ghost-button" onClick={() => void cancelAuth()}>
                      Отменить
                    </button>
                    <button className="ghost-button" onClick={() => void resetAuth()} disabled={busy}>
                      Полный сброс входа
                    </button>
                  </div>
                </div>
              ) : (
                <div className="field-group">
                  <p className="field-hint">
                    Откроется окно Google: выберите аккаунт и войдите. Как только вы вернётесь на
                    YouTube Music, библиотека, понравившиеся треки и плейлисты появятся в приложении.
                    Логин и пароль вводятся только на стороне Google.
                  </p>
                  <div className="actions-row">
                    <button className="solid-button" onClick={() => void startAuth()} disabled={busy}>
                      {busy ? "Подключение…" : "Войти через Google"}
                    </button>
                    <button className="ghost-button" onClick={() => void resetAuth()} disabled={busy}>
                      Полный сброс входа
                    </button>
                  </div>
                </div>
              )}
              <button className="ghost-button" onClick={() => onAuthChanged()} disabled={busy || pending}>
                Повторить проверку подключения
              </button>
              {failure ? <p className="field-hint" role="alert" style={{ color: "var(--accent)" }}>{failure}</p> : null}
            </SettingSection>
          ) : null}
          {tab === "playback" ? <PlaybackSettings /> : null}
          {tab === "discord" && discord.supported ? <DiscordSettings {...discord} /> : null}
          {tab === "updates" && open ? <UpdateSettings /> : null}
          {tab === "local" ? (
            <SettingSection title="Локальная музыка">
              <p className="field-hint">
                Добавьте папки с файлами на этом компьютере — приложение прочитает их теги и покажет
                треки в библиотеке, рядом с онлайн-музыкой.
              </p>
              {localStatus && roots.length === 0 && !scanning ? (
                <div className="settings-soft-row">
                  <FolderOpen size={17} />
                  Папки ещё не добавлены
                </div>
              ) : roots.length > 0 ? (
                <div className="folder-list">
                  {roots.map((root) => (
                    <div className="folder-row" key={root}>
                      <FolderOpen className="folder-icon" size={19} strokeWidth={1.6} />
                      <span className="folder-name">{root.split(/[\\/]/).filter(Boolean).pop() ?? root}</span>
                      <span className="folder-path" title={root}>
                        {root}
                      </span>
                      <button
                        className="ghost-button"
                        onClick={() => void removeFolder(root)}
                        disabled={scanning}
                      >
                        Убрать
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {localError ? (
                <div className="actions-row">
                  <span role="alert">{localError}</span>
                  <button className="ghost-button" onClick={() => setLocalRevision((value) => value + 1)}>Попробовать снова</button>
                </div>
              ) : roots.length > 0 || scanning || !localStatus ? (
                <div className="status-line" role="status">
                  <span className={`status-dot ${scanning || !localStatus ? "" : "ok"}`} />
                  {localCount === null
                    ? "Индексируем…"
                    : `Треков в библиотеке: ${localCount.toLocaleString("ru-RU")}${scanning ? " — сканируем…" : ""}`}
                </div>
              ) : null}
              <div className="actions-row">
                <button className="solid-button" onClick={() => void addFolder()} disabled={scanning || (!localStatus && !localError)}>
                  <Plus size={16} />
                  {scanning ? "Сканируем…" : "Добавить папку"}
                </button>
                {roots.length > 0 ? (
                  <button className="ghost-button" onClick={() => void rescan()} disabled={scanning}>
                    <RefreshCw size={14} />
                    Пересканировать
                  </button>
                ) : null}
              </div>
            </SettingSection>
          ) : null}
          {tab === "spotify" && <SpotifySyncSettings key={auth?.account?.handle ?? auth?.account?.name ?? ""}
            initialTarget={transferTarget} signedIn={Boolean(auth?.signedIn)} onGoogleSignIn={() => setTab("account")} />}
          {tab === "appearance" ? (
            <SettingSection title="Оформление">
              <p className="field-hint">
                Палитра задаёт цвет подсветки: активный раздел, играющий трек, ползунки и фон окна.
              </p>
              <div className="palette-grid">
                {PALETTES.map((option) => {
                  const active = option.id === palette;
                  return (
                    <button
                      key={option.id}
                      className={`palette-tile ${active ? "active" : ""}`}
                      aria-pressed={active}
                      onClick={() => {
                        setPalette(option.id);
                        applyPalette(option.id);
                        void saveSettings({ palette: option.id });
                      }}
                      title={`${option.name} — ${option.hint}`}
                    >
                      <span className="palette-swatch" style={{ background: option.swatch }} />
                      <span className="palette-name">{option.name}</span>
                      {active ? <Check className="palette-check" size={16} aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
            </SettingSection>
          ) : null}
          {tab === "catalog" ? (
            <SettingSection title="Язык каталога">
              <p className="field-hint">
                Язык названий разделов и метаданных, которые отдаёт YouTube Music.
              </p>
              <select
                className="text-input"
                aria-label="Язык каталога"
                value={language}
                onChange={(event) => {
                  setLanguage(event.target.value);
                  void saveSettings({ language: event.target.value });
                  onToast("Язык сохранён, переоткройте раздел для обновления");
                }}
              >
                {LANGUAGES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </SettingSection>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
