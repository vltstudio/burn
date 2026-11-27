use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Extensions the scanner treats as music. Everything else in a folder is left
/// alone, so pointing the app at a big directory stays cheap.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "webm", "wma", "aiff", "aif",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    /// Stable id: `local:<absolute path>`.
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: Option<u32>,
    pub has_cover: bool,
    /// Folder the track was found under, used for grouping.
    pub root: String,
}

/// One app-level favourite. It carries its own metadata so the list renders
/// offline, without asking either source to resolve the id again.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    /// Source-tagged: `yt:<videoId>` or `local:<absolute path>`.
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub duration: Option<u32>,
    /// `yt` or `local`.
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub video_id: Option<String>,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub thumb: Option<String>,
}

pub fn youtube_favorite_id(favorite: &Favorite) -> Option<&str> {
    if favorite.source != "yt" || favorite.local_path.is_some() {
        return None;
    }
    let id = favorite.video_id.as_deref()?;
    (id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && favorite.id == format!("yt:{id}"))
    .then_some(id)
}

/// One playlist moved to the local archive. It carries its own metadata so the
/// archive still renders when YouTube Music is unreachable.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedPlaylist {
    /// `playlistId` when known, otherwise the browse id.
    pub id: String,
    #[serde(default)]
    pub playlist_id: Option<String>,
    #[serde(default)]
    pub browse_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub thumbs: Vec<String>,
    #[serde(default)]
    pub archived_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    roots: Vec<String>,
    #[serde(deserialize_with = "deserialize_favorites")]
    favorites: Vec<Favorite>,
    favorites_account: Option<String>,
    archive: Vec<ArchivedPlaylist>,
    /// Absolute path of the archive's own cover, when the person set one.
    archive_cover: Option<String>,
}

/// Older builds stored favourites as bare ids. Accept both shapes so a store
/// written by them still loads its folder list.
fn deserialize_favorites<'de, D>(deserializer: D) -> std::result::Result<Vec<Favorite>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Array(items) = value else {
        return Ok(Vec::new());
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::String(id) => {
                let mut favorite = Favorite {
                    id: id.clone(),
                    ..Default::default()
                };
                if let Some(video_id) = id.strip_prefix("yt:") {
                    favorite.source = "yt".to_string();
                    favorite.video_id = Some(video_id.to_string());
                    favorite.title = video_id.to_string();
                } else {
                    favorite.source = "local".to_string();
                    let path = id.strip_prefix("local:").unwrap_or(&id).to_string();
                    favorite.title = Path::new(&path)
                        .file_stem()
                        .map(|stem| stem.to_string_lossy().to_string())
                        .unwrap_or(path.clone());
                    favorite.local_path = Some(path);
                }
                Some(favorite)
            }
            other => serde_json::from_value::<Favorite>(other).ok(),
        })
        .collect())
}

/// Local files plus the app's own favourites, kept in one small JSON file.
/// Favourites are source-tagged (`local:…`, `yt:…`) so more sources can join
/// later without touching this store.
pub struct LocalLibrary {
    path: PathBuf,
    /// The scanned list survives restarts; a 20k-file library must not be
    /// re-read every launch just to open the tab.
    tracks_path: PathBuf,
    cache_dir: PathBuf,
    store: std::sync::RwLock<Store>,
    writes: std::sync::Mutex<()>,
    tracks: std::sync::RwLock<Vec<LocalTrack>>,
    scanned: std::sync::atomic::AtomicBool,
}

impl LocalLibrary {
    pub fn load(path: PathBuf, cache_dir: PathBuf) -> Self {
        let store = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Store>(&text).ok())
            .unwrap_or_default();
        let tracks_path = path.with_file_name("tracks.json");
        let cached = std::fs::read_to_string(&tracks_path).ok();
        let scanned = cached.is_some();
        let tracks = cached
            .and_then(|text| serde_json::from_str::<Vec<LocalTrack>>(&text).ok())
            .unwrap_or_default();
        let _ = std::fs::create_dir_all(&cache_dir);
        Self {
            path,
            tracks_path,
            cache_dir,
            store: std::sync::RwLock::new(store),
            writes: std::sync::Mutex::new(()),
            tracks: std::sync::RwLock::new(tracks),
            scanned: std::sync::atomic::AtomicBool::new(scanned),
        }
    }

    /// True once a scan has run and its result is on disk.
    pub fn scanned(&self) -> bool {
        self.scanned.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn save(&self) -> Result<()> {
        let store = self
            .store
            .read()
            .map_err(|_| Error::io("local store is locked"))?;
        self.write_store(&store)
    }

    fn write_store(&self, store: &Store) -> Result<()> {
        let _write = self
            .writes
            .lock()
            .map_err(|_| Error::io("local store is locked"))?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text =
            serde_json::to_string_pretty(store).map_err(|error| Error::io(error.to_string()))?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(&temporary, &self.path)?;
        Ok(())
    }

    pub fn roots(&self) -> Vec<String> {
        self.store
            .read()
            .map(|store| store.roots.clone())
            .unwrap_or_default()
    }

    /// Newest first, so the list reads as a history of what was hearted.
    pub fn favorites(&self) -> Vec<Favorite> {
        self.store
            .read()
            .map(|store| store.favorites.clone())
            .unwrap_or_default()
    }

    /// Returns the new state: true when the favourite was added.
    pub fn toggle_favorite(&self, favorite: Favorite) -> Result<bool> {
        let mut store = self
            .store
            .write()
            .map_err(|_| Error::io("local store is locked"))?;
        let mut candidate = store.clone();
        let added = if let Some(index) = candidate
            .favorites
            .iter()
            .position(|item| item.id == favorite.id)
        {
            candidate.favorites.remove(index);
            false
        } else {
            candidate.favorites.insert(0, favorite);
            true
        };
        self.write_store(&candidate)?;
        *store = candidate;
        Ok(added)
    }

    pub fn favorites_account(&self) -> Result<Option<String>> {
        Ok(self
            .store
            .read()
            .map_err(|_| Error::io("local store is locked"))?
            .favorites_account
            .clone())
    }

    pub fn merge_synced_favorites(
        &self,
        started: &[Favorite],
        desired: Vec<Favorite>,
        expected_account: Option<&str>,
        account: &str,
    ) -> Result<Vec<Favorite>> {
        use std::collections::{BTreeMap, BTreeSet};
        let mut store = self
            .store
            .write()
            .map_err(|_| Error::io("local store is locked"))?;
        if store.favorites_account.as_deref() != expected_account {
            return Err(Error::api(
                "Аккаунт локального избранного изменился во время синхронизации",
            ));
        }
        let initial: BTreeSet<&str> = started.iter().filter_map(youtube_favorite_id).collect();
        let current: BTreeSet<&str> = store
            .favorites
            .iter()
            .filter_map(youtube_favorite_id)
            .collect();
        let mut wanted: BTreeMap<String, Favorite> = desired
            .iter()
            .filter_map(|item| youtube_favorite_id(item).map(|id| (id.to_string(), item.clone())))
            .collect();
        for removed in initial.difference(&current) {
            wanted.remove(*removed);
        }
        for item in &store.favorites {
            if let Some(id) = youtube_favorite_id(item) {
                if !initial.contains(id) {
                    wanted.insert(id.to_string(), item.clone());
                }
            }
        }
        let mut merged = Vec::new();
        for item in &store.favorites {
            match youtube_favorite_id(item) {
                Some(id) => {
                    if let Some(favorite) = wanted.remove(id) {
                        merged.push(favorite);
                    }
                }
                None => merged.push(item.clone()),
            }
        }
        for item in desired {
            if let Some(id) = youtube_favorite_id(&item) {
                if let Some(favorite) = wanted.remove(id) {
                    merged.push(favorite);
                }
            }
        }
        let mut candidate = store.clone();
        candidate.favorites = merged.clone();
        candidate.favorites_account = Some(account.to_string());
        self.write_store(&candidate)?;
        *store = candidate;
        Ok(merged)
    }

    /// Archived playlists, newest first.
    pub fn archive(&self) -> Vec<ArchivedPlaylist> {
        self.store
            .read()
            .map(|store| store.archive.clone())
            .unwrap_or_default()
    }

    pub fn archive_push(&self, item: ArchivedPlaylist) -> Result<Vec<ArchivedPlaylist>> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive.retain(|entry| entry.id != item.id);
            store.archive.insert(0, item);
        }
        self.save()?;
        Ok(self.archive())
    }

    pub fn archive_remove(&self, id: &str) -> Result<Vec<ArchivedPlaylist>> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive.retain(|entry| entry.id != id);
        }
        self.save()?;
        Ok(self.archive())
    }

    /// Copies the chosen image into the app's cache and remembers it as the
    /// archive cover. The bytes are validated as an image before they land.
    pub fn set_archive_cover(&self, source: &str) -> Result<()> {
        let bytes = std::fs::read(source)
            .map_err(|error| Error::io(format!("Не удалось прочитать картинку: {error}")))?;
        if bytes.is_empty() {
            return Err(Error::io("Файл обложки пустой"));
        }
        if bytes.len() > 12 * 1024 * 1024 {
            return Err(Error::io("Картинка больше 12 МБ"));
        }
        if !looks_like_image(&bytes) {
            return Err(Error::io(
                "Это не похоже на картинку: нужен JPEG, PNG, GIF или WebP",
            ));
        }
        std::fs::create_dir_all(&self.cache_dir)?;
        let path = self.cache_dir.join("archive-cover.img");
        std::fs::write(&path, &bytes)?;
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive_cover = Some(path.to_string_lossy().to_string());
        }
        self.save()
    }

    pub fn clear_archive_cover(&self) -> Result<()> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.archive_cover = None;
        }
        self.save()
    }

    pub fn archive_cover(&self) -> Option<Vec<u8>> {
        let path = self
            .store
            .read()
            .ok()
            .and_then(|store| store.archive_cover.clone())?;
        std::fs::read(path).ok()
    }

    pub fn add_root(&self, root: &str) -> Result<Vec<String>> {
        let path = Path::new(root);
        if !path.is_dir() {
            return Err(Error::io(format!("Папка не найдена: {root}")));
        }
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            let normalized = path.to_string_lossy().to_string();
            if !store.roots.contains(&normalized) {
                store.roots.push(normalized);
            }
        }
        self.save()?;
        Ok(self.roots())
    }

    /// Drops a folder and, with it, every track that came from there. The rest
    /// of the library stays indexed, so removing a folder needs no rescan.
    pub fn remove_root(&self, root: &str) -> Result<Vec<LocalTrack>> {
        {
            let mut store = self
                .store
                .write()
                .map_err(|_| Error::io("local store is locked"))?;
            store.roots.retain(|current| current != root);
        }
        self.save()?;

        let remaining = {
            let mut tracks = self
                .tracks
                .write()
                .map_err(|_| Error::io("track list is locked"))?;
            tracks.retain(|track| track.root != root);
            tracks.clone()
        };
        if let Ok(text) = serde_json::to_string(&remaining) {
            let _ = std::fs::write(&self.tracks_path, text);
        }
        Ok(remaining)
    }

    pub fn tracks(&self) -> Vec<LocalTrack> {
        self.tracks
            .read()
            .map(|tracks| tracks.clone())
            .unwrap_or_default()
    }

    /// Walks every root and rebuilds the track list. Cheap enough to rerun on
    /// startup and on demand: folders hold hundreds of files, not millions.
    /// Walks every root, rebuilding the track list. `progress` is called with
    /// the running count so a long scan can report where it is.
    pub fn scan(&self, progress: &dyn Fn(usize)) -> Result<Vec<LocalTrack>> {
        let mut found: Vec<LocalTrack> = Vec::new();
        for root in self.roots() {
            found.extend(walk_root(&root, &mut found.len(), progress));
        }
        found.sort_by(compare_tracks);
        self.replace_tracks(found, progress)
    }

    /// Indexes one folder and merges it into the list, so adding a folder costs
    /// as much as that folder holds, not as much as the whole library.
    pub fn scan_root(&self, root: &str, progress: &dyn Fn(usize)) -> Result<Vec<LocalTrack>> {
        let mut fresh: Vec<LocalTrack> = Vec::new();
        fresh.extend(walk_root(root, &mut fresh.len(), progress));

        let mut merged = {
            let mut tracks = self
                .tracks
                .write()
                .map_err(|_| Error::io("track list is locked"))?;
            tracks.retain(|track| track.root != root);
            tracks.extend(fresh);
            tracks.clone()
        };
        merged.sort_by(compare_tracks);
        self.replace_tracks(merged, progress)
    }

    fn replace_tracks(
        &self,
        tracks: Vec<LocalTrack>,
        progress: &dyn Fn(usize),
    ) -> Result<Vec<LocalTrack>> {
        *self
            .tracks
            .write()
            .map_err(|_| Error::io("track list is locked"))? = tracks.clone();
        self.scanned
            .store(true, std::sync::atomic::Ordering::Relaxed);
        progress(tracks.len());
        if let Ok(text) = serde_json::to_string(&tracks) {
            let _ = std::fs::write(&self.tracks_path, text);
        }
        Ok(tracks)
    }

    /// True when the path belongs to the scanned library; the media protocol
    /// refuses anything else so the webview cannot read arbitrary files.
    pub fn allows(&self, path: &str) -> bool {
        let wanted = PathBuf::from(path);
        self.tracks
            .read()
            .map(|tracks| {
                tracks
                    .iter()
                    .any(|track| PathBuf::from(&track.path) == wanted)
            })
            .unwrap_or(false)
    }

    /// Embedded artwork written next to the settings as a small cache file.
    pub fn cover(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let Some(track) = self.tracks().into_iter().find(|track| track.id == id) else {
            return Ok(None);
        };
        let cache_path = self.cache_dir.join(format!("{:x}.img", md5ish(&track.id)));
        if let Ok(bytes) = std::fs::read(&cache_path) {
            return Ok(Some(bytes));
        }
        let Some(picture) = read_picture(Path::new(&track.path)) else {
            return Ok(None);
        };
        let _ = std::fs::write(&cache_path, &picture);
        Ok(Some(picture))
    }
}

/// Magic-byte check for the formats an archive cover may arrive in.
fn looks_like_image(bytes: &[u8]) -> bool {
    let jpeg = bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
    let png = bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let gif = bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a");
    let webp = bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP";
    jpeg || png || gif || webp
}

/// Music files under one folder, in walk order.
fn walk_root(root: &str, count: &mut usize, progress: &dyn Fn(usize)) -> Vec<LocalTrack> {
    let mut found = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            let extension = path
                .extension()
                .map(|value| value.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !AUDIO_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            found.push(read_track(&path, root));
            *count += 1;
            if *count % 200 == 0 {
                progress(*count);
            }
        }
    }
    found
}

fn compare_tracks(a: &LocalTrack, b: &LocalTrack) -> std::cmp::Ordering {
    a.artist
        .to_lowercase()
        .cmp(&b.artist.to_lowercase())
        .then(a.album.to_lowercase().cmp(&b.album.to_lowercase()))
        .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
}

fn read_track(path: &Path, root: &str) -> LocalTrack {
    let id = format!("local:{}", path.to_string_lossy());
    let file_stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Без названия".into());

    let mut track = LocalTrack {
        id,
        path: path.to_string_lossy().to_string(),
        title: file_stem.clone(),
        artist: String::new(),
        album: String::new(),
        duration: None,
        has_cover: false,
        root: root.to_string(),
    };

    if let Ok(tagged) = lofty::read_from_path(path) {
        use lofty::prelude::{AudioFile, TaggedFileExt};
        track.duration = tagged.properties().duration().as_secs().try_into().ok();
        track.has_cover = tagged.tags().iter().any(|tag| !tag.pictures().is_empty());

        let mut title = None;
        let mut artist = None;
        let mut album = None;
        for tag in tagged.tags() {
            for item in tag.items() {
                let Some(text) = item.value().text() else {
                    continue;
                };
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }
                let key = item
                    .key()
                    .map_key(tag.tag_type(), false)
                    .unwrap_or_default();
                match key {
                    "TITLE" if title.is_none() => title = Some(text.to_string()),
                    "ARTIST" if artist.is_none() => artist = Some(text.to_string()),
                    "ALBUM" if album.is_none() => album = Some(text.to_string()),
                    _ => {}
                }
            }
        }
        if let Some(value) = title {
            track.title = value;
        }
        if let Some(value) = artist {
            track.artist = value;
        }
        if let Some(value) = album {
            track.album = value;
        }
    }

    if track.artist.is_empty() {
        // "Artist - Title.mp3" is the common untagged naming on disk.
        if let Some((artist, title)) = file_stem.split_once(" - ") {
            track.artist = artist.trim().to_string();
            track.title = title.trim().to_string();
        }
    }
    track
}

fn read_picture(path: &Path) -> Option<Vec<u8>> {
    use lofty::prelude::TaggedFileExt;
    let tagged = lofty::read_from_path(path).ok()?;
    for tag in tagged.tags() {
        if let Some(picture) = tag.pictures().first() {
            return Some(picture.data().to_vec());
        }
    }
    None
}

/// Small stable hash for cache file names; not security sensitive.
fn md5ish(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}
#[cfg(test)]
mod archive_tests {
    use super::*;

    fn temp_library(tag: &str) -> (LocalLibrary, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("ytmusicdt-local-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let library = LocalLibrary::load(root.join("local.json"), root.join("covers"));
        (library, root)
    }

    fn playlist(id: &str, title: &str) -> ArchivedPlaylist {
        ArchivedPlaylist {
            id: id.into(),
            playlist_id: Some(id.into()),
            browse_id: Some(format!("VL{id}")),
            title: title.into(),
            subtitle: "Исполнитель".into(),
            thumbs: vec!["https://example.invalid/cover.jpg".into()],
            archived_at: 1,
        }
    }

    fn favorite(id: &str) -> Favorite {
        Favorite {
            id: format!("yt:{id}"),
            source: "yt".into(),
            video_id: Some(id.into()),
            title: id.into(),
            ..Favorite::default()
        }
    }

    #[test]
    fn sync_merge_preserves_local_files_and_late_toggles() {
        let (library, root) = temp_library("favorites-merge");
        let local = Favorite {
            id: "local:file.flac".into(),
            source: "local".into(),
            local_path: Some("file.flac".into()),
            title: "Local".into(),
            ..Favorite::default()
        };
        library.toggle_favorite(local.clone()).unwrap();
        library.toggle_favorite(favorite("AAAAAAAAAAA")).unwrap();
        let started = library.favorites();
        library.toggle_favorite(favorite("AAAAAAAAAAA")).unwrap();
        library.toggle_favorite(favorite("CCCCCCCCCCC")).unwrap();
        let merged = library
            .merge_synced_favorites(
                &started,
                vec![favorite("AAAAAAAAAAA"), favorite("BBBBBBBBBBB")],
                None,
                "@account",
            )
            .unwrap();
        let ids: std::collections::BTreeSet<String> =
            merged.into_iter().map(|favorite| favorite.id).collect();
        assert!(!ids.contains("yt:AAAAAAAAAAA"));
        assert!(ids.contains("yt:BBBBBBBBBBB"));
        assert!(ids.contains("yt:CCCCCCCCCCC"));
        assert!(ids.contains(&local.id));
        let reloaded = LocalLibrary::load(root.join("local.json"), root.join("covers"));
        assert_eq!(
            reloaded.favorites_account().unwrap().as_deref(),
            Some("@account")
        );
        assert_eq!(reloaded.favorites().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_merge_rejects_changed_owner_and_failed_writes_keep_memory() {
        let (library, root) = temp_library("favorites-failure");
        library.toggle_favorite(favorite("AAAAAAAAAAA")).unwrap();
        let before = library.favorites();
        assert!(library
            .merge_synced_favorites(&before, Vec::new(), Some("@wrong"), "@new")
            .is_err());
        std::fs::create_dir(root.join("local.tmp")).unwrap();
        assert!(library
            .merge_synced_favorites(&before, Vec::new(), None, "@new")
            .is_err());
        assert_eq!(
            library.favorites()[0].video_id.as_deref(),
            Some("AAAAAAAAAAA")
        );
        assert!(library.favorites_account().unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_files_never_become_remote_favorites_even_with_a_video_field() {
        let mut local = favorite("AAAAAAAAAAA");
        local.source = "local".into();
        assert!(youtube_favorite_id(&local).is_none());
        local.source = "yt".into();
        local.local_path = Some("file.flac".into());
        assert!(youtube_favorite_id(&local).is_none());
    }

    #[test]
    fn archive_keeps_newest_first_and_replaces_duplicates() {
        let (library, root) = temp_library("archive");
        library.archive_push(playlist("a", "Первый")).expect("push");
        library.archive_push(playlist("b", "Второй")).expect("push");
        let items = library
            .archive_push(playlist("a", "Первый заново"))
            .expect("push");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].title, "Первый заново");
        assert_eq!(items[1].id, "b");

        let reloaded = LocalLibrary::load(root.join("local.json"), root.join("covers"));
        assert_eq!(
            reloaded.archive().len(),
            2,
            "archive must survive a restart"
        );

        let items = library.archive_remove("a").expect("remove");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "b");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cover_must_be_an_image_and_is_served_back() {
        let (library, root) = temp_library("cover");
        let text = root.join("note.txt");
        std::fs::write(&text, b"not an image").expect("write");
        assert!(library
            .set_archive_cover(text.to_str().expect("path"))
            .is_err());
        assert!(library.archive_cover().is_none());

        let image = root.join("cover.png");
        let png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        std::fs::write(&image, png).expect("write");
        library
            .set_archive_cover(image.to_str().expect("path"))
            .expect("accept png");
        assert_eq!(library.archive_cover().as_deref(), Some(&png[..]));

        library.clear_archive_cover().expect("clear");
        assert!(library.archive_cover().is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
