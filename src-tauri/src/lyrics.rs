//! Karaoke lyrics. YouTube Music answers with timestamped lines for the
//! Android client, which is the primary source; when it only has plain text,
//! LRCLIB is asked for an LRC file, since it is free, keyless and often has
//! timings where the catalogue does not.

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::ytm::api;
use crate::ytm::parse::LyricLine;
use crate::ytm::Ytm;

const LRCLIB: &str = "https://lrclib.net/api";
const USER_AGENT: &str = "YtMusicDT/0.1 (playlist client)";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// Lines with a start time; empty when only plain text was found.
    pub lines: Vec<LyricLine>,
    /// Text without timings, when no timed version exists anywhere.
    pub plain: Option<String>,
    /// youtube | lrclib
    pub source: String,
    /// Who supplied the text, when the source names itself (LyricFind).
    pub attribution: Option<String>,
    pub timed: bool,
}

/// Whatever the player already knows about the track. A local file has no
/// video id, so this is what LRCLIB gets searched with.
#[derive(Clone, Debug, Default)]
pub struct TrackInfo {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub seconds: Option<u32>,
}

/// Reads lyrics for the playing track: YouTube Music first, LRCLIB second,
/// plain YouTube Music text as the last resort.
pub async fn fetch(ytm: &Ytm, video_id: Option<&str>, info: TrackInfo) -> Result<Lyrics> {
    let mut info = info;
    let mut plain: Option<String> = None;

    if let Some(video_id) = video_id {
        match api::watch(ytm, video_id).await {
            Ok(watch) => {
                if let Some(track) = &watch.track {
                    if info.title.trim().is_empty() {
                        info.title = track.title.clone();
                    }
                    if info.artist.trim().is_empty() {
                        info.artist = track
                            .artists
                            .first()
                            .map(|artist| artist.name.clone())
                            .unwrap_or_default();
                    }
                    if info.album.is_none() {
                        info.album = track.album.as_ref().map(|album| album.name.clone());
                    }
                    if info.seconds.is_none() {
                        info.seconds = track.duration.as_deref().and_then(parse_clock);
                    }
                }
                if let Some(browse_id) = watch.lyrics_id {
                    match api::timed_lyrics(ytm, &browse_id).await {
                        Ok(page) => {
                            if !page.lines.is_empty() {
                                return Ok(Lyrics {
                                    attribution: page.source.as_deref().map(clean_attribution),
                                    lines: page.lines,
                                    plain: None,
                                    source: "youtube".into(),
                                    timed: true,
                                });
                            }
                            plain = page.plain;
                        }
                        Err(_) => {}
                    }
                    if plain.is_none() {
                        if let Ok(Some(text)) = api::plain_lyrics(ytm, &browse_id).await {
                            plain = Some(text);
                        }
                    }
                }
            }
            Err(_) => {}
        }
    }

    if !info.title.trim().is_empty() {
        if let Some(lines) = lrclib(ytm, &info).await {
            return Ok(Lyrics {
                lines,
                plain: None,
                source: "lrclib".into(),
                attribution: Some("LRCLIB".into()),
                timed: true,
            });
        }
    }

    match plain {
        Some(text) => Ok(Lyrics {
            lines: Vec::new(),
            plain: Some(text),
            source: "youtube".into(),
            attribution: None,
            timed: false,
        }),
        None => Err(Error::api("Текст этой песни не нашёлся")),
    }
}

/// LRCLIB wants an exact match on the GET endpoint; a miss falls back to the
/// fuzzy search, which is where edited titles and remasters are found.
async fn lrclib(ytm: &Ytm, info: &TrackInfo) -> Option<Vec<LyricLine>> {
    let mut query: Vec<(&str, String)> = vec![
        ("track_name", info.title.trim().to_string()),
        ("artist_name", info.artist.trim().to_string()),
    ];
    if let Some(album) = info.album.as_deref().map(str::trim).filter(|album| !album.is_empty()) {
        query.push(("album_name", album.to_string()));
    }
    if let Some(seconds) = info.seconds {
        query.push(("duration", seconds.to_string()));
    }
    if let Some(text) = request_synced(ytm, "/get", &query).await {
        return Some(text);
    }
    // The search endpoint ignores duration, so a slightly different length
    // (a remaster, a live take) still finds the song.
    let search: Vec<(&str, String)> = vec![
        ("track_name", info.title.trim().to_string()),
        ("artist_name", info.artist.trim().to_string()),
    ];
    let response = ytm
        .http
        .get(format!("{LRCLIB}/search"))
        .query(&search)
        .header("user-agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    for entry in body.as_array()? {
        if let Some(lines) = entry
            .get("syncedLyrics")
            .and_then(Value::as_str)
            .map(parse_lrc)
            .filter(|lines| !lines.is_empty())
        {
            return Some(lines);
        }
    }
    None
}

async fn request_synced(
    ytm: &Ytm,
    path: &str,
    query: &[(&str, String)],
) -> Option<Vec<LyricLine>> {
    let response = ytm
        .http
        .get(format!("{LRCLIB}{path}"))
        .query(query)
        .header("user-agent", USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("syncedLyrics")
        .and_then(Value::as_str)
        .map(parse_lrc)
        .filter(|lines| !lines.is_empty())
}

/// Reads an LRC file. Untimed lines and `[ar:…]`-style tags are dropped; a line
/// may carry several timestamps (repeated choruses are written that way).
pub fn parse_lrc(text: &str) -> Vec<LyricLine> {
    let mut entries: Vec<(u64, String)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_start_matches('\u{feff}');
        let mut cursor = 0usize;
        let mut stamps: Vec<u64> = Vec::new();
        while let Some(rest) = line[cursor..].strip_prefix('[') {
            let Some(end) = rest.find(']') else {
                break;
            };
            if let Some(stamp) = parse_stamp(&rest[..end]) {
                stamps.push(stamp);
            }
            cursor += 1 + end + 1;
            if cursor >= line.len() {
                break;
            }
        }
        if stamps.is_empty() {
            continue;
        }
        let content = line[cursor..].trim();
        if content.is_empty() {
            continue;
        }
        for stamp in stamps {
            entries.push((stamp, content.to_string()));
        }
    }
    entries.sort_by_key(|(stamp, _)| *stamp);
    let mut lines: Vec<LyricLine> = Vec::with_capacity(entries.len());
    for (index, (start, text)) in entries.iter().enumerate() {
        lines.push(LyricLine {
            text: text.clone(),
            start_ms: *start,
            end_ms: entries.get(index + 1).map(|(next, _)| *next),
        });
    }
    lines
}

/// `mm:ss.xx`, `mm:ss.xxx` and the older `mm:ss:xx`.
fn parse_stamp(tag: &str) -> Option<u64> {
    let (minutes, rest) = tag.split_once(':')?;
    if minutes.is_empty() || !minutes.chars().all(|symbol| symbol.is_ascii_digit()) {
        return None;
    }
    let minutes: u64 = minutes.parse().ok()?;
    let (seconds, fraction) = match rest.split_once(['.', ':']) {
        Some((seconds, fraction)) => (seconds, Some(fraction)),
        None => (rest, None),
    };
    if seconds.is_empty() || !seconds.chars().all(|symbol| symbol.is_ascii_digit()) {
        return None;
    }
    let seconds: u64 = seconds.parse().ok()?;
    if seconds >= 60 {
        return None;
    }
    let millis = match fraction {
        None => 0,
        Some(fraction) if fraction.is_empty() => 0,
        Some(fraction) if fraction.chars().all(|symbol| symbol.is_ascii_digit()) => {
            let digits: String = fraction.chars().take(3).collect();
            let value: u64 = digits.parse().ok()?;
            match digits.len() {
                1 => value * 100,
                2 => value * 10,
                _ => value,
            }
        }
        Some(_) => return None,
    };
    Some(minutes * 60_000 + seconds * 1_000 + millis)
}

/// The page says `Source: LyricFind` or its localised twin `Источник: LyricFind`;
/// the UI only needs the name.
fn clean_attribution(text: &str) -> String {
    let text = text.trim();
    match text.split_once(':') {
        Some((_, rest)) if !rest.trim().is_empty() => rest.trim().to_string(),
        _ => text.to_string(),
    }
}

fn parse_clock(text: &str) -> Option<u32> {
    let mut seconds = 0u32;
    for part in text.split(':') {
        seconds = seconds.checked_mul(60)?.checked_add(part.trim().parse().ok()?)?;
    }
    (seconds > 0).then_some(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_standard_lrc() {
        let text = "[ar:Michael Jackson]\n[ti:Thriller]\n[00:58.87] It's close to midnight\n[01:02.14]Something evil's lurking";
        let lines = parse_lrc(text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].start_ms, 58_870);
        assert_eq!(lines[0].text, "It's close to midnight");
        assert_eq!(lines[0].end_ms, Some(62_140));
        assert_eq!(lines[1].end_ms, None);
    }

    #[test]
    fn reads_millisecond_precision_and_repeats() {
        let text = "[00:01.123][00:31.500]Chorus\n[00:05.10]Verse";
        let lines = parse_lrc(text);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].start_ms, 1_123);
        assert_eq!(lines[1].start_ms, 5_100);
        assert_eq!(lines[2].start_ms, 31_500);
    }

    #[test]
    fn skips_untimed_and_broken_lines() {
        let text = "no timestamps here\n[00:00.00]\n[bad]line\n[00:60.00]out of range";
        assert!(parse_lrc(text).is_empty());
    }

    #[test]
    fn reads_the_old_colon_format() {
        assert_eq!(parse_stamp("01:02:50"), Some(62_500));
    }

    #[test]
    fn parses_clock_durations() {
        assert_eq!(parse_clock("3:45"), Some(225));
        assert_eq!(parse_clock("1:02:41"), Some(3761));
        assert_eq!(parse_clock("—"), None);
    }

    /// Live chain: YouTube Music's timestamped lines for a track that has them,
    /// and LRCLIB for one that only has plain text in the catalogue.
    #[test]
    #[ignore = "reads music.youtube.com and lrclib.net"]
    fn fetches_live_lyrics() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let ytm = Ytm::new(
            reqwest::Client::new(),
            std::env::temp_dir().join("ytmusicdt-lyrics-test.json"),
        );

        let timed = runtime
            .block_on(fetch(&ytm, Some("Z85lxckrtzg"), TrackInfo::default()))
            .expect("thriller lyrics");
        assert!(timed.timed, "{timed:?}");
        assert!(timed.lines.len() > 20, "{}", timed.lines.len());
        assert_eq!(timed.source, "youtube");
        assert_eq!(timed.attribution.as_deref(), Some("LyricFind"));
        assert!(timed.lines.windows(2).all(|pair| pair[0].start_ms <= pair[1].start_ms));

        let fallback = runtime
            .block_on(fetch(
                &ytm,
                Some("xtxjm7ciwmc"),
                TrackInfo {
                    title: "Группа крови".into(),
                    artist: "Кино".into(),
                    album: None,
                    seconds: Some(285),
                },
            ))
            .expect("kino lyrics");
        assert!(fallback.timed, "{fallback:?}");
        assert!(!fallback.lines.is_empty());
    }
}
