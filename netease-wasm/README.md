# NetEase Lyrics Extension (`netease-wasm`)

An algorithmically fast, lightweight WebAssembly extension for **Lyria Music Player** that resolves synchronized line-by-line and translated lyrics from [NetEase Cloud Music](https://music.163.com).

Built in **TypeScript / AssemblyScript (`asc`)** compiling to a ~41KB WASM binary running inside the sandboxed Extism runtime.

---

## Capabilities & Architecture

- **Capability:** `lyrics`
- **Priority:** `9` (fallback/alternative provider to LRCLIB)
- **Sandbox Runtime:** Extism WebAssembly with host HTTP dispatch (`host_http_request`)
- **Memory Footprint:** ~41KB WASM binary (negligible share of the 40MB total app RAM budget)
- **Exported Function:** `get_lyrics`

### Extism Host Bridge
The extension communicates with the Lyria Rust daemon through Extism host functions registered in the `"extism:host/user"` namespace:
```typescript
@external("extism:host/user", "host_http_request")
declare function host_http_request(request_offset: u64): u64;
```
The extension serializes an HTTP request `{ url: "...", method: "GET", headers: { "Referer": "https://music.163.com/" } }` into WASM memory and invokes `host_http_request`. The Rust host executes an async `reqwest` call and returns the HTTP status code and response body back into WASM memory.

---

## Resolution Workflow

When Lyria cues or plays a track, it calls `get_lyrics` with a JSON payload:
```json
{
  "title": "Bohemian Rhapsody",
  "artist": "Queen",
  "album": "A Night at the Opera",
  "duration_ms": 354000
}
```

The extension executes a 3-stage resolution pipeline:

1. **Candidate Discovery (`/api/search/suggest/web`)**:
   - Queries `https://music.163.com/api/search/suggest/web?s={query}&limit=5`.
   - Iterates candidate query strategies (`title + artist`, `artist + title`, `title`).
   - Obtains an array of candidate songs with track IDs, localized names, artists, and durations.
2. **Scoring & Best Match Selection**:
   - Ranks all candidate songs using multi-variable confidence heuristics:
     - **Title match:** Exact match (+50) or substring match (+30).
     - **Artist match:** Artist name presence in candidate artist array (+30).
     - **Duration proximity:** Time distance against `duration_ms` within $\le 3\text{s}$ (+20) or $\le 10\text{s}$ (+10).
   - Selects the candidate with the highest overall confidence score.
3. **Synchronized Lyric Extraction (`/api/song/lyric`)**:
   - Queries `https://music.163.com/api/song/lyric?id={id}&lv=1&kv=1&tv=-1`.
   - Extracts synchronized timestamped LRC content from `lrc.lyric`.
   - Writes the raw LRC text into Extism memory, where Lyria's `lyrics::parser::parse_lrc` converts cues into milliseconds for real-time UI rendering and caches it in SQLite.

---

## Directory Layout

```
extensions/netease-wasm/
├── assembly/
│   └── index.ts          # AssemblyScript source code implementing get_lyrics, scoring, and NetEase client
├── asconfig.json         # AssemblyScript compiler configuration
├── manifest.json         # Extism plugin manifest metadata
├── package.json          # Dependencies (assemblyscript, @extism/as-pdk, assemblyscript-json)
├── netease.wasm          # Compiled release WASM binary (~41KB)
└── README.md             # This documentation
```

---

## Building the Extension

### Prerequisites
- [Bun](https://bun.sh) (or Node.js >= 18)

### Build Commands
```bash
# Navigate to extension directory
cd extensions/netease-wasm

# Install dependencies
bun install

# Compile release WebAssembly binary
bun run build
```

Under the hood, `bun run build` runs:
```bash
asc assembly/index.ts --target release --outFile netease.wasm --use abort=assembly/index/myAbort -Ospeed --shrinkLevel 2 --noAssert
```

To deploy the extension into Lyria's root extension directory:
```bash
cp netease.wasm ../netease-wasm.wasm
cp manifest.json ../netease-wasm.json
```

---

## Verification & Testing

Lyria includes an end-to-end Rust integration test validating live NetEase resolution through Extism:

```bash
cd src-tauri
cargo test lyrics::tests::test_netease_extension_live_resolution -- --nocapture
```
This test spins up an Extism WASM context with the compiled `netease-wasm.wasm` binary, provides the `host_http_request` bridge, executes `get_lyrics` for `"Queen - Bohemian Rhapsody"`, and asserts that synchronized millisecond cue points are produced.
