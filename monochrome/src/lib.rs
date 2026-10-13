use std::collections::HashMap;
use extism_pdk::*;
use serde::{Deserialize, Serialize};

#[host_fn("extism:host/user")]
extern "ExtismHost" {
    fn host_http_request(req: String) -> String;
    fn host_log(msg: String);
}

#[derive(Serialize, Deserialize)]
struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Flac,
    Opus,
    Aac,
    Mp3,
    Vorbis,
    Wav,
    M4a,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadCandidateItem {
    pub native_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub artwork_url: Option<String>,
    pub codec: Option<AudioCodec>,
    pub bitrate_kbps: Option<u32>,
    pub extra_info: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadQueryInput {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub isrc: Option<String>,
    pub native_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadSourceResult {
    pub download_url: String,
    pub codec: AudioCodec,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub bit_depth: Option<u8>,
    pub content_length_bytes: Option<u64>,
    pub headers: Option<HashMap<String, String>>,
    pub cover_art_url: Option<String>,
    pub lyrics_lrc: Option<String>,
}

// ── Monochrome API Schema ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct MonochromeSearchResponse {
    #[serde(default)]
    pub tracks: Vec<MonochromeTrack>,
}

#[derive(Deserialize)]
struct MonochromeTrack {
    pub id: Option<String>,
    #[serde(rename = "trackId")]
    pub track_id: Option<String>,
    pub title: String,
    #[serde(rename = "artistNames", default)]
    pub artist_names: Vec<String>,
    pub duration: Option<u64>,
    pub artwork: Option<String>,
    #[serde(default)]
    pub playable: bool,
}

fn execute_http_get(url: &str) -> Result<String, String> {
    let mut headers = HashMap::new();
    headers.insert("Accept".to_string(), "application/json".to_string());
    headers.insert("User-Agent".to_string(), "Lyria/0.2.3".to_string());

    let req = HttpRequest {
        method: "GET".to_string(),
        url: url.to_string(),
        headers: Some(headers),
        body: None,
    };

    let req_json = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    let resp_json = unsafe { host_http_request(req_json) }.map_err(|e| format!("{:?}", e))?;
    let resp: HttpResponse = serde_json::from_str(&resp_json).map_err(|e| e.to_string())?;

    if resp.status >= 200 && resp.status < 300 {
        Ok(resp.body)
    } else {
        Err(format!("HTTP error {}: {}", resp.status, resp.body))
    }
}

// ── Exported PDK Functions ──────────────────────────────────────────────────

fn search_candidates_internal(query: &str) -> Result<Vec<DownloadCandidateItem>, String> {
    let encoded_query = urlencoding::encode(query.trim());
    let url = format!(
        "https://tracks.monochrome.st/search/tracks?q={}&limit=10",
        encoded_query
    );

    let body = match execute_http_get(&url) {
        Ok(b) => b,
        Err(e) => {
            let _ = unsafe { host_log(format!("[Monochrome] Search failed: {}", e)) };
            return Ok(Vec::new());
        }
    };

    let search_res: MonochromeSearchResponse = serde_json::from_str(&body).unwrap_or(MonochromeSearchResponse {
        tracks: Vec::new(),
    });

    let candidates: Vec<DownloadCandidateItem> = search_res
        .tracks
        .into_iter()
        .filter(|t| t.playable)
        .filter_map(|t| {
            let target_id = t.track_id.or(t.id)?;
            let artist_name = if t.artist_names.is_empty() {
                "Unknown Artist".to_string()
            } else {
                t.artist_names.join(", ")
            };

            Some(DownloadCandidateItem {
                native_id: target_id,
                title: t.title,
                artist: artist_name,
                album: None,
                duration_ms: t.duration,
                artwork_url: t.artwork,
                codec: Some(AudioCodec::Flac),
                bitrate_kbps: Some(1411),
                extra_info: Some("Lossless FLAC (16/24-bit)".to_string()),
            })
        })
        .collect();

    Ok(candidates)
}

#[plugin_fn]
pub fn search_download_candidates(query: String) -> FnResult<Json<Vec<DownloadCandidateItem>>> {
    let candidates = search_candidates_internal(&query)
        .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(e)))?;
    Ok(Json(candidates))
}

#[plugin_fn]
pub fn resolve_download(Json(input): Json<DownloadQueryInput>) -> FnResult<Json<DownloadSourceResult>> {
    // 1. FAST PATH: user explicitly selected candidate from search
    if let Some(target_id) = input.native_id.filter(|s| !s.trim().is_empty()) {
        let stream_url = format!("https://tracks.monochrome.st/track/{}", target_id.trim());
        return Ok(Json(DownloadSourceResult {
            download_url: stream_url,
            codec: AudioCodec::Flac,
            bitrate_kbps: Some(1411),
            sample_rate_hz: Some(44100),
            bit_depth: Some(16),
            content_length_bytes: None,
            headers: None,
            cover_art_url: None,
            lyrics_lrc: None,
        }));
    }

    // 2. AUTO PATH: query API, pick closest duration match
    let search_str = format!("{} {}", input.title, input.artist);
    let candidates = search_candidates_internal(&search_str)
        .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(e)))?;

    if candidates.is_empty() {
        return Err(WithReturnCode::from(extism_pdk::Error::msg(
            format!("No playable tracks found for '{} - {}'", input.artist, input.title)
        )));
    }

    // Best match: minimum duration difference if duration is known, else first candidate
    let best = if let Some(target_dur) = input.duration_ms {
        candidates
            .into_iter()
            .min_by_key(|c| {
                let diff = c.duration_ms.map(|d| (d as i64 - target_dur as i64).abs()).unwrap_or(i64::MAX);
                diff
            })
            .unwrap()
    } else {
        candidates.into_iter().next().unwrap()
    };

    let stream_url = format!("https://tracks.monochrome.st/track/{}", best.native_id);

    Ok(Json(DownloadSourceResult {
        download_url: stream_url,
        codec: AudioCodec::Flac,
        bitrate_kbps: Some(1411),
        sample_rate_hz: Some(44100),
        bit_depth: Some(16),
        content_length_bytes: None,
        headers: None,
        cover_art_url: best.artwork_url,
        lyrics_lrc: None,
    }))
}
