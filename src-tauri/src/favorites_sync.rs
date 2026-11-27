use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::local::{youtube_favorite_id, Favorite, LocalLibrary};
use crate::ytm::{api, parse, Ytm};

const TITLE: &str = "Любимые треки";
const MARKER: &str = "[YtMusicDT:favorites:v1]";
const DESCRIPTION: &str = "Любимые треки из приложения VLT Music.\n[YtMusicDT:favorites:v1]";
const CHUNK: usize = 25;

#[derive(Clone, Default, Serialize, Deserialize)]
struct AccountState {
    playlist_id: String,
    baseline: BTreeSet<String>,
    #[serde(default)]
    local: Vec<Favorite>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Store {
    accounts: BTreeMap<String, AccountState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub favorites: Vec<Favorite>,
    pub playlist_id: String,
    pub uploaded: usize,
    pub downloaded: usize,
    pub removed: usize,
}

pub struct FavoritesSync {
    path: PathBuf,
    running: tokio::sync::Mutex<()>,
}

struct RemoteTrack {
    favorite: Favorite,
    set_video_id: Option<String>,
}

struct RemotePlaylist {
    id: String,
    tracks: Vec<RemoteTrack>,
}

impl FavoritesSync {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            running: tokio::sync::Mutex::new(()),
        }
    }

    pub fn playlist_id(&self, handle: &str) -> Result<Option<String>> {
        Ok(self.load()?.accounts.get(handle.trim())
            .map(|account| account.playlist_id.clone())
            .filter(|id| !id.is_empty()))
    }

    fn load(&self) -> Result<Store> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Store::default())
            }
            Err(_) => {
                return Err(Error::io(
                    "Не удалось прочитать состояние синхронизации избранного",
                ))
            }
        };
        serde_json::from_str(&text).map_err(|_| Error::io("Повреждено состояние синхронизации избранного. Синхронизация остановлена без изменения плейлистов."))
    }

    fn save(&self, store: &Store) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(store)
            .map_err(|_| Error::io("Не удалось сохранить состояние избранного"))?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(temporary, &self.path)?;
        Ok(())
    }

    pub async fn sync(
        &self,
        source: &Ytm,
        local: &LocalLibrary,
        expected_handle: &str,
    ) -> Result<SyncReport> {
        let _running = self.running.lock().await;
        let revision = source.session_revision();
        let remote = source.authenticated_snapshot().await?;
        let account = api::account(&remote).await?;
        let handle = account.handle.as_deref().map(str::trim).filter(|handle| !handle.is_empty())
            .ok_or_else(|| Error::api("YouTube Music не вернул идентификатор аккаунта. Избранное не синхронизировано."))?;
        if handle != expected_handle.trim() || expected_handle.trim().is_empty() {
            return Err(Error::Auth(
                "Аккаунт Google изменился. Повторите синхронизацию избранного.".into(),
            ));
        }
        let check = || {
            if source.session_revision() == revision {
                Ok(())
            } else {
                Err(Error::Auth("Аккаунт Google изменился во время синхронизации. Локальное избранное не заменено.".into()))
            }
        };
        check()?;
        let started = local.favorites();
        let owner = local.favorites_account()?;
        let mut store = self.load()?;
        let intent = local_intent(&mut store, handle, owner.as_deref(), &started);
        let baseline = store
            .accounts
            .get(handle)
            .map(|state| state.baseline.clone())
            .unwrap_or_default();
        let saved_id = store
            .accounts
            .get(handle)
            .map(|state| state.playlist_id.clone())
            .filter(|id| !id.is_empty());
        let mut playlist = match saved_id {
            Some(id) => read_playlist(&remote, &id).await?,
            None => match discover(&remote).await? {
                Some(playlist) => playlist,
                None => {
                    check()?;
                    let id = api::create_playlist_full(&remote, TITLE, DESCRIPTION, "PRIVATE", &[]).await
                        .map_err(|error| Error::api(format!("Не удалось подтвердить создание плейлиста избранного: {error}. Проверьте библиотеку перед повтором.")))?;
                    RemotePlaylist {
                        id,
                        tracks: Vec::new(),
                    }
                }
            },
        };
        check()?;
        let playlist_id = playlist.id.clone();
        let account_state = store.accounts.entry(handle.to_string()).or_default();
        account_state.playlist_id = playlist_id.clone();
        account_state.local = intent.clone();
        self.save(&store)?;
        let initial_remote = remote_ids(&playlist.tracks);
        let local_ids = ids(&intent);
        let (additions, deletions) =
            changes(&baseline, &local_ids, &initial_remote, owner.is_some());
        let mut removals = Vec::new();
        for track in &playlist.tracks {
            let id = youtube_favorite_id(&track.favorite)
                .ok_or_else(|| Error::api("Некорректный трек избранного"))?;
            if deletions.contains(id) {
                let occurrence = track.set_video_id.as_ref().filter(|id| !id.is_empty())
                    .ok_or_else(|| Error::api("YouTube Music не вернул идентификатор записи для удаления. Локальное избранное сохранено."))?;
                removals.push((id.to_string(), occurrence.clone()));
            }
        }
        let mut uploaded = 0;
        let mut removed = 0;
        let mut remaining: BTreeMap<String, usize> = BTreeMap::new();
        for (id, _) in &removals {
            *remaining.entry(id.clone()).or_default() += 1;
        }
        for chunk in additions.chunks(CHUNK) {
            check()?;
            api::add_tracks(&remote, &playlist_id, chunk).await?;
            let _session = source.session_guard(revision).await?;
            store
                .accounts
                .get_mut(handle)
                .unwrap()
                .baseline
                .extend(chunk.iter().cloned());
            self.save(&store)?;
            uploaded += chunk.len();
        }
        for chunk in removals.chunks(CHUNK) {
            check()?;
            api::remove_tracks(&remote, &playlist_id, chunk).await?;
            let _session = source.session_guard(revision).await?;
            for (id, _) in chunk {
                let count = remaining.get_mut(id).unwrap();
                *count -= 1;
                if *count == 0 {
                    store.accounts.get_mut(handle).unwrap().baseline.remove(id);
                }
            }
            self.save(&store)?;
            removed += chunk.len();
        }
        if uploaded > 0 || removed > 0 {
            playlist = read_playlist(&remote, &playlist_id).await?;
        }
        check()?;
        let final_remote = remote_ids(&playlist.tracks);
        if additions.iter().any(|id| !final_remote.contains(id))
            || deletions.iter().any(|id| final_remote.contains(id))
        {
            return Err(Error::api("YouTube Music не подтвердил полный результат синхронизации. Локальное избранное сохранено; повторите позже."));
        }
        let downloaded = final_remote.difference(&local_ids).count();
        let mut seen = BTreeSet::new();
        let desired: Vec<Favorite> = playlist
            .tracks
            .into_iter()
            .map(|track| track.favorite)
            .filter(|favorite| seen.insert(favorite.id.clone()))
            .collect();
        let _session = source.session_guard(revision).await?;
        let favorites =
            local.merge_synced_favorites(&started, desired, owner.as_deref(), handle)?;
        let state = store.accounts.get_mut(handle).unwrap();
        state.baseline = final_remote;
        state.local = favorites
            .iter()
            .filter(|favorite| youtube_favorite_id(favorite).is_some())
            .cloned()
            .collect();
        self.save(&store)?;
        Ok(SyncReport {
            favorites,
            playlist_id,
            uploaded,
            downloaded,
            removed,
        })
    }
}

fn changes(
    baseline: &BTreeSet<String>,
    local: &BTreeSet<String>,
    remote: &BTreeSet<String>,
    attached: bool,
) -> (Vec<String>, BTreeSet<String>) {
    let additions = local
        .difference(baseline)
        .filter(|id| !remote.contains(*id))
        .cloned()
        .collect();
    let deletions = if attached {
        baseline.difference(local).cloned().collect()
    } else {
        BTreeSet::new()
    };
    (additions, deletions)
}

fn ids(favorites: &[Favorite]) -> BTreeSet<String> {
    favorites
        .iter()
        .filter_map(youtube_favorite_id)
        .map(str::to_string)
        .collect()
}

fn remote_ids(tracks: &[RemoteTrack]) -> BTreeSet<String> {
    tracks
        .iter()
        .filter_map(|track| youtube_favorite_id(&track.favorite))
        .map(str::to_string)
        .collect()
}

fn local_intent(
    store: &mut Store,
    handle: &str,
    owner: Option<&str>,
    current: &[Favorite],
) -> Vec<Favorite> {
    let youtube: Vec<Favorite> = current
        .iter()
        .filter(|favorite| youtube_favorite_id(favorite).is_some())
        .cloned()
        .collect();
    match owner {
        Some(active) if active != handle => {
            store.accounts.entry(active.to_string()).or_default().local = youtube;
            store
                .accounts
                .get(handle)
                .map(|state| state.local.clone())
                .unwrap_or_default()
        }
        _ => youtube,
    }
}

fn walk(node: &Value, visit: &mut impl FnMut(&Value)) {
    visit(node);
    match node {
        Value::Object(values) => {
            for child in values.values() {
                walk(child, visit);
            }
        }
        Value::Array(values) => {
            for child in values {
                walk(child, visit);
            }
        }
        _ => {}
    }
}

fn tokens(node: &Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    walk(node, &mut |node| {
        for pointer in [
            "/nextContinuationData/continuation",
            "/continuationCommand/token",
        ] {
            if let Some(token) = node
                .pointer(pointer)
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
            {
                found.insert(token.to_string());
            }
        }
    });
    found
}

fn has_renderer(value: &Value, key: &str) -> bool {
    let mut found = false;
    walk(value, &mut |node| {
        if node.get(key).is_some() {
            found = true;
        }
    });
    found
}

fn page_items(value: &Value) -> Vec<parse::MediaItem> {
    let mut rows = Vec::new();
    walk(value, &mut |node| {
        if node.get("musicTwoRowItemRenderer").is_some()
            || node.get("musicResponsiveListItemRenderer").is_some()
        {
            rows.push(node.clone());
        }
    });
    let response = json!({"contents":{"singleColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"gridRenderer":{"items":rows}}]}}}}]}}});
    parse::sections(&response)
        .into_iter()
        .flat_map(|section| section.items)
        .collect()
}

async fn discover(ytm: &Ytm) -> Result<Option<RemotePlaylist>> {
    let mut response = ytm
        .request("browse", json!({"browseId":"FEmusic_liked_playlists"}))
        .await?;
    let mut queue = VecDeque::new();
    let mut visited = BTreeSet::new();
    let mut candidates = BTreeSet::new();
    loop {
        if has_renderer(&response, "signInEndpoint") {
            return Err(Error::Auth(
                "Войдите в Google заново для синхронизации избранного".into(),
            ));
        }
        if ![
            "sectionListRenderer",
            "gridContinuation",
            "musicShelfContinuation",
            "appendContinuationItemsAction",
        ]
        .iter()
        .any(|key| has_renderer(&response, key))
        {
            return Err(Error::api(
                "YouTube Music вернул неизвестный формат библиотеки. Плейлист не создавался.",
            ));
        }
        for item in page_items(&response) {
            if item.title == TITLE {
                if let Some(id) = item.playlist_id.or_else(|| {
                    item.browse_id
                        .and_then(|id| id.strip_prefix("VL").map(str::to_string))
                }) {
                    if id != "LM" {
                        candidates.insert(id);
                    }
                }
            }
        }
        for token in tokens(&response) {
            if !visited.insert(token.clone()) {
                return Err(Error::api(
                    "YouTube Music повторил страницу библиотеки. Плейлист не создавался.",
                ));
            }
            queue.push_back(token);
        }
        let Some(token) = queue.pop_front() else {
            break;
        };
        response = ytm.request("browse", json!({"continuation":token})).await?;
    }
    let mut marked = None;
    for id in candidates {
        let response = ytm
            .request("browse", json!({"browseId":format!("VL{id}")}))
            .await?;
        if is_owned(&response) {
            if marked.is_some() {
                return Err(Error::api("Найдено несколько плейлистов избранного VLT Music. Выберите один, прежде чем продолжить синхронизацию."));
            }
            marked = Some(read_playlist_from(ytm, &id, response).await?);
        }
    }
    Ok(marked)
}

fn is_owned(response: &Value) -> bool {
    let detail = parse::detail(response);
    detail.header.title == TITLE
        && detail
            .header
            .description
            .as_deref()
            .is_some_and(|description| description.lines().any(|line| line.trim() == MARKER))
        && has_renderer(response, "musicEditablePlaylistDetailHeaderRenderer")
}

async fn read_playlist(ytm: &Ytm, id: &str) -> Result<RemotePlaylist> {
    let response = ytm
        .request("browse", json!({"browseId":format!("VL{id}")}))
        .await?;
    read_playlist_from(ytm, id, response).await
}

async fn read_playlist_from(ytm: &Ytm, id: &str, mut response: Value) -> Result<RemotePlaylist> {
    if !is_owned(&response) {
        return Err(Error::api("Плейлист избранного не подтверждён: нужны своё имя, метка приложения и право редактирования. Изменения не выполнялись."));
    }
    let mut tracks = Vec::new();
    let mut visited = BTreeSet::new();
    let mut continuing = false;
    loop {
        let (mut rows, continuation) = playlist_page(&response, continuing)?;
        tracks.append(&mut rows);
        let Some(token) = continuation else {
            break;
        };
        if !visited.insert(token.clone()) {
            return Err(Error::api(
                "YouTube Music повторил страницу избранного. Синхронизация остановлена.",
            ));
        }
        continuing = true;
        response = ytm.request("browse", json!({"continuation":token})).await?;
    }
    Ok(RemotePlaylist {
        id: id.to_string(),
        tracks,
    })
}

fn occurrence_id(row: &Value) -> Option<&str> {
    row.pointer("/playlistItemData/playlistSetVideoId")
        .or_else(|| row.pointer("/playlistItemData/setVideoId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
}

fn playlist_tokens(container: &Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for continuation in container
        .get("continuations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(token) = continuation
            .pointer("/nextContinuationData/continuation")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
        {
            found.insert(token.to_string());
        }
    }
    for entry in container
        .get("contents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(item) = entry.get("continuationItemRenderer") else {
            continue;
        };
        for pointer in [
            "/continuationEndpoint/continuationCommand/token",
            "/button/buttonRenderer/command/continuationCommand/token",
        ] {
            if let Some(token) = item
                .pointer(pointer)
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
            {
                found.insert(token.to_string());
            }
        }
    }
    found
}

fn recommendation_shelf(entry: &Value) -> bool {
    let Some(shelf) = entry.get("musicShelfRenderer") else {
        return false;
    };
    let title = parse::text_of(shelf.get("title").unwrap_or(&Value::Null));
    if ![
        "рекомендации",
        "recommendations",
        "recommended",
        "suggestions",
        "suggested songs",
    ]
    .contains(&title.trim().to_lowercase().as_str())
    {
        return false;
    }
    shelf
        .get("contents")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().all(|entry| {
                entry.get("continuationItemRenderer").is_some()
                    || entry
                        .get("musicResponsiveListItemRenderer")
                        .is_some_and(|row| occurrence_id(row).is_none())
            })
        })
}

fn playlist_page(response: &Value, continuing: bool) -> Result<(Vec<RemoteTrack>, Option<String>)> {
    let section_list = [
        "/continuationContents/sectionListContinuation",
        "/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer",
        "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
    ].iter().find_map(|pointer| response.pointer(pointer));
    if continuing
        && response
            .pointer("/continuationContents/sectionListContinuation")
            .is_some()
    {
        if let Some(contents) = section_list
            .and_then(|list| list.get("contents"))
            .and_then(Value::as_array)
        {
            if contents.iter().any(recommendation_shelf)
                && contents.iter().all(|entry| {
                    recommendation_shelf(entry) || entry.get("continuationItemRenderer").is_some()
                })
            {
                return Ok((Vec::new(), None));
            }
        }
    }
    let mut containers: Vec<(Value, bool)> = Vec::new();
    if let Some(list) = section_list {
        let mut entries: VecDeque<&Value> = list
            .get("contents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .collect();
        while let Some(entry) = entries.pop_front() {
            if let Some(shelf) = entry.get("musicPlaylistShelfRenderer") {
                containers.push((shelf.clone(), false));
            } else if let Some(children) = entry
                .pointer("/itemSectionRenderer/contents")
                .and_then(Value::as_array)
            {
                entries.extend(children);
            } else if entry.get("musicShelfRenderer").is_some() && !recommendation_shelf(entry) {
                return Err(Error::api("YouTube Music вернул неоднозначную секцию избранного. Локальная копия не изменена."));
            }
        }
    }
    for (pointer, generic) in [
        (
            "/continuationContents/musicPlaylistShelfContinuation",
            false,
        ),
        ("/continuationContents/musicShelfContinuation", true),
    ] {
        if let Some(shelf) = response.pointer(pointer) {
            containers.push((shelf.clone(), generic));
        }
    }
    if containers.is_empty() {
        for key in ["onResponseReceivedActions", "onResponseReceivedCommands"] {
            for action in response
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(items) = action
                    .pointer("/appendContinuationItemsAction/continuationItems")
                    .and_then(Value::as_array)
                {
                    containers.push((json!({"contents":items}), true));
                }
            }
        }
    }
    if containers.is_empty() {
        let mut explicitly_empty = false;
        walk(response, &mut |node| {
            if let Some(message) = node.get("messageRenderer") {
                let text = parse::text_of(message.get("text").unwrap_or(&Value::Null));
                if [
                    "This playlist is empty",
                    "There are no songs in this playlist",
                    "No songs in this playlist",
                    "Плейлист пуст",
                    "В этом плейлисте пока нет треков",
                ]
                .iter()
                .any(|known| text.trim().trim_end_matches('.') == *known)
                {
                    explicitly_empty = true;
                }
            }
        });
        if explicitly_empty && is_owned(response) {
            return Ok((Vec::new(), None));
        }
        return Err(Error::api(
            "YouTube Music не вернул полный список избранного. Локальные треки сохранены.",
        ));
    }
    let mut tracks = Vec::new();
    let mut next = BTreeSet::new();
    for (shelf, generic) in containers {
        let contents = shelf
            .get("contents")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::api("YouTube Music изменил формат треков избранного"))?;
        next.extend(playlist_tokens(&shelf));
        for entry in contents {
            if entry.get("continuationItemRenderer").is_some() {
                continue;
            }
            let row = entry.get("musicResponsiveListItemRenderer")
                .ok_or_else(|| Error::api("В плейлисте избранного есть неподдерживаемая запись. Синхронизация остановлена."))?;
            let set_video_id = occurrence_id(row).map(str::to_string);
            if generic && set_video_id.is_none() {
                return Err(Error::api("Продолжение не подтверждает принадлежность треков плейлисту. Локальная копия не изменена."));
            }
            let parsed = parse::continuation_page(
                &json!({"continuationContents":{"musicPlaylistShelfContinuation":{"contents":[entry]}}}),
            );
            let item = parsed
                .items
                .into_iter()
                .next()
                .ok_or_else(|| Error::api("Не удалось прочитать трек избранного"))?;
            let video_id = item.video_id.as_deref()
                .filter(|id| id.len() == 11 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte,b'_'|b'-')))
                .ok_or_else(|| Error::api("В плейлисте избранного есть недоступный трек. Локальная копия не изменена."))?.to_string();
            let duration = item.duration.as_deref().and_then(duration_seconds);
            tracks.push(RemoteTrack {
                favorite: Favorite {
                    id: format!("yt:{video_id}"),
                    source: "yt".into(),
                    video_id: Some(video_id),
                    title: item.title,
                    subtitle: item.subtitle,
                    duration,
                    local_path: None,
                    thumb: item.thumbs.last().cloned(),
                },
                set_video_id,
            });
        }
    }
    if next.is_empty() {
        if let Some(list) = section_list {
            next.extend(playlist_tokens(list));
        }
    }
    if next.len() > 1 {
        return Err(Error::api(
            "YouTube Music вернул неоднозначное продолжение списка избранного",
        ));
    }
    Ok((tracks, next.into_iter().next()))
}

fn duration_seconds(text: &str) -> Option<u32> {
    let mut total = 0u32;
    for part in text.split(':') {
        total = total
            .checked_mul(60)?
            .checked_add(part.trim().parse().ok()?)?;
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn favorite(id: &str) -> Favorite {
        Favorite {
            id: format!("yt:{id}"),
            source: "yt".into(),
            video_id: Some(id.into()),
            title: id.into(),
            ..Favorite::default()
        }
    }

    fn owned(description: &str) -> Value {
        json!({"contents":{"twoColumnBrowseResultsRenderer":{
            "tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{
                "musicEditablePlaylistDetailHeaderRenderer":{"header":{"musicResponsiveHeaderRenderer":{
                    "title":{"runs":[{"text":TITLE}]},"description":{"runs":[{"text":description}]}
                }}}
            }]}}}}],
            "secondaryContents":{"sectionListRenderer":{"contents":[{"musicPlaylistShelfRenderer":{"contents":[]}}]}}
        }}})
    }

    fn row(id: &str, occurrence: &str) -> Value {
        json!({"musicResponsiveListItemRenderer":{
            "playlistItemData":{"videoId":id,"playlistSetVideoId":occurrence},
            "flexColumns":[{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"A song"}]}}}]
        }})
    }

    #[test]
    fn cached_playlist_id_is_account_scoped() {
        let root = std::env::temp_dir().join(format!("ytmusicdt-favorites-id-{}", std::process::id()));
        let sync = FavoritesSync::new(root.join("state.json"));
        let mut store = Store::default();
        store.accounts.insert("@one".into(), AccountState {
            playlist_id: "PLone".into(),
            ..AccountState::default()
        });
        sync.save(&store).unwrap();
        assert_eq!(sync.playlist_id("@one").unwrap().as_deref(), Some("PLone"));
        assert_eq!(sync.playlist_id("@two").unwrap(), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ownership_requires_title_marker_line_and_editable_header() {
        assert!(is_owned(&owned(DESCRIPTION)));
        assert!(!is_owned(&owned("My own favorite songs")));
        assert!(!is_owned(&owned(&format!("User text {MARKER} user text"))));
        let mut foreign = owned(DESCRIPTION);
        let header = foreign.pointer_mut("/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0").unwrap();
        *header = json!({"musicResponsiveHeaderRenderer":{"title":{"runs":[{"text":TITLE}]},"description":{"runs":[{"text":DESCRIPTION}]}}});
        assert!(!is_owned(&foreign));
    }

    #[test]
    fn playlist_pages_keep_occurrence_ids_and_continuations() {
        let mut response = owned(DESCRIPTION);
        let shelf = response.pointer_mut("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents/0/musicPlaylistShelfRenderer").unwrap();
        *shelf = json!({"contents":[row("AAAAAAAAAAA","one"),row("AAAAAAAAAAA","two")],"continuations":[{"nextContinuationData":{"continuation":"page-two"}}]});
        let (tracks, next) = playlist_page(&response, false).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].set_video_id.as_deref(), Some("one"));
        assert_eq!(tracks[1].set_video_id.as_deref(), Some("two"));
        assert_eq!(next.as_deref(), Some("page-two"));
        let continuation = json!({"onResponseReceivedActions":[{"appendContinuationItemsAction":{"continuationItems":[row("BBBBBBBBBBB","three"),{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"page-three"}}}}]}}]});
        assert_eq!(
            playlist_page(&continuation, true).unwrap().1.as_deref(),
            Some("page-three")
        );
    }

    #[test]
    fn empty_and_unknown_pages_are_not_confused() {
        assert!(playlist_page(&owned(DESCRIPTION), false)
            .unwrap()
            .0
            .is_empty());
        assert!(playlist_page(&json!({"error":{"message":"upstream failed"}}), false).is_err());
        let invalid = json!({"continuationContents":{"musicPlaylistShelfContinuation":{"contents":[row("missing", "one")]}}});
        assert!(playlist_page(&invalid, true).is_err());
        let unsupported = json!({"continuationContents":{"musicPlaylistShelfContinuation":{"contents":[{"messageRenderer":{"text":{"simpleText":"unavailable"}}}]}}});
        assert!(playlist_page(&unsupported, true).is_err());
    }

    fn recommendations() -> Value {
        let mut song = row("RRRRRRRRRRR", "unused");
        song.pointer_mut("/musicResponsiveListItemRenderer/playlistItemData")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("playlistSetVideoId");
        json!({"musicShelfRenderer":{
            "title":{"runs":[{"text":"Рекомендации"}]},
            "contents":[song.clone(),song.clone(),song],
            "continuations":[{"nextContinuationData":{"continuation":"more-recommendations"}}]
        }})
    }

    #[test]
    fn recommendations_only_end_a_previously_validated_playlist() {
        let mut initial = owned(DESCRIPTION);
        *initial
            .pointer_mut(
                "/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer",
            )
            .unwrap() = json!({
            "contents":[{"musicPlaylistShelfRenderer":{"contents":[row("AAAAAAAAAAA","one")]}}],
            "continuations":[{"nextContinuationData":{"continuation":"outer-page"}}]
        });
        let (tracks, next) = playlist_page(&initial, false).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(next.as_deref(), Some("outer-page"));
        let follow_up = json!({"continuationContents":{"sectionListContinuation":{
            "contents":[recommendations()],
            "continuations":[{"nextContinuationData":{"continuation":"another-recommendations-page"}}]
        }}});
        let (tracks, next) = playlist_page(&follow_up, true).unwrap();
        assert!(tracks.is_empty());
        assert!(next.is_none());
        assert!(playlist_page(&follow_up, false).is_err());
    }

    #[test]
    fn genuine_outer_playlist_pages_continue_and_menu_tokens_do_not() {
        let mut song = row("AAAAAAAAAAA", "one");
        song["musicResponsiveListItemRenderer"]["menu"] = json!({"items":[
            {"continuationCommand":{"token":"not-pagination"}},row("BBBBBBBBBBB","menu-occurrence")
        ]});
        let page = json!({"continuationContents":{"sectionListContinuation":{
            "contents":[{"musicPlaylistShelfRenderer":{"contents":[song]}}],
            "continuations":[{"nextContinuationData":{"continuation":"real-page-three"}}]
        }}});
        let (tracks, next) = playlist_page(&page, true).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].favorite.video_id.as_deref(), Some("AAAAAAAAAAA"));
        assert_eq!(next.as_deref(), Some("real-page-three"));
        let page = json!({"continuationContents":{"sectionListContinuation":{
            "contents":[{"musicPlaylistShelfRenderer":{"contents":[row("AAAAAAAAAAA","one")]}},recommendations()]
        }}});
        let (tracks, next) = playlist_page(&page, true).unwrap();
        assert_eq!(tracks.len(), 1);
        assert!(
            next.is_none(),
            "recommendation shelf tokens must not be traversed"
        );
    }

    #[test]
    fn generic_pages_require_occurrences_and_ambiguous_pages_fail() {
        let mut song = row("AAAAAAAAAAA", "one");
        song.pointer_mut("/musicResponsiveListItemRenderer/playlistItemData")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("playlistSetVideoId");
        let shelf =
            json!({"continuationContents":{"musicShelfContinuation":{"contents":[song.clone()]}}});
        assert!(playlist_page(&shelf, true).is_err());
        let append = json!({"onResponseReceivedActions":[{"appendContinuationItemsAction":{"continuationItems":[song]}}]});
        assert!(playlist_page(&append, true).is_err());
        let confirmed = json!({"continuationContents":{"musicShelfContinuation":{"contents":[row("AAAAAAAAAAA","one")]}}});
        assert_eq!(playlist_page(&confirmed, true).unwrap().0.len(), 1);
        let mixed = json!({"continuationContents":{"sectionListContinuation":{"contents":[recommendations(),{
            "musicShelfRenderer":{"title":{"simpleText":"Unknown songs"},"contents":[row("AAAAAAAAAAA","one")]}
        }]}}});
        assert!(playlist_page(&mixed, true).is_err());
        let unavailable = json!({"continuationContents":{"sectionListContinuation":{"contents":[recommendations(),{
            "musicPlaylistShelfRenderer":{"contents":[row("invalid","one")]}
        }]}}});
        assert!(playlist_page(&unavailable, true).is_err());
    }

    #[test]
    fn account_switch_restores_pending_intent_without_cross_upload() {
        let mut state = Store::default();
        state
            .accounts
            .insert("@one".into(), AccountState::default());
        state.accounts.insert(
            "@two".into(),
            AccountState {
                local: vec![favorite("BBBBBBBBBBB")],
                ..AccountState::default()
            },
        );
        let current = vec![favorite("AAAAAAAAAAA")];
        assert!(local_intent(&mut state, "@new", Some("@one"), &current).is_empty());
        assert_eq!(
            state.accounts["@one"].local[0].video_id.as_deref(),
            Some("AAAAAAAAAAA")
        );
        assert_eq!(
            local_intent(&mut state, "@two", Some("@one"), &current)[0]
                .video_id
                .as_deref(),
            Some("BBBBBBBBBBB")
        );
        assert_eq!(local_intent(&mut state, "@first", None, &current).len(), 1);
    }

    #[test]
    fn three_way_changes_do_not_resurrect_remote_removals() {
        let set = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<BTreeSet<_>>()
        };
        let baseline = set(&["a"]);
        let (add, remove) = changes(&baseline, &set(&["a", "b"]), &set(&["c"]), true);
        assert_eq!(add, vec!["b"]);
        assert!(remove.is_empty());
        let (add, remove) = changes(&baseline, &set(&["b"]), &set(&["a", "c"]), true);
        assert_eq!(add, vec!["b"]);
        assert_eq!(remove, set(&["a"]));
        let (_, remove) = changes(&baseline, &BTreeSet::new(), &baseline, false);
        assert!(
            remove.is_empty(),
            "a missing local store must not imply a remote deletion"
        );
    }

    #[test]
    fn malformed_state_does_not_reset_a_baseline() {
        let root =
            std::env::temp_dir().join(format!("ytmusicdt-favorites-state-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        std::fs::write(&path, "malformed").unwrap();
        assert!(FavoritesSync::new(path).load().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn baseline_distinguishes_local_edits_from_remote_edits() {
        let set = |items: &[&str]| {
            items
                .iter()
                .map(|id| id.to_string())
                .collect::<BTreeSet<_>>()
        };
        let baseline = set(&["A"]);
        assert_eq!(
            changes(&baseline, &set(&["A"]), &set(&["B"]), true),
            (vec![], set(&[]))
        );
        assert_eq!(
            changes(&baseline, &set(&["B"]), &set(&["A"]), true),
            (vec!["B".into()], set(&["A"]))
        );
        assert_eq!(
            changes(&baseline, &set(&["A", "B"]), &set(&["A", "C"]), true),
            (vec!["B".into()], set(&[]))
        );
        assert_eq!(
            changes(&baseline, &set(&[]), &set(&["A"]), false),
            (vec![], set(&[]))
        );
    }
}
