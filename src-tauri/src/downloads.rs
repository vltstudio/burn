use crate::error::{Error, Result};
use crate::lyrics::Lyrics;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

/// How much audio is fetched before the next progress event, so a 4 MB track
/// reports a few dozen times instead of thousands.
const PROGRESS_STEP: u64 = 256 * 1024;

/// Bytes per ranged request. The audio host slows a single long download, and
/// a fresh window restores full speed.
const FETCH_WINDOW: u64 = 1024 * 1024;

/// One finished download: the index file's record and what the UI shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub video_id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub thumb: Option<String>,
    pub path: String,
    pub bytes: u64,
    /// The artwork was cached next to the audio, so the row renders offline.
    #[serde(default)]
    pub has_cover: bool,
}

/// The favourite's audio on disk. One file per track id, so a track downloaded
/// twice (a heart toggled off and on again, a synced favourite) keeps a single
/// copy, and a file the person deleted by hand leaves the index.
pub struct Downloads {
    dir: PathBuf,
    covers: PathBuf,
    lyrics: PathBuf,
    index_path: PathBuf,
    items: RwLock<Vec<Download>>,
    /// Ids currently being fetched, so a second request waits instead of
    /// writing the same file twice.
    active: Mutex<HashSet<String>>,
    http: reqwest::Client,
}

impl Downloads {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let covers = dir.join("covers");
        let _ = std::fs::create_dir_all(&covers);
        let lyrics = dir.join("lyrics");
        let _ = std::fs::create_dir_all(&lyrics);
        let index_path = dir.join("index.json");
        let mut items: Vec<Download> = std::fs::read_to_string(&index_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        items.retain(|item| {
            std::fs::metadata(&item.path)
                .map(|meta| meta.is_file())
                .unwrap_or(false)
        });
        for item in &mut items {
            if let Ok(meta) = std::fs::metadata(&item.path) {
                item.bytes = meta.len();
            }
        }
        let http = reqwest::Client::builder()
            .user_agent(crate::ytm::USER_AGENT)
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self {
            dir,
            covers,
            lyrics,
            index_path,
            items: RwLock::new(items),
            active: Mutex::new(HashSet::new()),
            http,
        }
    }

    pub fn list(&self) -> Vec<Download> {
        self.items.read().map(|items| items.clone()).unwrap_or_default()
    }

    /// Count and bytes of everything already on disk.
    pub fn usage(&self) -> (usize, u64) {
        self.items
            .read()
            .map(|items| (items.len(), items.iter().map(|item| item.bytes).sum()))
            .unwrap_or((0, 0))
    }

    pub fn find(&self, video_id: &str) -> Option<Download> {
        self.items
            .read()
            .ok()?
            .iter()
            .find(|item| item.video_id == video_id)
            .cloned()
    }

    /// True while a download owns the id.
    pub fn claim(&self, video_id: &str) -> bool {
        self.active
            .lock()
            .map(|mut active| active.insert(video_id.to_string()))
            .unwrap_or(false)
    }

    pub fn release(&self, video_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(video_id);
        }
    }

    /// The media protocol serves only the app's own downloads, never the rest
    /// of the disk.
    pub fn allows(&self, path: &str) -> bool {
        Path::new(path).starts_with(&self.dir)
    }

    pub fn part_path(&self, video_id: &str) -> PathBuf {
        self.dir.join(format!("{video_id}.part"))
    }

    pub fn target_path(&self, video_id: &str, extension: &str) -> PathBuf {
        self.dir.join(format!("{video_id}.{extension}"))
    }

    pub fn cover_path(&self, video_id: &str) -> PathBuf {
        self.covers.join(format!("{video_id}.img"))
    }

    pub fn cover(&self, video_id: &str) -> Option<Vec<u8>> {
        std::fs::read(self.cover_path(video_id)).ok()
    }

    /// Timed lyrics kept beside a downloaded track, so the pane works offline.
    pub fn store_lyrics(&self, video_id: &str, lyrics: &Lyrics) {
        if let Ok(text) = serde_json::to_string(lyrics) {
            let _ = std::fs::write(self.lyrics_path(video_id), text);
        }
    }

    pub fn lyrics(&self, video_id: &str) -> Option<Lyrics> {
        let text = std::fs::read_to_string(self.lyrics_path(video_id)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn lyrics_path(&self, video_id: &str) -> PathBuf {
        self.lyrics.join(format!("{video_id}.json"))
    }

    pub fn store_cover(&self, video_id: &str, bytes: &[u8]) {
        let _ = std::fs::write(self.cover_path(video_id), bytes);
    }

    /// Records a finished file, replacing an older copy of the same track so
    /// the list never holds two entries for one id.
    pub fn commit(&self, download: Download) -> Result<()> {
        let download = Download {
            has_cover: self.cover_path(&download.video_id).is_file(),
            ..download
        };
        let replaced = {
            let mut items = self
                .items
                .write()
                .map_err(|_| Error::io("download index is locked"))?;
            let replaced = items
                .iter()
                .position(|item| item.video_id == download.video_id)
                .map(|position| items.remove(position))
                .filter(|old| old.path != download.path);
            items.push(download.clone());
            items.sort_by(|left, right| left.title.to_lowercase().cmp(&right.title.to_lowercase()));
            self.write(&items)?;
            replaced
        };
        if let Some(old) = replaced {
            let _ = std::fs::remove_file(&old.path);
        }
        Ok(())
    }

    pub fn remove(&self, video_id: &str) -> Result<bool> {
        let removed = {
            let mut items = self
                .items
                .write()
                .map_err(|_| Error::io("download index is locked"))?;
            let removed = items
                .iter()
                .position(|item| item.video_id == video_id)
                .map(|position| items.remove(position));
            if removed.is_some() {
                self.write(&items)?;
            }
            removed
        };
        let Some(download) = removed else {
            return Ok(false);
        };
        let _ = std::fs::remove_file(&download.path);
        let _ = std::fs::remove_file(self.cover_path(video_id));
        let _ = std::fs::remove_file(self.lyrics_path(video_id));
        Ok(true)
    }

    fn write(&self, items: &[Download]) -> Result<()> {
        let text = serde_json::to_string_pretty(items).map_err(|error| Error::io(error.to_string()))?;
        let temporary = self.index_path.with_extension("tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, &self.index_path)?;
        Ok(())
    }

    /// Fetches the audio into a `.part` file and moves it into place only when
    /// every byte arrived, so a broken transfer never looks downloaded. The
    /// stream is read in windows: the audio host throttles a single long
    /// connection, and a ranged request per window keeps full speed.
    pub async fn fetch(
        &self,
        video_id: &str,
        url: &str,
        on_progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<(PathBuf, u64)> {
        use tokio::io::AsyncWriteExt;

        let part = self.part_path(video_id);
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|error| Error::io(error.to_string()))?;
        let mut extension: Option<&'static str> = None;
        let mut received = 0u64;
        let mut reported = 0u64;
        let mut total: Option<u64> = None;
        on_progress(0, None);
        loop {
            let end = received + FETCH_WINDOW - 1;
            let response = self
                .http
                .get(url)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .header(reqwest::header::RANGE, format!("bytes={received}-{end}"))
                .send()
                .await
                .map_err(|error| Error::io(format!("Не удалось скачать трек: {error}")))?;
            if response.status().as_u16() == 416 {
                // Asked past the end: the window before it was the last one.
                break;
            }
            if !response.status().is_success() {
                return Err(Error::io(format!(
                    "Сервис ответил {} при скачивании трека",
                    response.status().as_u16()
                )));
            }
            if extension.is_none() {
                extension = Some(extension_for(
                    response
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|value| value.to_str().ok()),
                ));
            }
            total = total.or_else(|| total_from_range(&response));
            let partial = response.status().as_u16() == 206;
            let mut response = response;
            let mut window = 0u64;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| Error::io(format!("Скачивание прервалось: {error}")))?
            {
                file.write_all(&chunk)
                    .await
                    .map_err(|error| Error::io(error.to_string()))?;
                window += chunk.len() as u64;
                received += chunk.len() as u64;
                if received - reported >= PROGRESS_STEP {
                    reported = received;
                    on_progress(received, total);
                }
            }
            if window == 0 {
                break;
            }
            if !partial {
                // The host ignored the range and sent the whole file.
                break;
            }
            if total.is_some_and(|total| received >= total) {
                break;
            }
        }
        file.flush().await.map_err(|error| Error::io(error.to_string()))?;
        drop(file);
        if received == 0 {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::io("Сервис вернул пустой аудиопоток"));
        }
        let target = self.target_path(video_id, extension.unwrap_or("m4a"));
        if target.is_file() {
            let _ = tokio::fs::remove_file(&target).await;
        }
        tokio::fs::rename(&part, &target)
            .await
            .map_err(|error| Error::io(error.to_string()))?;
        on_progress(received, Some(received));
        Ok((target, received))
    }

    /// The cover is optional: a track without artwork still plays offline.
    pub async fn fetch_cover(&self, video_id: &str, url: &str) {
        let Ok(response) = self.client().get(url).send().await else {
            return;
        };
        if !response.status().is_success() {
            return;
        }
        if let Ok(bytes) = response.bytes().await {
            if !bytes.is_empty() {
                self.store_cover(video_id, &bytes);
            }
        }
    }

    fn client(&self) -> &reqwest::Client {
        &self.http
    }

    /// Drops `.part` files left behind by a quit mid-download.
    pub fn sweep(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.path().extension().is_some_and(|extension| extension == "part") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Writes a file straight into the index, used by tests and by any future
    /// import path that already has bytes.
    #[cfg(test)]
    pub fn insert_bytes(&self, video_id: &str, bytes: &[u8]) -> Result<Download> {
        let path = self.target_path(video_id, "webm");
        std::fs::write(&path, bytes)?;
        let download = Download {
            video_id: video_id.to_string(),
            title: video_id.to_string(),
            subtitle: String::new(),
            duration: None,
            thumb: None,
            path: path.to_string_lossy().to_string(),
            bytes: bytes.len() as u64,
            has_cover: false,
        };
        self.commit(download.clone())?;
        Ok(download)
    }
}

/// `Content-Range: bytes 0-1048575/4194304` carries the whole file's size.
fn total_from_range(response: &reqwest::Response) -> Option<u64> {
    let value = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    value.rsplit('/').next()?.trim().parse().ok()
}

/// Maps the service's content type to a file extension the media protocol
/// already knows how to serve.
fn extension_for(content_type: Option<&str>) -> &'static str {
    match content_type.unwrap_or("").split(';').next().unwrap_or("").trim() {
        "audio/webm" | "video/webm" => "webm",
        "audio/mp4" | "video/mp4" | "audio/aac" => "m4a",
        "audio/ogg" | "application/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        "audio/flac" => "flac",
        _ => "m4a",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "burn-downloads-{name}-{}",
            std::process::id() as u64
                + std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos() as u64)
                    .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn one_entry_per_track_and_the_replaced_file_is_deleted() {
        let dir = temp_dir("dedupe");
        let downloads = Downloads::load(dir.clone());
        downloads.insert_bytes("aaaaaaaaaaa", b"first").unwrap();
        let first = downloads.find("aaaaaaaaaaa").unwrap();

        std::fs::write(downloads.target_path("aaaaaaaaaaa", "m4a"), b"second").unwrap();
        downloads
            .commit(Download {
                video_id: "aaaaaaaaaaa".into(),
                title: "Track".into(),
                subtitle: String::new(),
                duration: None,
                thumb: None,
                path: downloads
                    .target_path("aaaaaaaaaaa", "m4a")
                    .to_string_lossy()
                    .to_string(),
                bytes: 6,
                has_cover: false,
            })
            .unwrap();

        let items = downloads.list();
        assert_eq!(items.len(), 1, "the track keeps a single entry");
        assert!(items[0].path.ends_with(".m4a"));
        assert!(!Path::new(&first.path).exists(), "the stale file is gone");
        assert_eq!(downloads.usage(), (1, 6));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_index_survives_a_restart_and_forgets_missing_files() {
        let dir = temp_dir("restart");
        let downloads = Downloads::load(dir.clone());
        downloads.insert_bytes("bbbbbbbbbbb", b"audio").unwrap();
        let kept = downloads.find("bbbbbbbbbbb").unwrap();
        drop(downloads);

        let reopened = Downloads::load(dir.clone());
        assert_eq!(reopened.list().len(), 1, "a launch keeps what is on disk");

        std::fs::remove_file(&kept.path).unwrap();
        let after_delete = Downloads::load(dir.clone());
        assert!(after_delete.list().is_empty(), "a missing file leaves the index");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removal_frees_the_file_its_cover_and_the_ids() {
        let dir = temp_dir("remove");
        let downloads = Downloads::load(dir.clone());
        let item = downloads.insert_bytes("ccccccccccc", b"1234").unwrap();
        downloads.store_cover("ccccccccccc", b"cover");

        assert!(downloads.remove("ccccccccccc").unwrap());
        assert!(!Path::new(&item.path).exists());
        assert!(downloads.cover("ccccccccccc").is_none());
        assert!(downloads.list().is_empty());
        assert!(!downloads.remove("ccccccccccc").unwrap(), "second removal is a no-op");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_download_folder_is_served() {
        let dir = temp_dir("allows");
        let downloads = Downloads::load(dir.clone());
        let inside = downloads.target_path("ddddddddddd", "webm");
        assert!(downloads.allows(&inside.to_string_lossy()));
        assert!(!downloads.allows("C:\\Windows\\System32\\drivers\\etc\\hosts"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_track_is_claimed_once_while_it_downloads() {
        let dir = temp_dir("claim");
        let downloads = Downloads::load(dir.clone());
        assert!(downloads.claim("eeeeeeeeeee"));
        assert!(!downloads.claim("eeeeeeeeeee"), "a second request waits");
        downloads.release("eeeeeeeeeee");
        assert!(downloads.claim("eeeeeeeeeee"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn content_types_pick_a_known_extension() {
        assert_eq!(extension_for(Some("audio/webm; codecs=opus")), "webm");
        assert_eq!(extension_for(Some("audio/mp4")), "m4a");
        assert_eq!(extension_for(Some("audio/mpeg")), "mp3");
        assert_eq!(extension_for(None), "m4a");
    }
}
