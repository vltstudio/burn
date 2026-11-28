use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::watch;
use tokio::time::{self, Instant};

const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;
const SET_ACTIVITY: &str = "SET_ACTIVITY";
const APPLICATION_ID: &str = "1575963822924238941";
const LISTENING: u32 = 2;
const DISPLAY_DETAILS: u32 = 2;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_TEXT_UNITS: usize = 128;
const MAX_RETRY: Duration = Duration::from_secs(30);
static NEXT_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    pub(crate) title: String,
    pub(crate) artist: Option<String>,
    pub(crate) cover_url: Option<String>,
    pub(crate) video_id: Option<String>,
    pub(crate) start_ms: Option<u64>,
    pub(crate) end_ms: Option<u64>,
    pub(crate) local: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Idle,
    Connecting,
    Active,
    Unavailable,
    Rejected,
}

pub(crate) struct Presence {
    desired: watch::Sender<Option<Activity>>,
    status: watch::Receiver<Status>,
}

impl Presence {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        let (desired, updates) = watch::channel(None);
        let (statuses, status) = watch::channel(Status::Idle);
        tauri::async_runtime::spawn(run(
            updates,
            statuses,
            move |status| {
                let _ = app.emit_to("main", "discord-presence-status", status);
            },
            open_pipe,
            Timing {
                transaction: Duration::from_secs(2),
                clear: Duration::from_millis(600),
                retry: Duration::from_secs(2),
            },
        ));
        Self { desired, status }
    }

    pub(crate) fn set(&self, desired: Option<Activity>) {
        self.desired.send_if_modified(|current| {
            if *current == desired {
                return false;
            }
            *current = desired;
            true
        });
    }

    pub(crate) fn status(&self) -> Status {
        *self.status.borrow()
    }
}

#[derive(Clone, Copy)]
struct Timing {
    transaction: Duration,
    clear: Duration,
    retry: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    Unavailable,
    Rejected,
}

impl From<io::Error> for Fault {
    fn from(_: io::Error) -> Self {
        Self::Unavailable
    }
}

impl From<Fault> for Status {
    fn from(value: Fault) -> Self {
        match value {
            Fault::Unavailable => Self::Unavailable,
            Fault::Rejected => Self::Rejected,
        }
    }
}

async fn timed<T>(
    duration: Duration,
    operation: impl Future<Output = Result<T, Fault>>,
) -> Result<T, Fault> {
    time::timeout(duration, operation)
        .await
        .unwrap_or(Err(Fault::Unavailable))
}

struct Statuses<F> {
    current: watch::Sender<Status>,
    notify: F,
}

impl<F: Fn(Status)> Statuses<F> {
    fn set(&self, next: Status) {
        if self.current.send_if_modified(|current| {
            if *current == next {
                return false;
            }
            *current = next;
            true
        }) {
            (self.notify)(next);
        }
    }
}

async fn run<S, C, Open, F>(
    mut desired: watch::Receiver<Option<Activity>>,
    current: watch::Sender<Status>,
    notify: F,
    mut open: C,
    timing: Timing,
) where
    S: AsyncRead + AsyncWrite + Unpin,
    C: FnMut() -> Open,
    Open: Future<Output = io::Result<S>>,
    F: Fn(Status),
{
    let statuses = Statuses { current, notify };
    let mut idle = true;
    let mut uncleared = false;
    let mut next_attempt = Instant::now();
    let mut retry_delay = timing.retry;

    loop {
        let closed = desired.has_changed().is_err();
        if closed || desired.borrow_and_update().is_none() {
            if std::mem::take(&mut uncleared) {
                let _ = timed(timing.clear, async {
                    let mut connection = Connection::new(open().await?);
                    connection.handshake().await?;
                    connection.set_activity(None).await
                })
                .await;
            }
            statuses.set(Status::Idle);
            idle = true;
            if closed || desired.changed().await.is_err() {
                return;
            }
            continue;
        }
        if idle {
            idle = false;
            next_attempt = Instant::now();
            retry_delay = timing.retry;
            statuses.set(Status::Connecting);
        }
        if Instant::now() < next_attempt {
            tokio::select! {
                biased;
                _ = desired.changed() => {}
                _ = time::sleep_until(next_attempt) => {}
            }
            continue;
        }

        let connect = timed(timing.transaction, async {
            let mut connection = Connection::new(open().await?);
            connection.handshake().await?;
            Ok(connection)
        })
        .await;
        let error = match connect {
            Ok(mut connection) => {
                let mut dirty = std::mem::take(&mut uncleared);
                let result = if dirty {
                    timed(timing.clear, connection.set_activity(None)).await
                } else {
                    Ok(())
                };
                let result = match result {
                    Ok(()) => {
                        dirty = false;
                        serve(&mut connection, &mut desired, &statuses, timing, &mut dirty).await
                    }
                    Err(error) => Err(error),
                };
                if result.is_err() && *statuses.current.borrow() == Status::Active {
                    retry_delay = timing.retry;
                }
                if dirty
                    && timed(timing.clear, connection.set_activity(None))
                        .await
                        .is_err()
                {
                    uncleared = true;
                }
                match result {
                    Ok(()) => {
                        idle = true;
                        continue;
                    }
                    Err(error) => error,
                }
            }
            Err(error) => error,
        };
        statuses.set(error.into());
        next_attempt = Instant::now() + retry_delay;
        retry_delay = (retry_delay * 2).min(MAX_RETRY);
    }
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    connection: &mut Connection<S>,
    desired: &mut watch::Receiver<Option<Activity>>,
    statuses: &Statuses<impl Fn(Status)>,
    timing: Timing,
    dirty: &mut bool,
) -> Result<(), Fault> {
    let mut sent = None;
    loop {
        if desired.has_changed().is_err() {
            return Ok(());
        }
        let update = {
            let desired = desired.borrow_and_update();
            match desired.as_ref() {
                Some(activity) => (sent.as_ref() != Some(activity)).then(|| activity.clone()),
                None => return Ok(()),
            }
        };
        if let Some(activity) = update {
            *dirty = true;
            timed(timing.transaction, connection.set_activity(Some(&activity))).await?;
            sent = Some(activity);
            statuses.set(Status::Active);
            continue;
        }

        tokio::select! {
            biased;
            _ = desired.changed() => {}
            ready = connection.stream.fill_buf() => {
                if ready?.is_empty() {
                    return Err(Fault::Unavailable);
                }
                timed(timing.transaction, connection.receive()).await?;
            }
        }
    }
}

struct Connection<S> {
    stream: BufReader<S>,
    can_write: bool,
}

#[derive(Deserialize)]
struct Reply {
    cmd: Option<String>,
    evt: Option<String>,
    nonce: Option<String>,
    code: Option<u32>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Connection<S> {
    fn new(stream: S) -> Self {
        Self {
            stream: BufReader::new(stream),
            can_write: true,
        }
    }

    async fn send(&mut self, opcode: u32, body: &[u8]) -> Result<(), Fault> {
        if !self.can_write || body.len() > MAX_FRAME_BYTES {
            return Err(Fault::Unavailable);
        }
        self.can_write = false;
        write_frame(&mut self.stream, opcode, body).await?;
        self.can_write = true;
        Ok(())
    }

    async fn receive(&mut self) -> Result<Option<Reply>, Fault> {
        let (opcode, body) = read_frame(&mut self.stream).await?;
        match opcode {
            FRAME => serde_json::from_slice(&body)
                .map(Some)
                .map_err(|_| Fault::Unavailable),
            CLOSE => {
                let code = serde_json::from_slice::<Reply>(&body)
                    .ok()
                    .and_then(|reply| reply.code);
                Err(match code {
                    Some(4000 | 4001 | 4003..=4009) => Fault::Rejected,
                    _ => Fault::Unavailable,
                })
            }
            PING => {
                self.send(PONG, &body).await?;
                Ok(None)
            }
            PONG => Ok(None),
            _ => Err(Fault::Unavailable),
        }
    }

    async fn handshake(&mut self) -> Result<(), Fault> {
        let request = serde_json::to_vec(&json!({ "v": 1, "client_id": APPLICATION_ID }))
            .map_err(|_| Fault::Unavailable)?;
        self.send(HANDSHAKE, &request).await?;
        loop {
            if let Some(reply) = self.receive().await? {
                match (reply.cmd.as_deref(), reply.evt.as_deref()) {
                    (Some("DISPATCH"), Some("READY")) => return Ok(()),
                    (_, Some("ERROR")) if reply.nonce.is_none() => return Err(Fault::Rejected),
                    _ => {}
                }
            }
        }
    }

    async fn set_activity(&mut self, activity: Option<&Activity>) -> Result<(), Fault> {
        let mut payload = activity.map(Activity::payload);
        let mut result = self.send_activity(payload.as_ref()).await;
        if result != Err(Fault::Rejected) { return result; }
        let Some(data) = payload.as_mut().filter(|data| data.get("assets").is_some()) else { return result };
        if let Some(id) = activity.filter(|activity| !activity.local).and_then(|activity| activity.video_id.as_deref())
            .filter(|id| crate::ytm::parse::valid_video_id(id)) {
            let thumbnail = format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg");
            if data.pointer("/assets/large_image").and_then(Value::as_str) != Some(thumbnail.as_str()) {
                data["assets"]["large_image"] = json!(thumbnail);
                result = self.send_activity(Some(data)).await;
                if result != Err(Fault::Rejected) { return result; }
            }
        }
        data.as_object_mut().unwrap().remove("assets");
        self.send_activity(Some(data)).await
    }

    async fn send_activity(&mut self, activity: Option<&Value>) -> Result<(), Fault> {
        let nonce = NEXT_NONCE.fetch_add(1, Ordering::Relaxed).to_string();
        let request = serde_json::to_vec(&json!({
            "cmd": SET_ACTIVITY,
            "args": {
                "pid": std::process::id(),
                "activity": activity,
            },
            "nonce": nonce,
        }))
        .map_err(|_| Fault::Unavailable)?;
        self.send(FRAME, &request).await?;
        loop {
            if let Some(reply) = self.receive().await? {
                if reply.cmd.as_deref() == Some(SET_ACTIVITY)
                    && reply.nonce.as_deref() == Some(nonce.as_str())
                {
                    match reply.evt.as_deref() {
                        None => return Ok(()),
                        Some("ERROR") => return Err(Fault::Rejected),
                        _ => {}
                    }
                }
            }
        }
    }
}

async fn write_frame(
    stream: &mut (impl AsyncWrite + Unpin),
    opcode: u32,
    body: &[u8],
) -> io::Result<()> {
    let mut header = [0; 8];
    header[..4].copy_from_slice(&opcode.to_le_bytes());
    header[4..].copy_from_slice(&(body.len() as u32).to_le_bytes());
    stream.write_all(&header).await?;
    stream.write_all(body).await
}

async fn read_frame(stream: &mut (impl AsyncRead + Unpin)) -> Result<(u32, Vec<u8>), Fault> {
    let opcode = stream.read_u32_le().await?;
    let len = stream.read_u32_le().await? as usize;
    if len > MAX_FRAME_BYTES {
        return Err(Fault::Unavailable);
    }
    let mut body = vec![0; len];
    stream.read_exact(&mut body).await?;
    Ok((opcode, body))
}

impl Activity {
    fn payload(&self) -> Value {
        let title = clean_text(&self.title);
        let mut activity = json!({
            "type": LISTENING,
            "status_display_type": DISPLAY_DETAILS,
            "details": if title.is_empty() { "Unknown track" } else { &title },
        });
        if let Some(artist) = self
            .artist
            .as_deref()
            .map(clean_text)
            .filter(|s| !s.is_empty())
        {
            activity["state"] = json!(artist);
        }
        if !self.local {
            if let Some(cover) = self.cover_url.as_deref().and_then(public_cover_url) {
                activity["assets"] = json!({ "large_image": cover.as_str() });
            }
        }
        if self.start_ms.is_some() || self.end_ms.is_some() {
            let mut timestamps = json!({});
            if let Some(start) = self.start_ms {
                timestamps["start"] = json!(start / 1000);
            }
            if let Some(end) = self.end_ms {
                timestamps["end"] = json!(end / 1000);
            }
            activity["timestamps"] = timestamps;
        }
        activity
    }
}

fn public_cover_url(value: &str) -> Option<reqwest::Url> {
    let value = value.trim();
    if value.len() > 2048 {
        return None;
    }
    let mut url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let path = url.path().strip_prefix('/')?;
    let valid = match url.host_str()? {
        "yt3.googleusercontent.com" | "lh3.googleusercontent.com" | "yt3.ggpht.com" => {
            let token = path.strip_prefix("ytc/").unwrap_or(path);
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_=".contains(&byte))
        }
        "i.ytimg.com" | "i1.ytimg.com" | "i2.ytimg.com" | "i3.ytimg.com" | "i4.ytimg.com"
        | "img.youtube.com" => {
            let mut parts = path.split('/');
            matches!(parts.next(), Some("vi" | "vi_webp"))
                && parts.next().is_some_and(|id| {
                    id.len() == 11
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
                })
                && parts.next().is_some_and(|file| {
                    (file.ends_with(".jpg") || file.ends_with(".webp"))
                        && file
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
                })
                && parts.next().is_none()
        }
        _ => false,
    };
    if !valid {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

fn clean_text(value: &str) -> String {
    let mut text = String::new();
    let mut units = 0;
    let mut space = false;
    for ch in value.chars() {
        if ch.is_whitespace() {
            space = !text.is_empty();
            continue;
        }
        if ch.is_control() {
            continue;
        }
        units += usize::from(space) + ch.len_utf16();
        if units > MAX_TEXT_UNITS {
            break;
        }
        if space {
            text.push(' ');
            space = false;
        }
        text.push(ch);
    }
    text
}

#[cfg(windows)]
async fn open_pipe() -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let options = ClientOptions::new();
    for index in 0..10 {
        if let Ok(pipe) = options.open(format!(r"\\?\pipe\discord-ipc-{index}")) {
            return Ok(pipe);
        }
    }
    Err(io::ErrorKind::NotFound.into())
}

#[cfg(unix)]
async fn open_pipe() -> io::Result<tokio::net::UnixStream> {
    use std::path::PathBuf;
    use tokio::net::UnixStream;

    let mut checked = Vec::new();
    let directories = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .chain([PathBuf::from("/tmp")]);
    #[cfg(target_os = "linux")]
    let directories = directories.chain(
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(|directory| PathBuf::from(directory).join("app/com.discordapp.Discord")),
    );
    for directory in directories {
        if !directory.is_absolute() || checked.contains(&directory) {
            continue;
        }
        for index in 0..10 {
            let path = directory.join(format!("discord-ipc-{index}"));
            if let Ok(Ok(pipe)) =
                time::timeout(Duration::from_millis(25), UnixStream::connect(path)).await
            {
                return Ok(pipe);
            }
        }
        checked.push(directory);
    }
    Err(io::ErrorKind::NotFound.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, DuplexStream};
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    const TEST_DEADLINE: Duration = Duration::from_secs(3);
    const TEST_TIMING: Timing = Timing {
        transaction: Duration::from_millis(500),
        clear: Duration::from_millis(500),
        retry: Duration::from_millis(30),
    };

    fn track(title: &str) -> Activity {
        Activity {
            title: title.into(),
            artist: Some("Artist".into()),
            cover_url: None,
            video_id: None,
            start_ms: Some(1_700_000_000_000),
            end_ms: None,
            local: false,
        }
    }

    fn launch() -> (Presence, mpsc::Sender<DuplexStream>, JoinHandle<()>) {
        let (pipes, mut incoming) = mpsc::channel(4);
        let (desired, updates) = watch::channel(None);
        let (statuses, status) = watch::channel(Status::Idle);
        let worker = tokio::spawn(run(
            updates,
            statuses,
            |_| {},
            move || {
                std::future::ready(
                    incoming
                        .try_recv()
                        .map_err(|_| io::ErrorKind::NotFound.into()),
                )
            },
            TEST_TIMING,
        ));
        (Presence { desired, status }, pipes, worker)
    }

    fn fake_pipe(pipes: &mpsc::Sender<DuplexStream>) -> DuplexStream {
        let (client, peer) = duplex(4096);
        pipes.try_send(client).unwrap();
        peer
    }

    async fn frame(peer: &mut DuplexStream) -> (u32, Vec<u8>) {
        time::timeout(TEST_DEADLINE, read_frame(peer))
            .await
            .unwrap()
            .unwrap()
    }

    async fn request(peer: &mut DuplexStream, opcode: u32) -> Value {
        let (actual, body) = frame(peer).await;
        assert_eq!(actual, opcode);
        serde_json::from_slice(&body).unwrap()
    }

    async fn reply(peer: &mut DuplexStream, value: Value) {
        write_frame(peer, FRAME, &serde_json::to_vec(&value).unwrap())
            .await
            .unwrap();
    }

    async fn ready(peer: &mut DuplexStream) {
        reply(
            peer,
            json!({ "cmd": "DISPATCH", "evt": "READY", "data": {} }),
        )
        .await;
    }

    async fn handshake(peer: &mut DuplexStream) {
        assert_eq!(
            request(peer, HANDSHAKE).await,
            json!({ "v": 1, "client_id": "1575963822924238941" })
        );
        ready(peer).await;
    }

    async fn ack(peer: &mut DuplexStream, request: &Value) {
        reply(
            peer,
            json!({ "cmd": SET_ACTIVITY, "evt": null, "data": null, "nonce": request["nonce"] }),
        )
        .await;
    }

    async fn status(presence: &mut Presence, wanted: Status) {
        let _status = time::timeout(
            TEST_DEADLINE,
            presence.status.wait_for(|current| *current == wanted),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[test]
    fn activity_payload_contains_only_track_fields_and_converts_milliseconds_to_seconds() {
        let activity: Activity = serde_json::from_value(json!({
            "title": "  Title\n\0remix ",
            "artist": " Artist\tArtist ",
            "coverUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            "startMs": 1_700_000_000_123_u64,
            "endMs": 1_700_000_123_456_u64,
            "local": true,
        }))
        .unwrap();
        assert_eq!(
            activity.payload(),
            json!({
                "type": 2,
                "status_display_type": 2,
                "details": "Title remix",
                "state": "Artist Artist",
                "timestamps": {"start": 1_700_000_000_u64, "end": 1_700_000_123_u64}
            })
        );
        let title = "🎵".repeat(80);
        let payload = Activity {
            title,
            artist: Some("\n\t\0".into()),
            start_ms: None,
            ..activity
        }
        .payload();
        assert_eq!(payload["details"], "🎵".repeat(64));
        assert!(payload.get("state").is_none());
        assert_eq!(payload["timestamps"], json!({"end": 1_700_000_123_u64}));
        assert_eq!(
            serde_json::to_value(Status::Unavailable).unwrap(),
            "unavailable"
        );
    }

    #[test]
    fn only_public_track_images_are_passed_to_discord_without_query_values() {
        let mut activity = track("Online");
        for (provided, expected) in [
            (
                "https://lh3.googleusercontent.com/cover-32a9=w540-h540-l90-rj?tracking=private#fragment",
                "https://lh3.googleusercontent.com/cover-32a9=w540-h540-l90-rj",
            ),
            (
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?sqp=unused",
                "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            ),
        ] {
            activity.cover_url = Some(provided.into());
            assert_eq!(activity.payload()["assets"]["large_image"], expected);
        }
        for invalid in [
            "file:///C:/Music/cover.jpg",
            "http://localmedia.localhost/cover/private",
            "https://example.com/cover.jpg",
            "https://i.ytimg.com.example.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            "https://i.ytimg.com@somewhere.example/vi/dQw4w9WgXcQ/hqdefault.jpg",
            "https://member:password@i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            "https://lh3.googleusercontent.com/private/file.png",
        ] {
            activity.cover_url = Some(invalid.into());
            assert!(activity.payload().get("assets").is_none());
        }
    }

    #[tokio::test]
    async fn retries_a_rejected_cover_as_the_same_track_without_artwork() {
        let (mut presence, pipes, _) = launch();
        let mut peer = fake_pipe(&pipes);
        presence.set(Some(Activity {
            cover_url: Some("https://lh3.googleusercontent.com/album=w540-h540".into()),
            video_id: Some("dQw4w9WgXcQ".into()),
            ..track("A track")
        }));
        handshake(&mut peer).await;
        let with_art = request(&mut peer, FRAME).await;
        assert!(with_art["args"]["activity"]["assets"]["large_image"].is_string());
        reply(
            &mut peer,
            json!({ "cmd": SET_ACTIVITY, "evt": "ERROR", "nonce": with_art["nonce"] }),
        )
        .await;
        let fallback = request(&mut peer, FRAME).await;
        assert_eq!(fallback["args"]["activity"]["assets"]["large_image"], "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
        reply(&mut peer, json!({ "cmd": SET_ACTIVITY, "evt": "ERROR", "nonce": fallback["nonce"] })).await;
        let text_only = request(&mut peer, FRAME).await;
        assert_eq!(text_only["args"]["activity"], track("A track").payload());
        ack(&mut peer, &text_only).await;
        status(&mut presence, Status::Active).await;
    }

    #[tokio::test]
    async fn publishes_only_after_ready_and_a_matching_activity_ack() {
        let (mut presence, pipes, _) = launch();
        let mut peer = fake_pipe(&pipes);
        presence.set(Some(track("Now playing")));
        assert_eq!(
            request(&mut peer, HANDSHAKE).await,
            json!({ "v": 1, "client_id": APPLICATION_ID })
        );

        reply(&mut peer, json!({ "cmd": "OTHER", "evt": "READY" })).await;
        write_frame(&mut peer, PING, b"\0ping").await.unwrap();
        assert_eq!(frame(&mut peer).await, (PONG, b"\0ping".to_vec()));
        assert_eq!(presence.status(), Status::Connecting);
        ready(&mut peer).await;

        let update = request(&mut peer, FRAME).await;
        assert_eq!(update["cmd"], SET_ACTIVITY);
        assert_eq!(update["args"]["pid"], std::process::id());
        assert_eq!(update["args"]["activity"], track("Now playing").payload());
        reply(
            &mut peer,
            json!({ "cmd": SET_ACTIVITY, "nonce": "unrelated", "evt": "ERROR" }),
        )
        .await;
        reply(
            &mut peer,
            json!({ "cmd": "OTHER", "nonce": update["nonce"] }),
        )
        .await;
        reply(
            &mut peer,
            json!({ "cmd": SET_ACTIVITY, "nonce": update["nonce"], "evt": "OTHER" }),
        )
        .await;
        write_frame(&mut peer, PING, b"after unrelated replies")
            .await
            .unwrap();
        assert_eq!(
            frame(&mut peer).await,
            (PONG, b"after unrelated replies".to_vec())
        );
        assert_eq!(presence.status(), Status::Connecting);
        ack(&mut peer, &update).await;
        status(&mut presence, Status::Active).await;

        presence.set(None);
        let clear = request(&mut peer, FRAME).await;
        assert_eq!(clear["cmd"], SET_ACTIVITY);
        assert_eq!(
            clear["args"],
            json!({"pid": std::process::id(), "activity": null})
        );
        assert_ne!(clear["nonce"], update["nonce"]);
        ack(&mut peer, &clear).await;
        status(&mut presence, Status::Idle).await;
    }

    #[tokio::test]
    async fn retries_after_discord_opens_and_restarts_and_resends_the_latest_track() {
        let (mut presence, pipes, _) = launch();
        presence.set(Some(track("First")));
        status(&mut presence, Status::Unavailable).await;

        let mut first = fake_pipe(&pipes);
        handshake(&mut first).await;
        let update = request(&mut first, FRAME).await;
        ack(&mut first, &update).await;
        status(&mut presence, Status::Active).await;

        drop(first);
        status(&mut presence, Status::Unavailable).await;
        presence.set(Some(track("Latest")));
        let mut second = fake_pipe(&pipes);
        handshake(&mut second).await;
        let clear = request(&mut second, FRAME).await;
        assert!(clear["args"]["activity"].is_null());
        ack(&mut second, &clear).await;
        let update = request(&mut second, FRAME).await;
        assert_eq!(update["args"]["activity"]["details"], "Latest");
        ack(&mut second, &update).await;
        status(&mut presence, Status::Active).await;
    }

    #[tokio::test]
    async fn clears_on_rejection_and_reports_it_until_another_attempt() {
        let (mut presence, pipes, _) = launch();
        let mut peer = fake_pipe(&pipes);
        presence.set(Some(track("Rejected title")));
        handshake(&mut peer).await;
        let update = request(&mut peer, FRAME).await;
        reply(
            &mut peer,
            json!({
                "cmd": SET_ACTIVITY,
                "evt": "ERROR",
                "nonce": update["nonce"],
                "data": { "code": 4000, "message": "Invalid activity" }
            }),
        )
        .await;

        let clear = request(&mut peer, FRAME).await;
        assert!(clear["args"]["activity"].is_null());
        ack(&mut peer, &clear).await;
        status(&mut presence, Status::Rejected).await;
        presence.set(None);
        status(&mut presence, Status::Idle).await;
    }

    #[tokio::test]
    async fn updates_the_track_on_the_same_connection_and_clears_on_drop() {
        let (mut presence, pipes, worker) = launch();
        let mut peer = fake_pipe(&pipes);
        presence.set(Some(track("First")));
        handshake(&mut peer).await;
        let update = request(&mut peer, FRAME).await;
        ack(&mut peer, &update).await;
        status(&mut presence, Status::Active).await;

        presence.set(Some(track("Second")));
        let update = request(&mut peer, FRAME).await;
        assert_eq!(update["args"]["activity"]["details"], "Second");
        ack(&mut peer, &update).await;
        status(&mut presence, Status::Active).await;

        drop(presence);
        let clear = request(&mut peer, FRAME).await;
        assert!(clear["args"]["activity"].is_null());
        ack(&mut peer, &clear).await;
        time::timeout(TEST_DEADLINE, worker).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn does_not_publish_an_intent_cleared_during_handshake() {
        let (mut presence, pipes, _) = launch();
        let mut peer = fake_pipe(&pipes);
        presence.set(Some(track("No longer playing")));
        request(&mut peer, HANDSHAKE).await;
        presence.set(None);
        ready(&mut peer).await;
        assert_eq!(
            time::timeout(TEST_DEADLINE, peer.read_u8())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof,
        );
        status(&mut presence, Status::Idle).await;
    }

    #[tokio::test]
    async fn stalls_and_oversized_frames_are_treated_as_transport_failures() {
        let (mut presence, pipes, _) = launch();
        let mut stalled = fake_pipe(&pipes);
        presence.set(Some(track("Now playing")));
        request(&mut stalled, HANDSHAKE).await;
        stalled.write_u32_le(FRAME).await.unwrap();
        status(&mut presence, Status::Unavailable).await;

        let mut oversized = fake_pipe(&pipes);
        request(&mut oversized, HANDSHAKE).await;
        oversized.write_u32_le(FRAME).await.unwrap();
        oversized
            .write_u32_le(MAX_FRAME_BYTES as u32 + 1)
            .await
            .unwrap();
        assert_eq!(
            time::timeout(TEST_DEADLINE, oversized.read_u8())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof,
        );
        assert_eq!(presence.status(), Status::Unavailable);
    }
}
