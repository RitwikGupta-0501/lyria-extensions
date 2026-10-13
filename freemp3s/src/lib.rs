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

// ── yt2api / ytapi Schema ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    pub videos: Vec<VideoItem>,
}

#[derive(Deserialize)]
struct VideoItem {
    pub id: String,
    pub title: String,
    #[serde(rename = "thumbMedium")]
    pub thumb_medium: Option<String>,
    #[serde(rename = "thumbHigh")]
    pub thumb_high: Option<String>,
    #[serde(rename = "channelTitle")]
    pub channel_title: Option<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: Option<String>,
    pub duration: Option<String>,
}

#[derive(Deserialize)]
struct InfoResponse {
    pub formats: Option<FormatsObject>,
}

#[derive(Deserialize)]
struct FormatsObject {
    #[serde(default)]
    pub audio: Vec<AudioFormatItem>,
}

#[derive(Deserialize)]
struct AudioFormatItem {
    pub quality: Option<u32>,
    pub ext: Option<String>,
    pub token: String,
}

#[derive(Deserialize)]
struct ConvertResponse {
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
}

#[derive(Deserialize)]
struct StatusResponse {
    pub status: Option<String>,
    pub enum_status: Option<i32>,
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
}

fn parse_duration_to_ms(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        2 => {
            let mins: u64 = parts[0].trim().parse().ok()?;
            let secs: u64 = parts[1].trim().parse().ok()?;
            Some((mins * 60 + secs) * 1000)
        }
        3 => {
            let hours: u64 = parts[0].trim().parse().ok()?;
            let mins: u64 = parts[1].trim().parse().ok()?;
            let secs: u64 = parts[2].trim().parse().ok()?;
            Some((hours * 3600 + mins * 60 + secs) * 1000)
        }
        _ => None,
    }
}

fn execute_http_request(
    method: &str,
    url: &str,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<String, String> {
    let req = HttpRequest {
        method: method.to_string(),
        url: url.to_string(),
        headers,
        body,
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
    let url = format!("https://b.ytapi.cc/api/search/{}", encoded_query);

    let mut headers = HashMap::new();
    headers.insert("Accept".to_string(), "application/json".to_string());
    headers.insert("Referer".to_string(), "https://freemp3s.org/".to_string());
    headers.insert("Origin".to_string(), "https://freemp3s.org".to_string());
    headers.insert(
        "User-Agent".to_string(),
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36".to_string(),
    );

    let body = match execute_http_request("GET", &url, Some(headers), None) {
        Ok(b) => b,
        Err(e) => {
            let _ = unsafe { host_log(format!("[FreeMP3s] Search failed: {}", e)) };
            return Ok(Vec::new());
        }
    };

    let search_res: SearchResponse = serde_json::from_str(&body).unwrap_or(SearchResponse {
        videos: Vec::new(),
    });

    let candidates: Vec<DownloadCandidateItem> = search_res
        .videos
        .into_iter()
        .map(|v| {
            let dur_str = v.duration.clone().unwrap_or_default();
            let duration_ms = parse_duration_to_ms(&dur_str);
            let art = v.thumb_high.or(v.thumb_medium);
            let artist = v.channel_title.unwrap_or_else(|| "YouTube".to_string());
            let published = v.published_at.unwrap_or_default();

            DownloadCandidateItem {
                native_id: v.id,
                title: v.title,
                artist,
                album: None,
                duration_ms,
                artwork_url: art,
                codec: Some(AudioCodec::Mp3),
                bitrate_kbps: Some(320),
                extra_info: Some(format!("MP3 320k • {} • {}", published, dur_str)),
            }
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
    // 1. Resolve Target Video ID (fast path vs auto search)
    let (video_id, candidate_art) = if let Some(target_id) = input.native_id.filter(|s| !s.trim().is_empty()) {
        (target_id.trim().to_string(), None)
    } else {
        let search_str = format!("{} {}", input.title, input.artist);
        let candidates = search_candidates_internal(&search_str)
            .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(e)))?;

        if candidates.is_empty() {
            return Err(WithReturnCode::from(extism_pdk::Error::msg(
                format!("No media found for '{} - {}'", input.artist, input.title)
            )));
        }

        let best = if let Some(target_dur) = input.duration_ms {
            candidates
                .into_iter()
                .min_by_key(|c| {
                    c.duration_ms
                        .map(|d| (d as i64 - target_dur as i64).abs())
                        .unwrap_or(i64::MAX)
                })
                .unwrap()
        } else {
            candidates.into_iter().next().unwrap()
        };

        (best.native_id, best.artwork_url)
    };

    // 2. Fetch Formats & Ephemeral JWT Token
    let info_url = format!("https://v5-n01.yt2api.com/api/v5/info/{}", video_id);
    let mut info_headers = HashMap::new();
    info_headers.insert("Accept".to_string(), "application/json".to_string());

    let info_body = execute_http_request("GET", &info_url, Some(info_headers), None)
        .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(format!("Failed fetching format info: {}", e))))?;

    let info_res: InfoResponse = serde_json::from_str(&info_body)
        .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(format!("Invalid format info JSON: {}", e))))?;

    let audio_formats = info_res.formats.map(|f| f.audio).unwrap_or_default();
    if audio_formats.is_empty() {
        return Err(WithReturnCode::from(extism_pdk::Error::msg("No audio formats available for video")));
    }

    // Pick 320 quality if present, or highest available
    let chosen_format = audio_formats
        .iter()
        .find(|f| f.quality == Some(320))
        .or_else(|| audio_formats.iter().max_by_key(|f| f.quality.unwrap_or(0)))
        .ok_or_else(|| WithReturnCode::from(extism_pdk::Error::msg("Failed selecting format")))?;

    let token = chosen_format.token.clone();

    // 3. Create Convert Job
    let convert_url = "https://v5-n01.yt2api.com/api/v5/convert";
    let mut convert_headers = HashMap::new();
    convert_headers.insert("Content-Type".to_string(), "application/json".to_string());
    convert_headers.insert("Accept".to_string(), "application/json".to_string());

    let convert_payload = serde_json::json!({ "token": token }).to_string();
    let convert_body = execute_http_request("POST", convert_url, Some(convert_headers), Some(convert_payload))
        .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(format!("Failed creating transcode job: {}", e))))?;

    let convert_res: ConvertResponse = serde_json::from_str(&convert_body)
        .map_err(|e| WithReturnCode::from(extism_pdk::Error::msg(format!("Invalid convert response: {}", e))))?;

    let job_id = convert_res.job_id
        .ok_or_else(|| WithReturnCode::from(extism_pdk::Error::msg("Missing jobId in convert response")))?;

    // 4. Poll Job Status (1-second intervals, max 12 seconds)
    let mut download_url: Option<String> = None;
    for _ in 0..12 {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let status_url = format!("https://v5-n01.yt2api.com/api/v5/status/{}", job_id);
        let mut status_headers = HashMap::new();
        status_headers.insert("Accept".to_string(), "application/json".to_string());

        if let Ok(status_body) = execute_http_request("GET", &status_url, Some(status_headers), None) {
            if let Ok(st) = serde_json::from_str::<StatusResponse>(&status_body) {
                if st.status.as_deref() == Some("completed") || st.enum_status == Some(2) {
                    download_url = st.download_url;
                    break;
                }
            }
        }
    }

    let final_download_url = download_url.ok_or_else(|| {
        WithReturnCode::from(extism_pdk::Error::msg("Transcode job timed out before completion"))
    })?;

    Ok(Json(DownloadSourceResult {
        download_url: final_download_url,
        codec: AudioCodec::Mp3,
        bitrate_kbps: Some(320),
        sample_rate_hz: Some(44100),
        bit_depth: None,
        content_length_bytes: None,
        headers: None,
        cover_art_url: candidate_art,
        lyrics_lrc: None,
    }))
}
