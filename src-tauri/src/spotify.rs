//! Spotify side of the playlist import, ported from SpotAPI's approach: the
//! web player's own token endpoint guarded by a TOTP code found in the live
//! JavaScript bundle, and the playlist service behind it. Public playlists
//! work anonymously, a signed-in session additionally opens private ones.
//!
//! The anonymous token also serves the embed pages, which is where the fast
//! path for track metadata and cover art comes from.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tokio::task::JoinSet;

use crate::error::{Error, Result};

const OPEN: &str = "https://open.spotify.com";
const EMBED: &str = "https://open.spotify.com/embed";
const TOKEN: &str = "https://open.spotify.com/api/token";
const PLAYLIST_SERVICE: &str = "https://spclient.wg.spotify.com/playlist/v2/playlist";
const PATHFINDER: &str = "https://api-partner.spotify.com/pathfinder/v1/query";
/// Web player build the client token is requested for.
const CLIENT_VERSION: &str = "1.2.80.333.g6d8aabfd";
/// `fetchLibraryTracks` as of the bundle this was written against; a stale
/// hash is rediscovered from the live bundle.
const LIBRARY_TRACKS_HASH: &str =
    "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240";
/// Used only when the token endpoint does not name a client id.
const FALLBACK_CLIENT_ID: &str = "d8a5ed958d274c2e8ee717e6a4b0971d";
/// Hashes seen in released web players; the list is a safety net for the day
/// the bundle stops carrying the operation.
const IMAGE_CDN: &str = "https://i.scdn.co/image/";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

/// Tracks an embed page carries; a longer playlist needs one request per track
/// past this point.
const EMBED_TRACK_LIMIT: usize = 100;
const TRACK_WORKERS: usize = 6;
/// Renew the token a minute before Spotify invalidates it.
const TOKEN_MARGIN_MS: i64 = 60_000;
const STALE_QUERY: &str = "Spotify обновил описание запроса любимых треков";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Session {
    pub cookies: BTreeMap<String, String>,
}

impl Session {
    fn from_cookies(cookies: BTreeMap<String, String>) -> Option<Self> {
        let signed_in = cookies.get("sp_dc").is_some_and(|value| !value.is_empty());
        signed_in.then_some(Session { cookies })
    }

    fn cookie_header(&self) -> String {
        self.cookies
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Totp {
    secret: String,
    version: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct Store {
    session: Option<Session>,
    totp: Option<Totp>,
}

#[derive(Clone, Debug)]
struct Token {
    value: String,
    expires_at: i64,
    anonymous: bool,
    /// The web player's own client id, echoed back when asking for a client token.
    client_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct TrackMeta {
    title: String,
    artists: Vec<String>,
    seconds: Option<u32>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyTrack {
    pub title: String,
    pub artists: Vec<String>,
    pub seconds: Option<u32>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub description: String,
    pub cover: Option<String>,
    pub tracks: Vec<SpotifyTrack>,
    /// True when a signed-in session read the list, so a private playlist was
    /// readable.
    pub signed_in: bool,
}

pub struct Spotify {
    http: reqwest::Client,
    store_path: PathBuf,
    store: RwLock<Store>,
    token: RwLock<Option<(u64, Token)>>,
    session_generation: AtomicU64,
    client_token: RwLock<Option<(String, i64)>>,
}

impl Spotify {
    pub fn new(http: reqwest::Client, store_path: PathBuf) -> Self {
        let store = std::fs::read_to_string(&store_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Store>(&text).ok())
            .unwrap_or_default();
        Self {
            http,
            store_path,
            store: RwLock::new(store),
            token: RwLock::new(None),
            session_generation: AtomicU64::new(0),
            client_token: RwLock::new(None),
        }
    }

    pub async fn is_signed_in(&self) -> bool {
        self.store.read().await.session.is_some()
    }

    pub async fn sign_in(&self, cookies: BTreeMap<String, String>) -> Result<()> {
        let Some(session) = Session::from_cookies(cookies) else {
            return Err(Error::api(
                "Spotify не выдал cookie sp_dc — вход не завершился",
            ));
        };
        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let token = self.issue_token_for(Some(&session)).await?;
        if token.anonymous {
            return Err(Error::Auth(
                "Spotify не подтвердил вход. Войдите в Spotify заново.".into(),
            ));
        }
        {
            let mut store = self.store.write().await;
            if self.session_generation.load(Ordering::SeqCst) != generation {
                return Err(Error::api("Вход в Spotify был отменён или заменён новым"));
            }
            let mut candidate = store.clone();
            candidate.session = Some(session);
            self.save(&candidate)?;
            *store = candidate;
        }
        *self.token.write().await = Some((generation, token));
        *self.client_token.write().await = None;
        Ok(())
    }

    pub async fn sign_out(&self) -> Result<()> {
        self.session_generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut store = self.store.write().await;
            let mut candidate = store.clone();
            candidate.session = None;
            self.save(&candidate)?;
            *store = candidate;
        }
        *self.token.write().await = None;
        *self.client_token.write().await = None;
        Ok(())
    }

    /// Reads a playlist: name, description, cover and every track in order.
    /// Public playlists need no account; a private one needs a session.
    pub async fn playlist(&self, input: &str) -> Result<SpotifyPlaylist> {
        let id = parse_playlist_id(input)?;
        let token = self.access_token().await?;
        let service = self.service_playlist(&id, &token.value).await?;
        let embedded = self.embedded_playlist(&id).await;

        let name = service
            .name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| embedded.as_ref().map(|page| page.name.clone()))
            .unwrap_or_else(|| "Плейлист Spotify".into());
        let cover = embedded
            .as_ref()
            .and_then(|page| page.cover.clone())
            .or_else(|| service.picture.as_deref().map(cover_url));

        let mut known: HashMap<String, TrackMeta> = HashMap::new();
        if let Some(page) = &embedded {
            for (uri, meta) in &page.tracks {
                if valid_meta(meta) {
                    known.insert(uri.clone(), meta.clone());
                }
            }
        }

        let mut metas: Vec<Option<TrackMeta>> = service
            .uris
            .iter()
            .map(|uri| known.get(uri).cloned())
            .collect();

        let missing: Vec<(usize, String)> = metas
            .iter()
            .enumerate()
            .filter(|(_, meta)| meta.is_none())
            .filter_map(|(index, _)| {
                service.uris[index]
                    .strip_prefix("spotify:track:")
                    .map(|track| (index, track.to_string()))
            })
            .collect();
        if !missing.is_empty() {
            let mut set = JoinSet::new();
            let mut next = 0;
            while next < missing.len() || !set.is_empty() {
                while next < missing.len() && set.len() < TRACK_WORKERS {
                    let (index, track) = missing[next].clone();
                    let client = self.http.clone();
                    set.spawn(async move {
                        let mut meta = None;
                        for attempt in 0..3 {
                            meta = track_meta(&client, &track).await;
                            if meta.is_some() {
                                break;
                            }
                            if attempt < 2 {
                                tokio::time::sleep(Duration::from_millis(400 * (attempt + 1)))
                                    .await;
                            }
                        }
                        (index, meta)
                    });
                    next += 1;
                }
                if let Some(joined) = set.join_next().await {
                    if let Ok((index, Some(meta))) = joined {
                        metas[index] = Some(meta);
                    }
                }
            }
        }

        let unread = metas.iter().filter(|meta| meta.is_none()).count();
        if unread > 0 {
            return Err(Error::api(format!(
                "Не удалось прочитать {unread} из {} треков Spotify. Импорт остановлен, чтобы не создать неполную копию. Повторите проверку позже.",
                metas.len()
            )));
        }
        let tracks: Vec<SpotifyTrack> = metas
            .into_iter()
            .flatten()
            .map(|meta| SpotifyTrack {
                title: meta.title,
                artists: meta.artists,
                seconds: meta.seconds,
            })
            .collect();
        if tracks.is_empty() {
            return Err(Error::api("В плейлисте Spotify не нашлось треков"));
        }

        Ok(SpotifyPlaylist {
            id,
            name,
            description: service.description,
            cover,
            tracks,
            signed_in: !token.anonymous,
        })
    }

    /// The account's liked songs. Spotify keeps them as a collection rather
    /// than a playlist, so there is no link to import: they are read from the
    /// signed-in session with the same GraphQL call the web player makes
    /// (`fetchLibraryTracks`), which works where the public Web API is
    /// unreachable.
    pub async fn liked(&self) -> Result<SpotifyPlaylist> {
        if !self.is_signed_in().await {
            return Err(Error::Auth(
                "Войдите в Spotify, чтобы перенести любимые треки".into(),
            ));
        }
        let token = self.access_token().await?;
        if token.anonymous {
            return Err(Error::Auth(
                "Войдите в Spotify, чтобы перенести любимые треки".into(),
            ));
        }

        let tracks = self.liked_tracks().await?;
        if tracks.is_empty() {
            return Err(Error::api("В Spotify нет любимых треков"));
        }
        Ok(SpotifyPlaylist {
            id: "liked".into(),
            name: "Любимые треки Spotify".into(),
            description: "Любимые треки, перенесённые из Spotify".into(),
            cover: None,
            tracks,
            signed_in: true,
        })
    }

    async fn liked_tracks(&self) -> Result<Vec<SpotifyTrack>> {
        let pages = LibraryPages { spotify: self };
        match pages.read(LIBRARY_TRACKS_HASH).await {
            Ok(tracks) => Ok(tracks),
            Err(error) if error.to_string() == STALE_QUERY => {
                let hash = self.discovered_hash("fetchLibraryTracks").await
                    .filter(|hash| hash != LIBRARY_TRACKS_HASH)
                    .ok_or_else(|| Error::api("Spotify обновил запрос любимых треков, но новое описание не найдено. Попробуйте позже."))?;
                pages.read(&hash).await
            }
            Err(error) => Err(error),
        }
    }

    /// The current hashes live in the web player bundle, which Spotify rebuilds
    /// with every release; the constant above is only a first guess.
    async fn discovered_hash(&self, operation: &str) -> Option<String> {
        let html = self.text(OPEN).await.ok()?;
        let bundle = find_web_player_bundle(&html)?;
        let source = self.text(&bundle).await.ok()?;
        find_operation_hash(&source, operation)
    }

    /// Pathfinder rejects requests without Spotify's client token (HTTP 412).
    /// The web player asks clienttoken.spotify.com for one and keeps it for
    /// weeks, so it is cached next to the access token.
    async fn client_token(&self, client_id: Option<&str>) -> Result<String> {
        if let Some((value, expires_at)) = self.client_token.read().await.clone() {
            if expires_at > chrono::Utc::now().timestamp() {
                return Ok(value);
            }
        }
        let body = json!({
            "client_data": {
                "client_version": CLIENT_VERSION,
                "client_id": client_id.unwrap_or(FALLBACK_CLIENT_ID),
                "js_sdk_data": {
                    "device_brand": "unknown",
                    "device_model": "unknown",
                    "os": "windows",
                    "os_version": "NT 10.0",
                    "device_id": "1f8a3f0c-6d5f-4e2c-9a1b-3c7d5e9f0a11",
                    "device_type": "computer",
                },
            },
        });
        let response = self
            .http
            .post("https://clienttoken.spotify.com/v1/clienttoken")
            .header("user-agent", USER_AGENT)
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("origin", OPEN)
            .timeout(Duration::from_secs(20))
            .json(&body)
            .send()
            .await
            .map_err(transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::api(format!(
                "Spotify не выдал клиентский токен: HTTP {}",
                status.as_u16()
            )));
        }
        let value: Value = response.json().await.map_err(transport)?;
        let granted = value
            .get("granted_token")
            .ok_or_else(|| Error::api("Spotify ответил без клиентского токена"))?;
        let token = granted
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::api("Spotify ответил без клиентского токена"))?
            .to_string();
        let ttl = granted
            .get("expires_after_seconds")
            .and_then(Value::as_i64)
            .unwrap_or(3_600);
        *self.client_token.write().await =
            Some((token.clone(), chrono::Utc::now().timestamp() + ttl - 600));
        Ok(token)
    }

    /// One pathfinder call: the persisted query rides in the URL, the body stays
    /// empty, exactly as the web player sends it.
    async fn pathfinder(
        &self,
        token: &str,
        client_token: &str,
        operation: &str,
        hash: &str,
        variables: Value,
    ) -> Result<Value> {
        let extensions = json!({ "persistedQuery": { "version": 1, "sha256Hash": hash } });
        let response = self
            .http
            .post(PATHFINDER)
            .query(&[
                ("operationName", operation.to_string()),
                ("variables", variables.to_string()),
                ("extensions", extensions.to_string()),
            ])
            .header("authorization", format!("Bearer {token}"))
            .header("client-token", client_token)
            .header("spotify-app-version", CLIENT_VERSION)
            .header("app-platform", "WebPlayer")
            .header("origin", OPEN)
            .header("content-length", "0")
            .header("user-agent", USER_AGENT)
            .timeout(Duration::from_secs(20))
            .body(Vec::new())
            .send()
            .await
            .map_err(transport)?;
        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            *self.token.write().await = None;
            return Err(Error::Auth(
                "Spotify не принял сессию — войдите в Spotify заново".into(),
            ));
        }
        if !status.is_success() {
            return Err(Error::api(format!(
                "Spotify ответил HTTP {} на запрос любимых треков{}",
                status.as_u16(),
                if status.as_u16() == 429 {
                    ": слишком много запросов, повторите позже"
                } else {
                    ""
                }
            )));
        }
        let text = response.text().await.map_err(transport)?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| Error::api(format!("Spotify вернул неожиданный ответ: {error}")))?;
        check_graphql_errors(&value)?;
        Ok(value)
    }
    /// Cover art bytes, whatever size Spotify serves (usually 640×640).
    pub async fn cover(&self, url: &str) -> Result<Vec<u8>> {
        let url =
            reqwest::Url::parse(url).map_err(|_| Error::api("Неверный адрес обложки Spotify"))?;
        let host = url.host_str().unwrap_or("");
        if url.scheme() != "https"
            || !(host.ends_with(".scdn.co") || host.ends_with(".spotifycdn.com"))
        {
            return Err(Error::api("Неизвестный адрес обложки Spotify"));
        }
        let mut response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(transport)?;
        if !response.status().is_success() {
            return Err(Error::api(format!(
                "Spotify не отдал обложку: HTTP {}",
                response.status().as_u16()
            )));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err(Error::api("Обложка Spotify оказалась неожиданно большой"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    fn save(&self, store: &Store) -> Result<()> {
        if let Some(dir) = self.store_path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|_| Error::io("Не удалось создать папку настроек Spotify"))?;
        }
        let text = serde_json::to_string_pretty(store)
            .map_err(|_| Error::io("Не удалось сохранить настройки Spotify"))?;
        std::fs::write(&self.store_path, text)
            .map_err(|_| Error::io("Не удалось сохранить сессию Spotify"))
    }

    // ------------------------------------------------------------------ token

    async fn access_token(&self) -> Result<Token> {
        let generation = self.session_generation.load(Ordering::SeqCst);
        if let Some((version, token)) = self.token.read().await.clone() {
            if version == generation
                && token.expires_at - TOKEN_MARGIN_MS > chrono::Utc::now().timestamp_millis()
            {
                return Ok(token);
            }
        }
        let token = self.issue_token().await?;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            return Err(Error::api(
                "Сессия Spotify изменилась во время запроса. Повторите попытку.",
            ));
        }
        *self.token.write().await = Some((generation, token.clone()));
        Ok(token)
    }

    async fn issue_token(&self) -> Result<Token> {
        let session = self.store.read().await.session.clone();
        self.issue_token_for(session.as_ref()).await
    }

    async fn issue_token_for(&self, session: Option<&Session>) -> Result<Token> {
        let mut totp = self.totp().await?;
        for attempt in 0..2 {
            let code = totp_code(&totp.secret, chrono::Utc::now().timestamp());
            let mut request = self
                .http
                .get(TOKEN)
                .query(&[
                    ("reason", "init".to_string()),
                    ("productType", "web-player".to_string()),
                    ("totp", code.clone()),
                    ("totpServer", code),
                    ("totpVer", totp.version.to_string()),
                ])
                .header("user-agent", USER_AGENT)
                .header("accept", "application/json")
                .timeout(Duration::from_secs(20));
            if let Some(session) = &session {
                request = request.header("cookie", session.cookie_header());
            }
            let response = request.send().await.map_err(transport)?;
            let status = response.status();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                // Spotify rotates the TOTP secret with the web player build.
                if attempt == 0 {
                    totp = self.discover_totp().await?;
                    continue;
                }
                return Err(Error::Auth(
                    "Spotify не принял сессию — войдите в Spotify заново".into(),
                ));
            }
            if !status.is_success() {
                return Err(Error::api(format!(
                    "Spotify ответил HTTP {} на запрос токена",
                    status.as_u16()
                )));
            }
            let body: Value = response
                .text()
                .await
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .ok_or_else(|| Error::api("Spotify вернул токен в неизвестном виде"))?;
            let Some(value) = body.get("accessToken").and_then(Value::as_str) else {
                return Err(Error::api("Spotify не выдал токен"));
            };
            let expires_at = body
                .get("accessTokenExpirationTimestampMs")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() + 600_000);
            return Ok(Token {
                value: value.to_string(),
                expires_at,
                anonymous: body
                    .get("isAnonymous")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                client_id: body
                    .get("clientId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        Err(Error::api("Spotify не выдал токен"))
    }

    async fn totp(&self) -> Result<Totp> {
        if let Some(totp) = self.store.read().await.totp.clone() {
            return Ok(totp);
        }
        self.discover_totp().await
    }

    async fn fetch_totp(&self) -> Result<Totp> {
        let html = self.text(&format!("{OPEN}/")).await?;
        let bundle = find_web_player_bundle(&html).ok_or_else(|| {
            Error::api("Spotify не отдал страницу плеера — попробуйте ещё раз чуть позже")
        })?;
        let source = self.text(&bundle).await?;
        let (secret, version) = newest_secret(&source).ok_or_else(|| {
            Error::api("В плеере Spotify не нашёлся ключ авторизации: Spotify обновил сборку")
        })?;
        Ok(Totp { secret, version })
    }

    /// The web player's bundle carries the obfuscated TOTP secret; the newest
    /// version in it is the one the live page uses.
    async fn discover_totp(&self) -> Result<Totp> {
        let mut last = None;
        let mut found = None;
        for _ in 0..2 {
            match self.fetch_totp().await {
                Ok(totp) => {
                    found = Some(totp);
                    break;
                }
                Err(error) => last = Some(error),
            }
        }
        let Some(totp) = found else {
            return Err(last.unwrap_or_else(|| Error::api("Spotify не отдал ключ авторизации")));
        };
        {
            let mut store = self.store.write().await;
            store.totp = Some(totp.clone());
            let _ = self.save(&store);
        }
        Ok(totp)
    }

    // --------------------------------------------------------------- playlist

    async fn service_playlist(&self, id: &str, token: &str) -> Result<ServicePlaylist> {
        let mut playlist: Option<ServicePlaylist> = None;
        let mut offset = 0usize;
        loop {
            let page = self.service_playlist_page(id, token, offset).await?;
            if page.position != offset {
                return Err(Error::api("Spotify вернул неверную страницу плейлиста"));
            }
            let next = offset
                .checked_add(page.count)
                .ok_or_else(|| Error::api("Плейлист Spotify слишком большой"))?;
            if let Some(first) = &playlist {
                if first.length != page.length || first.revision != page.revision {
                    return Err(Error::api(
                        "Плейлист Spotify изменился во время чтения. Повторите проверку.",
                    ));
                }
            }
            let more = page.truncated || page.length.is_some_and(|total| next < total);
            if page.length.is_some_and(|total| next > total) || (more && next == offset) {
                return Err(Error::api(
                    "Spotify вернул неполный список треков плейлиста",
                ));
            }
            match &mut playlist {
                Some(first) => first.uris.extend(page.uris),
                None => playlist = Some(page),
            }
            if !more {
                return playlist.ok_or_else(|| Error::api("Spotify не отдал плейлист"));
            }
            offset = next;
        }
    }

    async fn service_playlist_page(
        &self,
        id: &str,
        token: &str,
        offset: usize,
    ) -> Result<ServicePlaylist> {
        let response = self
            .http
            .get(format!("{PLAYLIST_SERVICE}/{id}"))
            .query(&[
                ("format", "json".to_string()),
                ("from", offset.to_string()),
                ("length", "1000".to_string()),
            ])
            .header("authorization", format!("Bearer {token}"))
            .header("app-platform", "WebPlayer")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(transport)?;
        let status = response.status();
        if status.as_u16() == 401 {
            *self.token.write().await = None;
            return Err(Error::Auth(
                "Spotify не принял сессию — войдите в Spotify заново".into(),
            ));
        }
        if status.as_u16() == 404 || status.as_u16() == 403 {
            if self.is_signed_in().await {
                return Err(Error::api(
                    "Spotify не отдал плейлист: он удалён или принадлежит другому аккаунту",
                ));
            }
            return Err(Error::Auth(
                "Плейлист закрытый. Войдите в Spotify — приложение прочитает его от вашего имени."
                    .into(),
            ));
        }
        if !status.is_success() {
            return Err(Error::api(format!(
                "Spotify ответил HTTP {} на запрос плейлиста",
                status.as_u16()
            )));
        }
        let text = response.text().await.map_err(transport)?;
        json_service_playlist(&text)
    }

    /// The public embed page: name, cover and up to a hundred tracks with
    /// metadata in one request. Absent for private playlists.
    async fn embedded_playlist(&self, id: &str) -> Option<EmbeddedPlaylist> {
        let html = self.text(&format!("{EMBED}/playlist/{id}")).await.ok()?;
        let page: Value = serde_json::from_str(next_data(&html)?).ok()?;
        let entity = page.pointer("/props/pageProps/state/data/entity")?;
        let mut tracks = Vec::new();
        for row in entity
            .get("trackList")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().take(EMBED_TRACK_LIMIT))
            .into_iter()
            .flatten()
        {
            let Some(uri) = row.get("uri").and_then(Value::as_str) else {
                continue;
            };
            if row
                .get("subtitle")
                .and_then(Value::as_str)
                .is_some_and(|subtitle| {
                    subtitle.contains(',') || subtitle.contains(" · ") || subtitle.contains(" • ")
                })
            {
                continue;
            }
            tracks.push((
                uri.to_string(),
                TrackMeta {
                    title: row
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    artists: split_artists(
                        row.get("subtitle").and_then(Value::as_str).unwrap_or(""),
                    ),
                    seconds: row
                        .get("duration")
                        .and_then(Value::as_u64)
                        .and_then(milliseconds),
                },
            ));
        }
        Some(EmbeddedPlaylist {
            name: entity
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            cover: entity
                .pointer("/coverArt/sources/0/url")
                .and_then(Value::as_str)
                .map(str::to_string),
            tracks,
        })
    }

    async fn text(&self, url: &str) -> Result<String> {
        let response = self
            .http
            .get(url)
            .timeout(Duration::from_secs(30))
            .header("user-agent", USER_AGENT)
            .header("accept-language", "en")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(transport)?;
        if !response.status().is_success() {
            return Err(Error::api(format!(
                "Spotify ответил HTTP {}",
                response.status().as_u16()
            )));
        }
        response.text().await.map_err(transport)
    }
}

struct EmbeddedPlaylist {
    name: String,
    cover: Option<String>,
    tracks: Vec<(String, TrackMeta)>,
}

struct ServicePlaylist {
    name: Option<String>,
    description: String,
    picture: Option<String>,
    uris: Vec<String>,
    position: usize,
    count: usize,
    length: Option<usize>,
    truncated: bool,
    revision: Option<String>,
}

fn json_service_playlist(text: &str) -> Result<ServicePlaylist> {
    let body: Value = serde_json::from_str(text).map_err(|error| {
        Error::api(format!("Spotify вернул неожиданный список треков: {error}"))
    })?;
    let attributes = body.get("attributes").cloned().unwrap_or(Value::Null);
    let items = body
        .pointer("/contents/items")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::api("Spotify ответил без списка треков плейлиста"))?;
    let uris = items.iter().map(|item| {
        let uri = item.get("uri").and_then(Value::as_str)
            .filter(|uri| uri.strip_prefix("spotify:track:").is_some_and(valid_id))
            .ok_or_else(|| Error::api("В плейлисте Spotify есть недоступный трек, локальный файл или подкаст. Такой список нельзя перенести полностью."))?;
        Ok(uri.to_string())
    }).collect::<Result<Vec<_>>>()?;
    Ok(ServicePlaylist {
        position: body
            .pointer("/contents/pos")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(0),
        count: items.len(),
        length: body
            .get("length")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok()),
        truncated: body
            .pointer("/contents/truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        revision: body
            .get("revision")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: attributes
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: attributes
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        picture: attributes
            .get("picture")
            .and_then(Value::as_str)
            .map(str::to_string),
        uris,
    })
}

/// `https://open.spotify.com/playlist/<id>?si=…`, `spotify:playlist:<id>`, the
/// localised `open.spotify.com/intl-ru/playlist/<id>` and a bare id all name
/// the same playlist.
pub fn parse_playlist_id(input: &str) -> Result<String> {
    let text = input.trim();
    if valid_id(text) {
        return Ok(text.to_string());
    }
    let id = if let Some(rest) = text.strip_prefix("spotify:playlist:") {
        rest
    } else {
        let url = reqwest::Url::parse(text)
            .map_err(|_| Error::api("Это не ссылка на плейлист Spotify"))?;
        if url.scheme() != "https" || url.host_str() != Some("open.spotify.com") {
            return Err(Error::api("Нужна ссылка с сайта open.spotify.com"));
        }
        let segments: Vec<&str> = url.path_segments().into_iter().flatten().collect();
        let segments = if segments
            .first()
            .is_some_and(|segment| segment.starts_with("intl-"))
        {
            &segments[1..]
        } else {
            &segments[..]
        };
        if segments.len() != 2 || segments[0] != "playlist" {
            return Err(Error::api(
                "Это не ссылка на плейлист Spotify: нужна вида open.spotify.com/playlist/…",
            ));
        }
        let id = segments[1];
        if !valid_id(id) {
            return Err(Error::api(
                "В ссылке Spotify не нашлось идентификатора плейлиста",
            ));
        }
        return Ok(id.to_string());
    };
    let id = id.trim();
    if !valid_id(id) {
        return Err(Error::api(
            "В ссылке Spotify не нашлось идентификатора плейлиста",
        ));
    }
    Ok(id.to_string())
}

fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.chars().all(|symbol| symbol.is_ascii_alphanumeric())
}

fn cover_url(picture: &str) -> String {
    match picture.strip_prefix("spotify:image:") {
        Some(hash) => format!("{IMAGE_CDN}{hash}"),
        None => picture.to_string(),
    }
}

async fn track_meta(http: &reqwest::Client, track: &str) -> Option<TrackMeta> {
    let response = http
        .get(format!("{EMBED}/track/{track}"))
        .header("user-agent", USER_AGENT)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let html = response.text().await.ok()?;
    let page: Value = serde_json::from_str(next_data(&html)?).ok()?;
    let entity = page.pointer("/props/pageProps/state/data/entity")?;
    let meta = TrackMeta {
        title: entity.get("name").and_then(Value::as_str)?.to_string(),
        artists: entity
            .get("artists")
            .and_then(Value::as_array)?
            .iter()
            .map(|artist| {
                artist
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            })
            .collect::<Option<Vec<_>>>()?,
        seconds: entity
            .get("duration")
            .and_then(Value::as_u64)
            .and_then(milliseconds),
    };
    valid_meta(&meta).then_some(meta)
}

fn milliseconds(ms: u64) -> Option<u32> {
    u32::try_from(ms / 1000).ok().filter(|seconds| *seconds > 0)
}

fn valid_meta(meta: &TrackMeta) -> bool {
    !meta.title.trim().is_empty()
        && !meta.artists.is_empty()
        && meta.artists.iter().all(|name| !name.trim().is_empty())
        && meta.seconds.is_some_and(|seconds| seconds > 0)
}

fn split_artists(subtitle: &str) -> Vec<String> {
    subtitle
        .replace('\u{a0}', " ")
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

fn next_data(html: &str) -> Option<&str> {
    let mut rest = html;
    while let Some(at) = rest.find("<script") {
        rest = &rest[at + 7..];
        let end = rest.find('>')?;
        let attributes = &rest[..end];
        rest = &rest[end + 1..];
        if attributes.contains("id=\"__NEXT_DATA__\"") || attributes.contains("id='__NEXT_DATA__'")
        {
            return Some(&rest[..rest.find("</script>")?]);
        }
    }
    None
}

fn find_web_player_bundle(html: &str) -> Option<String> {
    let mut cursor = 0;
    while let Some(found) = html[cursor..].find("/web-player.") {
        let at = cursor + found;
        let start = html[..at].rfind("https://")?;
        let end = html[at..].find(".js").map(|offset| at + offset + 3)?;
        let url = &html[start..end];
        if !url.contains('"') && !url.contains(' ') && !url.contains('\\') {
            return Some(url.to_string());
        }
        cursor = end;
    }
    None
}

/// Spotify ships `secret:"…",version:N` in the bundle; several builds may be
/// present, and the highest version is the live one.
fn newest_secret(source: &str) -> Option<(String, u32)> {
    let mut best: Option<(String, u32)> = None;
    let mut cursor = 0;
    while let Some(found) = source[cursor..].find("secret") {
        let start = cursor + found + "secret".len();
        cursor = start;
        let Some((secret, length)) = read_secret(&source[start..]) else {
            continue;
        };
        let Some(version) = read_version(&source[start + length..]) else {
            continue;
        };
        if best
            .as_ref()
            .map_or(true, |(_, current)| version > *current)
        {
            best = Some((secret, version));
        }
    }
    best
}

fn read_secret(text: &str) -> Option<(String, usize)> {
    let colon = text.find(':')?;
    if colon > 8 {
        return None;
    }
    let rest = &text[colon + 1..];
    let trimmed = rest.trim_start();
    let indent = rest.len() - trimmed.len();
    let quote = trimmed.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &trimmed[1..];
    let end = body.find(quote)?;
    if end == 0 || end > 220 {
        return None;
    }
    Some((body[..end].to_string(), colon + 1 + indent + end + 1))
}

fn read_version(text: &str) -> Option<u32> {
    let window = &text[..text.len().min(96)];
    let at = window.find("version")?;
    let rest = &window[at + "version".len()..];
    let colon = rest.find(':')?;
    if colon > 10 {
        return None;
    }
    let digits: String = rest[colon + 1..]
        .trim_start()
        .chars()
        .take_while(|symbol| symbol.is_ascii_digit())
        .collect();
    let version: u32 = digits.parse().ok()?;
    (version > 0).then_some(version)
}

/// The bundle obfuscates the key as decimal code points xored with a rolling
/// constant; the digits are then concatenated into the ASCII key.
fn decode_secret(secret: &str) -> Vec<u8> {
    let mut key = String::with_capacity(secret.len() * 2);
    for (index, symbol) in secret.chars().enumerate() {
        let value = (symbol as u32) ^ ((index % 33 + 9) as u32);
        key.push_str(&value.to_string());
    }
    key.into_bytes()
}

fn totp_code(secret: &str, timestamp: i64) -> String {
    let key = decode_secret(secret);
    let counter = (timestamp.max(0) as u64) / 30;
    let digest = hmac_sha1(&key, &counter.to_be_bytes());
    let offset = (digest[19] & 0x0f) as usize;
    let value = u32::from_be_bytes([
        digest[offset] & 0x7f,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    format!("{:06}", value % 1_000_000)
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    use sha1::{Digest, Sha1};
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        let digest = Sha1::digest(key);
        block[..digest.len()].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner_key: Vec<u8> = block.iter().map(|byte| byte ^ 0x36).collect();
    let outer_key: Vec<u8> = block.iter().map(|byte| byte ^ 0x5c).collect();

    let mut inner = Sha1::new();
    inner.update(&inner_key);
    inner.update(message);
    let inner = inner.finalize();

    let mut outer = Sha1::new();
    outer.update(&outer_key);
    outer.update(inner);
    let digest = outer.finalize();

    let mut result = [0u8; 20];
    result.copy_from_slice(&digest);
    result
}

fn transport(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::api("Spotify не ответил вовремя — проверьте интернет или VPN")
    } else if error.is_connect() {
        Error::api("Нет связи с open.spotify.com — проверьте интернет или VPN")
    } else {
        Error::api("Запрос к Spotify не удался — проверьте соединение и повторите попытку")
    }
}

/// Reads the liked songs page by page with one working hash.
struct LibraryPages<'a> {
    spotify: &'a Spotify,
}

impl LibraryPages<'_> {
    const PAGE: u32 = 50;

    async fn read(&self, hash: &str) -> Result<Vec<SpotifyTrack>> {
        let mut tracks = Vec::new();
        let mut offset = 0usize;
        let mut expected = None;
        let mut previous = None;
        loop {
            let token = self.spotify.access_token().await?;
            if token.anonymous {
                return Err(Error::Auth(
                    "Spotify не подтвердил вход — войдите заново".into(),
                ));
            }
            let client_token = self
                .spotify
                .client_token(token.client_id.as_deref())
                .await?;
            let variables = json!({
                "offset": offset,
                "limit": Self::PAGE,
            });
            let value = self
                .spotify
                .pathfinder(
                    &token.value,
                    &client_token,
                    "fetchLibraryTracks",
                    hash,
                    variables,
                )
                .await?;
            let page = library_page(&value, offset)?;
            if expected.is_some_and(|total| total != page.total) {
                return Err(Error::api(
                    "Список любимых треков Spotify изменился во время чтения. Повторите импорт.",
                ));
            }
            expected = Some(page.total);
            let items = page.items;
            let found = items.len();
            if previous.as_ref().is_some_and(|last| last == items) && !items.is_empty() {
                return Err(Error::api(
                    "Spotify повторил страницу любимых треков. Импорт остановлен.",
                ));
            }
            for (index, item) in items.iter().enumerate() {
                tracks.push(liked_track(item).ok_or_else(|| Error::api(format!(
                    "Не удалось прочитать любимый трек №{}. В списке есть недоступные данные; импорт остановлен без создания плейлиста.", offset + index + 1
                )))?);
            }
            offset += found;
            if offset == page.total {
                break;
            }
            previous = Some(items.to_vec());
        }
        Ok(tracks)
    }
}

struct LibraryPage<'a> {
    items: &'a [Value],
    total: usize,
}

fn library_page(value: &Value, offset: usize) -> Result<LibraryPage<'_>> {
    let page = value
        .pointer("/data/me/library/tracks")
        .ok_or_else(|| Error::api("Spotify ответил без списка любимых треков"))?;
    let items = page
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::api("Spotify изменил формат списка любимых треков"))?;
    let total = page
        .get("totalCount")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| Error::api("Spotify не сообщил размер списка любимых треков"))?;
    if page
        .pointer("/pagingInfo/offset")
        .and_then(Value::as_u64)
        .is_some_and(|position| position != offset as u64)
        || offset
            .checked_add(items.len())
            .map_or(true, |end| end > total)
        || (items.is_empty() && offset < total)
    {
        return Err(Error::api(
            "Spotify вернул неполную или неверную страницу любимых треков",
        ));
    }
    Ok(LibraryPage { items, total })
}

fn check_graphql_errors(value: &Value) -> Result<()> {
    let Some(errors) = value.get("errors").filter(|errors| !errors.is_null()) else {
        return Ok(());
    };
    let errors = errors
        .as_array()
        .ok_or_else(|| Error::api("Spotify вернул неверный список ошибок"))?;
    for error in errors {
        let code = error
            .pointer("/extensions/code")
            .and_then(Value::as_str)
            .unwrap_or("");
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        if [code, message].iter().any(|text| {
            text.to_ascii_lowercase()
                .replace('_', "")
                .contains("persistedquery")
        }) {
            return Err(Error::api(STALE_QUERY));
        }
        if ["UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN"].contains(&code) {
            return Err(Error::Auth(
                "Spotify не принял сессию — войдите в Spotify заново".into(),
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Error::api(
            "Spotify отклонил запрос любимых треков. Повторите позже.",
        ))
    }
}

/// `new X("fetchLibraryTracks","query","<sha256>")` in the minified bundle.
fn find_operation_hash(source: &str, operation: &str) -> Option<String> {
    let needle = format!("\"{operation}\"");
    let mut cursor = 0;
    while let Some(found) = source[cursor..].find(&needle) {
        let at = cursor + found + needle.len();
        let window: String = source[at..].chars().take(200).collect();
        for quoted in window.split(['"', '\'']) {
            if quoted.len() == 64 && quoted.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return Some(quoted.to_string());
            }
        }
        cursor = at;
    }
    None
}

/// One entry of `fetchLibraryTracks`: the track sits under `track.data`.
fn liked_track(item: &Value) -> Option<SpotifyTrack> {
    let data = item.get("track").and_then(|track| track.get("data"))?;
    let title = data.get("name").and_then(Value::as_str)?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let artists: Vec<String> = data
        .pointer("/artists/items")
        .and_then(Value::as_array)?
        .iter()
        .map(|artist| {
            artist
                .pointer("/profile/name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .collect::<Option<Vec<_>>>()?;
    if artists.is_empty() {
        return None;
    }
    let seconds = data
        .pointer("/duration/totalMilliseconds")
        .and_then(Value::as_u64)
        .and_then(milliseconds);
    if seconds.is_none() {
        return None;
    }
    Some(SpotifyTrack {
        title,
        artists,
        seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(items: Value, total: usize, offset: usize) -> Value {
        json!({"data":{"me":{"library":{"tracks":{
            "items":items,"totalCount":total,"pagingInfo":{"offset":offset,"limit":50}
        }}}}})
    }

    #[test]
    fn library_pages_do_not_confuse_missing_short_and_empty_pages() {
        assert!(library_page(&json!({"data":{}}), 0).is_err());
        assert!(library_page(&library(json!([]), 100, 0), 0).is_err());
        assert!(library_page(&library(json!([{}]), 0, 0), 0).is_err());
        assert!(library_page(&library(json!([{}]), 100, 0), 50).is_err());
        let value = library(json!([{}, {}]), 6001, 5050);
        let page = library_page(&value, 5050).unwrap();
        assert_eq!(page.total, 6001);
        assert_eq!(page.items.len(), 2);
        assert_eq!(library_page(&library(json!([]), 0, 0), 0).unwrap().total, 0);
    }

    #[test]
    fn liked_tracks_require_real_metadata_and_checked_duration() {
        let item = json!({"track":{"data":{
            "name":"Song","artists":{"items":[{"profile":{"name":"Earth, Wind & Fire"}}]},
            "duration":{"totalMilliseconds":240999}
        }}});
        let parsed = liked_track(&item).unwrap();
        assert_eq!(parsed.artists, vec!["Earth, Wind & Fire"]);
        assert_eq!(parsed.seconds, Some(240));
        let mut missing = item.clone();
        missing["track"]["data"]["name"] = json!(" ");
        assert!(liked_track(&missing).is_none());
        missing = item.clone();
        missing["track"]["data"]["duration"]["totalMilliseconds"] = json!(u64::MAX);
        assert!(liked_track(&missing).is_none());
        missing = item.clone();
        missing["track"]["data"]["artists"]["items"] =
            json!([{}, {"profile":{"name":"Featured Artist"}}]);
        assert!(liked_track(&missing).is_none());
        assert!(liked_track(&json!({"track":{"data":{"__typename":"NotFound"}}})).is_none());
    }

    #[test]
    fn graphql_errors_are_sanitized_and_empty_errors_are_successful() {
        assert!(check_graphql_errors(&json!({"errors":[]})).is_ok());
        assert_eq!(
            check_graphql_errors(&json!({"errors":[{"message":"PersistedQueryNotFound"}]}))
                .unwrap_err()
                .to_string(),
            STALE_QUERY
        );
        assert!(matches!(
            check_graphql_errors(&json!({"errors":[{"extensions":{"code":"UNAUTHENTICATED"}}]})),
            Err(Error::Auth(_))
        ));
        let error =
            check_graphql_errors(&json!({"errors":[{"message":"sensitive upstream body"}]}))
                .unwrap_err();
        assert!(!error.to_string().contains("sensitive"));
    }

    #[test]
    fn operation_hash_scanning_handles_query_type_and_unicode() {
        let hash = "a".repeat(64);
        let source = format!(
            "new Q(\"fetchLibraryTracks\",\"query\",\"{hash}\");{}",
            "я".repeat(200)
        );
        assert_eq!(
            find_operation_hash(&source, "fetchLibraryTracks"),
            Some(hash)
        );
    }

    #[test]
    fn playlist_pages_preserve_order_duplicates_and_continuation() {
        let uri = "spotify:track:37i9dQZF1DX4UtSsGT1Sbe";
        let page = json_service_playlist(&json!({
            "length":5,"revision":"r1","contents":{"pos":2,"truncated":true,"items":[{"uri":uri},{"uri":uri}]}
        }).to_string()).unwrap();
        assert_eq!(page.position, 2);
        assert_eq!(page.count, 2);
        assert_eq!(page.length, Some(5));
        assert!(page.truncated);
        assert_eq!(page.uris, vec![uri, uri]);
        assert!(json_service_playlist("{}").is_err());
        assert!(
            json_service_playlist(r#"{"contents":{"items":[{"uri":"spotify:local:track"}]}}"#)
                .is_err()
        );
    }

    #[test]
    fn embed_script_attributes_can_be_reordered() {
        assert_eq!(
            next_data("<script nonce='x' type='application/json' id='__NEXT_DATA__'>{}</script>"),
            Some("{}")
        );
        assert!(next_data("<script id='other'>{}</script>").is_none());
    }

    #[test]
    fn accepts_every_share_link_shape() {
        let id = "37i9dQZF1DX4UtSsGT1Sbe";
        for link in [
            format!("https://open.spotify.com/playlist/{id}"),
            format!("https://open.spotify.com/playlist/{id}?si=fJAlq4E7TDyILvq6yq1LSw&utm_source=copy-link"),
            format!("https://open.spotify.com/intl-ru/playlist/{id}"),
            format!("spotify:playlist:{id}"),
            format!("  {id}  "),
        ] {
            assert_eq!(parse_playlist_id(&link).unwrap(), id, "{link}");
        }
    }

    #[test]
    fn rejects_what_is_not_a_playlist() {
        assert!(
            parse_playlist_id("https://open.spotify.com/album/4hF2gTGuPYlykYuphDxi8J").is_err()
        );
        assert!(parse_playlist_id("hello").is_err());
        assert!(parse_playlist_id("https://open.spotify.com/playlist/short").is_err());
        assert!(parse_playlist_id("https://evil.example/playlist/37i9dQZF1DX4UtSsGT1Sbe").is_err());
        assert!(parse_playlist_id(
            "https://open.spotify.com.evil.example/playlist/37i9dQZF1DX4UtSsGT1Sbe"
        )
        .is_err());
    }

    #[test]
    fn decodes_the_obfuscated_totp_key() {
        // A porting slip here would show up as the decoded key being raw
        // bytes instead of the concatenated decimal code points.
        assert_eq!(decode_secret("ab"), b"104104");
    }

    #[test]
    fn totp_is_six_digits_and_time_based() {
        let secret = "abcdefghijklmnopqrstuvwxyz0123456789";
        let first = totp_code(secret, 1_700_000_000);
        assert_eq!(first.len(), 6);
        assert_eq!(first, totp_code(secret, 1_700_000_000));
        assert_ne!(first, totp_code(secret, 1_700_000_030));
    }

    #[test]
    fn finds_the_newest_secret_in_a_bundle() {
        let source = r#"x={secret:"older",version:12},y={secret:"newest",version:61}"#;
        assert_eq!(newest_secret(source), Some(("newest".to_string(), 61)));
    }

    #[test]
    fn finds_the_player_bundle_link() {
        let html = r#"<link href="https://open.spotifycdn.com/cdn/build/web-player/web-player.e603cf98.js"/>"#;
        assert_eq!(
            find_web_player_bundle(html).as_deref(),
            Some("https://open.spotifycdn.com/cdn/build/web-player/web-player.e603cf98.js")
        );
    }

    #[test]
    fn builds_a_cover_url_from_an_image_uri() {
        assert_eq!(
            cover_url("spotify:image:ab67706f00000002ffe80c69d2e795ea01e63447"),
            "https://i.scdn.co/image/ab67706f00000002ffe80c69d2e795ea01e63447"
        );
    }

    /// A playlist the anonymous session cannot see must ask for a sign-in
    /// instead of failing with a vague error.
    #[test]
    #[ignore = "reads open.spotify.com"]
    fn a_closed_playlist_asks_for_a_spotify_session() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let spotify = Spotify::new(
            reqwest::Client::new(),
            std::env::temp_dir().join("ytmusicdt-spotify-closed-test.json"),
        );
        let error = runtime
            .block_on(spotify.playlist("https://open.spotify.com/playlist/00000000000000000000AA"))
            .expect_err("closed playlist must not read anonymously");
        assert!(matches!(error, Error::Auth(_)), "{error}");
    }

    /// The whole live chain: bundle → TOTP → anonymous token → playlist
    /// service → embed metadata, on a public playlist longer than one page.
    #[test]
    #[ignore = "reads open.spotify.com"]
    fn reads_a_live_playlist() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let spotify = Spotify::new(
            reqwest::Client::new(),
            std::env::temp_dir().join("ytmusicdt-spotify-test.json"),
        );
        let playlist = runtime
            .block_on(spotify.playlist("https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe"))
            .expect("playlist");
        assert_eq!(playlist.name, "All Out 80s");
        assert_eq!(playlist.tracks.len(), 150);
        assert!(playlist.cover.is_some());
        assert_eq!(playlist.tracks[0].artists, vec!["Duran Duran"]);
        assert!(playlist
            .description
            .contains("The biggest songs of the 1980s"));
    }
}
