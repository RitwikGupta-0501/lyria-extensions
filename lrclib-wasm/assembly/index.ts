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
  const m = Memory.allocateString("[lrclib-wasm] " + msg);
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
  headersObj.set("User-Agent", "LyriaMusicPlayer/0.2.3 (https://github.com/RitwikGupta-0501/lyria-music-player)");
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
 * Output: Raw LRC string or plain text lyrics string
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

  const trackIdVal = query.getString("track_id");
  if (trackIdVal && trackIdVal.valueOf().length > 0) {
    const idUrl = "https://lrclib.net/api/get/" + trackIdVal.valueOf();
    const idBody = httpGet(idUrl);
    if (idBody && idBody.length > 0) {
      const data = <JSON.Obj>(JSON.parse(idBody));
      if (data) {
        const synced = data.getString("syncedLyrics");
        if (synced && synced.valueOf().length > 0) {
          Host.outputString(synced.valueOf());
          return 0;
        }
        const plain = data.getString("plainLyrics");
        if (plain && plain.valueOf().length > 0) {
          Host.outputString(plain.valueOf());
          return 0;
        }
      }
    }
  }

  const titleVal = query.getString("title");
  const artistVal = query.getString("artist");
  const albumVal = query.getString("album");
  const durationVal = query.getInteger("duration_ms");

  if (!titleVal || !artistVal) {
    Host.outputString("");
    return 0;
  }

  const title = titleVal.valueOf().trim();
  const artist = artistVal.valueOf().trim();
  const album = albumVal ? albumVal.valueOf().trim() : "";
  const durationSecs = durationVal ? durationVal.valueOf() / 1000 : 0;

  log("Searching lyrics for: " + artist + " - " + title);

  // 1. Try exact match from LRCLIB: /api/get
  let getUrl = "https://lrclib.net/api/get?track_name=" + urlEncode(title) + "&artist_name=" + urlEncode(artist);
  if (album.length > 0) {
    getUrl += "&album_name=" + urlEncode(album);
  }
  if (durationSecs > 0) {
    getUrl += "&duration=" + durationSecs.toString();
  }

  const getBody = httpGet(getUrl);
  if (getBody && getBody.length > 0) {
    const data = <JSON.Obj>(JSON.parse(getBody));
    if (data) {
      const synced = data.getString("syncedLyrics");
      if (synced && synced.valueOf().length > 0) {
        log("Found exact synced lyrics");
        Host.outputString(synced.valueOf());
        return 0;
      }
      const plain = data.getString("plainLyrics");
      if (plain && plain.valueOf().length > 0) {
        log("Found exact plain lyrics");
        Host.outputString(plain.valueOf());
        return 0;
      }
    }
  }

  // 2. Fallback to search endpoint: /api/search
  log("Exact match not found, falling back to search query...");
  const searchUrl = "https://lrclib.net/api/search?track_name=" + urlEncode(title) + "&artist_name=" + urlEncode(artist);
  const searchBody = httpGet(searchUrl);
  if (searchBody && searchBody.length > 0) {
    const searchArr = <JSON.Arr>(JSON.parse(searchBody));
    if (searchArr && searchArr._arr.length > 0) {
      // First pass: look for a search result with synced lyrics
      for (let i = 0; i < searchArr._arr.length; i++) {
        const item = <JSON.Obj>(searchArr._arr[i]);
        if (item) {
          const synced = item.getString("syncedLyrics");
          if (synced && synced.valueOf().length > 0) {
            log("Found search match with synced lyrics (result #" + (i + 1).toString() + ")");
            Host.outputString(synced.valueOf());
            return 0;
          }
        }
      }
      // Second pass: accept plain lyrics if no synced lyrics available
      for (let i = 0; i < searchArr._arr.length; i++) {
        const item = <JSON.Obj>(searchArr._arr[i]);
        if (item) {
          const plain = item.getString("plainLyrics");
          if (plain && plain.valueOf().length > 0) {
            log("Found search match with plain lyrics (result #" + (i + 1).toString() + ")");
            Host.outputString(plain.valueOf());
            return 0;
          }
        }
      }
    }
  }

  log("No lyrics found for: " + artist + " - " + title);
  Host.outputString("");
  return 0;
}

/**
 * Exported Extism Hook: search_lyrics
 * 
 * Input: Search query string (raw or JSON with { query: string })
 * Output: JSON array of LyricsSearchResultItem
 */
export function search_lyrics(): i32 {
  const rawInput = Host.inputString();
  if (rawInput.length == 0) {
    Host.outputString("[]");
    return 0;
  }

  let searchTerm = rawInput.trim();
  if (searchTerm.startsWith("{")) {
    const parsed = <JSON.Obj>(JSON.parse(searchTerm));
    if (parsed) {
      const qVal = parsed.getString("query");
      if (qVal) {
        searchTerm = qVal.valueOf().trim();
      }
    }
  }

  if (searchTerm.length == 0) {
    Host.outputString("[]");
    return 0;
  }

  log("Searching LRCLIB candidates for: " + searchTerm);
  const searchUrl = "https://lrclib.net/api/search?q=" + urlEncode(searchTerm);
  const searchBody = httpGet(searchUrl);
  if (!searchBody || searchBody.length == 0) {
    Host.outputString("[]");
    return 0;
  }

  const rawArr = <JSON.Arr>(JSON.parse(searchBody));
  if (!rawArr || rawArr._arr.length == 0) {
    Host.outputString("[]");
    return 0;
  }

  const outArr = new JSON.Arr();
  const count = rawArr._arr.length > 10 ? 10 : rawArr._arr.length;

  for (let i = 0; i < count; i++) {
    const item = <JSON.Obj>(rawArr._arr[i]);
    if (!item) continue;

    const idVal = item.getInteger("id");
    const trackNameVal = item.getString("trackName");
    const nameVal = item.getString("name");
    const artistVal = item.getString("artistName");
    const albumVal = item.getString("albumName");
    const durVal = item.getFloat("duration");
    const durInt = item.getInteger("duration");
    const syncedVal = item.getString("syncedLyrics");
    const plainVal = item.getString("plainLyrics");

    const titleStr = trackNameVal ? trackNameVal.valueOf() : (nameVal ? nameVal.valueOf() : "");
    const artistStr = artistVal ? artistVal.valueOf() : "Unknown";
    const idStr = idVal ? idVal.valueOf().toString() : i.toString();

    const hasSynced: bool = syncedVal != null && syncedVal.valueOf().length > 0;
    const hasPlain: bool = plainVal != null && plainVal.valueOf().length > 0;
    if (!hasSynced && !hasPlain) {
      continue;
    }

    let durMs: i64 = 0;
    if (durVal) {
      durMs = <i64>(durVal.valueOf() * 1000.0);
    } else if (durInt) {
      durMs = durInt.valueOf() * 1000;
    }

    const resObj = new JSON.Obj();
    resObj.set("id", idStr);
    resObj.set("title", titleStr);
    resObj.set("artist", artistStr);
    if (albumVal && albumVal.valueOf().length > 0) {
      resObj.set("album", albumVal.valueOf());
    }
    if (durMs > 0) {
      resObj.set("duration_ms", durMs);
    }
    resObj.set("format", hasSynced ? "synced" : "plain");
    resObj.set("provider_id", "lrclib-wasm.wasm");
    resObj.set("provider_name", "LRCLIB");

    let preview = "";
    if (hasSynced) {
      const syncStr = (<JSON.Str>syncedVal).valueOf();
      const firstLineEnd = syncStr.indexOf("\n");
      const firstLine = firstLineEnd > 0 ? syncStr.slice(0, firstLineEnd) : syncStr;
      const bracketEnd = firstLine.indexOf("]");
      if (bracketEnd >= 0 && bracketEnd + 1 < firstLine.length) {
        preview = firstLine.slice(bracketEnd + 1).trim();
      } else {
        preview = firstLine.trim();
      }
    } else if (hasPlain) {
      const plainStr = (<JSON.Str>plainVal).valueOf();
      const firstLineEnd = plainStr.indexOf("\n");
      preview = (firstLineEnd > 0 ? plainStr.slice(0, firstLineEnd) : plainStr).trim();
    }
    if (preview.length > 0) {
      resObj.set("preview_text", preview);
    }

    outArr.push(resObj);
  }

  Host.outputString(outArr.stringify());
  return 0;
}

