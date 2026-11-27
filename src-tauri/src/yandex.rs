use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::import::{self, ImportProgress, ImportReport, RunningImport};
use crate::spotify::SpotifyTrack;
use crate::ytm::Ytm;

const CATALOG: &str = "https://api.music.yandex.net/tracks";
const MAX_FILES: usize = 20;
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_COLLECTIONS: usize = 100;
const MAX_TRACKS: usize = 20_000;
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
const CATALOG_BATCH: usize = 100;
const LIKED: &str = "Мне нравится — Яндекс Музыка";
const LIBRARY: &str = "Коллекция — Яндекс Музыка";

#[derive(Deserialize)]
pub struct YandexFile {
    pub name: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct YandexTrack {
    pub title: String,
    pub artists: Vec<String>,
    pub seconds: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct YandexCollection {
    pub id: String,
    pub name: String,
    pub tracks: Vec<YandexTrack>,
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
pub struct YandexPreview {
    pub collections: Vec<YandexCollection>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YandexProgress {
    #[serde(flatten)]
    pub progress: ImportProgress,
    pub collection_name: String,
    pub collection_index: usize,
    pub collection_total: usize,
}

#[derive(Serialize)]
pub struct YandexImportResult {
    pub id: String,
    pub name: String,
    pub skipped: usize,
    pub report: Option<ImportReport>,
    pub error: Option<String>,
}

struct SourceTrack {
    id: Option<String>,
    metadata: Option<YandexTrack>,
}

#[derive(Default)]
struct Source {
    collections: Vec<(String, Vec<Option<SourceTrack>>)>,
    warnings: Vec<String>,
    track_count: usize,
}

pub async fn preview(files: Vec<YandexFile>) -> Result<YandexPreview> {
    let source = parse_files(files)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| Error::api("Не удалось подготовить поиск в каталоге Яндекс Музыки"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    Ok(resolve(source, |ids| async {
        tokio::time::timeout_at(deadline, catalog(&client, ids))
            .await
            .map_err(|_| ())?
    })
    .await)
}

fn parse_files(files: Vec<YandexFile>) -> Result<Source> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(Error::api("Выберите от 1 до 20 файлов JSON"));
    }
    if files.iter().map(|file| file.text.len()).sum::<usize>() > MAX_FILE_BYTES {
        return Err(Error::api("Размер выбранных файлов превышает 16 МБ"));
    }
    let mut source = Source::default();
    for file in files {
        let basename = file.name.rsplit(['/', '\\']).next().unwrap_or_default();
        let filename: String = basename
            .chars()
            .filter(|c| !c.is_control())
            .take(124)
            .collect();
        let lower = filename.to_lowercase();
        if !lower.ends_with(".json")
            || matches!(
                lower.as_str(),
                "history.json" | "usersettings.json" | "wizard.json" | "dislikes.json"
            )
        {
            source
                .warnings
                .push(format!("«{filename}»: не файл коллекции Яндекс Музыки."));
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(file.text.trim_start_matches('\u{feff}'))
        else {
            source
                .warnings
                .push(format!("«{filename}»: не удалось прочитать JSON."));
            continue;
        };
        let fallback = filename.get(..filename.len() - 5).unwrap_or(LIBRARY);
        let before = source.collections.len();
        if let Some(rows) = value.as_array() {
            if lower == "playlists.json" || rows.iter().any(|row| track_rows(row).is_some()) {
                source.playlists(rows)?;
            } else {
                let name = match lower.as_str() {
                    "likes.json" | "liked_tracks.json" | "liked-tracks.json" => LIKED,
                    "library.json" | "tracks.json" => LIBRARY,
                    _ => fallback,
                };
                source.collection(
                    name,
                    rows,
                    !matches!(
                        lower.as_str(),
                        "liked_tracks.json" | "liked-tracks.json" | "library.json" | "tracks.json"
                    ),
                )?;
            }
        } else if value.is_object() {
            if let Some(likes) = value.get("likes").or_else(|| value.get("favorites")) {
                if let Some(rows) = track_rows(likes) {
                    source.collection(LIKED, rows, false)?;
                } else if let Some(rows) = likes.as_array() {
                    source.collection(LIKED, rows, true)?;
                }
            }
            if let Some(rows) = value
                .get("likedTracks")
                .or_else(|| value.get("liked_tracks"))
                .and_then(Value::as_array)
            {
                source.collection(LIKED, rows, false)?;
            }
            let library = value.get("library").unwrap_or(&value);
            if let Some(rows) = track_rows(library) {
                let fallback = if lower == "likes.json" {
                    LIKED
                } else if library != &value
                    || matches!(lower.as_str(), "library.json" | "tracks.json")
                {
                    LIBRARY
                } else {
                    fallback
                };
                source.collection(label(library).unwrap_or(fallback), rows, false)?;
            }
            if let Some(rows) = value
                .get("playlists")
                .or_else(|| library.get("playlists"))
                .and_then(Value::as_array)
            {
                source.playlists(rows)?;
            }
        }
        if source.collections.len() == before {
            source
                .warnings
                .push(format!("«{filename}»: списки треков не найдены."));
        }
    }
    Ok(source)
}

impl Source {
    fn playlists(&mut self, playlists: &[Value]) -> Result<()> {
        for value in playlists {
            let playlist = value.get("playlist").unwrap_or(value);
            let name = label(playlist).unwrap_or("Плейлист Яндекс Музыки");
            if let Some(rows) = track_rows(playlist) {
                self.collection(name, rows, false)?;
            } else if label(playlist).is_some() {
                self.warnings.push(format!(
                    "«{}»: в файле есть название плейлиста, но нет списка треков.",
                    clean(name, 150)
                ));
                if self.warnings.len() == MAX_COLLECTIONS + MAX_FILES {
                    return Err(Error::api("Выбрано слишком много списков для просмотра"));
                }
            }
        }
        Ok(())
    }

    fn collection(&mut self, name: &str, rows: &[Value], mixed_likes: bool) -> Result<()> {
        self.track_count += rows.len();
        if self.collections.len() >= MAX_COLLECTIONS || self.track_count > MAX_TRACKS {
            return Err(Error::api("Выбрано больше 100 списков или 20 000 треков"));
        }
        let mut name = clean(name, 150);
        if name.is_empty() {
            name = LIBRARY.into();
        }
        self.collections.push((
            name,
            rows.iter()
                .map(|row| source_track(row, mixed_likes))
                .collect(),
        ));
        Ok(())
    }
}

fn clean(value: &str, max: usize) -> String {
    value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max)
        .collect()
}

fn label(value: &Value) -> Option<&str> {
    value
        .get("title")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
}

fn track_rows(value: &Value) -> Option<&Vec<Value>> {
    ["tracks", "trackIds", "track_ids", "items"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_array))
}

fn source_track(row: &Value, mixed_likes: bool) -> Option<SourceTrack> {
    if ["liked", "isLiked", "like"]
        .iter()
        .any(|key| row.get(key).and_then(Value::as_bool) == Some(false))
        || row.get("disliked").and_then(Value::as_bool) == Some(true)
        || row
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|action| action.eq_ignore_ascii_case("dislike"))
    {
        return None;
    }
    let kind = ["type", "entityType", "objectType", "object_type", "kind"]
        .iter()
        .find_map(|key| row.get(key).and_then(Value::as_str));
    if kind.is_some_and(|kind| {
        !["track", "song"]
            .iter()
            .any(|song| kind.eq_ignore_ascii_case(song))
    }) {
        return None;
    }
    let track = row
        .get("track")
        .filter(|track| track.is_object())
        .unwrap_or(row);
    let metadata = metadata(track);
    let specified = ["trackId", "track_id"]
        .iter()
        .find_map(|key| row.get(key).and_then(catalog_id));
    let id = specified.or_else(|| {
        (!mixed_likes || kind.is_some() || metadata.is_some() || !std::ptr::eq(track, row))
            .then(|| catalog_id(track.get("id").unwrap_or(track)))
            .flatten()
    });
    (id.is_some() || metadata.is_some()).then_some(SourceTrack { id, metadata })
}

fn catalog_id(value: &Value) -> Option<String> {
    if let Some(number) = value.as_u64() {
        return (number > 0).then(|| number.to_string());
    }
    let text = value.as_str()?.trim();
    let (id, album) = text.split_once(':').unwrap_or((text, ""));
    if id.is_empty()
        || !id.bytes().all(|byte| byte.is_ascii_digit())
        || !album.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    id.parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
}

fn metadata(value: &Value) -> Option<YandexTrack> {
    let mut title = clean(
        label(value).or_else(|| value.get("track").and_then(Value::as_str))?,
        300,
    );
    if let Some(version) = value.get("version").and_then(Value::as_str) {
        let version = clean(version, 100);
        if !version.is_empty() && !title.to_lowercase().contains(&version.to_lowercase()) {
            title = clean(&format!("{title} ({version})"), 300);
        }
    }
    let artists = value.get("artists").or_else(|| value.get("artist"))?;
    let artists: Vec<String> = if let Some(artist) = artists.as_str() {
        vec![clean(artist, 200)]
    } else {
        artists
            .as_array()?
            .iter()
            .take(16)
            .filter_map(|artist| {
                artist
                    .as_str()
                    .or_else(|| artist.get("name").and_then(Value::as_str))
                    .map(|name| clean(name, 200))
            })
            .filter(|name| !name.is_empty())
            .collect()
    };
    if title.is_empty() || artists.first().is_none_or(String::is_empty) {
        return None;
    }
    let seconds = ["durationMs", "duration_ms"]
        .iter()
        .find_map(|key| value.get(key).and_then(Value::as_u64))
        .map(|ms| ms.saturating_add(500) / 1_000)
        .or_else(|| {
            ["seconds", "duration_sec", "durationSeconds", "duration"]
                .iter()
                .find_map(|key| {
                    value.get(key).and_then(|duration| {
                        duration
                            .as_u64()
                            .or_else(|| parse_duration(duration.as_str()?))
                    })
                })
        })
        .filter(|seconds| (1..=86_400).contains(seconds))
        .map(|seconds| seconds as u32);
    Some(YandexTrack {
        title,
        artists,
        seconds,
    })
}

fn parse_duration(value: &str) -> Option<u64> {
    let mut seconds = 0_u64;
    for (index, part) in value.trim().split(':').enumerate() {
        let amount = part.parse::<u64>().ok()?;
        if index > 2 || (index > 0 && amount >= 60) {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(amount)?;
    }
    Some(seconds)
}

async fn resolve<F, Fut>(source: Source, lookup: F) -> YandexPreview
where
    F: Fn(Vec<String>) -> Fut,
    Fut: Future<Output = std::result::Result<BTreeMap<String, YandexTrack>, ()>>,
{
    let mut warnings = source.warnings;
    let needed: Vec<String> = source
        .collections
        .iter()
        .flat_map(|(_, rows)| rows)
        .flatten()
        .filter(|track| {
            track
                .metadata
                .as_ref()
                .is_none_or(|track| track.seconds.is_none())
        })
        .filter_map(|track| track.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut found = BTreeMap::new();
    for ids in needed.chunks(CATALOG_BATCH) {
        match lookup(ids.to_vec()).await {
            Ok(catalog) => found.extend(catalog),
            Err(()) => {
                warnings.push("Каталог Яндекс Музыки не ответил. Часть треков без названия и исполнителя может отсутствовать.".into());
                break;
            }
        }
    }
    let collections = source
        .collections
        .into_iter()
        .enumerate()
        .map(|(index, (name, rows))| {
            let total = rows.len();
            let tracks: Vec<_> = rows
                .into_iter()
                .flatten()
                .filter_map(|row| match row.metadata {
                    Some(track) if track.seconds.is_some() => Some(track),
                    provided => row.id.and_then(|id| found.get(&id).cloned()).or(provided),
                })
                .collect();
            YandexCollection {
                id: format!("collection-{index}"),
                name,
                skipped: total - tracks.len(),
                tracks,
            }
        })
        .collect();
    YandexPreview {
        collections,
        warnings,
    }
}

async fn catalog(
    client: &reqwest::Client,
    ids: Vec<String>,
) -> std::result::Result<BTreeMap<String, YandexTrack>, ()> {
    let mut response = client
        .get(CATALOG)
        .query(&[("track-ids", ids.join(","))])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len() + chunk.len() > MAX_CATALOG_BYTES {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| ())?;
    let tracks = value.get("result").and_then(Value::as_array).ok_or(())?;
    let requested: BTreeSet<_> = ids.iter().map(String::as_str).collect();
    Ok(tracks
        .iter()
        .filter_map(|row| {
            let id = catalog_id(row.get("id")?)?;
            if !requested.contains(id.as_str()) {
                return None;
            }
            Some((id, metadata(row)?))
        })
        .collect())
}

pub async fn import(
    ytm: Arc<Ytm>,
    request_id: String,
    collections: Vec<YandexCollection>,
    progress: impl Fn(YandexProgress),
) -> Result<Vec<YandexImportResult>> {
    let total = collections.len();
    let rows: usize = collections
        .iter()
        .map(|collection| collection.tracks.len())
        .sum();
    let mut ids = BTreeSet::new();
    if total == 0
        || total > MAX_COLLECTIONS
        || rows > MAX_TRACKS
        || collections.iter().any(|collection| {
            collection.name.is_empty()
                || collection.name.chars().count() > 150
                || collection.id.len() > 40
                || !ids.insert(collection.id.as_str())
                || collection.tracks.is_empty()
                || collection.tracks.iter().any(|track| {
                    track.title.is_empty()
                        || track.title.chars().count() > 300
                        || track.artists.is_empty()
                        || track.artists.len() > 16
                        || track
                            .artists
                            .iter()
                            .any(|artist| artist.is_empty() || artist.chars().count() > 200)
                        || track
                            .seconds
                            .is_some_and(|seconds| !(1..=86_400).contains(&seconds))
                })
        })
    {
        return Err(Error::api(
            "Некорректные данные списков. Проверьте файлы ещё раз.",
        ));
    }
    let job = RunningImport::start(&request_id)?;
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы импортировать плейлисты".into(),
        ));
    }
    let mut results = Vec::with_capacity(total);
    let mut auth_lost = false;
    for (index, collection) in collections.into_iter().enumerate() {
        let YandexCollection {
            id,
            name,
            tracks,
            skipped,
        } = collection;
        let result = if job.check(None).is_err() {
            Err(Error::api("Список не импортирован: импорт остановлен."))
        } else if auth_lost {
            Err(Error::api(
                "Список не импортирован: требуется вход в YouTube Music.",
            ))
        } else {
            let tracks = tracks
                .into_iter()
                .map(|track| SpotifyTrack {
                    title: track.title,
                    artists: track.artists,
                    seconds: track.seconds,
                })
                .collect();
            import::import_metadata(ytm.clone(), name.clone(), tracks, &job, |mut update| {
                update.request_id = request_id.clone();
                progress(YandexProgress {
                    progress: update,
                    collection_name: name.clone(),
                    collection_index: index + 1,
                    collection_total: total,
                });
            })
            .await
        };
        let (report, error) = match result {
            Ok(report) => (Some(report), None),
            Err(error) => {
                auth_lost |= matches!(&error, Error::Auth(_));
                (None, Some(error.to_string()))
            }
        };
        results.push(YandexImportResult {
            id,
            name,
            skipped,
            report,
            error,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::future::ready;

    fn file(name: &str, text: &str) -> YandexFile {
        YandexFile {
            name: name.into(),
            text: text.into(),
        }
    }

    #[tokio::test]
    async fn archive_tracks_and_owned_playlists_use_one_catalog_lookup() {
        let source = parse_files(vec![
            file("likes.json", r#"[
                {"type":"track","id":"200:4"},
                {"type":"album","id":"990"},
                {"type":"track","id":"100","action":"dislike"},
                {"type":"track","id":"300"},
                {"id":"1234"}
            ]"#),
            file("playlists.json", r#"{
                "playlists": [
                    {"title":"Мои треки", "tracks":[
                        {"track":{"title":"Трек","artists":[{"name":"Группа"}],"durationMs":205001}},
                        {"trackId":200},
                        {"trackId":"https://other.example/1"}
                    ]},
                    {"title":"Нет списка","id":9}
                ]
            }"#),
            file("library.json", r#"{"library":{"tracks":[
                {"track":"Twilight","artist":"Artist","duration":"3:40"}
            ]}}"#),
        ]).unwrap();
        let looked_up = RefCell::new(Vec::new());
        let preview = resolve(source, |ids| {
            looked_up.borrow_mut().push(ids);
            ready(Ok(BTreeMap::from([(
                "200".into(),
                YandexTrack {
                    title: "Из каталога".into(),
                    artists: vec!["Исполнитель".into()],
                    seconds: Some(201),
                },
            )])))
        })
        .await;
        assert_eq!(*looked_up.borrow(), vec![vec!["200", "300"]]);
        assert_eq!(preview.collections.len(), 3);
        assert_eq!(preview.collections[0].name, LIKED);
        assert_eq!(preview.collections[0].skipped, 4);
        assert_eq!(preview.collections[1].name, "Мои треки");
        assert_eq!(preview.collections[1].tracks[0].seconds, Some(205));
        assert_eq!(preview.collections[1].tracks[1].title, "Из каталога");
        assert_eq!(preview.collections[1].skipped, 1);
        assert_eq!(preview.collections[2].name, LIBRARY);
        assert_eq!(preview.collections[2].tracks[0].seconds, Some(220));
        assert_eq!(preview.warnings.len(), 1);
        assert!(preview.warnings[0].contains("Нет списка"));
    }

    #[tokio::test]
    async fn offline_preview_keeps_available_metadata_and_reports_skips() {
        let source = parse_files(vec![
            file(
                r"C:\private\likES.json",
                r#"{"tracks":[
                {"artist":"Artist","title":"Song","id":542},
                {"id":681}
            ]}"#,
            ),
            file(r"C:\private\history.json", "[33, 44]"),
            file(r"C:\private\bad.json", "{"),
        ])
        .unwrap();
        let preview = resolve(source, |_| ready(Err(()))).await;
        assert_eq!(preview.warnings.len(), 3);
        assert!(preview
            .warnings
            .iter()
            .all(|message| !message.contains("private")));
        assert_eq!(preview.collections[0].name, LIKED);
        assert_eq!(preview.collections[0].tracks[0].title, "Song");
        assert_eq!(preview.collections[0].skipped, 1);
    }

    #[tokio::test]
    async fn unrelated_numeric_arrays_do_not_become_catalog_requests() {
        let source = parse_files(vec![file("data.json", "[1, 2, 3]")]).unwrap();
        let preview = resolve(source, |_| {
            panic!("untyped IDs in an arbitrary JSON file shouldn't be used as music IDs");
            #[allow(unreachable_code)]
            ready(Err(()))
        })
        .await;
        assert!(preview.collections[0].tracks.is_empty());
        assert_eq!(preview.collections[0].skipped, 3);
    }
}
