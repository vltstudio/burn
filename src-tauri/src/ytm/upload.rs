//! Playlist covers. YouTube Music has no documented endpoint for a custom
//! playlist image, so this mirrors the web player: reserve a resumable upload,
//! send the bytes, then attach the returned blob id to the playlist. Both
//! steps ride the same browser session InnerTube already uses.

use serde_json::{json, Value};

use super::{Ytm, ORIGIN, USER_AGENT};
use crate::error::{Error, Result};

const UPLOAD: &str = "playlist_image_upload/playlist_custom_thumbnail";

impl Ytm {
    /// Pins `image` (JPEG or PNG bytes) as the playlist's cover.
    pub async fn set_playlist_cover(&self, playlist_id: &str, image: &[u8]) -> Result<()> {
        if image.is_empty() {
            return Err(Error::api("Обложка пришла пустой"));
        }
        let session = self.session.read().await.clone().ok_or_else(|| {
            Error::Auth("Войдите через Google, чтобы поставить обложку плейлиста".into())
        })?;
        let authorization = session.authorization_header().ok_or_else(|| {
            Error::Auth("В сессии нет SAPISID — войдите через Google ещё раз".into())
        })?;
        let cookie = format!("{}; SOCS=CAI", session.cookie_header());
        let url = format!("{ORIGIN}/{UPLOAD}");

        let start = self
            .http
            .post(&url)
            .header("user-agent", USER_AGENT)
            .header("origin", ORIGIN)
            .header("x-origin", ORIGIN)
            .header("x-goog-authuser", "0")
            .header("cookie", &cookie)
            .header("authorization", &authorization)
            .header("x-goog-upload-command", "start")
            .header("x-goog-upload-protocol", "resumable")
            .header(
                "x-goog-upload-header-content-length",
                image.len().to_string(),
            )
            // Without an explicit zero length the handshake answers 411 and
            // never hands out an upload address.
            .header("content-length", "0")
            .body(Vec::new())
            .send()
            .await
            .map_err(transport)?;
        if !start.status().is_success() {
            return Err(Error::api(format!(
                "YouTube Music не начал загрузку обложки: HTTP {}",
                start.status().as_u16()
            )));
        }
        let upload_url = upload_target(start.headers(), &url)?;

        let sent = self
            .http
            .post(upload_url)
            .header("user-agent", USER_AGENT)
            .header("origin", ORIGIN)
            .header("x-origin", ORIGIN)
            .header("x-goog-authuser", "0")
            .header("cookie", &cookie)
            .header("authorization", &authorization)
            .header("x-goog-upload-command", "upload, finalize")
            .header("x-goog-upload-offset", "0")
            .header("content-type", "application/octet-stream")
            .body(image.to_vec())
            .send()
            .await
            .map_err(transport)?;
        let status = sent.status();
        let text = sent
            .text()
            .await
            .map_err(|error| Error::api(format!("Обложка не загрузилась: {error}")))?;
        if !status.is_success() {
            return Err(Error::api(format!(
                "YouTube Music не принял обложку: HTTP {}",
                status.as_u16()
            )));
        }
        let body: Value = serde_json::from_str(&text).map_err(|error| {
            Error::api(format!("Неожиданный ответ при загрузке обложки: {error}"))
        })?;
        let blob = body
            .get("encryptedBlobId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::api("YouTube Music не вернул идентификатор обложки"))?
            .to_string();

        let response = self
            .request(
                "browse/edit_playlist",
                json!({
                    "playlistId": playlist_id.trim_start_matches("VL"),
                    "actions": [{
                        "action": "ACTION_SET_CUSTOM_THUMBNAIL",
                        "addedCustomThumbnail": {
                            "imageKey": {
                                "type": "PLAYLIST_IMAGE_TYPE_CUSTOM_THUMBNAIL",
                                "name": "studio_square_thumbnail",
                            },
                            "playlistScottyEncryptedBlobId": blob,
                        },
                    }],
                }),
            )
            .await?;
        let status = response.get("status").and_then(Value::as_str).unwrap_or("");
        if status.contains("SUCCEEDED") {
            Ok(())
        } else {
            Err(Error::api(format!(
                "YouTube Music не поставил обложку ({status})"
            )))
        }
    }
}

/// The reserved upload's own address. Google answers the handshake with
/// `x-goog-upload-url`, and older responses carry only the upload id, so both
/// shapes are accepted.
fn upload_target(headers: &reqwest::header::HeaderMap, endpoint: &str) -> Result<tauri::Url> {
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let mut target = if let Some(value) = header("x-goog-upload-url").or_else(|| header("location"))
    {
        tauri::Url::parse(value).map_err(|_| Error::api("Некорректный адрес загрузки обложки"))?
    } else {
        let id = header("x-guploader-uploadid")
            .ok_or_else(|| Error::api("YouTube Music не выдал адрес загрузки обложки"))?;
        let mut target = tauri::Url::parse(endpoint)
            .map_err(|_| Error::api("Некорректный адрес загрузки обложки"))?;
        target.query_pairs_mut().append_pair("upload_id", id);
        target
    };
    if target.scheme() != "https"
        || target.host_str() != Some("music.youtube.com")
        || target.port_or_known_default() != Some(443)
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err(Error::api(
            "YouTube Music вернул небезопасный адрес загрузки обложки",
        ));
    }
    if !target
        .query_pairs()
        .any(|(key, _)| key == "upload_protocol")
    {
        target
            .query_pairs_mut()
            .append_pair("upload_protocol", "resumable");
    }
    Ok(target)
}

fn transport(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::api("YouTube Music не ответил вовремя при загрузке обложки")
    } else {
        Error::api("Не удалось связаться с YouTube Music при загрузке обложки")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn adds_upload_protocol_to_url_without_query() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-goog-upload-url",
            HeaderValue::from_static("https://music.youtube.com/playlist_image_upload/test"),
        );
        let url = upload_target(&headers, ORIGIN).unwrap();
        assert_eq!(url.query(), Some("upload_protocol=resumable"));
    }

    #[test]
    fn rejects_external_upload_target() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "location",
            HeaderValue::from_static("https://example.com/upload"),
        );
        assert!(upload_target(&headers, ORIGIN).is_err());
    }

    #[test]
    fn encodes_upload_id() {
        let mut headers = HeaderMap::new();
        headers.insert("x-guploader-uploadid", HeaderValue::from_static("a&b"));
        let url = upload_target(&headers, ORIGIN).unwrap();
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "upload_id" && value == "a&b"));
    }
}
