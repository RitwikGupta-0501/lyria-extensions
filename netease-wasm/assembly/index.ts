import { JSON } from "assemblyscript-json/assembly";
import { Host, Memory } from "@extism/as-pdk";
import { length } from "@extism/as-pdk/lib/env";

// Local abort handler to avoid missing env::abort import in Extism
function myAbort(
  message: string | null,
  fileName: string | null,
  lineNumber: u32,
  columnNumber: u32
): void { }

// Declare Lyria Host Imports (Extism User Functions)
@external("extism:host/user", "host_http_request")
declare function host_http_request(ptr: u64): u64;

@external("extism:host/user", "host_log")
declare function host_log(ptr: u64): void;

function log(msg: string): void {
  const m = Memory.allocateString("[netease-wasm] " + msg);
  host_log(m.offset);
  m.free();
}

/**
 * Standard RFC 3986 percent-encoding for query string parameters.
 */
function urlEncode(str: string): string {
  let out = "";
  const utf8 = Uint8Array.wrap(String.UTF8.encode(str));
  for (let i = 0; i < utf8.length; i++) {
    const b = utf8[i];
    // A-Z, a-z, 0-9, -, _, ., ~
    if (
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b == 0x2d || b == 0x5f || b == 0x2e || b == 0x7e
    ) {
      out += String.fromCharCode(b);
    } else if (b == 0x20) {
      out += "+";
    } else {
      const hex = b.toString(16).toUpperCase();
      out += "%" + (hex.length == 1 ? "0" + hex : hex);
    }
  }
  return out;
}

/**
 * Dispatches an HTTP GET request through the Lyria host async reqwest bridge.
 */
function httpGet(url: string): string | null {
  const reqObj = new JSON.Obj();
  reqObj.set("method", "GET");
  reqObj.set("url", url);

  const headersObj = new JSON.Obj();
  headersObj.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  headersObj.set("Referer", "https://music.163.com/");
  reqObj.set("headers", headersObj);

  const reqStr = reqObj.stringify();
  const reqMem = Memory.allocateString(reqStr);
  const resPtr = host_http_request(reqMem.offset);
  reqMem.free();

  if (resPtr == 0) {
    return null;
  }

  const resLen = length(resPtr);
  const resMem = new Memory(resPtr, resLen);
  const resStr = resMem.toString();
  resMem.free();

  const respParsed = <JSON.Obj>(JSON.parse(resStr));
  if (!respParsed) {
    return null;
  }

  const statusNum = respParsed.getInteger("status");
  if (!statusNum || statusNum.valueOf() != 200) {
    return null;
  }

  const bodyStr = respParsed.getString("body");
  if (!bodyStr) {
    return null;
  }

  return bodyStr.valueOf();
}

/**
 * Exported Extism Hook: get_lyrics
 * 
 * Input: JSON string representing LyricsQuery { title, artist, album?, duration_ms? }
 * Output: Raw LRC string
 */
export function get_lyrics(): i32 {
  const rawInput = Host.inputString();
  if (rawInput.length == 0) {
    Host.outputString("");
    return 0;
  }

  const query = <JSON.Obj>(JSON.parse(rawInput));
  if (!query) {
    Host.outputString("");
    return 0;
  }

  const titleVal = query.getString("title");
  const artistVal = query.getString("artist");
  const durationVal = query.getInteger("duration_ms");

  if (!titleVal) {
    Host.outputString("");
    return 0;
  }

  const title = titleVal.valueOf().trim();
  const artist = artistVal ? artistVal.valueOf().trim() : "";
  const targetDurationMs: i64 = durationVal ? durationVal.valueOf() : 0;

  log("Searching NetEase lyrics for: " + (artist.length > 0 ? artist + " - " : "") + title);

  // 1. Candidate search via suggest endpoint
  const queries: string[] = [];
  if (artist.length > 0) {
    queries.push(title + " " + artist);
    queries.push(artist + " " + title);
  }
  queries.push(title);

  let candidateSongs: JSON.Arr | null = null;
  for (let qIdx = 0; qIdx < queries.length; qIdx++) {
    const qStr = queries[qIdx];
    const suggestUrl = "https://music.163.com/api/search/suggest/web?s=" + urlEncode(qStr) + "&limit=5";
    const body = httpGet(suggestUrl);
    if (body && body.length > 0) {
      const parsed = <JSON.Obj>(JSON.parse(body));
      if (parsed) {
        const resultObj = parsed.getObj("result");
        if (resultObj) {
          const songsArr = resultObj.getArr("songs");
          if (songsArr && songsArr._arr.length > 0) {
            candidateSongs = songsArr;
            log("Query '" + qStr + "' matched " + songsArr._arr.length.toString() + " candidate(s)");
            break;
          }
        }
      }
    }
  }

  if (!candidateSongs || candidateSongs._arr.length == 0) {
    log("No candidates found on NetEase");
    Host.outputString("");
    return 0;
  }

  // 2. Score and pick best candidate song
  let bestId: i64 = -1;
  let highestScore: i32 = -1;

  const targetTitleLower = title.toLowerCase();
  const targetArtistLower = artist.toLowerCase();

  for (let i = 0; i < candidateSongs._arr.length; i++) {
    const songObj = <JSON.Obj>(candidateSongs._arr[i]);
    if (!songObj) continue;

    const idVal = songObj.getInteger("id");
    if (!idVal) continue;
    const songId = idVal.valueOf();

    const nameVal = songObj.getString("name");
    const songName = nameVal ? nameVal.valueOf().toLowerCase() : "";

    let score: i32 = 0;

    // Title match scoring
    if (songName == targetTitleLower) {
      score += 50;
    } else if (songName.includes(targetTitleLower) || targetTitleLower.includes(songName)) {
      score += 30;
    }

    // Artist match scoring
    if (targetArtistLower.length > 0) {
      const artistsArr = songObj.getArr("artists");
      if (artistsArr) {
        for (let aIdx = 0; aIdx < artistsArr._arr.length; aIdx++) {
          const artistObj = <JSON.Obj>(artistsArr._arr[aIdx]);
          if (artistObj) {
            const aNameVal = artistObj.getString("name");
            if (aNameVal) {
              const aName = aNameVal.valueOf().toLowerCase();
              if (aName.includes(targetArtistLower) || targetArtistLower.includes(aName)) {
                score += 30;
                break;
              }
            }
          }
        }
      }
    }

    // Duration proximity scoring (difference <= 5s)
    if (targetDurationMs > 0) {
      const durVal = songObj.getInteger("duration");
      if (durVal) {
        const diffMs = abs(durVal.valueOf() - targetDurationMs);
        if (diffMs <= 3000) {
          score += 20;
        } else if (diffMs <= 10000) {
          score += 10;
        }
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestId = songId;
    }
  }

  // Fallback: If no candidate scored above 0, use first candidate
  if (bestId < 0 && candidateSongs._arr.length > 0) {
    const firstSong = <JSON.Obj>(candidateSongs._arr[0]);
    if (firstSong) {
      const idVal = firstSong.getInteger("id");
      if (idVal) bestId = idVal.valueOf();
    }
  }

  if (bestId < 0) {
    log("Failed to select a valid candidate ID");
    Host.outputString("");
    return 0;
  }

  log("Selected NetEase song ID: " + bestId.toString() + " (score: " + highestScore.toString() + ")");

  // 3. Fetch lyrics
  const lyricUrl = "https://music.163.com/api/song/lyric?id=" + bestId.toString() + "&lv=1&kv=1&tv=-1";
  const lyricBody = httpGet(lyricUrl);
  if (lyricBody && lyricBody.length > 0) {
    const lyricJson = <JSON.Obj>(JSON.parse(lyricBody));
    if (lyricJson) {
      const lrcObj = lyricJson.getObj("lrc");
      if (lrcObj) {
        const lrcStr = lrcObj.getString("lyric");
        if (lrcStr && lrcStr.valueOf().trim().length > 0) {
          log("Successfully retrieved synchronized lyrics from NetEase");
          Host.outputString(lrcStr.valueOf());
          return 0;
        }
      }
    }
  }

  log("No lyrics found in NetEase response for ID " + bestId.toString());
  Host.outputString("");
  return 0;
}
