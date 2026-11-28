//! Matches source tracks, creates a YouTube Music playlist and fills it.

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::task::JoinSet;

use crate::error::{Error, Result};
use crate::spotify::{Spotify, SpotifyPlaylist, SpotifyTrack};
use crate::ytm::api;
use crate::ytm::parse::{MediaItem, SearchResults};
use crate::ytm::Ytm;

/// A candidate below this is not trusted to be the same recording.
const ACCEPT: f64 = 0.72;
/// Two edits of one song can differ by seconds; a minute cannot.
const MAX_DRIFT: f64 = 25.0;
const MATCH_WORKERS: usize = 4;
/// Tracks per `browse/edit_playlist` call. The server takes a whole array, but
/// long arrays are where it starts answering with errors.
const ADD_CHUNK: usize = 25;

#[derive(Clone, Debug, Default)]
pub struct ImportRequest {
    pub request_id: String,
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub privacy: Option<String>,
    pub cover: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub request_id: String,
    /// fetch | match | create | add | cover | done
    pub stage: String,
    pub done: usize,
    pub total: usize,
    pub message: Option<String>,
    pub playlist_id: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedTrack {
    pub title: String,
    pub artists: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub playlist_id: String,
    pub title: String,
    pub total: usize,
    pub added: usize,
    pub unmatched: Vec<UnmatchedTrack>,
    pub cover: bool,
    pub cover_error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifySyncReport {
    pub total: usize,
    pub present: usize,
    pub added: usize,
    pub repeats: usize,
    pub missing: Vec<UnmatchedTrack>,
    pub unmatched: Vec<UnmatchedTrack>,
}

fn compare_tracks(
    source: &[SpotifyTrack],
    matches: &[Option<MediaItem>],
    destination: &BTreeSet<&str>,
) -> (SpotifySyncReport, Vec<String>) {
    let mut report = SpotifySyncReport { total: source.len(), ..Default::default() };
    let mut to_add = Vec::new();
    let mut seen = BTreeSet::new();
    for (track, result) in source.iter().zip(matches) {
        let label = || UnmatchedTrack { title: track.title.clone(), artists: track.artists.clone() };
        match result.as_ref().and_then(|item| item.video_id.as_deref()) {
            None => report.unmatched.push(label()),
            Some(id) if !seen.insert(id) => report.repeats += 1,
            Some(id) if destination.contains(id) => report.present += 1,
            Some(id) => {
                report.missing.push(label());
                to_add.push(id.to_owned());
            }
        }
    }
    (report, to_add)
}

/// Compare against the current contents of the selected destination, including all pages.
pub async fn reconcile(
    spotify: &Spotify,
    account: &Ytm,
    source: &str,
    playlist_id: &str,
    repair: bool,
    request_id: &str,
    progress: impl Fn(ImportProgress),
) -> Result<SpotifySyncReport> {
    let job = RunningImport::start(request_id)?;
    let revision = account.session_revision();
    let ytm = Arc::new(account.authenticated_snapshot().await?);
    let target = playlist_id.strip_prefix("VL").unwrap_or(playlist_id);
    if target == "LM" {
        return Err(Error::api("Выберите плейлист, в который переносили треки из Spotify"));
    }
    let progress = |mut update: ImportProgress| {
        update.request_id = request_id.to_owned();
        progress(update);
    };
    progress(ImportProgress { stage: "fetch".into(), ..Default::default() });
    let playlist = if source == "liked" {
        job.read(spotify.liked()).await?
    } else {
        job.read(spotify.playlist(source)).await?
    };
    let existing = job.read(crate::favorites_sync::playlist_members(&ytm, target)).await?;
    let matches = match_tracks(ytm.clone(), &playlist.tracks, &existing, &job, &progress).await?;
    let ids = existing.iter().filter_map(|item| item.video_id.as_deref()).collect();
    let (report, missing) = compare_tracks(&playlist.tracks, &matches, &ids);
    if !repair || missing.is_empty() {
        let _guard = account.session_guard(revision).await?;
        return Ok(report);
    }
    let mut submitted = 0;
    for chunk in missing.chunks(ADD_CHUNK) {
        job.check(Some((target, submitted)))?;
        let _guard = account.session_guard(revision).await?;
        api::add_tracks(&ytm, target, chunk).await?;
        submitted += chunk.len();
        progress(ImportProgress {
            stage: "add".into(), done: submitted, total: missing.len(),
            playlist_id: Some(target.to_owned()), ..Default::default()
        });
    }
    // An accepted edit can be only partly visible. Count only entries read back from YouTube.
    let confirmed = crate::favorites_sync::playlist_members(&ytm, target).await?;
    let ids = confirmed.iter().filter_map(|item| item.video_id.as_deref()).collect();
    let (mut verified, _) = compare_tracks(&playlist.tracks, &matches, &ids);
    let _guard = account.session_guard(revision).await?;
    verified.added = missing.iter().filter(|id| ids.contains(id.as_str())).count();
    Ok(verified)
}

static ACTIVE: Mutex<Option<Arc<ImportJob>>> = Mutex::new(None);

struct ImportJob {
    id: String,
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

pub(crate) struct RunningImport(Arc<ImportJob>);

impl RunningImport {
    pub(crate) fn start(id: &str) -> Result<Self> {
        if id.is_empty() || id.len() > 128 {
            return Err(Error::api("Некорректный идентификатор импорта"));
        }
        let mut active = ACTIVE.lock().map_err(|_| Error::api("Импорт недоступен"))?;
        if active.is_some() {
            return Err(Error::api("Другой импорт ещё выполняется"));
        }
        let job = Arc::new(ImportJob {
            id: id.to_string(),
            cancelled: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        });
        *active = Some(job.clone());
        Ok(Self(job))
    }

    pub(crate) fn check(&self, playlist: Option<(&str, usize)>) -> Result<()> {
        if !self.0.cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        Err(Error::api(match playlist {
            Some((id, added)) => {
                format!("Импорт остановлен. Плейлист {id} сохранён: добавлено {added} треков.")
            }
            None => "Импорт отменён. Плейлист не создавался.".into(),
        }))
    }

    async fn read<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        self.check(None)?;
        tokio::select! {
            biased;
            _ = self.0.notify.notified() => {
                self.check(None)?;
                Err(Error::api("Импорт отменён"))
            }
            value = future => value,
        }
    }
}

impl Drop for RunningImport {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().is_some_and(|job| Arc::ptr_eq(job, &self.0)) {
                *active = None;
            }
        }
    }
}

pub fn cancel(request_id: &str) -> bool {
    let Ok(active) = ACTIVE.lock() else {
        return false;
    };
    let Some(job) = active.as_ref().filter(|job| job.id == request_id) else {
        return false;
    };
    job.cancelled.store(true, Ordering::SeqCst);
    job.notify.notify_one();
    true
}

/// Reads the playlist, matches every track, creates the YouTube Music
/// playlist and fills it. Progress is reported for each stage so the window
/// can show a real count instead of a spinner.
pub async fn import(
    spotify: &Spotify,
    ytm: Arc<Ytm>,
    request: ImportRequest,
    progress: impl Fn(ImportProgress),
) -> Result<ImportReport> {
    let job = RunningImport::start(&request.request_id)?;
    let revision = ytm.session_revision();
    let progress = |mut update: ImportProgress| {
        update.request_id = request.request_id.clone();
        progress(update);
    };
    progress(ImportProgress {
        stage: "fetch".into(),
        ..ImportProgress::default()
    });
    let playlist = job.read(spotify.playlist(&request.url)).await?;
    import_playlist(Some(spotify), ytm, revision, playlist, &request, &job, progress).await
}

/// The same pipeline for a list that has no playlist behind it, such as the
/// account's liked songs.
pub async fn import_liked(
    spotify: &Spotify,
    ytm: Arc<Ytm>,
    request: ImportRequest,
    progress: impl Fn(ImportProgress),
) -> Result<ImportReport> {
    let job = RunningImport::start(&request.request_id)?;
    let revision = ytm.session_revision();
    let progress = |mut update: ImportProgress| {
        update.request_id = request.request_id.clone();
        progress(update);
    };
    progress(ImportProgress {
        stage: "fetch".into(),
        ..ImportProgress::default()
    });
    let playlist = job.read(spotify.liked()).await?;
    import_playlist(Some(spotify), ytm, revision, playlist, &request, &job, progress).await
}

pub(crate) async fn import_metadata(
    ytm: Arc<Ytm>,
    name: String,
    tracks: Vec<SpotifyTrack>,
    job: &RunningImport,
    progress: impl Fn(ImportProgress),
) -> Result<ImportReport> {
    let playlist = SpotifyPlaylist {
        name,
        tracks,
        ..SpotifyPlaylist::default()
    };
    import_playlist(
        None,
        ytm.clone(),
        ytm.session_revision(),
        playlist,
        &ImportRequest::default(),
        job,
        progress,
    )
    .await
}

async fn import_playlist(
    spotify: Option<&Spotify>,
    ytm: Arc<Ytm>,
    revision: u64,
    playlist: SpotifyPlaylist,
    request: &ImportRequest,
    job: &RunningImport,
    progress: impl Fn(ImportProgress),
) -> Result<ImportReport> {
    let total = playlist.tracks.len();
    if total == 0 {
        return Err(Error::api("Не нашлось треков для импорта"));
    }
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы импортировать плейлист".into(),
        ));
    }

    let account = ytm;
    let ytm = Arc::new(account.authenticated_snapshot().await?);
    drop(account.session_guard(revision).await?);
    let results = match_tracks(ytm.clone(), &playlist.tracks, &[], job, &progress).await?;

    let mut seen = BTreeSet::new();
    let video_ids: Vec<String> = results
        .iter()
        .flatten()
        .filter_map(|item| item.video_id.clone())
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if video_ids.is_empty() {
        return Err(Error::api(
            "Надёжных совпадений на YouTube Music не нашлось. Плейлист не создавался.",
        ));
    }
    let unmatched: Vec<UnmatchedTrack> = results
        .iter()
        .enumerate()
        .filter(|(_, item)| item.is_none())
        .map(|(index, _)| UnmatchedTrack {
            title: playlist.tracks[index].title.clone(),
            artists: playlist.tracks[index].artists.clone(),
        })
        .collect();

    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&playlist.name)
        .to_string();
    let description = compose_description(&playlist, request);
    let privacy = request
        .privacy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("PRIVATE");
    if !["PRIVATE", "PUBLIC", "UNLISTED"].contains(&privacy) {
        return Err(Error::api("Неизвестная видимость плейлиста"));
    }

    job.check(None)?;
    progress(ImportProgress {
        stage: "create".into(),
        total,
        ..ImportProgress::default()
    });
    let guard = account.session_guard(revision).await?;
    let playlist_id = api::create_playlist_full(&ytm, &title, &description, privacy, &[])
        .await.map_err(|error| match error {
            Error::Auth(_) => error,
            _ => Error::api(format!("Не удалось подтвердить создание плейлиста: {error}. Он мог создаться на сервере — проверьте библиотеку перед повтором.")),
        })?;

    drop(guard);

    let mut added = 0;
    progress(ImportProgress {
        stage: "add".into(),
        total: video_ids.len(),
        playlist_id: Some(playlist_id.clone()),
        ..ImportProgress::default()
    });
    for chunk in video_ids.chunks(ADD_CHUNK) {
        job.check(Some((&playlist_id, added)))?;
        let guard = account.session_guard(revision).await?;
        if let Err(error) = api::add_tracks(&ytm, &playlist_id, chunk).await {
            return Err(Error::api(format!(
                "Импорт прерван: {error}. Плейлист {playlist_id} сохранён; подтверждено {added} треков. Последняя порция могла добавиться — проверьте плейлист перед повтором."
            )));
        }
        drop(guard);
        added += chunk.len();
        progress(ImportProgress {
            stage: "add".into(),
            done: added,
            total: video_ids.len(),
            playlist_id: Some(playlist_id.clone()),
            ..ImportProgress::default()
        });
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let mut cover = false;
    let mut cover_error = None;
    job.check(Some((&playlist_id, added)))?;
    if let Some(spotify) = spotify.filter(|_| request.cover) {
        progress(ImportProgress {
            stage: "cover".into(),
            total,
            playlist_id: Some(playlist_id.clone()),
            ..ImportProgress::default()
        });
        match &playlist.cover {
            Some(url) => match spotify.cover(url).await {
                Ok(image) => {
                    job.check(Some((&playlist_id, added)))?;
                    let _guard = account.session_guard(revision).await?;
                    match ytm.set_playlist_cover(&playlist_id, &image).await {
                        Ok(()) => cover = true,
                        // The playlist is already usable, so a cover failure is
                        // reported rather than thrown away.
                        Err(error) => cover_error = Some(error.to_string()),
                    }
                }
                Err(error) => cover_error = Some(error.to_string()),
            },
            None => cover_error = Some("У плейлиста Spotify нет обложки".into()),
        }
    }

    job.check(Some((&playlist_id, added)))?;

    progress(ImportProgress {
        stage: "done".into(),
        done: total,
        total,
        playlist_id: Some(playlist_id.clone()),
        ..ImportProgress::default()
    });

    Ok(ImportReport {
        playlist_id,
        title,
        total,
        added,
        unmatched,
        cover,
        cover_error,
    })
}

async fn match_tracks(
    ytm: Arc<Ytm>,
    tracks: &[SpotifyTrack],
    existing: &[MediaItem],
    job: &RunningImport,
    progress: &impl Fn(ImportProgress),
) -> Result<Vec<Option<MediaItem>>> {
    let total = tracks.len();
    progress(ImportProgress {
        stage: "match".into(),
        total,
        ..ImportProgress::default()
    });
    let mut results: Vec<Option<MediaItem>> = vec![None; total];
    let mut set: JoinSet<(usize, Result<Option<MediaItem>>)> = JoinSet::new();
    let mut next = 0;
    let mut done = 0;
    let mut by_title: HashMap<String, Vec<&MediaItem>> = HashMap::new();
    for item in existing {
        by_title.entry(normalize(&item.title)).or_default().push(item);
    }
    while next < total || !set.is_empty() {
        while next < total && set.len() < MATCH_WORKERS {
            let index = next;
            let track = &tracks[index];
            next += 1;
            if track.artists.is_empty() || track.title.trim().is_empty() {
                done += 1;
                continue;
            }
            if let Some(item) = by_title.get(&normalize(&track.title)).and_then(|candidates| {
                let items = candidates.iter().copied()
                    .filter(|item| item.video_id.as_deref().is_some_and(crate::ytm::parse::valid_video_id));
                if track.seconds.is_none() { return exact_song_without_duration(items, track); }
                items
                    .map(|item| (score(track, item), item))
                    .filter(|(score, _)| *score >= ACCEPT)
                    .max_by(|a, b| a.0.total_cmp(&b.0))
                    .map(|(_, item)| item)
            }) {
                results[index] = Some(item.clone());
                done += 1;
                continue;
            }
            let track = track.clone();
            let ytm = ytm.clone();
            set.spawn(async move {
                (
                    index,
                    match_track(&ytm, &track).await,
                )
            });
        }
        if set.is_empty() {
            job.check(None)?;
            progress(ImportProgress { stage: "match".into(), done, total, ..Default::default() });
            break;
        }
        let joined = job.read(async { Ok(set.join_next().await) }).await?;
        if let Some(joined) = joined {
            let (index, matched) = joined.map_err(|error| {
                crate::error::Error::api(format!("Сопоставление прервалось: {error}"))
            })?;
            results[index] = matched?;
            done += 1;
            progress(ImportProgress {
                stage: "match".into(),
                done,
                total,
                ..ImportProgress::default()
            });
        }
    }

    Ok(results)
}

fn compose_description(playlist: &SpotifyPlaylist, request: &ImportRequest) -> String {
    let mut parts: Vec<String> = Vec::new();
    let own = request.description.as_deref().map(str::trim).unwrap_or("");
    let source = if own.is_empty() {
        playlist.description.trim()
    } else {
        own
    };
    if !source.is_empty() {
        parts.push(source.chars().take(1800).collect());
    }
    if playlist.id == "liked" {
        parts.push("Импортировано из Spotify: https://open.spotify.com/collection/tracks".into());
    } else if let Ok(id) = crate::spotify::parse_playlist_id(&request.url) {
        parts.push(format!("Импортировано из Spotify: https://open.spotify.com/playlist/{id}"));
    }
    parts.join("\n\n")
}

async fn match_track(
    ytm: &Ytm,
    track: &SpotifyTrack,
) -> Result<Option<MediaItem>> {
    let query = search_query(track);
    let songs = search(ytm, &query, Some("songs")).await?;
    if track.seconds.is_none() {
        return Ok(exact_song_without_duration(songs.top.iter().chain(&songs.items), track).cloned());
    }
    if let Some((score, item)) = best(&songs, track) {
        if score >= ACCEPT {
            return Ok(Some(item));
        }
    }
    Ok(best(&search(ytm, &query, None).await?, track)
        .filter(|(score, _)| *score >= ACCEPT)
        .map(|(_, item)| item))
}

fn exact_song_without_duration<'a>(items: impl Iterator<Item = &'a MediaItem>, track: &SpotifyTrack) -> Option<&'a MediaItem> {
    let title = artist_name(&track.title);
    let artists: Vec<_> = track.artists.iter().map(|name| artist_name(name)).collect();
    if title.is_empty() || artists.is_empty() || artists.iter().any(String::is_empty) {
        return None;
    }
    let mut matches = items.filter(|item| {
        item.kind == "song"
            && item.video_id.as_ref().is_some_and(|id| !id.is_empty())
            && artist_name(&item.title) == title
            && item
                .artists
                .iter()
                .map(|artist| artist_name(&artist.name))
                .eq(artists.iter().cloned())
    });
    let first = matches.next()?;
    let duration = first.duration.as_deref().and_then(parse_duration)?;
    if matches.any(|item| {
        item.duration
            .as_deref()
            .and_then(parse_duration)
            .is_none_or(|seconds| duration.abs_diff(seconds) > 5)
    }) {
        return None;
    }
    Some(first)
}

/// A throttled or dropped search would otherwise read as "this track is not on
/// YouTube Music", so a failed query is retried before it is written off.
async fn search(ytm: &Ytm, query: &str, filter: Option<&str>) -> Result<SearchResults> {
    for attempt in 0..3 {
        match api::search(ytm, query, filter).await {
            Ok(results) => return Ok(results),
            Err(error @ Error::Auth(_)) => return Err(error),
            Err(_) if attempt < 2 => {
                tokio::time::sleep(Duration::from_millis(400 * (attempt + 1) as u64)).await;
            }
            Err(error) => {
                return Err(Error::api(format!(
                "Поиск YouTube Music недоступен: {error}. Повторите попытку."
            )))
            }
        }
    }
    Err(Error::api("Поиск YouTube Music недоступен"))
}

fn best(results: &SearchResults, track: &SpotifyTrack) -> Option<(f64, MediaItem)> {
    results
        .top
        .iter()
        .chain(results.items.iter())
        .filter(|candidate| candidate.video_id.as_ref().is_some_and(|id| !id.is_empty()))
        .map(|candidate| (score(track, candidate), candidate.clone()))
        .max_by(|left, right| {
            left.0
                .partial_cmp(&right.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

pub fn score(track: &SpotifyTrack, candidate: &MediaItem) -> f64 {
    if !matches!(candidate.kind.as_str(), "song" | "video")
        || recording_versions(&track.title) != recording_versions(&candidate.title)
    {
        return 0.0;
    }
    let title = title_score(&normalize(&track.title), &normalize(&candidate.title));
    if title < 0.80 {
        return 0.0;
    }
    let wanted: BTreeSet<String> = track
        .artists
        .iter()
        .map(|name| artist_name(name))
        .filter(|name| !name.is_empty())
        .collect();
    let offered: BTreeSet<String> = candidate
        .artists
        .iter()
        .map(|artist| artist_name(&artist.name))
        .filter(|name| !name.is_empty())
        .collect();
    let lead = track
        .artists
        .first()
        .map(|name| artist_name(name))
        .unwrap_or_default();
    if lead.is_empty() || !offered.contains(&lead) {
        return 0.0;
    }
    let overlap = if wanted.is_empty() || offered.is_empty() {
        0.0
    } else {
        wanted.intersection(&offered).count() as f64 / wanted.len().min(offered.len()) as f64
    };
    let drift = match (
        track.seconds,
        candidate.duration.as_deref().and_then(parse_duration),
    ) {
        (Some(wanted), Some(offered)) => (wanted as f64 - offered as f64).abs(),
        _ => return 0.0,
    };
    if drift > MAX_DRIFT {
        return 0.0;
    }
    let duration = (1.0 - drift / MAX_DRIFT).max(0.0);
    0.45 * title + 0.30 * overlap + 0.25 * duration
}

fn artist_name(text: &str) -> String {
    text.to_lowercase()
        .split(|symbol: char| !symbol.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn recording_versions(text: &str) -> BTreeSet<String> {
    let markers = [
        "live",
        "remix",
        "mix",
        "acoustic",
        "instrumental",
        "karaoke",
        "cover",
        "sped",
        "slowed",
        "nightcore",
        "reverb",
        "demo",
        "radio",
        "edit",
        "mono",
        "stereo",
        "version",
        "extended",
        "dub",
        "club",
        "unplugged",
        "orchestral",
        "orchestra",
        "rerecorded",
    ];
    let mut versions: BTreeSet<String> = artist_name(text)
        .split_whitespace()
        .filter(|word| markers.contains(word))
        .map(str::to_string)
        .collect();
    for qualifier in text.replace(" - ", "(").split(['(', '[', ')', ']']).skip(1) {
        let qualifier = artist_name(qualifier);
        if qualifier
            .split_whitespace()
            .any(|word| markers.contains(&word))
        {
            versions.extend(qualifier.split_whitespace().map(str::to_string));
        }
    }
    versions
}

fn title_score(left: &str, right: &str) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let letters = 1.0
        - levenshtein(left, right) as f64 / left.chars().count().max(right.chars().count()) as f64;
    let tokens_left: BTreeSet<&str> = left.split_whitespace().collect();
    let tokens_right: BTreeSet<&str> = right.split_whitespace().collect();
    let shared = tokens_left.intersection(&tokens_right).count() as f64;
    let union = tokens_left.union(&tokens_right).count() as f64;
    let tokens = if union == 0.0 { 0.0 } else { shared / union };
    0.5 * letters.max(0.0) + 0.5 * tokens
}

/// Lowercase, drop bracketed asides and version suffixes, keep letters.
pub fn normalize(text: &str) -> String {
    let lowered = text.to_lowercase().replace('\u{a0}', " ");
    let mut flat = String::with_capacity(lowered.len());
    let mut depth = 0usize;
    let mut aside = String::new();
    for symbol in lowered.chars() {
        match symbol {
            '(' | '[' => {
                if depth == 0 {
                    aside.clear();
                }
                depth += 1;
            }
            ')' | ']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let words = artist_name(&aside);
                    if !["feat ", "ft ", "featuring ", "with ", "from ", "official "]
                        .iter()
                        .any(|prefix| words.starts_with(prefix))
                        && !words.contains("remaster")
                    {
                        flat.push(' ');
                        flat.push_str(&aside);
                        flat.push(' ');
                    }
                }
            }
            _ if depth == 0 => flat.push(symbol),
            _ => aside.push(symbol),
        }
    }
    let flat = match flat.split_once(" - ") {
        Some((head, tail)) if tail.contains("remaster") => head.to_string(),
        _ => flat,
    };
    let words: Vec<&str> = flat
        .split(|symbol: char| !symbol.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    words.join(" ")
}

/// The query a person would type: credited artists, then the title without
/// its version suffix.
fn search_query(track: &SpotifyTrack) -> String {
    let title = match track.title.split_once(" - ") {
        Some((head, tail))
            if artist_name(tail)
                .split_whitespace()
                .any(|word| matches!(word, "remaster" | "remastered"))
                || artist_name(tail) == "radio edit" =>
        {
            head.to_string()
        }
        _ => track.title.clone(),
    };
    let artists = track.artists.first().cloned().unwrap_or_default();
    format!("{} {}", artists, title).trim().to_string()
}

fn parse_duration(text: &str) -> Option<u32> {
    let parts: Vec<&str> = text.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0u32;
    for (index, part) in parts.iter().enumerate() {
        let part = part.trim();
        if part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        let value: u32 = part.parse().ok()?;
        if index > 0 && (value >= 60 || part.len() != 2) {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(value)?;
    }
    (seconds > 0).then_some(seconds)
}

fn levenshtein(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    let mut current = vec![0usize; right.len() + 1];
    for (row, letter) in left.iter().enumerate() {
        current[0] = row + 1;
        for (column, other) in right.iter().enumerate() {
            let cost = usize::from(letter != other);
            current[column + 1] = (current[column] + 1)
                .min(previous[column + 1] + 1)
                .min(previous[column] + cost);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ytm::parse::ItemRef;

    fn track(title: &str, artist: &str, seconds: u32) -> SpotifyTrack {
        SpotifyTrack {
            title: title.into(),
            artists: vec![artist.into()],
            seconds: Some(seconds),
        }
    }

    fn candidate(title: &str, artist: &str, duration: &str) -> MediaItem {
        MediaItem {
            kind: "song".into(),
            title: title.into(),
            video_id: Some("video".into()),
            duration: Some(duration.into()),
            artists: vec![ItemRef {
                name: artist.into(),
                browse_id: String::new(),
            }],
            ..MediaItem::default()
        }
    }

    #[test]
    fn checking_and_repair_only_count_distinct_confirmed_tracks() {
        let source = vec![track("Here", "Artist", 80), track("Missing", "Artist", 90),
            track("Repeat", "Artist", 80), track("Rare", "Artist", 100)];
        let matched = |id: &str| Some(MediaItem { video_id: Some(id.into()), ..MediaItem::default() });
        let matches = vec![matched("AAAAAAAAAAA"), matched("BBBBBBBBBBB"), matched("AAAAAAAAAAA"), None];
        let (first, missing) = compare_tracks(&source, &matches, &BTreeSet::from(["AAAAAAAAAAA"]));
        assert_eq!((first.total, first.present, first.repeats, first.added), (4, 1, 1, 0));
        assert_eq!(missing, ["BBBBBBBBBBB"]);
        assert_eq!(first.missing[0].title, "Missing");
        assert_eq!(first.unmatched[0].title, "Rare");
        let (second, missing) = compare_tracks(&source, &matches, &BTreeSet::from(["AAAAAAAAAAA", "BBBBBBBBBBB"]));
        assert_eq!((second.present, second.repeats, second.unmatched.len()), (2, 1, 1));
        assert!(missing.is_empty());
    }

    #[test]
    fn normalization_drops_versions_and_asides() {
        assert_eq!(
            normalize("Hungry Like the Wolf - 2009 Remaster"),
            "hungry like the wolf"
        );
        assert_eq!(
            normalize("Get Lucky (feat. Pharrell Williams)"),
            "get lucky"
        );
        assert_eq!(
            normalize("Flower In A Hurricane [From GTAVI: Original Score] (feat. SZA)"),
            "flower in a hurricane"
        );
        assert_eq!(normalize("Группа крови"), "группа крови");
    }

    #[test]
    fn durations_come_out_as_seconds() {
        assert_eq!(parse_duration("3:45"), Some(225));
        assert_eq!(parse_duration("1:02:41"), Some(3761));
        assert_eq!(parse_duration("—"), None);
    }

    #[test]
    fn a_right_match_scores_high_and_a_wrong_one_scores_low() {
        let wanted = track("Thriller - 2001 Remaster", "Michael Jackson", 358);
        let right = candidate("Thriller", "Michael Jackson", "5:58");
        let wrong = candidate("Thriller (Cover)", "Simon Servida", "1:44");
        assert!(score(&wanted, &right) > 0.9, "{}", score(&wanted, &right));
        assert!(score(&wanted, &wrong) < 0.4, "{}", score(&wanted, &wrong));
    }

    #[test]
    fn a_track_of_the_wrong_length_never_matches() {
        let wanted = track("Get Lucky", "Daft Punk", 240);
        let long = candidate("Get Lucky", "Daft Punk", "6:10");
        assert_eq!(score(&wanted, &long), 0.0);
    }

    #[test]
    fn durationless_metadata_needs_an_exact_and_unambiguous_song() {
        let mut wanted = track("Песня", "Исполнитель", 0);
        wanted.seconds = None;
        let mut results = SearchResults {
            top: None,
            items: vec![
                candidate("Песня (Live)", "Исполнитель", "4:00"),
                candidate("Песня", "Другой исполнитель", "4:00"),
                candidate("Песня", "Исполнитель", "4:00"),
            ],
            continuation: None,
        };
        assert!(exact_song_without_duration(results.top.iter().chain(&results.items), &wanted).is_some());
        assert_eq!(score(&wanted, &results.items[2]), 0.0);
        results
            .items
            .push(candidate("Песня", "Исполнитель", "5:00"));
        assert!(exact_song_without_duration(results.top.iter().chain(&results.items), &wanted).is_none());
    }

    #[test]
    fn an_identical_title_and_length_cannot_override_the_artist() {
        let wanted = track("Thriller", "Michael Jackson", 358);
        assert_eq!(
            score(&wanted, &candidate("Thriller", "Someone Else", "5:58")),
            0.0
        );
        let mut featured = wanted.clone();
        featured.artists.push("Someone Else".into());
        assert_eq!(
            score(&featured, &candidate("Thriller", "Someone Else", "5:58")),
            0.0
        );
    }

    #[test]
    fn artist_and_duration_cannot_override_the_title() {
        let wanted = track("One", "Metallica", 400);
        assert_eq!(
            score(
                &wanted,
                &candidate("Nothing Else Matters", "Metallica", "6:40")
            ),
            0.0
        );
    }

    #[test]
    fn recording_versions_and_remix_names_are_not_erased() {
        let wanted = track("Song", "Artist", 240);
        for title in [
            "Song (Live)",
            "Song - Radio Edit",
            "Song (Acoustic)",
            "Song (Remix)",
            "Song (Cover)",
            "Song (Slowed + Reverb)",
        ] {
            assert_eq!(
                score(&wanted, &candidate(title, "Artist", "4:00")),
                0.0,
                "{title}"
            );
        }
        assert_eq!(
            score(
                &track("Song (Alpha Remix)", "Artist", 240),
                &candidate("Song (Beta Remix)", "Artist", "4:00")
            ),
            0.0
        );
        assert_eq!(normalize("Song (Alpha Remix)"), "song alpha remix");
        let long_title = "A Very Long And Otherwise Identical Song Title";
        assert_eq!(
            score(
                &track(&format!("{long_title} (Alpha Remix)"), "Artist", 240),
                &candidate(&format!("{long_title} (Beta Remix)"), "Artist", "4:00")
            ),
            0.0
        );
        assert!(
            score(
                &track("Song (Alpha Remix)", "Artist", 240),
                &candidate("Song - Alpha Remix", "Artist", "4:00")
            ) >= ACCEPT
        );
    }

    #[test]
    fn missing_or_malformed_duration_cannot_match() {
        let wanted = track("Song", "Artist", 240);
        assert_eq!(score(&wanted, &candidate("Song", "Artist", "—")), 0.0);
        for duration in [
            "3:99",
            "1:60:00",
            "1:2",
            "-1:30",
            "240",
            "1::30",
            "4294967295:00",
        ] {
            assert_eq!(parse_duration(duration), None, "{duration}");
        }
    }

    #[test]
    fn import_jobs_are_exclusive_and_cancellation_is_scoped() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let job = RunningImport::start("job-one").unwrap();
        assert!(RunningImport::start("job-two").is_err());
        assert!(!cancel("job-two"));
        assert!(job.check(None).is_ok());
        assert!(cancel("job-one"));
        assert!(runtime
            .block_on(job.read(std::future::pending::<Result<()>>()))
            .is_err());
        assert!(job
            .check(Some(("created-list", 25)))
            .unwrap_err()
            .to_string()
            .contains("25"));
        drop(job);
        assert!(RunningImport::start("job-two").is_ok());
        let job = RunningImport::start("job-three").unwrap();
        runtime.block_on(async {
            let (result, stopped) =
                tokio::join!(job.read(std::future::pending::<Result<()>>()), async {
                    tokio::task::yield_now().await;
                    cancel("job-three")
                });
            assert!(stopped);
            assert!(result.is_err());
        });
    }

    #[test]
    fn the_search_query_leaves_the_version_out() {
        assert_eq!(
            search_query(&track("Get Lucky - Radio Edit", "Daft Punk", 240)),
            "Daft Punk Get Lucky"
        );
    }

    /// The matching half against the live site, on two well-known tracks.
    #[test]
    #[ignore = "reads music.youtube.com"]
    fn matches_live_tracks() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let ytm = Arc::new(Ytm::new(
            reqwest::Client::new(),
            std::env::temp_dir().join("none.json"),
        ));
        let found = runtime.block_on(match_track(
            &ytm,
            &track("Thriller - 2001 Remaster", "Michael Jackson", 358),
        ));
        let found = found.expect("search").expect("match");
        assert!(found.title.to_lowercase().contains("thriller"));
    }
}
