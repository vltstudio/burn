mod clip;
mod config;
#[cfg(desktop)]
mod discord;
mod favorites_sync;
mod error;
mod import;
mod local;
mod lyrics;
mod quick_player;
mod signin;
mod spotify;
mod yandex;
use signin::{Phase, SignIn};
mod ytm;

use audio_resolver::AudioResolver;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;

use config::{ConfigStore, Settings};
#[cfg(desktop)]
use config::DiscordPreferences;
use favorites_sync::{FavoritesSync, SyncReport};
use error::{Error, Result};
use import::{ImportProgress, ImportReport, ImportRequest};
use local::{ArchivedPlaylist, Favorite, LocalAddRootResult, LocalLibrary, LocalStatus, LocalTrackPage};
use lyrics::{Lyrics, TrackInfo};
use spotify::{Spotify, SpotifyPlaylist};
use ytm::api::{self, Account};
use ytm::parse::{Detail, MediaItem, SearchResults, Section};
use ytm::{auth, Ytm};

/// Label of the embedded webview where the person signs in to Google. Its
/// cookies, once YouTube Music serves them, are the whole credential.
const SIGNIN_WINDOW: &str = "google-signin";

pub struct AppState {
    ytm: Arc<Ytm>,
    spotify: Spotify,
    audio: AudioResolver,
    settings: ConfigStore,
    signin: Mutex<SignIn>,
    local: Arc<LocalLibrary>,
    lyrics: Mutex<HashMap<String, Lyrics>>,
    favorites_sync: FavoritesSync,
    #[cfg(desktop)]
    discord: discord::Presence,
}

// ------------------------------------------------------------------- commands

#[tauri::command]
async fn search(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    filter: Option<String>,
) -> Result<SearchResults> {
    api::search(&state.ytm, &query, filter.as_deref()).await
}

#[tauri::command]
async fn watch_track(
    state: tauri::State<'_, Arc<AppState>>,
    video_id: String,
) -> Result<MediaItem> {
    api::watch_track(&state.ytm, &video_id).await
}

#[tauri::command]
async fn recommendations(
    state: tauri::State<'_, Arc<AppState>>,
    video_id: String,
) -> Result<Vec<MediaItem>> {
    api::recommendations(&state.ytm, &video_id).await
}

#[tauri::command]
async fn search_more(
    state: tauri::State<'_, Arc<AppState>>,
    continuation: String,
    query: String,
    filter: Option<String>,
) -> Result<Section> {
    api::search_more(&state.ytm, &continuation, &query, filter.as_deref()).await
}

#[tauri::command]
async fn suggestions(state: tauri::State<'_, Arc<AppState>>, query: String) -> Result<Vec<String>> {
    api::suggestions(&state.ytm, &query).await
}

#[tauri::command]
async fn home(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Section>> {
    api::home(&state.ytm).await
}

#[tauri::command]
async fn browse(state: tauri::State<'_, Arc<AppState>>, browse_id: String) -> Result<Detail> {
    api::browse(&state.ytm, &browse_id).await
}

#[tauri::command]
async fn browse_more(
    state: tauri::State<'_, Arc<AppState>>,
    continuation: String,
) -> Result<Section> {
    api::browse_more(&state.ytm, &continuation).await
}

#[tauri::command]
async fn library_playlists(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Section>> {
    api::library_playlists(&state.ytm).await
}

#[tauri::command]
async fn library_albums(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Section>> {
    api::library_albums(&state.ytm).await
}

#[tauri::command]
async fn library_artists(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Section>> {
    api::library_artists(&state.ytm).await
}

#[tauri::command]
async fn liked_songs(state: tauri::State<'_, Arc<AppState>>) -> Result<Detail> {
    api::liked_songs(&state.ytm).await
}

#[tauri::command]
async fn add_to_playlist(
    state: tauri::State<'_, Arc<AppState>>,
    playlist_id: String,
    video_id: String,
) -> Result<()> {
    api::add_to_playlist(&state.ytm, &playlist_id, &video_id).await
}

#[tauri::command]
async fn create_playlist(
    state: tauri::State<'_, Arc<AppState>>,
    title: String,
    video_id: Option<String>,
) -> Result<String> {
    api::create_playlist(&state.ytm, &title, video_id.as_deref()).await
}

const SPOTIFY_WINDOW: &str = "spotify-signin";
const SPOTIFY_LOGIN: &str =
    "https://accounts.spotify.com/en/login?continue=https%3A%2F%2Fopen.spotify.com%2F";
const SPOTIFY_TIMEOUT_SECS: i64 = 600;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct SpotifyStatus {
    signed_in: bool,
}

#[tauri::command]
async fn spotify_status(state: tauri::State<'_, Arc<AppState>>) -> Result<SpotifyStatus> {
    Ok(SpotifyStatus {
        signed_in: state.spotify.is_signed_in().await,
    })
}

/// Opens Spotify's own login page in a webview and keeps the session cookie it
/// leaves behind. The cookie is the whole credential: playback and the private
/// playlists both hang off it, and nothing is stored that the browser would not
/// store itself.
#[tauri::command]
async fn spotify_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SpotifyStatus> {
    if let Some(window) = app.get_webview_window(SPOTIFY_WINDOW) {
        let _ = window.close();
    }
    let url: tauri::Url = SPOTIFY_LOGIN
        .parse()
        .map_err(|error| Error::io(format!("bad spotify url: {error}")))?;
    WebviewWindowBuilder::new(&app, SPOTIFY_WINDOW, WebviewUrl::External(url))
        .title("Вход в Spotify")
        .inner_size(460.0, 720.0)
        .min_inner_size(360.0, 520.0)
        .resizable(true)
        .build()
        .map_err(|error| Error::io(format!("не удалось открыть окно входа Spotify: {error}")))?;

    let origin: tauri::Url = "https://open.spotify.com"
        .parse()
        .map_err(|error| Error::io(format!("bad spotify origin: {error}")))?;
    let deadline = chrono::Utc::now().timestamp() + SPOTIFY_TIMEOUT_SECS;

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let Some(window) = app.get_webview_window(SPOTIFY_WINDOW) else {
            return Err(Error::api("Окно входа Spotify закрыто"));
        };
        if let Ok(cookies) = window.cookies_for_url(origin.clone()) {
            let cookies: BTreeMap<String, String> = cookies
                .into_iter()
                .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
                .collect();
            if cookies.contains_key("sp_dc") {
                let _ = window.close();
                state.spotify.sign_in(cookies).await?;
                return Ok(SpotifyStatus { signed_in: true });
            }
        }
        if chrono::Utc::now().timestamp() > deadline {
            let _ = window.close();
            return Err(Error::api(
                "Вход в Spotify не завершился, попробуйте ещё раз",
            ));
        }
    }
}

#[tauri::command]
async fn spotify_sign_out(state: tauri::State<'_, Arc<AppState>>) -> Result<SpotifyStatus> {
    state.spotify.sign_out().await?;
    Ok(SpotifyStatus { signed_in: false })
}

#[tauri::command]
async fn spotify_preview(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<SpotifyPlaylist> {
    state.spotify.playlist(&url).await
}

/// Reads the Spotify playlist, matches every track on YouTube Music, then
/// creates the playlist with the same name, description and cover.
#[tauri::command]
async fn spotify_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
    title: Option<String>,
    description: Option<String>,
    privacy: Option<String>,
    cover: Option<bool>,
    request_id: String,
) -> Result<ImportReport> {
    let request = ImportRequest {
        request_id,
        url,
        title,
        description,
        privacy,
        cover: cover.unwrap_or(true),
    };
    let state = state.inner().clone();
    import::import(
        &state.spotify,
        state.ytm.clone(),
        request,
        move |progress| emit_import(&app, progress),
    )
    .await
}

/// Liked songs are a collection, not a playlist, so they are read from the
/// signed-in Spotify session and pushed through the same import pipeline.
#[tauri::command]
async fn spotify_import_liked(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    title: Option<String>,
    privacy: Option<String>,
    cover: Option<bool>,
    request_id: String,
) -> Result<ImportReport> {
    let request = ImportRequest {
        request_id,
        url: "spotify:liked".into(),
        title,
        description: None,
        privacy,
        cover: cover.unwrap_or(false),
    };
    let state = state.inner().clone();
    import::import_liked(
        &state.spotify,
        state.ytm.clone(),
        request,
        move |progress| emit_import(&app, progress),
    )
    .await
}

fn emit_import(app: &tauri::AppHandle, progress: ImportProgress) {
    use tauri::Emitter;
    let _ = app.emit("spotify-import", progress);
}

#[tauri::command]
fn spotify_import_cancel(request_id: String) -> bool {
    import::cancel(&request_id)
}

#[tauri::command]
async fn yandex_preview(files: Vec<yandex::YandexFile>) -> Result<yandex::YandexPreview> {
    yandex::preview(files).await
}

#[tauri::command]
async fn yandex_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    collections: Vec<yandex::YandexCollection>,
    request_id: String,
) -> Result<Vec<yandex::YandexImportResult>> {
    use tauri::Emitter;
    yandex::import(state.ytm.clone(), request_id, collections, move |progress| {
        let _ = app.emit("yandex-import", progress);
    }).await
}

#[tauri::command]
fn yandex_import_cancel(request_id: String) -> bool {
    import::cancel(&request_id)
}

#[tauri::command]
async fn playlist_delete(
    state: tauri::State<'_, Arc<AppState>>,
    playlist_id: String,
) -> Result<()> {
    api::delete_playlist(&state.ytm, &playlist_id).await
}

/// Karaoke lyrics for the playing track: timestamped lines from YouTube Music,
/// LRCLIB when the catalogue only has plain text. The result is cached per
/// track because the panel is opened and closed often.
#[tauri::command]
async fn track_lyrics(
    state: tauri::State<'_, Arc<AppState>>,
    video_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration: Option<u32>,
) -> Result<Lyrics> {
    let info = TrackInfo {
        title: title.unwrap_or_default(),
        artist: artist.unwrap_or_default(),
        album,
        seconds: duration,
    };
    let key = match &video_id {
        Some(id) => format!("yt:{id}"),
        None => format!("meta:{}—{}", info.title, info.artist),
    };
    if let Some(hit) = state.lyrics.lock().await.get(&key).cloned() {
        return Ok(hit);
    }
    let fetched = lyrics::fetch(&state.ytm, video_id.as_deref(), info).await?;
    let mut cache = state.lyrics.lock().await;
    if cache.len() >= 64 {
        cache.clear();
    }
    cache.insert(key, fetched.clone());
    Ok(fetched)
}

#[tauri::command]
async fn rate_song(
    state: tauri::State<'_, Arc<AppState>>,
    video_id: String,
    rating: String,
) -> Result<()> {
    api::rate_song(&state.ytm, &video_id, &rating).await
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    signed_in: bool,
    account: Option<Account>,
}

#[tauri::command]
async fn auth_status(
    state: tauri::State<'_, Arc<AppState>>,
    refresh: Option<bool>,
) -> Result<AuthStatus> {
    let signin = state.signin.lock().await;
    if !state.ytm.is_signed_in().await {
        return Ok(AuthStatus::default());
    }
    if let Some(account) = signin.account.clone().filter(|_| !refresh.unwrap_or(false)) {
        return Ok(AuthStatus {
            signed_in: true,
            account: Some(account),
        });
    }
    let generation = signin.generation();
    drop(signin);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        api::account(&state.ytm),
    ).await.map_err(|_| Error::api("Не удалось проверить аккаунт за 12 секунд. Проверьте интернет или VPN и повторите проверку."))?;
    let mut signin = state.signin.lock().await;
    if signin.generation() != generation {
        return Err(Error::api(
            "Состояние входа изменилось. Повторите проверку аккаунта.",
        ));
    }
    match result {
        Ok(account) => {
            signin.account = Some(account.clone());
            Ok(AuthStatus {
                signed_in: true,
                account: Some(account),
            })
        }
        Err(Error::Auth(message)) => {
            state.ytm.sign_out().await?;
            signin.invalidate();
            Err(Error::Auth(message))
        }
        Err(error) => Err(error),
    }
}

const SIGNIN_URL: &str = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmusic.youtube.com%2F&service=youtube";
const SIGNIN_TIMEOUT_SECS: u64 = 300;

#[tauri::command]
async fn auth_open_signin(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<()> {
    let mut signin = state.signin.lock().await;
    if let Some(window) = app.get_webview_window(SIGNIN_WINDOW) {
        if matches!(signin.phase, Phase::Pending | Phase::Verifying) {
            window
                .set_focus()
                .map_err(|_| Error::io("Не удалось показать окно входа"))?;
            return Ok(());
        }
        window
            .close()
            .map_err(|_| Error::io("Не удалось закрыть прежнее окно входа"))?;
    }
    let url: tauri::Url = SIGNIN_URL
        .parse()
        .map_err(|_| Error::io("Некорректный адрес входа"))?;
    WebviewWindowBuilder::new(&app, SIGNIN_WINDOW, WebviewUrl::External(url))
        .title("Вход в Google")
        .inner_size(480.0, 760.0)
        .min_inner_size(380.0, 560.0)
        .resizable(true)
        .build()
        .map_err(|_| Error::io("Не удалось открыть окно входа Google"))?;
    let generation = signin.begin();
    drop(signin);
    watch_signin(state.inner().clone(), app, generation);
    Ok(())
}

fn signin_cookies(app: &tauri::AppHandle) -> Option<auth::Session> {
    let origin: tauri::Url = ytm::ORIGIN.parse().ok()?;
    let window = app
        .get_webview_window(SIGNIN_WINDOW)
        .or_else(|| app.get_webview_window("main"))?;
    let cookies = window.cookies_for_url(origin).ok()?;
    let jar = cookies
        .into_iter()
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
        .collect();
    auth::Session::from_cookies(jar)
}

fn watch_signin(state: Arc<AppState>, app: tauri::AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let mut closed_at: Option<std::time::Instant> = None;
        let last_message = "Google ещё не передал сессию YouTube Music. Завершите вход в окне Google или повторите попытку.".to_string();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            if !state.signin.lock().await.active(generation) {
                return;
            }
            let window = app.get_webview_window(SIGNIN_WINDOW);
            if window.is_none() {
                closed_at.get_or_insert_with(std::time::Instant::now);
            }
            let cookie_app = app.clone();
            let candidate = match tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tauri::async_runtime::spawn_blocking(move || signin_cookies(&cookie_app)),
            )
            .await
            {
                Ok(Ok(candidate)) => candidate,
                _ => {
                    state.signin.lock().await.finish(generation, Phase::Failed("Окно Google не передало данные входа за 5 секунд. Закройте его и повторите вход.".into()));
                    return;
                }
            };
            if let Some(session) = candidate {
                state
                    .signin
                    .lock()
                    .await
                    .finish(generation, Phase::Verifying);
                let validation = tokio::time::timeout(
                    std::time::Duration::from_secs(12),
                    state.ytm.validate_session(session.clone()),
                )
                .await;
                let mut signin = state.signin.lock().await;
                if !signin.active(generation) {
                    return;
                }
                match validation {
                    Ok(Ok(account)) => {
                        match state.ytm.store_session(session).await {
                            Ok(()) => {
                                signin.finish(generation, Phase::Ready(account));
                            }
                            Err(_) => {
                                signin.finish(
                                    generation,
                                    Phase::Failed("Не удалось сохранить сессию на диск".into()),
                                );
                            }
                        }
                        if let Some(window) = window {
                            let _ = window.close();
                        }
                        return;
                    }
                    Ok(Err(Error::Auth(_))) => {
                        signin.finish(generation, Phase::Failed("Google запомнил аккаунт, но YouTube Music не подтвердил доступ. Завершите вход и согласие на странице YouTube Music, затем повторите вход; при необходимости выполните полный сброс.".into()));
                        return;
                    }
                    Ok(Err(error)) => {
                        signin.finish(
                            generation,
                            Phase::Failed(format!("Не удалось подтвердить вход: {error}")),
                        );
                        return;
                    }
                    Err(_) => {
                        signin.finish(generation, Phase::Failed("YouTube Music не ответил при проверке входа за 12 секунд. Проверьте интернет или VPN и повторите вход.".into()));
                        return;
                    }
                }
            }
            if started.elapsed().as_secs() >= SIGNIN_TIMEOUT_SECS
                || closed_at.is_some_and(|at| at.elapsed().as_secs() >= 6)
            {
                state
                    .signin
                    .lock()
                    .await
                    .finish(generation, Phase::Failed(last_message));
                if let Some(window) = window {
                    let _ = window.close();
                }
                return;
            }
        }
    });
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct AuthPoll {
    status: String,
    account: Option<Account>,
    message: Option<String>,
}

#[tauri::command]
async fn auth_poll_signin(state: tauri::State<'_, Arc<AppState>>) -> Result<AuthPoll> {
    let signin = state.signin.lock().await;
    Ok(match &signin.phase {
        Phase::Idle => AuthPoll {
            status: "denied".into(),
            message: Some("Вход отменён или не начат".into()),
            ..AuthPoll::default()
        },
        Phase::Pending => AuthPoll {
            status: "pending".into(),
            message: Some("Завершите вход в окне Google".into()),
            ..AuthPoll::default()
        },
        Phase::Verifying => AuthPoll {
            status: "pending".into(),
            message: Some("Проверяем доступ к YouTube Music…".into()),
            ..AuthPoll::default()
        },
        Phase::Ready(account) => AuthPoll {
            status: "granted".into(),
            account: Some(account.clone()),
            message: None,
        },
        Phase::Failed(message) => AuthPoll {
            status: "denied".into(),
            message: Some(message.clone()),
            ..AuthPoll::default()
        },
    })
}

#[tauri::command]
async fn auth_cancel(state: tauri::State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<()> {
    state.signin.lock().await.invalidate();
    if let Some(window) = app.get_webview_window(SIGNIN_WINDOW) {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
async fn auth_sign_out(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<()> {
    let mut signin = state.signin.lock().await;
    signin.invalidate();
    if let Some(window) = app.get_webview_window(SIGNIN_WINDOW) {
        let _ = window.close();
    }
    state.ytm.sign_out().await
}

#[tauri::command]
async fn auth_reset(state: tauri::State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<()> {
    let mut signin = state.signin.lock().await;
    signin.invalidate();
    if let Some(window) = app.get_webview_window(SIGNIN_WINDOW) {
        let _ = window.close();
    }
    state.ytm.sign_out().await?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| Error::io("Главное окно не найдено"))?;
    main.clear_all_browsing_data().map_err(|_| {
        Error::io(
            "Не удалось очистить данные окна входа. Перезапустите приложение и повторите сброс.",
        )
    })?;
    let cleared = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let main = main.clone();
            let empty = tauri::async_runtime::spawn_blocking(move || {
                [
                    ytm::ORIGIN,
                    "https://www.youtube.com",
                    "https://accounts.google.com",
                ]
                .into_iter()
                .all(|origin| {
                    origin
                        .parse()
                        .ok()
                        .and_then(|url| main.cookies_for_url(url).ok())
                        .is_some_and(|cookies| cookies.is_empty())
                })
            })
            .await
            .unwrap_or(false);
            if empty {
                return;
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(6), cleared).await
        .map_err(|_| Error::io("Сессия удалена, но очистка cookie ещё не подтверждена. Перезапустите приложение перед новым входом."))
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    found: usize,
    done: bool,
}

#[tauri::command]
async fn local_status(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<LocalStatus> {
    let library = state.local.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_local_library(&app, &library))
        .await
        .map_err(|_| Error::io("Не удалось прочитать состояние локальной библиотеки"))?
}

#[tauri::command]
async fn local_search(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    offset: usize,
    limit: usize,
    generation: Option<u64>,
) -> Result<LocalTrackPage> {
    let library = state.local.clone();
    tauri::async_runtime::spawn_blocking(move || library.search(&query, offset, limit, generation))
        .await
        .map_err(|_| Error::io("Не удалось выполнить поиск по локальной библиотеке"))?
}

#[tauri::command]
async fn local_add_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<LocalAddRootResult> {
    let library = state.local.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = library.add_root_and_scan(&path, &|found| emit_scan(&app, found, false));
        emit_scan(&app, result.as_ref().map_or(0, |value| value.status.total), true);
        result
    }).await.map_err(|_| Error::io("Не удалось просканировать папку"))?
}

#[tauri::command]
async fn local_remove_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<LocalStatus> {
    let library = state.local.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = library.remove_root(&path);
        emit_scan(&app, result.as_ref().map_or(0, |value| value.total), true);
        result
    }).await.map_err(|_| Error::io("Не удалось убрать папку из библиотеки"))?
}

#[tauri::command]
async fn local_rescan(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<LocalStatus> {
    let library = state.local.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = library.scan(&|found| emit_scan(&app, found, false));
        emit_scan(&app, result.as_ref().map_or(0, |value| value.total), true);
        result
    })
    .await
    .map_err(|_| Error::io("Не удалось обновить локальную библиотеку"))?
}

fn emit_scan(app: &tauri::AppHandle, found: usize, done: bool) {
    use tauri::Emitter;
    let _ = app.emit("local-scan", ScanProgress { found, done });
}

fn ensure_local_library(app: &tauri::AppHandle, library: &LocalLibrary) -> Result<LocalStatus> {
    let started = std::cell::Cell::new(false);
    let result = library.ensure_scan(&|found| {
        started.set(true);
        emit_scan(app, found, false);
    });
    if started.get() {
        emit_scan(app, result.as_ref().map_or(0, |value| value.total), true);
    }
    result
}

/// One payload for the archive screen: entries and whether the person set a
/// cover, so the UI never renders a stale combination of the two.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct ArchiveState {
    archived: Vec<ArchivedPlaylist>,
    has_cover: bool,
}

fn archive_snapshot(state: &AppState) -> ArchiveState {
    ArchiveState {
        archived: state.local.archive(),
        has_cover: state.local.archive_cover().is_some(),
    }
}

#[tauri::command]
async fn archive_state(state: tauri::State<'_, Arc<AppState>>) -> Result<ArchiveState> {
    Ok(archive_snapshot(&state))
}

#[tauri::command]
async fn archive_add(
    state: tauri::State<'_, Arc<AppState>>,
    playlist: ArchivedPlaylist,
) -> Result<ArchiveState> {
    state.local.archive_push(playlist)?;
    Ok(archive_snapshot(&state))
}

#[tauri::command]
async fn archive_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<ArchiveState> {
    state.local.archive_remove(&id)?;
    Ok(archive_snapshot(&state))
}

#[tauri::command]
async fn archive_cover_set(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<ArchiveState> {
    state.local.set_archive_cover(&path)?;
    Ok(archive_snapshot(&state))
}

#[tauri::command]
async fn archive_cover_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<ArchiveState> {
    state.local.clear_archive_cover()?;
    Ok(archive_snapshot(&state))
}

#[tauri::command]
async fn favorites_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<Favorite>> {
    Ok(state.local.favorites())
}

#[tauri::command]
async fn favorites_sync_playlist(state: tauri::State<'_, Arc<AppState>>) -> Result<Option<String>> {
    let handle = state.signin.lock().await.account.as_ref().and_then(|account| account.handle.clone());
    match handle {
        Some(handle) => state.favorites_sync.playlist_id(&handle),
        None => Ok(None),
    }
}

#[tauri::command]
async fn favorites_sync(state: tauri::State<'_, Arc<AppState>>) -> Result<SyncReport> {
    let handle = state.signin.lock().await.account.as_ref()
        .and_then(|account| account.handle.clone())
        .ok_or_else(|| Error::Auth("Подтвердите вход в Google перед синхронизацией любимых треков".into()))?;
    state.favorites_sync.sync(&state.ytm, &state.local, &handle).await
}

#[tauri::command]
async fn favorite_toggle(
    state: tauri::State<'_, Arc<AppState>>,
    favorite: Favorite,
) -> Result<bool> {
    state.local.toggle_favorite(favorite)
}

#[tauri::command]
async fn settings_get(state: tauri::State<'_, Arc<AppState>>) -> Result<Settings> {
    Ok(state.settings.get())
}

#[tauri::command]
async fn settings_set(
    state: tauri::State<'_, Arc<AppState>>,
    settings: Settings,
) -> Result<Settings> {
    let saved = state.settings.save(|current| {
        current.language = settings.language;
        current.palette = settings.palette;
    })?;
    if let Some(language) = saved.language.as_deref() {
        state.ytm.set_language(language).await;
    }
    Ok(saved)
}

#[cfg(desktop)]
fn discord_main_window(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(Error::io("Настройки Discord доступны только в основном окне"))
    }
}

#[cfg(desktop)]
#[derive(Serialize)]
struct DiscordPresenceView {
    preferences: DiscordPreferences,
    status: discord::Status,
}

#[cfg(desktop)]
#[tauri::command]
fn discord_presence_get(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordPresenceView> {
    discord_main_window(&window)?;
    Ok(DiscordPresenceView {
        preferences: state.settings.get().discord,
        status: state.discord.status(),
    })
}

#[cfg(desktop)]
#[tauri::command]
fn discord_presence_configure(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    preferences: DiscordPreferences,
) -> Result<DiscordPreferences> {
    discord_main_window(&window)?;
    let previous = state.settings.get().discord;
    let saved = state.settings.save(|settings| settings.discord = preferences)?.discord;
    if saved != previous {
        state.discord.set(None);
    }
    Ok(saved)
}

#[cfg(desktop)]
#[tauri::command]
fn discord_presence_sync(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    activity: Option<discord::Activity>,
) -> Result<()> {
    discord_main_window(&window)?;
    let preferences = state.settings.get().discord;
    let desired = activity.filter(|activity| {
        preferences.enabled && (!activity.local || preferences.share_local)
    });
    state.discord.set(desired);
    Ok(())
}

#[tauri::command]
async fn stream_url(
    state: tauri::State<'_, Arc<AppState>>,
    video_id: String,
    refresh: Option<bool>,
) -> Result<String> {
    if refresh.unwrap_or(false) {
        state.audio.invalidate(&video_id).await;
    }
    state
        .audio
        .resolve(&video_id)
        .await
        .map(String::from)
        .map_err(|err| Error::player(err.to_string()))
}

// ---------------------------------------------------------------------- setup

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<Arc<AppState>>() {
                    state.discord.set(None);
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol("localmedia", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve_local_media(&app, request));
            });
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&config_dir).ok();

            let settings = ConfigStore::load(config_dir.join("settings.json"));
            let http = reqwest::Client::builder()
                .user_agent(ytm::USER_AGENT)
                .timeout(std::time::Duration::from_secs(30))
                .build()?;

            let audio = AudioResolver::new(http.clone());
            let ytm = Arc::new(Ytm::new(http.clone(), config_dir.join("auth.json")));
            let local = Arc::new(LocalLibrary::load(
                config_dir.join("local.json"),
                config_dir.join("covers"),
            ));
            let local_for_state = local.clone();

            let state = Arc::new(AppState {
                ytm,
                spotify: Spotify::new(http, config_dir.join("spotify.json")),
                audio,
                settings,
                signin: Mutex::new(SignIn::default()),
                local: local_for_state,
                lyrics: Mutex::new(HashMap::new()),
                favorites_sync: FavoritesSync::new(config_dir.join("favorites-sync.json")),
                #[cfg(desktop)]
                discord: discord::Presence::new(app.handle().clone()),
            });

            let loaded = state.settings.language();
            tauri::async_runtime::block_on(async {
                state.ytm.set_language(&loaded).await;
                state.ytm.load_session().await;
            });

            let scanner = state.local.clone();
            let progress_app = app.handle().clone();
            app.manage(state);
            #[cfg(windows)]
            if let Err(error) = quick_player::setup(app) {
                eprintln!("Could not set up the quick player: {error}");
            }
            tauri::async_runtime::spawn_blocking(move || {
                let _ = ensure_local_library(&progress_app, &scanner);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search,
            watch_track,
            clip::resolve_clip,
            clip::start_clip_embed,
            recommendations,
            search_more,
            suggestions,
            home,
            browse,
            browse_more,
            library_playlists,
            library_albums,
            library_artists,
            liked_songs,
            local_status,
            local_search,
            local_add_root,
            local_remove_root,
            local_rescan,
            favorites_list,
            favorites_sync,
            favorites_sync_playlist,
            archive_state,
            archive_add,
            archive_remove,
            archive_cover_set,
            archive_cover_clear,
            favorite_toggle,
            add_to_playlist,
            create_playlist,
            playlist_delete,
            spotify_status,
            spotify_sign_in,
            spotify_sign_out,
            spotify_preview,
            spotify_import,
            spotify_import_liked,
            spotify_import_cancel,
            yandex_preview,
            yandex_import,
            yandex_import_cancel,
            rate_song,
            track_lyrics,
            auth_status,
            auth_open_signin,
            auth_poll_signin,
            auth_cancel,
            auth_reset,
            auth_sign_out,
            settings_get,
            settings_set,
            #[cfg(desktop)]
            discord_presence_get,
            #[cfg(desktop)]
            discord_presence_configure,
            #[cfg(desktop)]
            discord_presence_sync,
            stream_url,
            quick_player::quick_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BURN");
}

// ------------------------------------------------------- local media protocol

/// `localmedia://localhost/<encoded path>` serves a scanned audio file. Anything
/// outside the scanned library is refused, so the webview cannot read the disk.
fn serve_local_media(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use std::borrow::Cow;
    use tauri::Manager;

    let raw = request.uri().path().trim_start_matches('/');
    let state = app.state::<std::sync::Arc<AppState>>();

    if raw == "archive-cover" {
        return match state.local.archive_cover() {
            Some(bytes) => {
                let mime = sniff_image(&bytes);
                tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Cache-Control", "no-store")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Cow::Owned(bytes))
                    .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&b""[..])))
            }
            None => tauri::http::Response::builder()
                .status(404)
                .body(Cow::Borrowed(&b"no cover"[..]))
                .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&b""[..]))),
        };
    }

    if let Some(encoded) = raw.strip_prefix("cover/") {
        let id = percent_decode(encoded);
        return match state.local.cover(&id) {
            Ok(Some(bytes)) => {
                let mime = sniff_image(&bytes);
                tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Cache-Control", "max-age=3600")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Cow::Owned(bytes))
                    .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&b""[..])))
            }
            _ => tauri::http::Response::builder()
                .status(404)
                .body(Cow::Borrowed(&b"no cover"[..]))
                .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&b""[..]))),
        };
    }

    let path = percent_decode(raw);

    if !state.local.allows(&path) {
        return tauri::http::Response::builder()
            .status(403)
            .body(Cow::Borrowed(&b"forbidden"[..]))
            .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&b""[..])));
    }

    use std::io::{Read, Seek, SeekFrom};
    let response = |file: &mut std::fs::File| -> std::io::Result<_> {
        let length = file.metadata()?.len();
        let mut builder = tauri::http::Response::builder()
            .header("Content-Type", mime_for(&path))
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Allow-Origin", "*");
        let head = request.method() == tauri::http::Method::HEAD;
        let mut bytes = Vec::new();
        if let Some(range) = request.headers().get(tauri::http::header::RANGE) {
            let Some((start, end)) = range.to_str().ok().and_then(|range| media_range(range, length)) else {
                return Ok(builder.status(416).header("Content-Range", format!("bytes */{length}"))
                    .body(Cow::Borrowed(&b""[..])).unwrap());
            };
            let count = end - start + 1;
            if !head {
                file.seek(SeekFrom::Start(start))?;
                bytes.resize(count as usize, 0);
                file.read_exact(&mut bytes)?;
            }
            builder = builder.status(206)
                .header("Content-Range", format!("bytes {start}-{end}/{length}"))
                .header("Content-Length", count);
        } else {
            if !head {
                file.read_to_end(&mut bytes)?;
            }
            builder = builder.status(200).header("Content-Length", length);
        }
        Ok(builder.body(Cow::Owned(bytes)).unwrap())
    };
    std::fs::File::open(&path).and_then(|mut file| response(&mut file)).unwrap_or_else(|_| {
        tauri::http::Response::builder().status(404)
            .body(Cow::Borrowed(&b"not found"[..])).unwrap()
    })
}

fn media_range(header: &str, length: u64) -> Option<(u64, u64)> {
    const CHUNK: u64 = 2 * 1024 * 1024;
    let (first, last) = header.strip_prefix("bytes=")?.trim().split_once('-')?;
    let limit = length.checked_sub(1)?;
    let parse = |number: &str| {
        (!number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| number.parse::<u64>().ok()).flatten()
    };
    let (start, end) = if first.is_empty() {
        let count = parse(last)?;
        if count == 0 { return None; }
        (length.saturating_sub(count.min(CHUNK)), limit)
    } else {
        let start = parse(first)?;
        let end = if last.is_empty() { limit } else { parse(last)?.min(limit) };
        (start, end.min(start.saturating_add(CHUNK - 1)))
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
#[test]
fn local_media_ranges_are_bounded() {
    assert_eq!(media_range("bytes=10-19", 100), Some((10, 19)));
    assert_eq!(media_range("bytes=10-", 100), Some((10, 99)));
    assert_eq!(media_range("bytes=-10", 100), Some((90, 99)));
    assert_eq!(media_range("bytes=0-9999999", 10_000_000), Some((0, 2_097_151)));
    assert_eq!(media_range("bytes=100-101", 100), None);
    assert_eq!(media_range("bytes=10-9", 100), None);
    assert_eq!(media_range("bytes=0-1,4-6", 100), None);
    assert_eq!(media_range("bytes=-0", 100), None);
    assert_eq!(media_range("bytes=0-", 0), None);
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mime_for(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        "wma" => "audio/x-ms-wma",
        "aiff" | "aif" => "audio/aiff",
        _ => "application/octet-stream",
    }
}

fn sniff_image(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    }
}
