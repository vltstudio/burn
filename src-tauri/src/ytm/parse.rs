use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub name: String,
    pub browse_id: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    /// song | video | album | artist | playlist | episode | unknown
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub video_id: Option<String>,
    pub browse_id: Option<String>,
    pub playlist_id: Option<String>,
    pub duration: Option<String>,
    pub year: Option<String>,
    /// Ascending by size; the last entry is the largest cover available.
    pub thumbs: Vec<String>,
    pub artists: Vec<ItemRef>,
    pub album: Option<ItemRef>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: Option<String>,
    /// carousel | grid | list
    pub layout: String,
    pub items: Vec<MediaItem>,
    pub continuation: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DetailHeader {
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub meta: String,
    pub description: Option<String>,
    pub thumbs: Vec<String>,
    pub browse_id: Option<String>,
    pub playlist_id: Option<String>,
    pub year: Option<String>,
    pub artists: Vec<ItemRef>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub header: DetailHeader,
    pub sections: Vec<Section>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub top: Option<MediaItem>,
    pub items: Vec<MediaItem>,
    pub continuation: Option<String>,
}

// ---------------------------------------------------------------- primitives

/// Flattens a `{runs: [...]}` / `{simpleText}` text object into a string.
pub fn text_of(value: &Value) -> String {
    if let Some(runs) = value.get("runs").and_then(Value::as_array) {
        return runs
            .iter()
            .filter_map(|run| run.get("text").and_then(Value::as_str))
            .collect();
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = value.get("simpleText").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return text.to_string();
    }
    String::new()
}

fn text_at(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).map(text_of).unwrap_or_default()
}

/// Collects thumbnail urls ascending by width.
fn thumbs_of(value: &Value) -> Vec<String> {
    let array = value
        .get("thumbnails")
        .and_then(Value::as_array)
        .or_else(|| value.get("sources").and_then(Value::as_array))
        .or_else(|| value.as_array());
    let Some(array) = array else {
        return Vec::new();
    };

    let mut entries: Vec<(u64, String)> = array
        .iter()
        .filter_map(|entry| {
            let url = entry.get("url")?.as_str()?.to_string();
            if url.starts_with("//") {
                return Some((
                    entry.get("width").and_then(Value::as_u64).unwrap_or(0),
                    format!("https:{url}"),
                ));
            }
            let width = entry
                .get("width")
                .and_then(Value::as_u64)
                .or_else(|| entry.get("height").and_then(Value::as_u64))
                .unwrap_or(0);
            Some((width, url))
        })
        .collect();
    entries.sort_by_key(|(width, _)| *width);
    entries.dedup_by(|a, b| a.1 == b.1);
    entries.into_iter().map(|(_, url)| url).collect()
}

struct Endpoint {
    browse_id: Option<String>,
    page_type: Option<String>,
    video_id: Option<String>,
    watch_playlist_id: Option<String>,
}

fn endpoint_of(node: &Value) -> Endpoint {
    let nav = node.get("navigationEndpoint").or_else(|| node.get("onTap"));
    Endpoint {
        browse_id: nav
            .and_then(|n| n.pointer("/browseEndpoint/browseId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        page_type: nav
            .and_then(|n| {
                n.pointer(
                    "/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType",
                )
            })
            .and_then(Value::as_str)
            .map(str::to_string),
        video_id: nav
            .and_then(|n| n.pointer("/watchEndpoint/videoId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        watch_playlist_id: nav
            .and_then(|n| n.pointer("/watchPlaylistEndpoint/playlistId"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn music_video_type(node: &Value) -> Option<String> {
    for pointer in [
        "/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType",
        "/navigationEndpoint/watchEndpoint/watchEndpointMusicSupportedConfigs/watchEndpointMusicConfig/musicVideoType",
    ] {
        if let Some(kind) = node.pointer(pointer).and_then(Value::as_str) {
            return Some(kind.to_string());
        }
    }
    None
}

fn is_artist_page(page_type: Option<&str>) -> bool {
    matches!(
        page_type,
        Some("MUSIC_PAGE_TYPE_ARTIST")
            | Some("MUSIC_PAGE_TYPE_USER_CHANNEL")
            | Some("MUSIC_PAGE_TYPE_LIBRARY_ARTIST")
    )
}

fn is_album_page(page_type: Option<&str>) -> bool {
    matches!(
        page_type,
        Some("MUSIC_PAGE_TYPE_ALBUM") | Some("MUSIC_PAGE_TYPE_AUDIOBOOK")
    )
}

fn is_playlist_page(page_type: Option<&str>) -> bool {
    matches!(
        page_type,
        Some("MUSIC_PAGE_TYPE_PLAYLIST")
            | Some("MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_PLAYLIST_DETAIL_PAGE")
            | Some("MUSIC_PAGE_TYPE_LIBRARY_PLAYLIST")
    )
}

fn kind_of(page_type: Option<&str>, video_id: Option<&str>, video_type: Option<&str>) -> String {
    if is_album_page(page_type) {
        return "album".into();
    }
    if is_artist_page(page_type) {
        return "artist".into();
    }
    if is_playlist_page(page_type) {
        return "playlist".into();
    }
    if video_id.is_some() {
        return match video_type {
            Some("MUSIC_VIDEO_TYPE_ATV") | None => "song".into(),
            Some(_) => "video".into(),
        };
    }
    "unknown".into()
}

/// "3:05", "1:02:41" — used to spot durations in subtitle runs.
fn looks_like_duration(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text.len() > 8 {
        return false;
    }
    let mut colons = 0;
    for (index, ch) in text.chars().enumerate() {
        if ch == ':' {
            colons += 1;
            if colons > 2 || index == 0 || index == text.len() - 1 {
                return false;
            }
        } else if !ch.is_ascii_digit() {
            return false;
        }
    }
    colons > 0
}

fn looks_like_year(text: &str) -> bool {
    let text = text.trim();
    text.len() == 4
        && text.chars().all(|c| c.is_ascii_digit())
        && (text.starts_with("19") || text.starts_with("20"))
}

fn playlist_id_of(browse_id: &str) -> Option<String> {
    browse_id.strip_prefix("VL").map(str::to_string)
}

fn video_id_of(node: &Value) -> Option<String> {
    for pointer in [
        "/playlistItemData/videoId",
        "/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId",
        "/navigationEndpoint/watchEndpoint/videoId",
        "/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchPlaylistEndpoint/videoId",
    ] {
        if let Some(id) = node.pointer(pointer).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    None
}

fn continuation_at(node: &Value) -> Option<String> {
    node.pointer("/continuations/0/nextContinuationData/continuation")
        .or_else(|| node.pointer("/continuations/0/reloadContinuationData/continuation"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

// ---------------------------------------------------------------- list items

/// `musicResponsiveListItemRenderer` — the row used by search, shelves and track lists.
fn parse_responsive(node: &Value) -> Option<MediaItem> {
    let columns = node.get("flexColumns")?.as_array()?;
    let mut column_texts: Vec<String> = Vec::new();
    let mut artists: Vec<ItemRef> = Vec::new();
    let mut album: Option<ItemRef> = None;
    let mut playlist_ref: Option<ItemRef> = None;
    let mut duration: Option<String> = None;
    let mut year: Option<String> = None;

    for column in columns {
        let Some(renderer) = column.get("musicResponsiveListItemFlexColumnRenderer") else {
            continue;
        };
        let Some(text) = renderer.get("text") else {
            continue;
        };
        column_texts.push(text_of(text));
        let Some(runs) = text.get("runs").and_then(Value::as_array) else {
            continue;
        };
        for run in runs {
            let run_text = text_of(run);
            let endpoint = endpoint_of(run);
            if let Some(browse_id) = endpoint.browse_id {
                let name = run_text.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                if is_artist_page(endpoint.page_type.as_deref()) {
                    if !artists.iter().any(|a| a.browse_id == browse_id) {
                        artists.push(ItemRef { name, browse_id });
                    }
                } else if is_album_page(endpoint.page_type.as_deref()) {
                    album.get_or_insert(ItemRef { name, browse_id });
                } else if is_playlist_page(endpoint.page_type.as_deref()) {
                    playlist_ref.get_or_insert(ItemRef { name, browse_id });
                }
            } else {
                if duration.is_none() && looks_like_duration(&run_text) {
                    duration = Some(run_text.trim().to_string());
                }
                if year.is_none() && looks_like_year(&run_text) {
                    year = Some(run_text.trim().to_string());
                }
            }
        }
    }

    if let Some(fixed) =
        node.pointer("/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text")
    {
        let text = text_of(fixed);
        if looks_like_duration(&text) && duration.is_none() {
            duration = Some(text.trim().to_string());
        }
    }

    let title = column_texts.first().cloned().unwrap_or_default();
    if title.is_empty() {
        return None;
    }

    let own = endpoint_of(node);
    let video_id = video_id_of(node).or(own.video_id);
    let video_type = music_video_type(node);
    let kind = kind_of(
        own.page_type.as_deref(),
        video_id.as_deref(),
        video_type.as_deref(),
    );
    let browse_id = own.browse_id;
    let playlist_id = browse_id.as_deref().and_then(playlist_id_of).or_else(|| {
        playlist_ref
            .as_ref()
            .and_then(|reference| playlist_id_of(&reference.browse_id))
    });

    Some(MediaItem {
        kind,
        title,
        subtitle: column_texts.get(1).cloned().unwrap_or_default(),
        video_id,
        browse_id,
        playlist_id,
        duration,
        year,
        thumbs: thumbs_of(
            node.pointer("/thumbnail/musicThumbnailRenderer/thumbnail")
                .unwrap_or(&Value::Null),
        ),
        artists,
        album,
    })
}

/// `musicTwoRowItemRenderer` — album/artist/playlist cards in carousels and grids.
fn parse_two_row(node: &Value) -> Option<MediaItem> {
    let title = node.get("title").map(text_of).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let subtitle_value = node.get("subtitle").cloned().unwrap_or(Value::Null);
    let subtitle = text_of(&subtitle_value);

    let mut artists = Vec::new();
    let mut album = None;
    let mut year = None;
    if let Some(runs) = subtitle_value.get("runs").and_then(Value::as_array) {
        for run in runs {
            let run_text = text_of(run);
            let endpoint = endpoint_of(run);
            if let Some(browse_id) = endpoint.browse_id {
                let name = run_text.trim().to_string();
                if name.is_empty() {
                    continue;
                }
                if is_artist_page(endpoint.page_type.as_deref()) {
                    artists.push(ItemRef { name, browse_id });
                } else if is_album_page(endpoint.page_type.as_deref()) {
                    album.get_or_insert(ItemRef { name, browse_id });
                }
            } else if year.is_none() && looks_like_year(&run_text) {
                year = Some(run_text.trim().to_string());
            }
        }
    }

    let own = endpoint_of(node);
    let video_id = own.video_id.clone();
    let browse_id = own
        .browse_id
        .clone()
        .or_else(|| own.watch_playlist_id.as_ref().map(|id| format!("VL{id}")));
    if video_id.is_none() && browse_id.is_none() {
        return None;
    }
    let kind = if own.browse_id.is_none() && own.watch_playlist_id.is_some() {
        "playlist".to_string()
    } else {
        kind_of(own.page_type.as_deref(), video_id.as_deref(), None)
    };
    let playlist_id = browse_id.as_deref().and_then(playlist_id_of);

    Some(MediaItem {
        kind,
        title,
        subtitle,
        video_id,
        browse_id,
        playlist_id,
        duration: None,
        year,
        thumbs: thumbs_of(
            node.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail")
                .unwrap_or(&Value::Null),
        ),
        artists,
        album,
    })
}

/// The "top result" card at the head of a search response.
fn parse_card(node: &Value) -> Option<MediaItem> {
    let title = node.get("title").map(text_of).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let subtitle = node.get("subtitle").map(text_of).unwrap_or_default();
    let own = endpoint_of(node);
    let kind = kind_of(own.page_type.as_deref(), own.video_id.as_deref(), None);
    let playlist_id = own.browse_id.as_deref().and_then(playlist_id_of);
    Some(MediaItem {
        kind,
        title,
        subtitle,
        video_id: own.video_id,
        browse_id: own.browse_id,
        playlist_id,
        duration: None,
        year: None,
        thumbs: thumbs_of(
            node.pointer("/thumbnail/musicThumbnailRenderer/thumbnail")
                .unwrap_or(&Value::Null),
        ),
        artists: Vec::new(),
        album: None,
    })
}

// ---------------------------------------------------------------- collections

fn parse_cell(entry: &Value) -> Option<MediaItem> {
    if let Some(cell) = entry.get("musicTwoRowItemRenderer") {
        return parse_two_row(cell);
    }
    entry
        .get("musicResponsiveListItemRenderer")
        .and_then(parse_responsive)
}

fn parse_shelf(section: &Value, out: &mut Vec<Section>) {
    if let Some(shelf) = section.get("musicCarouselShelfRenderer") {
        let items: Vec<MediaItem> = shelf
            .get("contents")
            .and_then(Value::as_array)
            .map(|contents| contents.iter().filter_map(parse_cell).collect())
            .unwrap_or_default();
        if !items.is_empty() {
            out.push(Section {
                title: Some(text_at(
                    shelf,
                    "/header/musicCarouselShelfBasicHeaderRenderer/title",
                ))
                .filter(|t| !t.is_empty()),
                layout: "carousel".into(),
                items,
                continuation: continuation_at(shelf),
            });
        }
        return;
    }

    if let Some(shelf) = section.get("musicShelfRenderer") {
        let items = parse_responsive_list(shelf.get("contents"));
        if !items.is_empty() {
            out.push(Section {
                title: Some(text_at(shelf, "/title")).filter(|t| !t.is_empty()),
                layout: "list".into(),
                items,
                continuation: continuation_at(shelf),
            });
        }
        return;
    }

    if let Some(shelf) = section.get("musicPlaylistShelfRenderer") {
        let items = parse_responsive_list(shelf.get("contents"));
        if !items.is_empty() {
            out.push(Section {
                title: None,
                layout: "list".into(),
                items,
                continuation: continuation_at(shelf),
            });
        }
        return;
    }

    if let Some(grid) = section.get("gridRenderer") {
        let items: Vec<MediaItem> = grid
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_cell).collect())
            .unwrap_or_default();
        if !items.is_empty() {
            out.push(Section {
                title: Some(text_at(grid, "/header/gridHeaderRenderer/title"))
                    .filter(|t| !t.is_empty()),
                layout: "grid".into(),
                items,
                continuation: continuation_at(grid),
            });
        }
        return;
    }

    if let Some(section_renderer) = section.get("itemSectionRenderer") {
        if let Some(contents) = section_renderer.get("contents").and_then(Value::as_array) {
            for child in contents {
                parse_shelf(child, out);
            }
        }
    }
}

fn parse_responsive_list(contents: Option<&Value>) -> Vec<MediaItem> {
    contents
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| entry.get("musicResponsiveListItemRenderer"))
                .filter_map(parse_responsive)
                .collect()
        })
        .unwrap_or_default()
}

fn section_list(response: &Value) -> Option<&Value> {
    for pointer in [
        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
        "/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer",
        "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
        "/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
    ] {
        if let Some(renderer) = response.pointer(pointer) {
            if renderer.get("contents").and_then(Value::as_array).is_some() {
                return Some(renderer);
            }
        }
    }
    None
}

pub fn sections(response: &Value) -> Vec<Section> {
    let mut out = Vec::new();
    if let Some(list) = section_list(response) {
        if let Some(contents) = list.get("contents").and_then(Value::as_array) {
            for section in contents {
                parse_shelf(section, &mut out);
            }
        }
    }
    out
}

pub fn continuation_page(response: &Value) -> Section {
    let contents = response.get("continuationContents");

    // Playlist pages continue a whole section list rather than a single shelf.
    if let Some(list) = contents.and_then(|c| c.get("sectionListContinuation")) {
        let mut section = Section {
            title: None,
            layout: "list".into(),
            items: Vec::new(),
            continuation: continuation_at(list),
        };
        for child in list
            .get("contents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(shelf) = child.get("musicPlaylistShelfRenderer") {
                section
                    .items
                    .extend(parse_responsive_list(shelf.get("contents")));
                if section.continuation.is_none() {
                    section.continuation = continuation_at(shelf);
                }
            }
        }
        if !section.items.is_empty() || section.continuation.is_some() {
            return section;
        }
    }

    if let Some(list) = contents
        .and_then(|c| c.get("musicShelfContinuation"))
        .or_else(|| contents.and_then(|c| c.get("musicPlaylistShelfContinuation")))
    {
        return Section {
            title: None,
            layout: "list".into(),
            items: parse_responsive_list(list.get("contents")),
            continuation: continuation_at(list),
        };
    }
    if let Some(grid) = contents.and_then(|c| c.get("gridContinuation")) {
        let items = grid
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_cell).collect())
            .unwrap_or_default();
        return Section {
            title: None,
            layout: "grid".into(),
            items,
            continuation: continuation_at(grid),
        };
    }
    Section::default()
}

pub fn search_results(response: &Value) -> SearchResults {
    let mut results = SearchResults::default();
    let Some(contents) = section_list(response)
        .and_then(|list| list.get("contents"))
        .and_then(Value::as_array)
    else {
        return results;
    };

    for section in contents {
        if let Some(card) = section.get("musicCardShelfRenderer") {
            results.top = parse_card(card);
            continue;
        }
        if let Some(shelf) = section.get("musicShelfRenderer") {
            results
                .items
                .extend(parse_responsive_list(shelf.get("contents")));
            if results.continuation.is_none() {
                results.continuation = continuation_at(shelf);
            }
            continue;
        }
        if let Some(inner) = section
            .get("itemSectionRenderer")
            .and_then(|renderer| renderer.get("contents"))
            .and_then(Value::as_array)
        {
            for child in inner {
                if let Some(item) = child
                    .get("musicResponsiveListItemRenderer")
                    .and_then(parse_responsive)
                {
                    results.items.push(item);
                } else if let Some(shelf) = child.get("musicShelfRenderer") {
                    results
                        .items
                        .extend(parse_responsive_list(shelf.get("contents")));
                }
            }
        }
    }

    results
        .items
        .dedup_by(|a, b| a.title == b.title && a.video_id.is_some() && a.video_id == b.video_id);
    results
}

pub(crate) fn valid_video_id(video_id: &str) -> bool {
    video_id.len() == 11
        && video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn watch_queue(response: &Value) -> Option<Vec<&Value>> {
    let tabs = response.pointer(
        "/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs",
    )?.as_array()?;
    let mut found = false;
    let mut entries = Vec::new();
    for tab in tabs {
        if let Some(queue) = tab.pointer("/tabRenderer/content/musicQueueRenderer") {
            found = true;
            entries.extend(
                queue
                    .pointer("/content/playlistPanelRenderer/contents")?
                    .as_array()?,
            );
        }
    }
    found.then_some(entries)
}

pub fn watch_track(response: &Value, video_id: &str) -> Option<MediaItem> {
    if response
        .pointer("/currentVideoEndpoint/watchEndpoint/videoId")?
        .as_str()?
        != video_id
        || !clip_playable(response)
    {
        return None;
    }
    let track = watch_queue(response)?
        .into_iter()
        .filter_map(|entry| {
            entry.get("playlistPanelVideoRenderer").or_else(|| {
                entry.pointer(
                    "/playlistPanelVideoWrapperRenderer/primaryRenderer/playlistPanelVideoRenderer",
                )
            })
        })
        .find(|track| track.get("videoId").and_then(Value::as_str) == Some(video_id))?;
    panel_video(track)
}

pub(super) fn clip_counterpart<'a>(response: &'a Value, video_id: &str) -> Option<&'a str> {
    if !valid_video_id(video_id)
        || response
            .pointer("/currentVideoEndpoint/watchEndpoint/videoId")
            .and_then(Value::as_str)
            .is_some_and(|current| current != video_id)
        || !clip_playable(response)
    {
        return None;
    }

    watch_queue(response)?
        .into_iter()
        .filter_map(|entry| entry.get("playlistPanelVideoWrapperRenderer"))
        .filter(|wrapper| {
            wrapper
                .pointer("/primaryRenderer/playlistPanelVideoRenderer")
                .is_some_and(|track| {
                    track.get("videoId").and_then(Value::as_str) == Some(video_id)
                        && clip_playable(track)
                })
        })
        .filter_map(|wrapper| wrapper.get("counterpart").and_then(Value::as_array))
        .flatten()
        .filter_map(|entry| entry.pointer("/counterpartRenderer/playlistPanelVideoRenderer"))
        .filter(|track| {
            clip_playable(track)
                && matches!(
                    music_video_type(track).as_deref(),
                    Some("MUSIC_VIDEO_TYPE_OMV") | Some("MUSIC_VIDEO_TYPE_UGC")
                )
        })
        .filter_map(|track| {
            let id = track.get("videoId")?.as_str()?;
            let endpoint_id = track
                .pointer("/navigationEndpoint/watchEndpoint/videoId")
                .and_then(Value::as_str);
            (valid_video_id(id)
                && id != video_id
                && !endpoint_id.is_some_and(|endpoint_id| endpoint_id != id))
            .then_some(id)
        })
        .next()
}

fn clip_playable(track: &Value) -> bool {
    track.get("isPlayable").and_then(Value::as_bool) != Some(false)
        && track.get("unplayableText").is_none()
        && !track
            .pointer("/playabilityStatus/status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "OK")
}

fn clip_title(title: &str) -> String {
    title
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|ch| !matches!(ch, '\'' | '’'))
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn clip_video_title(title: &str) -> String {
    let title = title.trim();
    for (left, right) in [('(', ')'), ('[', ']')] {
        if let Some((base, suffix)) = title
            .strip_suffix(right)
            .and_then(|text| text.rsplit_once(left))
        {
            if matches!(
                clip_title(suffix).as_str(),
                "official music video" | "official video"
            ) {
                return clip_title(base);
            }
        }
    }
    clip_title(title)
}

fn clip_duration(text: &str) -> Option<u32> {
    if !looks_like_duration(text) {
        return None;
    }
    let mut components = text.trim().split(':');
    let mut seconds = components.next()?.parse::<u32>().ok()?;
    for component in components {
        let part: u32 = component.parse().ok()?;
        if part >= 60 || component.len() != 2 {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(part)?;
    }
    (seconds > 0).then_some(seconds)
}

pub(super) fn clip_search_match(response: &Value, track: &MediaItem) -> Option<String> {
    let artist = &track.artists.first()?.browse_id;
    if artist.is_empty() {
        return None;
    }
    let title = clip_title(&track.title);
    if title.is_empty() {
        return None;
    }
    let duration = clip_duration(track.duration.as_deref()?)?;
    let tolerance = (duration * 8 / 100).clamp(5, 25);
    let sections = section_list(response)?.get("contents")?.as_array()?;
    let mut best = None::<(u32, String)>;
    let mut tied = false;
    for section in sections.iter().flat_map(|section| {
        std::iter::once(section).chain(
            section
                .pointer("/itemSectionRenderer/contents")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        )
    }) {
        let Some(rows) = section
            .pointer("/musicShelfRenderer/contents")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for row in rows
            .iter()
            .filter_map(|row| row.get("musicResponsiveListItemRenderer"))
        {
            if !clip_playable(row)
                || music_video_type(row).as_deref() != Some("MUSIC_VIDEO_TYPE_OMV")
            {
                continue;
            }
            let Some(candidate) = parse_responsive(row) else {
                continue;
            };
            let Some(id) = candidate
                .video_id
                .filter(|id| valid_video_id(id) && track.video_id.as_ref() != Some(id))
            else {
                continue;
            };
            if !candidate
                .artists
                .first()
                .is_some_and(|credit| &credit.browse_id == artist)
                || clip_video_title(&candidate.title) != title
            {
                continue;
            }
            let Some(delta) = candidate
                .duration
                .as_deref()
                .and_then(clip_duration)
                .map(|value| duration.abs_diff(value))
            else {
                continue;
            };
            if delta > tolerance {
                continue;
            }
            match &best {
                Some((score, _)) if *score < delta => (),
                Some((score, best_id)) if *score == delta => tied |= best_id != &id,
                _ => {
                    best = Some((delta, id));
                    tied = false;
                }
            }
        }
    }
    if tied {
        None
    } else {
        best.map(|(_, id)| id)
    }
}

#[cfg(test)]
mod clip_tests {
    use super::*;
    use serde_json::json;

    const SONG: &str = "9mWr4c_ig54";
    const CLIP: &str = "E0S4W34zFMA";
    const OTHER: &str = "M7lc1UVf-VE";

    fn panel(id: &str, kind: &str) -> Value {
        json!({
            "videoId": id,
            "navigationEndpoint": { "watchEndpoint": {
                "videoId": id,
                "watchEndpointMusicSupportedConfigs": {"watchEndpointMusicConfig": {"musicVideoType": kind}}
            }}
        })
    }

    fn wrapper(id: &str, counterparts: Vec<Value>) -> Value {
        json!({"playlistPanelVideoWrapperRenderer": {
            "primaryRenderer": {"playlistPanelVideoRenderer": panel(id, "MUSIC_VIDEO_TYPE_ATV")},
            "counterpart": counterparts.into_iter().map(|item| json!({
                "counterpartRenderer": {"playlistPanelVideoRenderer": item}
            })).collect::<Vec<_>>(),
        }})
    }

    fn watch(entries: Vec<Value>) -> Value {
        json!({
            "currentVideoEndpoint": {"watchEndpoint": {"videoId": SONG}},
            "contents": {"singleColumnMusicWatchNextResultsRenderer": {"tabbedRenderer": {
                "watchNextTabbedResultsRenderer": {"tabs": [
                    {"tabRenderer": {"content": {"musicQueueRenderer": {
                        "content": {"playlistPanelRenderer": {"contents": entries}}
                    }}}}
                ]}
            }}}
        })
    }

    #[test]
    fn resolves_only_explicit_video_counterparts_of_the_requested_song() {
        for kind in ["MUSIC_VIDEO_TYPE_OMV", "MUSIC_VIDEO_TYPE_UGC"] {
            let response = watch(vec![
                wrapper(OTHER, vec![panel(OTHER, kind)]),
                wrapper(
                    SONG,
                    vec![panel(OTHER, "MUSIC_VIDEO_TYPE_ATV"), panel(CLIP, kind)],
                ),
            ]);
            assert_eq!(clip_counterpart(&response, SONG), Some(CLIP));
        }
    }

    #[test]
    fn ignores_unrelated_queue_rows_and_audio_only_tracks() {
        let response = watch(vec![
            json!({"playlistPanelVideoRenderer": panel(CLIP, "MUSIC_VIDEO_TYPE_OMV")}),
            wrapper(OTHER, vec![panel(CLIP, "MUSIC_VIDEO_TYPE_OMV")]),
            wrapper(
                SONG,
                vec![
                    panel(SONG, "MUSIC_VIDEO_TYPE_OMV"),
                    panel(CLIP, "MUSIC_VIDEO_TYPE_ATV"),
                ],
            ),
        ]);
        assert_eq!(clip_counterpart(&response, SONG), None);
        assert_eq!(clip_counterpart(&response, OTHER), None);
    }

    #[test]
    fn rejects_invalid_mismatched_and_restricted_counterparts() {
        let mut restricted = panel(CLIP, "MUSIC_VIDEO_TYPE_OMV");
        restricted["playabilityStatus"] = json!({"status": "LOGIN_REQUIRED"});
        let mut mismatch = panel(CLIP, "MUSIC_VIDEO_TYPE_UGC");
        mismatch["navigationEndpoint"]["watchEndpoint"]["videoId"] = json!(OTHER);
        let response = watch(vec![wrapper(
            SONG,
            vec![
                panel("../../video", "MUSIC_VIDEO_TYPE_OMV"),
                restricted,
                mismatch,
            ],
        )]);
        assert_eq!(clip_counterpart(&response, SONG), None);
    }

    fn search(entries: Vec<Value>) -> Value {
        json!({"contents": {"tabbedSearchResultsRenderer": {"tabs": [
            {"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
                {"musicShelfRenderer": {"contents": entries}}
            ]}}}}
        ]}}})
    }

    fn video(id: &str, title: &str, artist: &str, duration: &str, kind: &str) -> Value {
        let mut renderer = panel(id, kind);
        renderer["flexColumns"] = json!([
            {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": title}]}}},
            {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
                {"text": "The Band", "navigationEndpoint": {"browseEndpoint": {
                    "browseId": artist,
                    "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}}
                }}},
                {"text": " • "}, {"text": "2 million views"}, {"text": " • "}, {"text": duration}
            ]}}}
        ]);
        json!({"musicResponsiveListItemRenderer": renderer})
    }

    fn song() -> MediaItem {
        MediaItem {
            video_id: Some(SONG.into()),
            title: "Don’t Stop Me".into(),
            artists: vec![ItemRef {
                name: "The Band".into(),
                browse_id: "UC-band".into(),
            }],
            duration: Some("4:00".into()),
            ..MediaItem::default()
        }
    }

    #[test]
    fn matches_official_video_by_title_artist_and_duration_even_after_unrelated_rows() {
        let items = vec![
            video(
                OTHER,
                "Don't Stop Me",
                "UC-imitator",
                "4:00",
                "MUSIC_VIDEO_TYPE_OMV",
            ),
            video(
                OTHER,
                "Don't Stop Me",
                "UC-band",
                "4:00",
                "MUSIC_VIDEO_TYPE_UGC",
            ),
            video(
                OTHER,
                "Don't Stop Me (Acoustic)",
                "UC-band",
                "4:01",
                "MUSIC_VIDEO_TYPE_OMV",
            ),
            video(
                CLIP,
                "Don't Stop Me [Official Music Video]",
                "UC-band",
                "4:12",
                "MUSIC_VIDEO_TYPE_OMV",
            ),
        ];
        assert_eq!(
            clip_search_match(&search(items), &song()).as_deref(),
            Some(CLIP)
        );
    }

    #[test]
    fn rejects_wrong_versions_missing_metadata_restrictions_and_ambiguous_matches() {
        for title in [
            "Don't Stop Me (Live)",
            "Don't Stop Me (Remix)",
            "Don't Stop Me (Remastered 2011)",
        ] {
            assert_eq!(
                clip_search_match(
                    &search(vec![video(
                        CLIP,
                        title,
                        "UC-band",
                        "4:00",
                        "MUSIC_VIDEO_TYPE_OMV"
                    )]),
                    &song(),
                ),
                None
            );
        }
        let mut restricted = video(
            CLIP,
            "Don't Stop Me",
            "UC-band",
            "4:00",
            "MUSIC_VIDEO_TYPE_OMV",
        );
        restricted["musicResponsiveListItemRenderer"]["isPlayable"] = json!(false);
        for entries in [
            vec![restricted],
            vec![video(
                CLIP,
                "Don't Stop Me",
                "UC-band",
                "4:25",
                "MUSIC_VIDEO_TYPE_OMV",
            )],
            vec![video(
                CLIP,
                "Don't Stop Me",
                "UC-band",
                "4:99",
                "MUSIC_VIDEO_TYPE_OMV",
            )],
            vec![video(
                CLIP,
                "Don't Stop Me",
                "UC-band",
                "",
                "MUSIC_VIDEO_TYPE_OMV",
            )],
            vec![
                video(
                    CLIP,
                    "Don't Stop Me",
                    "UC-band",
                    "4:02",
                    "MUSIC_VIDEO_TYPE_OMV",
                ),
                video(
                    OTHER,
                    "Don't Stop Me",
                    "UC-band",
                    "3:58",
                    "MUSIC_VIDEO_TYPE_OMV",
                ),
            ],
        ] {
            assert_eq!(clip_search_match(&search(entries), &song()), None);
        }
    }
}

pub fn recommendations(response: &Value, seed: &str) -> Option<Vec<MediaItem>> {
    if !valid_video_id(seed) {
        return None;
    }
    let mut seen = std::collections::BTreeSet::new();
    let tracks = watch_queue(response)?
        .into_iter()
        .filter_map(|entry| entry.get("playlistPanelVideoRenderer"))
        .filter_map(panel_video)
        .filter(|item| {
            item.video_id
                .as_deref()
                .is_some_and(|id| id != seed && seen.insert(id.to_string()))
        })
        .take(20)
        .collect();
    Some(tracks)
}

fn panel_video(track: &Value) -> Option<MediaItem> {
    let video_id = track
        .get("videoId")
        .and_then(Value::as_str)
        .filter(|id| valid_video_id(id))?;

    let title = text_at(track, "/title");
    if title.trim().is_empty()
        || track.get("isPlayable").and_then(Value::as_bool) == Some(false)
        || !text_at(track, "/unplayableText").trim().is_empty()
        || track
            .pointer("/playabilityStatus/status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "OK")
    {
        return None;
    }

    let duration = text_at(track, "/lengthText");
    let mut artists: Vec<ItemRef> = Vec::new();
    let mut album = None;
    for field in ["longBylineText", "shortBylineText"] {
        if let Some(runs) = track
            .pointer(&format!("/{field}/runs"))
            .and_then(Value::as_array)
        {
            for run in runs {
                let endpoint = endpoint_of(run);
                let Some(browse_id) = endpoint.browse_id else {
                    continue;
                };
                let name = text_of(run).trim().to_string();
                if name.is_empty() {
                    continue;
                }
                if is_artist_page(endpoint.page_type.as_deref()) || browse_id.starts_with("UC") {
                    if !artists.iter().any(|artist| artist.browse_id == browse_id) {
                        artists.push(ItemRef { name, browse_id });
                    }
                } else if is_album_page(endpoint.page_type.as_deref())
                    || browse_id.starts_with("MPRE")
                {
                    album.get_or_insert(ItemRef { name, browse_id });
                }
            }
        }
    }
    Some(MediaItem {
        title,
        subtitle: text_at(track, "/shortBylineText"),
        video_id: Some(video_id.to_owned()),
        kind: kind_of(None, Some(video_id), music_video_type(track).as_deref()),
        duration: looks_like_duration(&duration).then_some(duration),
        thumbs: track.get("thumbnail").map(thumbs_of).unwrap_or_default(),
        artists,
        album,
        ..MediaItem::default()
    })
}

#[cfg(test)]
mod watch_track_tests {
    use super::watch_track;
    use serde_json::json;

    #[test]
    fn selects_only_the_requested_track_and_rejects_unplayable_items() {
        let id = "dQw4w9WgXcQ";
        let mut response = json!({
            "currentVideoEndpoint": {"watchEndpoint": {"videoId": id}},
            "contents": {"singleColumnMusicWatchNextResultsRenderer": {"tabbedRenderer": {
                "watchNextTabbedResultsRenderer": {"tabs": [
                    {"tabRenderer": {"content": {"musicQueueRenderer": {
                        "content": {"playlistPanelRenderer": {"contents": [
                            {"playlistPanelVideoRenderer": {"videoId": "M7lc1UVf-VE", "title": {"simpleText": "Unrelated"}}},
                            {"playlistPanelVideoRenderer": {
                                "videoId": id,
                                "title": {"runs": [{"text": "Requested track"}]},
                                "shortBylineText": {"simpleText": "Artist"},
                                "lengthText": {"simpleText": "3:34"}
                            }}
                        ]}}
                    }}}}
                ]}
            }}}
        });
        let track = watch_track(&response, id).unwrap();
        assert_eq!(track.title, "Requested track");
        assert_eq!(track.subtitle, "Artist");
        assert_eq!(track.duration.as_deref(), Some("3:34"));
        assert!(watch_track(&response, "M7lc1UVf-VE").is_none());

        let track = response.pointer_mut(
            "/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs/0/tabRenderer/content/musicQueueRenderer/content/playlistPanelRenderer/contents/1/playlistPanelVideoRenderer",
        ).unwrap();
        track["isPlayable"] = json!(false);
        assert!(watch_track(&response, id).is_none());
    }
}

pub fn suggestions(response: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(sections) = response.get("contents").and_then(Value::as_array) else {
        return out;
    };
    for section in sections {
        let Some(entries) = section
            .get("searchSuggestionsSectionRenderer")
            .and_then(|renderer| renderer.get("contents"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for entry in entries {
            let Some(suggestion) = entry
                .get("searchSuggestionRenderer")
                .and_then(|renderer| renderer.get("suggestion"))
            else {
                continue;
            };
            let text = text_of(suggestion);
            let text = text.trim();
            if !text.is_empty() && !out.iter().any(|existing| existing == text) {
                out.push(text.to_string());
            }
        }
    }
    out.truncate(10);
    out
}

// ---------------------------------------------------------------- detail pages

fn header_renderer(response: &Value) -> Option<(&'static str, &Value)> {
    let candidates: [(&str, &str); 7] = [
        (
            "album",
            "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicResponsiveHeaderRenderer",
        ),
        (
            "album",
            "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicEditablePlaylistDetailHeaderRenderer/header/musicDetailHeaderRenderer",
        ),
        (
            "playlist",
            "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicEditablePlaylistDetailHeaderRenderer/header/musicDetailHeaderRenderer",
        ),
        // Playlists the account owns come back with a responsive header, not a detail one.
        (
            "playlist",
            "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicEditablePlaylistDetailHeaderRenderer/header/musicResponsiveHeaderRenderer",
        ),
        (
            "artist",
            "/header/musicImmersiveHeaderRenderer",
        ),
        ("artist", "/header/musicVisualHeaderRenderer"),
        ("album", "/header/musicDetailHeaderRenderer"),
    ];
    for (kind, pointer) in candidates {
        if let Some(header) = response.pointer(pointer) {
            return Some((kind, header));
        }
    }
    None
}

pub fn detail(response: &Value) -> Detail {
    let (hint_kind, header) = match header_renderer(response) {
        Some(found) => found,
        None => {
            return Detail {
                header: DetailHeader::default(),
                sections: sections(response),
            }
        }
    };

    let title = text_at(header, "/title");
    let subtitle = text_at(header, "/subtitle");
    let meta = text_at(header, "/secondSubtitle");

    let mut description = None;
    for pointer in [
        "/description/musicDescriptionShelfRenderer/description",
        "/description",
    ] {
        if let Some(value) = header.pointer(pointer) {
            let text = text_of(value);
            if !text.trim().is_empty() {
                description = Some(text.trim().to_string());
                break;
            }
        }
    }

    let thumbs = {
        let nested = thumbs_of(
            header
                .pointer("/thumbnail/musicThumbnailRenderer/thumbnail")
                .unwrap_or(&Value::Null),
        );
        if nested.is_empty() {
            thumbs_of(header.get("thumbnail").unwrap_or(&Value::Null))
        } else {
            nested
        }
    };

    let mut artists: Vec<ItemRef> = Vec::new();
    let mut year = None;
    for (pointer, is_title_run) in [("/straplineTextOne", false), ("/subtitle", true)] {
        let Some(runs) = header
            .pointer(pointer)
            .and_then(|value| value.get("runs"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for run in runs {
            let run_text = text_of(run);
            let endpoint = endpoint_of(run);
            if let Some(browse_id) = endpoint.browse_id {
                if is_artist_page(endpoint.page_type.as_deref()) {
                    let name = run_text.trim().to_string();
                    if !name.is_empty() && !artists.iter().any(|a| a.browse_id == browse_id) {
                        artists.push(ItemRef { name, browse_id });
                    }
                }
            } else if is_title_run && year.is_none() && looks_like_year(&run_text) {
                year = Some(run_text.trim().to_string());
            }
        }
    }

    let kind = hint_kind.to_string();

    Detail {
        header: DetailHeader {
            kind,
            title,
            subtitle,
            meta,
            description,
            thumbs,
            browse_id: None,
            playlist_id: None,
            year,
            artists,
        },
        sections: sections(response),
    }
}

// --------------------------------------------------------------------- lyrics

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: Option<u64>,
}

#[cfg(test)]
mod recommendation_tests {
    use super::*;
    use serde_json::json;

    const SEED: &str = "SEEDseed123";

    fn row(id: &str) -> Value {
        json!({"playlistPanelVideoRenderer":{
            "videoId":id,"title":{"simpleText":"A song"},
            "shortBylineText":{"runs":[{"text":"Artist","navigationEndpoint":{"browseEndpoint":{"browseId":"UCartist"}}}]},
            "longBylineText":{"runs":[
                {"text":"Artist","navigationEndpoint":{"browseEndpoint":{"browseId":"UCartist"}}},
                {"text":" • "},
                {"text":"Album","navigationEndpoint":{"browseEndpoint":{"browseId":"MPREalbum"}}}
            ]},
            "lengthText":{"simpleText":"4:02"},
            "thumbnail":{"thumbnails":[{"url":"large","width":400},{"url":"small","width":100}]},
            "navigationEndpoint":{"watchEndpoint":{"watchEndpointMusicSupportedConfigs":{"watchEndpointMusicConfig":{"musicVideoType":"MUSIC_VIDEO_TYPE_ATV"}}}}
        }})
    }

    fn queue(entries: Vec<Value>) -> Value {
        json!({"contents":{"singleColumnMusicWatchNextResultsRenderer":{"tabbedRenderer":{
            "watchNextTabbedResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"musicQueueRenderer":{
                "content":{"playlistPanelRenderer":{"contents":entries}}
            }}}}]}
        }}}})
    }

    #[test]
    fn queue_metadata_preserves_navigation_artwork_and_duration() {
        let response = queue(vec![row("AAAAAAAAAAA")]);
        let tracks = recommendations(&response, SEED).unwrap();
        let item = &tracks[0];
        assert_eq!(item.title, "A song");
        assert_eq!(item.kind, "song");
        assert_eq!(item.subtitle, "Artist");
        assert_eq!(item.duration.as_deref(), Some("4:02"));
        assert_eq!(item.thumbs, vec!["small", "large"]);
        assert_eq!(item.artists.len(), 1);
        assert_eq!(item.artists[0].name, "Artist");
        assert_eq!(item.artists[0].browse_id, "UCartist");
        assert_eq!(item.album.as_ref().unwrap().name, "Album");
        assert_eq!(item.album.as_ref().unwrap().browse_id, "MPREalbum");
        assert!(watch_track(&response, "AAAAAAAAAAA").is_none());
    }

    #[test]
    fn unavailable_seed_duplicates_and_malformed_rows_are_skipped() {
        let mut blocked = row("BBBBBBBBBBB");
        blocked["playlistPanelVideoRenderer"]["isPlayable"] = json!(false);
        let mut unplayable = row("CCCCCCCCCCC");
        unplayable["playlistPanelVideoRenderer"]["unplayableText"] =
            json!({"simpleText":"Unavailable"});
        let mut status = row("DDDDDDDDDDD");
        status["playlistPanelVideoRenderer"]["playabilityStatus"] = json!({"status":"UNPLAYABLE"});
        let mut blank = row("EEEEEEEEEEE");
        blank["playlistPanelVideoRenderer"]["title"] = json!({"simpleText":"  "});
        let hidden = json!({"menu":{"playlistPanelVideoRenderer":row("FFFFFFFFFFF")["playlistPanelVideoRenderer"]}});
        let response = queue(vec![
            row(SEED),
            row("AAAAAAAAAAA"),
            row("AAAAAAAAAAA"),
            blocked,
            unplayable,
            status,
            blank,
            row("invalid"),
            row("AAAAAAAAAA+"),
            row(""),
            Value::Null,
            hidden,
            row("BBBBBBBBBBB"),
        ]);
        let tracks = recommendations(&response, SEED).unwrap();
        assert_eq!(
            tracks
                .iter()
                .filter_map(|item| item.video_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["AAAAAAAAAAA", "BBBBBBBBBBB"]
        );
    }

    #[test]
    fn candidate_limit_is_applied_after_filtering_in_server_order() {
        let mut entries = vec![row(SEED), row("invalid")];
        for index in 0..35 {
            let item = row(&format!("{index:011}"));
            entries.push(item.clone());
            entries.push(item);
        }
        let tracks = recommendations(&queue(entries), SEED).unwrap();
        assert_eq!(tracks.len(), 20);
        for (index, item) in tracks.iter().enumerate() {
            assert_eq!(
                item.video_id.as_deref(),
                Some(format!("{index:011}").as_str())
            );
        }
    }

    #[test]
    fn missing_or_malformed_queue_is_distinct_from_recognized_empty() {
        assert!(recommendations(&queue(vec![]), SEED).unwrap().is_empty());
        assert!(recommendations(&json!({}), SEED).is_none());
        assert!(recommendations(&json!({"tracking":{"musicQueueRenderer":{"content":{"playlistPanelRenderer":{"contents":[row("AAAAAAAAAAA")]}}}}}),SEED).is_none());
        let mut malformed = queue(vec![]);
        *malformed.pointer_mut("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs/0/tabRenderer/content/musicQueueRenderer/content/playlistPanelRenderer/contents").unwrap() = json!({"not":"an array"});
        assert!(recommendations(&malformed, SEED).is_none());
        assert!(recommendations(&queue(vec![row("AAAAAAAAAAA")]), "bad").is_none());
    }
}

#[derive(Clone, Debug, Default)]
pub struct LyricsPage {
    /// Lines with a start time, in the order the server lists them.
    pub lines: Vec<LyricLine>,
    /// Text without timings, when the server has no timed version.
    pub plain: Option<String>,
    pub source: Option<String>,
}

/// The lyrics page id sits on the "Lyrics" tab of a watch response.
pub fn lyrics_id(response: &Value) -> Option<String> {
    fn visit(node: &Value, found: &mut Option<String>) {
        match node {
            Value::Object(map) => {
                if found.is_none() {
                    let page_type = map
                        .get("browseEndpointContextSupportedConfigs")
                        .and_then(|config| config.get("browseEndpointContextMusicConfig"))
                        .and_then(|music| music.get("pageType"))
                        .and_then(Value::as_str);
                    if page_type == Some("MUSIC_PAGE_TYPE_TRACK_LYRICS") {
                        if let Some(id) = map.get("browseId").and_then(Value::as_str) {
                            *found = Some(id.to_string());
                        }
                    }
                }
                for value in map.values() {
                    if found.is_none() {
                        visit(value, found);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    if found.is_none() {
                        visit(item, found);
                    }
                }
            }
            _ => {}
        }
    }
    let mut found = None;
    visit(response, &mut found);
    found
}

/// Reads a lyrics page. Timed lines arrive from the mobile client as
/// `timedLyricsData`; the web client only fills a description shelf.
pub fn lyrics_page(response: &Value) -> LyricsPage {
    let source = find_string(response, "sourceMessage");
    let mut lines = Vec::new();
    let mut untimed: Vec<String> = Vec::new();
    if let Some(rows) = find_value(response, "timedLyricsData").and_then(Value::as_array) {
        for row in rows {
            let text = row
                .get("lyricLine")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                continue;
            }
            let start = row
                .pointer("/cueRange/startTimeMilliseconds")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u64>().ok());
            match start {
                Some(start) => lines.push(LyricLine {
                    text: text.to_string(),
                    start_ms: start,
                    end_ms: row
                        .pointer("/cueRange/endTimeMilliseconds")
                        .and_then(Value::as_str)
                        .and_then(|value| value.parse::<u64>().ok()),
                }),
                None => untimed.push(text.to_string()),
            }
        }
    }
    let plain = if lines.is_empty() {
        if untimed.is_empty() {
            description_lyrics(response)
        } else {
            Some(untimed.join("\n"))
        }
    } else {
        None
    };
    LyricsPage {
        lines,
        plain,
        source,
    }
}

fn description_lyrics(response: &Value) -> Option<String> {
    let shelf = find_value(response, "musicDescriptionShelfRenderer")?;
    let text = shelf.get("description").map(text_of).unwrap_or_default();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn find_value<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    match node {
        Value::Object(map) => {
            if let Some(value) = map.get(key) {
                return Some(value);
            }
            map.values().find_map(|value| find_value(value, key))
        }
        Value::Array(items) => items.iter().find_map(|item| find_value(item, key)),
        _ => None,
    }
}

fn find_string(node: &Value, key: &str) -> Option<String> {
    match node {
        Value::Object(map) => {
            if let Some(text) = map.get(key).and_then(Value::as_str) {
                return Some(text.to_string());
            }
            map.values().find_map(|value| find_string(value, key))
        }
        Value::Array(items) => items.iter().find_map(|item| find_string(item, key)),
        _ => None,
    }
}

#[cfg(test)]
mod lyrics_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn watch_byline_retains_artist_and_album_navigation() {
        let id = "dQw4w9WgXcQ";
        let response = json!({
            "currentVideoEndpoint": {"watchEndpoint": {"videoId": id}},
            "contents": {"singleColumnMusicWatchNextResultsRenderer": {"tabbedRenderer": {
                "watchNextTabbedResultsRenderer": {"tabs": [{"tabRenderer": {"content": {
                    "musicQueueRenderer": {"content": {"playlistPanelRenderer": {"contents": [{
                        "playlistPanelVideoRenderer": {
                            "videoId": id, "title": {"simpleText": "Song"},
                            "longBylineText": {"runs": [
                                {"text": "Artist", "navigationEndpoint": {"browseEndpoint": {"browseId": "UCartist"}}},
                                {"text": " • "},
                                {"text": "Album", "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREalbum"}}}
                            ]},
                            "shortBylineText": {"runs": [
                                {"text": "Artist", "navigationEndpoint": {"browseEndpoint": {"browseId": "UCartist"}}}
                            ]}
                        }
                    }]}}}
                }}}]}
            }}}
        });
        let track = watch_track(&response, id).unwrap();
        assert_eq!(track.artists.len(), 1);
        assert_eq!(track.artists[0].browse_id, "UCartist");
        assert_eq!(track.album.unwrap().browse_id, "MPREalbum");
    }

    #[test]
    fn finds_the_lyrics_tab() {
        let response = json!({
            "contents": {"tabs": [
                {"tabRenderer": {"title": "Up next"}},
                {"tabRenderer": {"endpoint": {"browseEndpoint": {
                    "browseId": "MPLYt_dqWTncCjkSp-4",
                    "browseEndpointContextSupportedConfigs": {
                        "browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_TRACK_LYRICS"}
                    }
                }}}}
            ]}
        });
        assert_eq!(lyrics_id(&response).as_deref(), Some("MPLYt_dqWTncCjkSp-4"));
    }

    #[test]
    fn reads_timed_lines() {
        let response = json!({
            "timedLyricsModel": {"lyricsData": {
                "timedLyricsData": [
                    {"lyricLine": "It's close to midnight", "cueRange": {"startTimeMilliseconds": "59040", "endTimeMilliseconds": "61220"}},
                    {"lyricLine": "Something evil's lurking in the dark", "cueRange": {"startTimeMilliseconds": "61220", "endTimeMilliseconds": "64000"}}
                ],
                "sourceMessage": "Source: LyricFind"
            }}
        });
        let page = lyrics_page(&response);
        assert_eq!(page.lines.len(), 2);
        assert_eq!(page.lines[0].start_ms, 59040);
        assert_eq!(page.lines[1].end_ms, Some(64000));
        assert!(page.plain.is_none());
        assert_eq!(page.source.as_deref(), Some("Source: LyricFind"));
    }

    #[test]
    fn falls_back_to_untimed_lines() {
        let response = json!({
            "timedLyricsData": [
                {"lyricLine": "Первая строка"},
                {"lyricLine": "Вторая строка"}
            ]
        });
        let page = lyrics_page(&response);
        assert!(page.lines.is_empty());
        assert_eq!(page.plain.as_deref(), Some("Первая строка\nВторая строка"));
    }

    #[test]
    fn falls_back_to_the_description_shelf() {
        let response = json!({
            "contents": {"sectionListRenderer": {"contents": [{"musicDescriptionShelfRenderer": {
                "description": {"runs": [{"text": "Текст песни"}, {"text": " целиком"}]}
            }}]}}
        });
        assert_eq!(
            lyrics_page(&response).plain.as_deref(),
            Some("Текст песни целиком")
        );
    }
}
