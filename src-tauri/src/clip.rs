use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;

use crate::error::{Error, Result};
use crate::{ytm, AppState};

const RELAY_HTML: &str = include_str!("clip.html");
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(24);
const RELAY_LIFETIME: Duration = Duration::from_secs(12);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(900);
const MAX_HEADERS: usize = 4096;
static RELAY_SLOTS: Semaphore = Semaphore::const_new(8);

#[tauri::command]
pub async fn resolve_clip(
    state: tauri::State<'_, Arc<AppState>>,
    video_id: String,
    kind: Option<String>,
) -> Result<Option<String>> {
    timeout(
        LOOKUP_TIMEOUT,
        ytm::api::resolve_clip(&state.ytm, &video_id, kind.as_deref()),
    )
    .await
    .map_err(|_| Error::api("Превышено время ожидания поиска клипа"))?
}

#[tauri::command]
pub async fn start_clip_embed(video_id: String, channel: String) -> Result<String> {
    if !ytm::parse::valid_video_id(&video_id)
        || channel.len() != 32
        || !channel
            .bytes()
            .all(|ch| matches!(ch, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(Error::api("Некорректные параметры клипа"));
    }
    let slot = RELAY_SLOTS
        .try_acquire()
        .map_err(|_| Error::api("Слишком много запросов на открытие клипа"))?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let host = listener.local_addr()?.to_string();
    let origin = format!("http://{host}");
    let path = format!("/clip/{channel}");
    let url = format!("{origin}{path}");
    let html = RELAY_HTML
        .replace("__CLIP_CHANNEL__", &channel)
        .replace("__CLIP_ID__", &video_id)
        .replace("__CLIP_ORIGIN__", &origin);
    let csp = format!(
        "default-src 'none'; script-src 'nonce-{channel}' https://www.youtube.com; \
         style-src 'unsafe-inline'; frame-src https://www.youtube.com; base-uri 'none'; \
         form-action 'none'; frame-ancestors http://localhost:1420 http://127.0.0.1:1420 \
         http://tauri.localhost https://tauri.localhost tauri:;"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: strict-origin-when-cross-origin\r\nContent-Security-Policy: {csp}\r\n\r\n{html}",
        html.len()
    );

    tauri::async_runtime::spawn(async move {
        let _slot = slot;
        let _ = timeout(
            RELAY_LIFETIME,
            serve_once(listener, &host, &path, &response),
        )
        .await;
    });
    Ok(url)
}

async fn serve_once(listener: TcpListener, host: &str, path: &str, response: &str) {
    for _ in 0..8 {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let request = timeout(REQUEST_TIMEOUT, read_request(&mut stream)).await;
        if let Ok(Some(headers)) = request {
            if request_matches(&headers, host, path) {
                let _ = timeout(REQUEST_TIMEOUT, stream.write_all(response.as_bytes())).await;
                return;
            }
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut bytes = [0; MAX_HEADERS];
    let mut len = 0;
    while len < bytes.len() {
        let n = stream.read(&mut bytes[len..]).await.ok()?;
        if n == 0 {
            break;
        }
        let end = len + n;
        if let Some(index) = bytes[len.saturating_sub(3)..end]
            .windows(4)
            .position(|chunk| chunk == b"\r\n\r\n")
        {
            let header_end = len.saturating_sub(3) + index;
            return std::str::from_utf8(&bytes[..header_end])
                .ok()
                .map(str::to_owned);
        }
        len = end;
    }
    None
}

fn request_matches(headers: &str, host: &str, path: &str) -> bool {
    let mut lines = headers.split("\r\n");
    if lines.next() != Some(format!("GET {path} HTTP/1.1").as_str()) {
        return false;
    }
    let mut found_host = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        if name.eq_ignore_ascii_case("Host") {
            if found_host || value.trim() != host {
                return false;
            }
            found_host = true;
        }
        if name.eq_ignore_ascii_case("Sec-Fetch-Dest") && value.trim() != "iframe" {
            return false;
        }
    }
    found_host
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "/clip/abcdef0123456789abcdef0123456789";

    #[test]
    fn rejects_unexpected_paths_methods_hosts_and_non_frame_requests() {
        let host = "127.0.0.1:9000";
        for headers in [
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:9000".into(),
            format!("POST {PATH} HTTP/1.1\r\nHost: {host}"),
            format!("GET {PATH} HTTP/1.1\r\nHost: example.org"),
            format!("GET {PATH} HTTP/1.1\r\nHost: {host}\r\nHost: {host}"),
            format!("GET {PATH} HTTP/1.1\r\nHost: {host}\r\nSec-Fetch-Dest: document"),
        ] {
            assert!(!request_matches(&headers, host, PATH));
        }
        assert!(request_matches(
            &format!("GET {PATH} HTTP/1.1\r\nHost: {host}\r\nSec-Fetch-Dest: iframe"),
            host,
            PATH
        ));
    }

    #[tokio::test]
    async fn serves_only_one_valid_request_and_releases_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            serve_once(listener, &addr.to_string(), PATH, "clip fixture").await;
        });
        let mut wrong = TcpStream::connect(addr).await.unwrap();
        wrong
            .write_all(format!("GET /other HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut body = Vec::new();
        wrong.read_to_end(&mut body).await.unwrap();
        assert!(body.is_empty());

        let mut right = TcpStream::connect(addr).await.unwrap();
        right
            .write_all(format!("GET {PATH} HTTP/1.1\r\nHost: {addr}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        right.read_to_end(&mut body).await.unwrap();
        assert_eq!(body, b"clip fixture");
        task.await.unwrap();
        assert!(TcpStream::connect(addr).await.is_err());
    }
}
