# LRCLIB Lyrics Extension (`lrclib-wasm`)

An algorithmically fast, lightweight WebAssembly extension for **Lyria Music Player** that resolves synchronized and plain lyrics via [LRCLIB](https://lrclib.net).

Built in **TypeScript / AssemblyScript (`asc`)** compiling to a ~35KB WASM binary running inside the sandboxed Extism runtime.

---

## Capabilities & Architecture

- **Capability:** `lyrics`
- **Priority:** `10`
- **Sandbox Runtime:** Extism WebAssembly with host HTTP dispatch (`host_http_request`)
- **Memory Footprint:** ~35KB WASM binary (negligible share of the 40MB total app RAM budget)
- **Exported Function:** `get_lyrics`

### Extism Host Bridge
The extension communicates with the Lyria Rust daemon through Extism host functions registered in the `"extism:host/user"` namespace:
```typescript
@external("extism:host/user", "host_http_request")
declare function host_http_request(request_offset: u64): u64;
```
The extension serializes an HTTP request `{ url: "...", method: "GET" }` into WASM memory and invokes `host_http_request`. The Rust host executes an async `reqwest` call with safety headers (including a custom `User-Agent`) and returns the HTTP status code and response body back into WASM memory.

---

## Resolution Workflow

When Lyria plays or cues a track, it calls `get_lyrics` with a JSON payload:
```json
{
  "title": "Bohemian Rhapsody",
  "artist": "Queen",
  "album": "A Night at the Opera",
  "duration": 354
}
```

The extension executes a 2-tier search:

1. **Exact Match (`/api/get`)**:
   - Queries `https://lrclib.net/api/get` with `track_name`, `artist_name`, `album_name`, and integer `duration`.
   - If HTTP 200 is returned, inspects `syncedLyrics` first. If present, returns the synced LRC text. Otherwise, falls back to `plainLyrics`.
2. **Search Query Fallback (`/api/search`)**:
   - If the exact match returns 404 or fails, issues a search query to `https://lrclib.net/api/search?q={artist} {title}`.
   - Parses the JSON array of candidates.
   - Selects the first item with `syncedLyrics` (or `plainLyrics` if no synced lyrics exist).
3. **Host Ingestion**:
   - The extension writes the raw LRC string into Extism output memory.
   - The Lyria backend's `lyrics::parser::parse_lrc` automatically parses standard and centisecond timestamps (`[mm:ss.xx]`, `[mm:ss.xxx]`, multi-bracket lines, and `[offset:...]` tags) into structured `LyricsResult` cues for UI rendering and saves the result to SQLite cache.

---

## Directory Layout

```
extensions/lrclib-wasm/
├── assembly/
│   └── index.ts          # AssemblyScript source code implementing get_lyrics & HTTP client
├── asconfig.json         # AssemblyScript compiler configuration
├── manifest.json         # Extism plugin manifest metadata
├── package.json          # Dependencies (assemblyscript, @extism/as-pdk, assemblyscript-json)
├── lrclib.wasm           # Compiled release WASM binary (~35KB)
└── README.md             # This documentation
```

---

## Building the Extension

### Prerequisites
- [Bun](https://bun.sh) (or Node.js >= 18)

### Build Commands
```bash
# Navigate to extension directory
cd extensions/lrclib-wasm

# Install dependencies
bun install

# Compile release WebAssembly binary
bun run build
```

Under the hood, `bun run build` runs:
```bash
asc assembly/index.ts --target release --outFile lrclib.wasm --use abort=assembly/index/myAbort -Ospeed --shrinkLevel 2 --noAssert
```
The `--use abort=assembly/index/myAbort` flag binds AssemblyScript's abort handler to a host-safe no-op instead of `env::abort`, ensuring zero-dependency compatibility with standard Extism host environments.

To deploy the extension into Lyria's root extension folder:
```bash
cp lrclib.wasm ../lrclib-wasm.wasm
cp manifest.json ../lrclib-wasm.json
```

---

## Verification & Testing

Lyria includes an end-to-end Rust integration test validating live LRCLIB resolution through Extism:

```bash
cd src-tauri
cargo test lyrics::tests::test_lrclib_extension_live_resolution -- --nocapture
```
This test spins up an Extism WASM context with the compiled `lrclib-wasm.wasm` binary, provides the `host_http_request` mock/live bridge, executes `get_lyrics` for `"Queen - Bohemian Rhapsody"`, and asserts that synchronized millisecond cue points are produced.
