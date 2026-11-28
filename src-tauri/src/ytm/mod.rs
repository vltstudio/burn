pub mod api;
pub mod auth;
pub mod parse;
pub mod upload;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::RwLock;

use crate::error::{Error, Result};

pub const ORIGIN: &str = "https://music.youtube.com";
const API_BASE: &str = "https://music.youtube.com/youtubei/v1/";
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0";
/// Client version the Android Music app reports; the lyrics page keys its
/// timestamped answer off it.
const MOBILE_CLIENT_VERSION: &str = "7.21.50";

/// Thin InnerTube (YouTube Music web) client: builds requests the way the web app
/// does, sending the signed-in browser session's cookies when one is stored.
pub struct Ytm {
    pub http: reqwest::Client,
    client_version: String,
    auth_path: PathBuf,
    visitor: RwLock<Option<String>>,
    visitor_fetch: tokio::sync::Mutex<Option<std::time::Instant>>,
    session: RwLock<Option<auth::Session>>,
    language: RwLock<String>,
    session_revision: AtomicU64,
}

impl Ytm {
    pub fn new(http: reqwest::Client, auth_path: PathBuf) -> Self {
        let today = chrono::Utc::now().format("%Y%m%d").to_string();
        Self {
            http,
            client_version: format!("1.{today}.01.00"),
            auth_path,
            visitor: RwLock::new(None),
            visitor_fetch: tokio::sync::Mutex::new(None),
            session: RwLock::new(None),
            language: RwLock::new("ru".into()),
            session_revision: AtomicU64::new(0),
        }
    }

    pub async fn load_session(&self) {
        if let Some(session) =
            auth::Session::load(&self.auth_path).filter(auth::Session::is_complete)
        {
            *self.session.write().await = Some(session);
        }
    }

    pub async fn set_language(&self, language: &str) {
        *self.language.write().await = language.to_string();
    }

    pub async fn is_signed_in(&self) -> bool {
        self.session.read().await.is_some()
    }

    pub async fn sign_out(&self) -> Result<()> {
        let mut session = self.session.write().await;
        *session = None;
        self.session_revision.fetch_add(1, Ordering::SeqCst);
        match std::fs::remove_file(&self.auth_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    pub async fn store_session(&self, session: auth::Session) -> Result<()> {
        session.save(&self.auth_path)?;
        let mut stored = self.session.write().await;
        *stored = Some(session);
        self.session_revision.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub async fn validate_session(&self, session: auth::Session) -> Result<api::Account> {
        let candidate = Self::new(self.http.clone(), self.auth_path.clone());
        *candidate.session.write().await = Some(session);
        *candidate.language.write().await = self.language.read().await.clone();
        *candidate.visitor.write().await = self.visitor.read().await.clone();
        api::account(&candidate).await
    }

    pub fn session_revision(&self) -> u64 {
        self.session_revision.load(Ordering::SeqCst)
    }

    pub async fn session_guard(&self, revision: u64) -> Result<tokio::sync::RwLockReadGuard<'_, Option<auth::Session>>> {
        let guard = self.session.read().await;
        if self.session_revision() != revision || guard.is_none() {
            return Err(Error::Auth("Аккаунт Google изменился во время синхронизации".into()));
        }
        Ok(guard)
    }

    pub async fn authenticated_snapshot(&self) -> Result<Self> {
        let session = self.session.read().await.clone().ok_or_else(|| Error::Auth("Войдите через Google для синхронизации".into()))?;
        let snapshot = Self::new(self.http.clone(), self.auth_path.clone());
        *snapshot.session.write().await = Some(session);
        *snapshot.language.write().await = self.language.read().await.clone();
        *snapshot.visitor.write().await = self.visitor.read().await.clone();
        Ok(snapshot)
    }

    async fn context(&self, mobile: bool) -> Value {
        let language = self.language.read().await.clone();
        // The Android client serves timestamped lyrics for the lyrics page;
        // everything else goes through the web client it always used.
        let (client_name, client_version) = if mobile {
            ("ANDROID_MUSIC", MOBILE_CLIENT_VERSION)
        } else {
            ("WEB_REMIX", self.client_version.as_str())
        };
        json!({
            "context": {
                "client": {
                    "clientName": client_name,
                    "clientVersion": client_version,
                    "hl": language,
                    "gl": "US",
                    "userAgent": USER_AGENT,
                },
                "user": {},
            }
        })
    }

    /// Visitor id from the web page; YouTube is noticeably happier with one.
    async fn visitor_id(&self) -> Option<String> {
        if let Some(id) = self.visitor.read().await.clone() {
            return Some(id);
        }
        let mut fetch = self.visitor_fetch.lock().await;
        if let Some(id) = self.visitor.read().await.clone() {
            return Some(id);
        }
        if fetch.is_some_and(|at| at.elapsed() < Duration::from_secs(30)) {
            return None;
        }
        *fetch = Some(std::time::Instant::now());
        let response = self
            .http
            .get(ORIGIN)
            .header("user-agent", USER_AGENT)
            .header("cookie", "SOCS=CAI")
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .ok()?;
        let html = response.text().await.ok()?;
        let id = extract_visitor_data(&html)?;
        *self.visitor.write().await = Some(id.clone());
        Some(id)
    }

    pub async fn request(&self, endpoint: &str, body: Value) -> Result<Value> {
        self.send(endpoint, body, false).await
    }

    /// The same transport with the Android Music client in the context: the
    /// lyrics page answers with timestamped lines only for that client.
    pub async fn request_mobile(&self, endpoint: &str, body: Value) -> Result<Value> {
        self.send(endpoint, body, true).await
    }

    async fn send(&self, endpoint: &str, body: Value, mobile: bool) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(25), self.send_inner(endpoint, body, mobile))
            .await
            .map_err(|_| Error::api("YouTube Music не ответил за 25 секунд — проверьте интернет или VPN и повторите запрос"))?
    }

    async fn send_inner(&self, endpoint: &str, body: Value, mobile: bool) -> Result<Value> {
        let session = self.session.read().await.clone();
        let mut transport_attempt = 0;
        loop {
            let mut payload = body.clone();
            let context = self.context(mobile).await;
            if let (Some(target), Some(context)) = (payload.as_object_mut(), context.get("context"))
            {
                target.insert("context".into(), context.clone());
            }

            let mut request = self
                .http
                .post(format!("{API_BASE}{endpoint}?alt=json&prettyPrint=false"))
                .header("user-agent", USER_AGENT)
                .header("accept", "*/*")
                .header("origin", ORIGIN)
                .header(
                    "cookie",
                    match &session {
                        Some(session) => format!("{}; SOCS=CAI", session.cookie_header()),
                        None => "SOCS=CAI".to_string(),
                    },
                )
                .timeout(Duration::from_secs(30))
                .json(&payload);

            if let Some(visitor) = self.visitor_id().await {
                request = request.header("x-goog-visitor-id", visitor);
            }
            if let Some(session) = &session {
                if let Some(authorization) = session.authorization_header() {
                    request = request
                        .header("authorization", authorization)
                        .header("x-origin", ORIGIN)
                        .header("x-goog-authuser", "0");
                }
            }

            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    // A dropped connection is worth retrying: the first request after a
                    // sign-in sometimes hits one, and a fresh attempt fixes it.
                    if transport_attempt < 1
                        && retryable_read(endpoint)
                        && (error.is_connect() || error.is_timeout())
                    {
                        transport_attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            300 * transport_attempt as u64,
                        ))
                        .await;
                        continue;
                    }
                    return Err(error.into());
                }
            };
            let status = response.status();
            let text = response.text().await.unwrap_or_default();

            if status.as_u16() == 403 && endpoint == "account/account_menu" {
                return Err(Error::api("YouTube Music отклонил проверку аккаунта. Сохранённый вход можно проверить ещё раз в настройках."));
            }
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(Error::Auth(
                    "Войдите через Google, чтобы открыть библиотеку".into(),
                ));
            }
            if !status.is_success() {
                return Err(Error::Api(format!(
                    "YouTube Music ответил HTTP {}: {}",
                    status.as_u16(),
                    truncate(&text, 240)
                )));
            }
            return serde_json::from_str(&text).map_err(Into::into);
        }
        // The loop cannot spin: every path returns or retries the auth refresh exactly once.
        #[allow(unreachable_code)]
        Err(Error::Api("Запрос к YouTube Music не удался".into()))
    }
}

fn retryable_read(endpoint: &str) -> bool {
    matches!(
        endpoint,
        "search" | "browse" | "next" | "account/account_menu" | "music/get_search_suggestions"
    )
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    #[test]
    fn mutations_are_never_retried_automatically() {
        for endpoint in ["playlist/create", "playlist/delete", "browse/edit_playlist", "like/like", "like/removelike"] {
            assert!(!retryable_read(endpoint));
        }
        assert!(retryable_read("browse"));
        assert!(retryable_read("account/account_menu"));
    }

    #[tokio::test]
    async fn authenticated_snapshot_does_not_follow_account_changes() {
        let path = std::env::temp_dir().join(format!("ytmusicdt-session-snapshot-{}-{}.json", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let source = Ytm::new(reqwest::Client::new(), path);
        let session = |value: &str| auth::Session { cookies: [("SAPISID".into(), value.into()), ("__Secure-1PSID".into(), "test".into())].into() };
        source.store_session(session("before")).await.unwrap();
        let revision = source.session_revision();
        let snapshot = source.authenticated_snapshot().await.unwrap();
        source.store_session(session("after")).await.unwrap();
        assert_ne!(source.session_revision(), revision);
        assert_eq!(snapshot.session.read().await.as_ref().unwrap().cookies["SAPISID"], "before");
        source.sign_out().await.unwrap();
        assert!(snapshot.is_signed_in().await);
        assert!(!source.is_signed_in().await);
    }
}

fn extract_visitor_data(html: &str) -> Option<String> {
    let marker = "\"VISITOR_DATA\":\"";
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod probe {
    use super::*;

    fn client() -> Ytm {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client");
        Ytm::new(http, std::env::temp_dir().join("ytmusicdt-probe-auth.json"))
    }

    #[tokio::test]
    #[ignore = "reads a public artist and discography from the live catalog"]
    async fn anonymous_artist_discography() {
        let ytm = client();
        let results = api::search(&ytm, "Clonnex", Some("artists")).await.unwrap();
        let mut artists = std::collections::BTreeSet::new();
        for artist in results.top.iter().chain(&results.items).filter(|item| item.title.eq_ignore_ascii_case("Clonnex")) {
            let Some(id) = &artist.browse_id else { continue };
            if !artists.insert(id.clone()) { continue; }
            let detail = api::browse(&ytm, id).await.unwrap();
            for section in detail.sections {
                let Some(more) = section.more_endpoint else { continue };
                let mut page = api::browse_releases(&ytm, &more.browse_id, &more.params).await.unwrap();
                let mut tokens = std::collections::BTreeSet::new();
                loop {
                    if let Some(ep) = page.items.iter().find(|item| item.title.to_lowercase().contains("blood n roll")) {
                        let album = api::browse(&ytm, ep.browse_id.as_deref().unwrap()).await.unwrap();
                        let track = album.sections.iter().flat_map(|section| &section.items).find(|item| item.video_id.is_some()).unwrap();
                        let stream = audio_resolver::AudioResolver::new(ytm.http.clone()).resolve(track.video_id.as_deref().unwrap()).await;
                        match stream {
                            Ok(url) => {
                                let sample = ytm.http.get(url).header(reqwest::header::RANGE, "bytes=0-511").send().await.unwrap();
                                assert_eq!(sample.status(), 206);
                                assert_eq!(sample.bytes().await.unwrap().len(), 512);
                                println!("{} — {} — {}: audio available", artist.title, ep.title, track.title);
                            }
                            Err(audio_resolver::ResolveError::SignInRequired) => {
                                println!("{} — {} — {}: official player sign-in required", artist.title, ep.title, track.title);
                            }
                            Err(error) => panic!("{} — {}: {error}", ep.title, track.title),
                        }
                        return;
                    }
                    let Some(token) = page.continuation.filter(|token| tokens.insert(token.clone())) else { break };
                    page = api::browse_more(&ytm, &token).await.unwrap();
                }
            }
        }
        panic!("the public discography did not return the EP");
    }

    #[tokio::test]
    #[ignore = "hits the live anonymous YouTube Music catalog; results can vary by region"]
    async fn anonymous_clip_discovery() {
        let ytm = client();
        for (track, expected) in [
            ("lYBUbBu4W08", Some("dQw4w9WgXcQ")),
            ("4ujBQOzs6Lw", Some("rYEDA3JcQqw")),
            ("ljUtuoFt-8c", Some("hTWKbfoikeg")),
            ("HzdD8kbDzZA", Some("djV11Xbc914")),
            ("Qd8DtYYloE8", Some("nUqV2bwfVdM")),
        ] {
            let found = api::resolve_clip(&ytm, track, Some("song"), None)
                .await
                .expect("clip lookup");
            println!("{track} → {found:?}");
            assert_eq!(found.as_deref(), expected, "anonymous lookup for {track}");
        }
    }

    /// Writes real responses to %TEMP%\ytmusicdt-fixtures so the UI can be
    /// previewed in a browser with production-shaped data.
    #[tokio::test]
    #[ignore = "hits the live YouTube Music API"]
    async fn account_with_bogus_token() {
        let ytm = client();
        let cookies = ["SAPISID", "SID", "__Secure-1PSID"]
            .iter()
            .map(|name| (name.to_string(), "bogus".to_string()))
            .collect();
        ytm.store_session(auth::Session { cookies })
            .await
            .expect("store session");
        match api::account(&ytm).await {
            Ok(account) => println!("unexpected ok: {account:?}"),
            Err(error) => println!("account error: {error}"),
        }
        let _ = ytm.sign_out().await;
    }

    #[tokio::test]
    #[ignore = "hits the live YouTube Music API"]
    async fn dump_fixtures() {
        let ytm = client();
        let dir = std::env::temp_dir().join("ytmusicdt-fixtures");
        std::fs::create_dir_all(&dir).expect("fixtures dir");

        let write = |name: &str, value: &serde_json::Value| {
            std::fs::write(dir.join(name), serde_json::to_string(value).expect("json"))
                .expect("write");
        };

        let search = api::search(&ytm, "nirvana", None).await.expect("search");
        write("search.json", &serde_json::to_value(&search).unwrap());

        let home = api::home(&ytm).await.expect("home");
        write("home.json", &serde_json::to_value(&home).unwrap());

        let album = api::browse(&ytm, "MPREb_99mXCzrVmLg").await.expect("album");
        write("album.json", &serde_json::to_value(&album).unwrap());

        let playlist = api::browse(&ytm, "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5")
            .await
            .expect("playlist");
        write("playlist.json", &serde_json::to_value(&playlist).unwrap());

        let artist = api::browse(&ytm, "UC4DGncXvX-32aG7obY5dF1w")
            .await
            .expect("artist");
        write("artist.json", &serde_json::to_value(&artist).unwrap());

        println!("fixtures written to {}", dir.display());
    }

    #[tokio::test]
    #[ignore = "hits the live YouTube Music API"]
    async fn search_browse_and_suggestions_parse() {
        let ytm = client();

        let results = api::search(&ytm, "nirvana", None).await.expect("search");
        assert!(!results.items.is_empty(), "search returned no items");
        assert!(results.items.iter().any(|item| item.kind == "song"));
        assert!(results.items.iter().any(|item| item.video_id.is_some()));
        assert!(
            results
                .items
                .iter()
                .any(|item| !item.artists.is_empty() || item.album.is_some()),
            "no structured artist/album refs"
        );
        println!(
            "search: {} items, top={:?}",
            results.items.len(),
            results.top.as_ref().map(|item| (&item.title, &item.kind))
        );

        let filtered = api::search(&ytm, "nirvana", Some("albums"))
            .await
            .expect("filtered search");
        assert!(
            filtered.items.iter().all(|item| item.kind == "album"),
            "album filter returned mixed kinds"
        );
        println!("albums filter: {} items", filtered.items.len());

        let home = api::home(&ytm).await.expect("home");
        assert!(!home.is_empty());
        println!("home: {} sections, first={:?}", home.len(), home[0].title);

        let album = api::browse(&ytm, "MPREb_99mXCzrVmLg").await.expect("album");
        assert_eq!(album.header.kind, "album");
        assert!(!album.header.thumbs.is_empty());
        let album_tracks = album
            .sections
            .iter()
            .filter(|section| section.layout == "list")
            .flat_map(|section| section.items.iter())
            .filter(|item| item.video_id.is_some())
            .count();
        assert!(album_tracks > 0, "album has no tracks");
        println!("album: {} — {} tracks", album.header.title, album_tracks);

        let playlist = api::browse(&ytm, "VLPLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5")
            .await
            .expect("playlist");
        assert_eq!(playlist.header.kind, "playlist");
        assert_eq!(
            playlist.header.playlist_id.as_deref(),
            Some("PLdEiuPxBVWSjsUaOc08SAf9vMpYkeXvo5")
        );
        println!(
            "playlist: {} — {} sections",
            playlist.header.title,
            playlist.sections.len()
        );

        if let Some(continuation) = playlist
            .sections
            .iter()
            .find_map(|section| section.continuation.clone())
        {
            let page = api::browse_more(&ytm, &continuation)
                .await
                .expect("continuation");
            println!(
                "continuation: {} more items, next={}",
                page.items.len(),
                page.continuation.is_some()
            );
        }

        let artist = api::browse(&ytm, "UC4DGncXvX-32aG7obY5dF1w")
            .await
            .expect("artist");
        assert_eq!(artist.header.kind, "artist");
        assert!(artist
            .sections
            .iter()
            .any(|section| section.layout == "carousel"));
        println!(
            "artist: {} — {} sections",
            artist.header.title,
            artist.sections.len()
        );

        let suggestions = api::suggestions(&ytm, "nirv").await.expect("suggestions");
        assert!(!suggestions.is_empty());
        println!("suggestions: {:?}", suggestions);

        match api::library_playlists(&ytm).await {
            Err(crate::error::Error::Auth(_)) => {
                println!("library without auth: refused as expected")
            }
            Ok(_) => panic!("library must not answer without auth"),
            Err(other) => panic!("unexpected library error: {other}"),
        }
    }
}
