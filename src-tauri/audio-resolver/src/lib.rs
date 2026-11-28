use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{json, Deserializer};
use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const ORIGIN: &str = "https://www.youtube.com";
const CLIENT_NAME: &str = "VISIONOS";
const CLIENT_ID: &str = "101";
const CLIENT_VERSION: &str = "1.02";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_TTL: Duration = Duration::from_secs(25 * 60);
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);
const CACHE_SIZE: usize = 128;

#[derive(Debug, PartialEq, Eq)]
pub enum ResolveError {
    InvalidId,
    Network,
    Unavailable,
    SignInRequired,
    Playability(String),
    NoAudio,
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidId => "Некорректный идентификатор трека YouTube.",
            Self::Network => "Не удалось получить ответ от YouTube. Проверьте подключение.",
            Self::Unavailable => "YouTube не разрешил воспроизвести этот трек.",
            Self::SignInRequired => "YouTube просит подтвердить вход. Откройте трек в плеере YouTube Music.",
            Self::Playability(reason) => return write!(f, "YouTube: {reason}"),
            Self::NoAudio => "YouTube не предоставил совместимый аудиопоток для этого трека.",
        })
    }
}

impl std::error::Error for ResolveError {}

struct Cached<T> {
    value: T,
    until: Instant,
}

#[derive(Default)]
struct StreamCache {
    generation: u64,
    urls: HashMap<String, Cached<Url>>,
}

pub struct AudioResolver {
    http: Client,
    visitor: Mutex<Option<Cached<String>>>,
    streams: Mutex<StreamCache>,
}

impl AudioResolver {
    pub fn new(http: Client) -> Self {
        Self {
            http,
            visitor: Mutex::new(None),
            streams: Mutex::new(StreamCache::default()),
        }
    }

    pub async fn resolve(&self, video_id: &str) -> Result<Url, ResolveError> {
        self.resolve_inner(video_id, false).await
    }

    pub async fn resolve_fresh(&self, video_id: &str) -> Result<Url, ResolveError> {
        self.resolve_inner(video_id, true).await
    }

    async fn resolve_inner(&self, video_id: &str, refresh: bool) -> Result<Url, ResolveError> {
        if video_id.len() != 11
            || !video_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(ResolveError::InvalidId);
        }

        let generation = {
            let mut streams = self.streams.lock().await;
            if refresh {
                // YouTube can bind signed URLs to the outgoing IP address.
                streams.generation += 1;
                streams.urls.clear();
            } else if let Some(cached) = streams
                .urls
                .get(video_id)
                .filter(|entry| entry.until > Instant::now())
            {
                return Ok(cached.value.clone());
            }
            streams.generation
        };

        let visitor = self.visitor_id(refresh).await?;
        let response = self
            .http
            .post(format!("{ORIGIN}/youtubei/v1/player?prettyPrint=false"))
            .timeout(REQUEST_TIMEOUT)
            .header("user-agent", USER_AGENT)
            .header("origin", ORIGIN)
            .header("x-youtube-client-name", CLIENT_ID)
            .header("x-youtube-client-version", CLIENT_VERSION)
            .header("x-goog-visitor-id", visitor)
            .json(&json!({
                "videoId": video_id,
                "context": { "client": {
                    "clientName": CLIENT_NAME,
                    "clientVersion": CLIENT_VERSION,
                    "deviceMake": "Apple",
                    "deviceModel": "RealityDevice17,1",
                    "osName": "visionOS",
                    "osVersion": "26.5.23O471",
                    "userAgent": USER_AGENT,
                    "hl": "en"
                }},
                "playbackContext": { "contentPlaybackContext": {
                    "html5Preference": "HTML5_PREF_WANTS"
                }}
            }))
            .send()
            .await
            .map_err(|_| ResolveError::Network)?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(ResolveError::Unavailable);
        }
        let response: PlayerResponse = response
            .error_for_status()
            .map_err(|_| ResolveError::Network)?
            .json()
            .await
            .map_err(|_| ResolveError::Network)?;

        let (url, ttl) = select_audio(response, SystemTime::now())?;
        let mut streams = self.streams.lock().await;
        if streams.generation != generation {
            return Ok(url);
        }
        let streams = &mut streams.urls;
        let now = Instant::now();
        streams.retain(|_, stream| stream.until > now);
        if streams.len() >= CACHE_SIZE && !streams.contains_key(video_id) {
            if let Some(key) = streams
                .iter()
                .min_by_key(|(_, stream)| stream.until)
                .map(|(key, _)| key.clone())
            {
                streams.remove(&key);
            }
        }
        streams.insert(
            video_id.to_owned(),
            Cached {
                value: url.clone(),
                until: now + ttl,
            },
        );
        Ok(url)
    }

    async fn visitor_id(&self, refresh: bool) -> Result<String, ResolveError> {
        let mut visitor = self.visitor.lock().await;
        if refresh {
            *visitor = None;
        }
        if let Some(cached) = visitor
            .as_ref()
            .filter(|entry| entry.until > Instant::now())
        {
            return Ok(cached.value.clone());
        }
        let html = self
            .http
            .get(ORIGIN)
            .timeout(REQUEST_TIMEOUT)
            .header("user-agent", USER_AGENT)
            .send()
            .await
            .and_then(|response| response.error_for_status())
            .map_err(|_| ResolveError::Network)?
            .text()
            .await
            .map_err(|_| ResolveError::Network)?;
        let id = visitor_from_html(&html).ok_or(ResolveError::Network)?;
        *visitor = Some(Cached {
            value: id.clone(),
            until: Instant::now() + CACHE_TTL,
        });
        Ok(id)
    }
}

fn visitor_from_html(html: &str) -> Option<String> {
    ["\"VISITOR_DATA\"", "\"visitorData\""]
        .into_iter()
        .flat_map(|key| {
            html.match_indices(key)
                .map(move |(start, _)| &html[start + key.len()..])
        })
        .filter_map(|tail| {
            let value = tail.trim_start().strip_prefix(':')?;
            Deserializer::from_str(value)
                .into_iter::<String>()
                .next()?
                .ok()
        })
        .find(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_graphic()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlayerResponse {
    playability_status: Playability,
    streaming_data: Option<StreamingData>,
}

#[derive(Deserialize)]
struct Playability {
    status: String,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamingData {
    #[serde(default)]
    adaptive_formats: Vec<Format>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Format {
    mime_type: String,
    #[serde(default)]
    bitrate: u32,
    url: Option<String>,
}

fn select_audio(
    response: PlayerResponse,
    now: SystemTime,
) -> Result<(Url, Duration), ResolveError> {
    if response.playability_status.status != "OK" {
        let reason = response.playability_status.reason.unwrap_or_default();
        let reason = reason.split_whitespace().collect::<Vec<_>>().join(" ");
        if response.playability_status.status == "LOGIN_REQUIRED" && (reason.is_empty() || reason.to_lowercase().contains("sign in")) {
            return Err(ResolveError::SignInRequired);
        }
        return Err(if reason.is_empty() { ResolveError::Unavailable } else {
            ResolveError::Playability(reason.chars().take(240).collect())
        });
    }
    response
        .streaming_data
        .into_iter()
        .flat_map(|data| data.adaptive_formats)
        .filter_map(|format| {
            let rank = match format.mime_type.split(';').next()? {
                "audio/mp4" => 2,
                "audio/webm" => 1,
                _ => return None,
            };
            let url = Url::parse(&format.url?).ok()?;
            let host = url.host_str()?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port().is_some()
                || !(host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
                || url.path() != "/videoplayback"
                || url.query_pairs().any(|(key, _)| key == "n")
            {
                return None;
            }
            let expires = url
                .query_pairs()
                .find(|(key, _)| key == "expire")?
                .1
                .parse()
                .ok()?;
            let ttl = UNIX_EPOCH
                .checked_add(Duration::from_secs(expires))?
                .duration_since(now)
                .ok()?
                .checked_sub(EXPIRY_MARGIN)?;
            (!ttl.is_zero()).then_some((rank, format.bitrate, url, ttl.min(CACHE_TTL)))
        })
        .max_by_key(|(rank, bitrate, _, _)| (*rank, *bitrate))
        .map(|(_, _, url, ttl)| (url, ttl))
        .ok_or(ResolveError::NoAudio)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{CONTENT_RANGE, CONTENT_TYPE, RANGE};

    fn fixture(status: &str, formats: serde_json::Value) -> PlayerResponse {
        serde_json::from_value(json!({
            "playabilityStatus": {"status": status},
            "streamingData": {"adaptiveFormats": formats}
        }))
        .unwrap()
    }

    #[test]
    fn parses_a_nonempty_visitor_value() {
        assert_eq!(
            visitor_from_html(r#"{"VISITOR_DATA":"","visitorData": "guest\u003d"}"#).as_deref(),
            Some("guest=")
        );
        assert_eq!(visitor_from_html(r#"{"visitorData":"\r\n"}"#), None);
    }

    #[test]
    fn prefers_aac_and_then_bitrate_and_respects_expiry() {
        let response = fixture(
            "OK",
            json!([
                {"mimeType":"audio/webm","bitrate":160000,"url":"https://rr.googlevideo.com/videoplayback?expire=2000&itag=251"},
                {"mimeType":"audio/mp4","bitrate":48000,"url":"https://rr.googlevideo.com/videoplayback?expire=2000&itag=139"},
                {"mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","bitrate":128000,"url":"https://rr.googlevideo.com/videoplayback?expire=1460&itag=140"},
                {"mimeType":"audio/mp4","bitrate":260000,"url":"https://rr.googlevideo.com/videoplayback?expire=1000&itag=141"},
                {"mimeType":"video/mp4","bitrate":750000,"url":"https://rr.googlevideo.com/videoplayback?expire=4000&itag=18"}
            ]),
        );
        let (url, ttl) = select_audio(response, UNIX_EPOCH + Duration::from_secs(1000)).unwrap();
        assert!(url.query_pairs().any(|(k, v)| k == "itag" && v == "140"));
        assert_eq!(ttl, Duration::from_secs(400));
    }

    #[test]
    fn skips_urls_that_arent_direct_youtube_audio() {
        let response = fixture(
            "OK",
            json!([
                {"mimeType":"audio/mp4","url":"https://fakegooglevideo.com/videoplayback?expire=4000"},
                {"mimeType":"audio/mp4","url":"https://rr.googlevideo.com/videoplayback?expire=4000&n=encoded"},
                {"mimeType":"audio/mp4","signatureCipher":"unresolved"},
                {"mimeType":"audio/webm","url":"https://rr.googlevideo.com/videoplayback?expire=4000&itag=251"}
            ]),
        );
        let (url, ttl) = select_audio(response, UNIX_EPOCH + Duration::from_secs(1000)).unwrap();
        assert!(url.query_pairs().any(|(k, v)| k == "itag" && v == "251"));
        assert_eq!(ttl, CACHE_TTL);
    }

    #[test]
    fn ignores_formats_when_playback_is_denied() {
        let response = fixture(
            "LOGIN_REQUIRED",
            json!([
                {"mimeType":"audio/mp4","url":"https://rr.googlevideo.com/videoplayback?expire=4000"}
            ]),
        );
        assert_eq!(
            select_audio(response, UNIX_EPOCH),
            Err(ResolveError::SignInRequired)
        );
    }

    #[test]
    fn keeps_a_region_restriction_visible() {
        let response = serde_json::from_value(json!({"playabilityStatus":{
            "status":"UNPLAYABLE","reason":"This video is unavailable in your country."
        }})).unwrap();
        let error = select_audio(response, UNIX_EPOCH).unwrap_err();
        assert!(error.to_string().contains("unavailable in your country"));
    }

    #[tokio::test]
    async fn rejects_invalid_ids_before_any_network_request() {
        let resolver = AudioResolver::new(Client::new());
        assert_eq!(
            resolver.resolve("bad?videoid").await,
            Err(ResolveError::InvalidId)
        );
    }

    #[tokio::test]
    #[ignore = "requires live access to YouTube"]
    async fn resolves_and_reads_audio_ranges() {
        let http = Client::new();
        let resolver = AudioResolver::new(http.clone());
        for id in ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "Lf986x4Rlxg", "9qf-mjf6jkY"] {
            let url = resolver
                .resolve(id)
                .await
                .unwrap_or_else(|error| panic!("{id}: {error}"));
            assert!(resolver.resolve(id).await.is_ok_and(|cached| cached == url));
            for range in ["bytes=0-511", "bytes=65536-66047"] {
                let response = http
                    .get(url.clone())
                    .header(RANGE, range)
                    .timeout(REQUEST_TIMEOUT)
                    .send()
                    .await
                    .unwrap_or_else(|_| {
                        panic!("{id}: timed out or disconnected while reading {range}")
                    });
                assert_eq!(response.status(), 206, "{id}: {range}");
                assert!(response.headers()[CONTENT_TYPE]
                    .as_bytes()
                    .starts_with(b"audio/"));
                assert!(response.headers().contains_key(CONTENT_RANGE));
                assert_eq!(
                    response.bytes().await.map(|body| body.len()).ok(),
                    Some(512)
                );
            }
        }
    }
}
