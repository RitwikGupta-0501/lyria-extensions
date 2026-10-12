# TODO

## YouTube Extension (youtube-wasm)
- [x] Clean up untracked modular vs monolith lib.rs variants
- [ ] Implement robust cipher deobfuscation and signature deciphering resilience
- [ ] Support adaptive HLS/DASH audio stream extraction
- [ ] Optimize search and module aggregation response times
- [ ] Add unit and adversarial test suites

## Planned Extensions
- [ ] Implement LRCLIB / synced lyrics provider (lyrics capability)
- [ ] Implement Spotify metadata and discovery provider
- [ ] Implement SoundCloud search and streaming provider
- [ ] Implement Subsonic / Navidrome private cloud audio provider
- [ ] Implement Last.fm / ListenBrainz scrobbler (scrobble capability)

## CI/CD & Distribution
- [x] Set up GitHub Actions workflow to auto-discover and build WASM modules
- [x] Implement automated release packaging (clean 2-file bundling of manifest.json + .wasm into .zip archives and publishing GitHub Releases on main/tags)

## Audio Engine & Core Player (src-tauri/src/audio)
- [ ] Handle Audio Hardware Disconnection & Device Drop: Detect USB DAC / Bluetooth headphone disconnection gracefully on the audio thread, transition playback state to Paused, notify frontend without panicking or hanging, and support re-attaching/re-enumerating default audio output streams.
- [ ] Implement Comprehensive Audio Subsystem Unit Tests: Benchmarking is not equivalent to functional tests. Implement automated unit tests under `src-tauri/src/audio` covering FLAC, MP3, WAV, and Opus decoding; container-level time seeking and coarse bisection fallback; ring buffer underrun/silence masking; and TrackedSource gapless transition callbacks.

