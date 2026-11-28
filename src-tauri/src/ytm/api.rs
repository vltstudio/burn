use serde::Serialize;
use serde_json::{json, Value};

use super::parse::{self, Detail, MediaItem, SearchResults, Section};
use super::Ytm;
use crate::error::{Error, Result};

fn search_params(filter: Option<&str>) -> Option<&'static str> {
    match filter? {
        "songs" => Some("EgWKAQIIAWoMEA4QChADEAQQCRAF"),
        "videos" => Some("EgWKAQIQAWoMEA4QChADEAQQCRAF"),
        "albums" => Some("EgWKAQIYAWoMEA4QChADEAQQCRAF"),
        "artists" => Some("EgWKAQIgAWoMEA4QChADEAQQCRAF"),
        "playlists" => Some("Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo="),
        _ => None,
    }
}

pub async fn search(ytm: &Ytm, query: &str, filter: Option<&str>) -> Result<SearchResults> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResults::default());
    }
    let mut body = json!({ "query": query });
    if let Some(params) = search_params(filter) {
        body["params"] = json!(params);
    }
    let response = ytm.request("search", body).await?;
    Ok(parse::search_results(&response))
}

/// One watch response answers two questions at once: what the track is and
/// where its lyrics page lives.
pub struct Watch {
    pub track: Option<MediaItem>,
    pub lyrics_id: Option<String>,
}

pub async fn watch(ytm: &Ytm, video_id: &str) -> Result<Watch> {
    let response = ytm.request("next", json!({ "videoId": video_id })).await?;
    Ok(Watch {
        track: parse::watch_track(&response, video_id),
        lyrics_id: parse::lyrics_id(&response),
    })
}

/// Timed lyrics: the Android Music client is the one that answers with
/// timestamps for the same lyrics page.
pub async fn timed_lyrics(ytm: &Ytm, browse_id: &str) -> Result<parse::LyricsPage> {
    let response = ytm
        .request_mobile("browse", json!({ "browseId": browse_id }))
        .await?;
    Ok(parse::lyrics_page(&response))
}

/// Plain lyrics, in the shape the web client renders.
pub async fn plain_lyrics(ytm: &Ytm, browse_id: &str) -> Result<Option<String>> {
    let response = ytm
        .request("browse", json!({ "browseId": browse_id }))
        .await?;
    Ok(parse::lyrics_page(&response).plain)
}

pub async fn watch_track(ytm: &Ytm, video_id: &str) -> Result<MediaItem> {
    if !parse::valid_video_id(video_id) {
        return Err(Error::api("Некорректная ссылка на видео YouTube"));
    }

    let response = ytm.request("next", json!({ "videoId": video_id })).await?;
    parse::watch_track(&response, video_id)
        .ok_or_else(|| Error::api("YouTube не вернул доступный трек по этой ссылке"))
}

#[derive(serde::Deserialize)]
pub struct ClipHint {
    pub title: String,
    pub artists: Vec<parse::ItemRef>,
    pub duration: Option<String>,
}

pub async fn resolve_clip(ytm: &Ytm, video_id: &str, kind: Option<&str>, hint: Option<ClipHint>) -> Result<Option<String>> {
    if !parse::valid_video_id(video_id) {
        return Ok(None);
    }
    if kind == Some("video") {
        return Ok(Some(video_id.to_owned()));
    }

    let response = ytm
        .request(
            "next",
            json!({
                "videoId": video_id,
                "playlistId": format!("RDAMVM{video_id}"),
                "isAudioOnly": true,
                "enablePersistentPlaylistPanel": true,
                "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
                "watchEndpointMusicSupportedConfigs": {
                    "watchEndpointMusicConfig": {
                        "hasPersistentPlaylistPanel": true,
                        "musicVideoType": "MUSIC_VIDEO_TYPE_ATV",
                    }
                },
            }),
        )
        .await?;
    if !parse::allows_clip_lookup(&response, video_id) { return Ok(None); }
    if let Some(id) = parse::clip_counterpart(&response, video_id) {
        return Ok(Some(id.to_owned()));
    }
    let mut track = parse::watch_track(&response, video_id).unwrap_or_default();
    if let Some(hint) = hint {
        if track.title.is_empty() { track.title = hint.title; }
        if track.artists.is_empty() { track.artists = hint.artists; }
        if track.duration.is_none() { track.duration = hint.duration; }
    }
    track.video_id = Some(video_id.to_owned());
    if track.kind == "video" {
        return Ok(Some(video_id.to_owned()));
    }
    let Some(artist) = track.artists.first() else {
        return Ok(None);
    };
    if track.title.trim().is_empty() {
        return Ok(None);
    }
    let query = format!("{} {}", artist.name, track.title);
    for query in [query.clone(), format!("{query} official video")] {
        let videos = ytm.request("search", json!({
            "query": query, "params": search_params(Some("videos")),
        })).await?;
        if let Some(id) = parse::clip_search_match(&videos, &track) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn recommendation_body(video_id: &str) -> Result<Value> {
    if !parse::valid_video_id(video_id) {
        return Err(Error::api("Некорректная ссылка на видео YouTube"));
    }
    Ok(json!({
        "videoId":video_id,
        "playlistId":format!("RDAMVM{video_id}"),
        "params":"wAEB",
        "isAudioOnly":true,
        "enablePersistentPlaylistPanel":true,
        "tunerSettingValue":"AUTOMIX_SETTING_NORMAL",
    }))
}

pub async fn recommendations(ytm: &Ytm, video_id: &str) -> Result<Vec<MediaItem>> {
    let response = ytm.request("next", recommendation_body(video_id)?).await?;
    parse::recommendations(&response, video_id)
        .ok_or_else(|| Error::api("YouTube Music не вернул очередь рекомендаций. Повторите позже."))
}

/// Next page of an already started search. A filtered search keeps its query
/// and filter params in the continuation request; sending the continuation
/// alone is rejected as an invalid argument.
pub async fn search_more(
    ytm: &Ytm,
    continuation: &str,
    query: &str,
    filter: Option<&str>,
) -> Result<Section> {
    let mut body = json!({ "continuation": continuation, "query": query });
    if let Some(params) = search_params(filter) {
        body["params"] = json!(params);
    }
    let response = ytm.request("search", body).await?;
    Ok(parse::continuation_page(&response))
}

pub async fn suggestions(ytm: &Ytm, query: &str) -> Result<Vec<String>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let response = ytm
        .request("music/get_search_suggestions", json!({ "input": query }))
        .await?;
    Ok(parse::suggestions(&response))
}

pub async fn home(ytm: &Ytm) -> Result<Vec<Section>> {
    let response = ytm
        .request("browse", json!({ "browseId": "FEmusic_home" }))
        .await?;
    Ok(parse::sections(&response))
}

pub async fn browse(ytm: &Ytm, browse_id: &str) -> Result<Detail> {
    let response = ytm
        .request("browse", json!({ "browseId": browse_id }))
        .await?;
    browse_detail(&response, browse_id)
}

#[cfg(test)]
#[test]
fn public_artist_with_a_sign_in_button_stays_readable() {
    let response = json!({"header":{"musicImmersiveHeaderRenderer":{
        "title":{"simpleText":"Clonnex"},
        "subscriptionButton":{"buttonRenderer":{"navigationEndpoint":{"signInEndpoint":{}}}}
    }}});
    assert_eq!(browse_detail(&response, "UCfixture").unwrap().header.title, "Clonnex");
    let sign_in = json!({"contents":{"buttonRenderer":{"navigationEndpoint":{"signInEndpoint":{}}}}});
    assert!(matches!(browse_detail(&sign_in, "VLprivate"), Err(Error::Auth(_))));
}

fn browse_detail(response: &Value, browse_id: &str) -> Result<Detail> {
    let mut detail = parse::detail(response);
    // Public artist and album pages also offer sign-in actions, e.g. on Subscribe.
    let empty = detail.header.title.is_empty() && detail.sections.is_empty();
    if empty && is_sign_in_page(response) {
        return Err(Error::Auth("Войдите через Google, чтобы открыть эту страницу YouTube Music".into()));
    }
    let mut unavailable = false;
    walk(response, &mut |node| {
        if node
            .get("alertRenderer")
            .is_some_and(|alert| alert.get("type").and_then(Value::as_str) == Some("ERROR"))
        {
            unavailable = true;
        }
    });
    if unavailable || response.get("error").is_some() {
        return Err(Error::api("Плейлист недоступен: он удалён, закрыт или YouTube Music временно не отвечает. Проверьте доступ и повторите запрос."));
    }
    if empty {
        return Err(Error::api(
            "YouTube Music вернул пустую страницу. Повторите загрузку плейлиста.",
        ));
    }
    detail.header.browse_id = Some(browse_id.to_string());
    if detail.header.kind == "playlist" || browse_id.starts_with("VL") {
        detail.header.playlist_id = Some(browse_id.trim_start_matches("VL").to_string());
        detail.header.kind = "playlist".into();
    }
    Ok(detail)
}

pub async fn browse_more(ytm: &Ytm, continuation: &str) -> Result<Section> {
    let response = ytm
        .request("browse", json!({ "continuation": continuation }))
        .await?;
    Ok(parse::continuation_page(&response))
}

pub async fn browse_releases(ytm: &Ytm, browse_id: &str, params: &str) -> Result<Section> {
    let response = ytm
        .request("browse", json!({ "browseId": browse_id, "params": params }))
        .await?;
    parse::sections(&response)
        .into_iter()
        .filter(|section| matches!(section.layout.as_str(), "grid" | "carousel"))
        .find_map(|mut section| {
            section.items.retain(|item| item.kind == "album");
            (!section.items.is_empty()).then_some(section)
        })
        .ok_or_else(|| Error::api("YouTube Music не вернул список релизов."))
}

async fn library_browse(ytm: &Ytm, browse_id: &str) -> Result<Vec<Section>> {
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы открыть библиотеку".into(),
        ));
    }
    let response = ytm
        .request("browse", json!({ "browseId": browse_id }))
        .await?;

    let shelves = parse::sections(&response);
    if shelves.is_empty() && is_sign_in_page(&response) {
        return Err(Error::Auth("Повторите вход в Google, чтобы открыть библиотеку".into()));
    }

    Ok(shelves)
}

pub async fn library_playlists(ytm: &Ytm) -> Result<Vec<Section>> {
    library_browse(ytm, "FEmusic_liked_playlists").await
}

pub async fn library_albums(ytm: &Ytm) -> Result<Vec<Section>> {
    library_browse(ytm, "FEmusic_liked_albums").await
}

pub async fn library_artists(ytm: &Ytm) -> Result<Vec<Section>> {
    library_browse(ytm, "FEmusic_library_corpus_track_artists").await
}

pub async fn liked_songs(ytm: &Ytm) -> Result<Detail> {
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы открыть библиотеку".into(),
        ));
    }
    browse(ytm, "VLLM").await
}

fn is_sign_in_page(response: &Value) -> bool {
    let mut found = false;
    walk(response, &mut |node| {
        if node.get("signInEndpoint").is_some() {
            found = true;
        }
    });
    found
}

fn walk(node: &Value, visit: &mut impl FnMut(&Value)) {
    visit(node);
    match node {
        Value::Object(map) => {
            for value in map.values() {
                walk(value, visit);
            }
        }
        Value::Array(items) => {
            for value in items {
                walk(value, visit);
            }
        }
        _ => {}
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    pub handle: Option<String>,
    pub photo: Option<String>,
}

pub async fn account(ytm: &Ytm) -> Result<Account> {
    if !ytm.is_signed_in().await {
        return Err(Error::Auth("Not signed in".into()));
    }
    let response = ytm.request("account/account_menu", json!({})).await?;
    let mut header = None;
    walk(&response, &mut |node| {
        if header.is_none() {
            header = node.get("activeAccountHeaderRenderer").cloned();
        }
    });
    let header = match header {
        Some(header) if !parse::text_of(header.get("accountName").unwrap_or(&Value::Null)).trim().is_empty() => header,
        _ if is_sign_in_page(&response) => return Err(Error::Auth("YouTube Music не подтвердил вход Google. Повторите вход в настройках.".into())),
        _ => return Err(Error::api("YouTube Music не вернул профиль аккаунта. Повторите проверку подключения в настройках.")),
    };
    Ok(Account {
        name: parse::text_of(header.get("accountName").unwrap_or(&Value::Null)),
        handle: header.get("channelHandle").map(parse::text_of).filter(|handle| !handle.trim().is_empty()),
        photo: header
            .pointer("/accountPhoto/thumbnails/0/url")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Strips the `VL` browse prefix so InnerTube gets the bare playlist id.
fn bare_playlist_id(playlist_id: &str) -> &str {
    playlist_id.trim_start_matches("VL")
}

pub async fn add_to_playlist(ytm: &Ytm, playlist_id: &str, video_id: &str) -> Result<()> {
    let video_ids = [video_id.to_string()];
    add_tracks(ytm, playlist_id, &video_ids).await
}

/// Adds several tracks in one call. The server takes the whole array at once,
/// which is what makes importing a long playlist bearable.
pub async fn add_tracks(ytm: &Ytm, playlist_id: &str, video_ids: &[String]) -> Result<()> {
    if video_ids.is_empty() {
        return Ok(());
    }
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы менять плейлисты".into(),
        ));
    }
    let actions: Vec<Value> = video_ids
        .iter()
        .map(|video_id| {
            json!({
                "action": "ACTION_ADD_VIDEO",
                "addedVideoId": video_id,
                // A track already in the playlist must not fail the whole call.
                "dedupeOption": "DEDUPE_OPTION_SKIP",
            })
        })
        .collect();
    let response = ytm
        .request(
            "browse/edit_playlist",
            json!({ "playlistId": bare_playlist_id(playlist_id), "actions": actions }),
        )
        .await?;
    let status = response.get("status").and_then(Value::as_str).unwrap_or("");
    if status.contains("SUCCEEDED") {
        Ok(())
    } else {
        Err(Error::api(format!(
            "YouTube Music не принял добавление в плейлист ({status})"
        )))
    }
}

pub async fn remove_tracks(
    ytm: &Ytm,
    playlist_id: &str,
    tracks: &[(String, String)],
) -> Result<()> {
    if tracks.is_empty() {
        return Ok(());
    }
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы менять плейлисты".into(),
        ));
    }
    let actions: Vec<Value> = tracks
        .iter()
        .map(|(video_id, set_video_id)| {
            json!({
                "action":"ACTION_REMOVE_VIDEO", "removedVideoId":video_id, "setVideoId":set_video_id
            })
        })
        .collect();
    let response = ytm
        .request(
            "browse/edit_playlist",
            json!({
                "playlistId":bare_playlist_id(playlist_id), "actions":actions
            }),
        )
        .await?;
    if response.get("status").and_then(Value::as_str) != Some("STATUS_SUCCEEDED") {
        return Err(Error::api(
            "YouTube Music не подтвердил удаление треков из плейлиста",
        ));
    }
    Ok(())
}

pub async fn create_playlist(ytm: &Ytm, title: &str, video_id: Option<&str>) -> Result<String> {
    let video_ids: Vec<String> = video_id.map(|id| vec![id.to_string()]).unwrap_or_default();
    create_playlist_full(ytm, title, "", "PRIVATE", &video_ids).await
}

/// Creates a playlist with a description and privacy, optionally seeded with
/// tracks. `privacy` is one of PUBLIC, PRIVATE, UNLISTED.
pub async fn create_playlist_full(
    ytm: &Ytm,
    title: &str,
    description: &str,
    privacy: &str,
    video_ids: &[String],
) -> Result<String> {
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы создавать плейлисты".into(),
        ));
    }
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::api("У плейлиста должно быть название"));
    }
    if title.contains('<') || title.contains('>') {
        return Err(Error::api("В названии плейлиста нельзя использовать < и >"));
    }

    let mut body = json!({
        "title": title,
        "description": description.trim(),
        "privacyStatus": privacy,
    });
    if !video_ids.is_empty() {
        body["videoIds"] = json!(video_ids);
    }
    let response = ytm.request("playlist/create", body).await?;
    response
        .get("playlistId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::api("YouTube Music не создал плейлист"))
}

/// Removes a playlist the signed-in account owns. Used to roll back an import
/// that could not be filled, so a failure leaves nothing behind.
pub async fn delete_playlist(ytm: &Ytm, playlist_id: &str) -> Result<()> {
    if !ytm.is_signed_in().await {
        return Err(Error::Auth(
            "Войдите через Google, чтобы удалять плейлисты".into(),
        ));
    }
    ytm.request(
        "playlist/delete",
        json!({ "playlistId": bare_playlist_id(playlist_id) }),
    )
    .await?;
    Ok(())
}

pub async fn rate_song(ytm: &Ytm, video_id: &str, rating: &str) -> Result<()> {
    let endpoint = match rating {
        "like" => "like/like",
        "dislike" => "like/dislike",
        _ => "like/removelike",
    };
    ytm.request(endpoint, json!({ "target": { "videoId": video_id } }))
        .await?;
    Ok(())
}

#[cfg(test)]
mod recommendation_tests {
    use super::*;

    #[test]
    fn radio_request_has_the_upstream_audio_automix_shape() {
        let id = "dQw4w9WgXcQ";
        assert_eq!(
            recommendation_body(id).unwrap(),
            json!({
                "videoId":id,"playlistId":"RDAMVMdQw4w9WgXcQ","params":"wAEB",
                "isAudioOnly":true,"enablePersistentPlaylistPanel":true,
                "tunerSettingValue":"AUTOMIX_SETTING_NORMAL"
            })
        );
    }

    #[test]
    fn malformed_seeds_are_rejected_before_a_request() {
        for id in [
            "",
            "short",
            "ABCDEFGHIJKL",
            "AAAAAAAAAA+",
            "AAAAAAAAAA/",
            " AAAAAAAAAA",
            "AAAAAAAAAA\n",
            "https://youtu.be/dQw4w9WgXcQ",
            "абвгдежзийк",
        ] {
            assert!(recommendation_body(id).is_err(), "{id:?}");
        }
        assert!(recommendation_body("_-abcdefghi").is_ok());
    }
}
