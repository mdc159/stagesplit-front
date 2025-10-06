# 🎛️ StageSplit / Electron Karaoke-Mixer Prototype

## 1  Purpose & Vision

A lightweight **desktop mixer** for video-karaoke practice:

* **Single self-contained MP4** → 1 × video + 6 × stems (Vocals, Drums, Bass, Guitar, Piano, Ambience)
* Realtime **faders, meters & mute/solo** so singers and instrumentalists can rebalance a song on-the-fly.
* Built with **Electron + Web Audio API** so it runs cross-platform with zero native code.
* Uses **ffmpeg.wasm** in-renderer—no external binaries once the MP4 is prepared.

Long-term roadmap (not in this PoC): seek/scrub, preset recall, live-mic input, lyrics overlay, full screen show-mode.

---

## 2  Architecture Overview

```
┌───────────┐  choose MP4   ┌──────────────────────────┐
│ HTML UI   │──────────────▶│ ffmpeg.wasm (demux AAC)  │
└───────────┘               │  ↘ six AudioBuffers      │
       ▲ JS (ES-module)      └───────────────┬──────────┘
       │                                     │
       │ video tag (muted, master clock)     ▼
       │                               ┌──────────────┐
       │ transport controls            │ Web Audio    │
       │                               │ Gain+Meter   │
       ▼                               └─────┬────────┘
 video preview                               │
 six faders (GainNodes) ◀────────────────────┘
```

* **Demucs 6-S model** (CLI or GUI) splits the original stereo mix into 6 × `*.wav` stems.
* `build_karaoke_six_stem.bat` muxes the stems + original video 👉 `«Song» (karaoke_six_stem).mp4`, tagging each track via `handler_name`.
* The Electron renderer loads that MP4, demuxes inside the browser, decodes to `AudioBuffer`s, then aligns them to the `<video>`’s timeline.

---

## 3  Prerequisites

| Tool           | Version | Notes                                             |
| -------------- | ------- | ------------------------------------------------- |
| Node .js       | ≥ 18    | (ESM & top-level await)                           |
| npm            | ≥ 9     |                                                   |
| **ffmpeg.exe** | 6/7     | Only needed for offline batch script              |
| Demucs-GUI     | any     | For stem extraction (or CLI `python -m demucs …`) |

---

## 4  Folder Layout

```
project/
├─ main.js                # Electron main-process (no preload)
├─ index.html             # UI shell (video, mixer div)
├─ renderer.js            # ES-module, all front-end logic
├─ style.css              # Minimal dark theme
├─ package.json           # electron devDep + @ffmpeg/ffmpeg
└─ build_karaoke_six_stem.bat  # helper to mux stems → labelled MP4
```

---

## 5  Setup & Run (DEV)

```bash
# 1  clone or copy the folder
npm install                # installs electron + ffmpeg.wasm
npm start                  # boots the prototype
```

Electron opens; pick your `…(karaoke_six_stem).mp4`.  After a few seconds you’ll see:

* video preview (muted)
* six vertical faders with animated meters (RMS peak)
* ▶ ⏸ ⏹ transport buttons

---

## 6  Preparing a Song End-to-End

```bash
# 1  split stems (Demucs 6-S)
demucs -n htdemucs_6s "song.mp4"   # outputs vocals.wav … other.wav

# 2  enter the new folder and run the batch
build_karaoke_six_stem.bat         # creates "song (karaoke_six_stem).mp4"
```

Key points:

* Original stereo track **is NOT** included in the new MP4 → no double audio.
* Each stem is AAC 256 kb/s; `handler_name` tags = UI labels.

---

## 7  Controls

| UI      | Action                                     |
| ------- | ------------------------------------------ |
| ⏵ Play  | resumes `<video>` + resumes `AudioContext` |
| ⏸ Pause | pauses both                                |
| ⏹ Stop  | pause + reset `currentTime` ↦ 0            |
| Slider  | gain 0 → +6 dB per stem                    |

Meters update at ~60 fps from an `AnalyserNode`.

---

## 8  Known Limitations / TODO

* Seek/scrub not yet implemented (requires re-offsetting BufferSources).
* No master clip meter.
* ffmpeg.wasm demux ≈ 2-3 × realtime on first load; could move demux to Electron main with native ffmpeg for bulk.
* Security: dev build uses `contextIsolation: true` but no CSP; tighten before shipping.

---

## 9  Troubleshooting

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for the full write-up.

### FFmpeg module import mismatch

* **Symptom:** Renderer console showed `Module missing expected exports.` when loading the local `@ffmpeg/ffmpeg` bundle and the UI stayed in the "Failed to load MP4" state.
* **Root cause:** The project originally called `createFFmpeg()` from the old API, but `@ffmpeg/ffmpeg@0.12.x` exposes an `FFmpeg` class in its ESM build instead of that factory function.
* **Resolution:** Updated the loader (`index.html`) to request the `FFmpeg` class and refactored `renderer.js` to instantiate it, move file-system calls to the new async methods (`writeFile`, `readFile`, `deleteFile`, `exec`), and wire logging through `ffmpeg.on('log', …)`.

### ffmpeg-core import failure

* **Symptom:** After the first fix, loading an MP4 emitted `Error: failed to import ffmpeg-core.js` from the worker thread.
* **Root cause:** The loader still pointed at the UMD build in `@ffmpeg/core/dist/umd`, which lacks a default export when imported from a module worker under Electron’s ESM sandbox.
* **Resolution:** Switched all core URLs to the ESM artifacts (`@ffmpeg/core/dist/esm/ffmpeg-core.{js,wasm}`) for both local and CDN sources so the worker’s dynamic `import()` succeeds offline.

### Verifying the fixes

1. `npm install`
2. `npm start`
3. Watch the DevTools console: you should see “FFmpeg loaded from: …” with no subsequent errors, and stems will demux once you load a prepared MP4.

## 10  Roadmap Ideas

* **Live mic** track with latency compensation.
* **Preset save/recall** (JSON snapshots of gain values).
* **Lyric overlay** via embedded WebVTT track.
* **Dark/Light theming** (Tailwind).
* **Packaging** with `electron-builder` for Win/macOS/Linux.

---

## 11  License

Prototype MIT / attribution for Demucs & ffmpeg.wasm.
