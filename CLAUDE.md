# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**StageSplit** is an Electron-based desktop karaoke mixer that enables real-time mixing of six-stem audio tracks (Vocals, Drums, Bass, Guitar, Piano, Ambience) synchronized with video playback. The application uses ffmpeg.wasm for in-browser audio demuxing and the Web Audio API for real-time audio processing.

## Development Commands

```bash
# Install dependencies (Electron + ffmpeg.wasm packages)
npm install

# Start the application
npm start

# Start with DevTools open (detached)
STAGESPLIT_DEVTOOLS=1 npm start
```

## Architecture

### Core Technologies
- **Electron 38+**: Desktop application framework with strict security (contextIsolation: true, nodeIntegration: false)
- **ffmpeg.wasm 0.12.x**: In-browser MP4 demuxing (runs in Web Worker)
- **Web Audio API**: Real-time audio mixing and metering
- **HTML5 Video**: Serves as the master timeline clock (muted, video-only)

### Application Structure

**Three-file core architecture:**
- `main.js`: Electron main process (simple window creation, no preload script)
- `index.html`: UI shell with inline ES module loader for ffmpeg.wasm
- `renderer.js`: All application logic (ES module, exported `init()` function)

**Key Design Patterns:**

1. **FFmpeg Module Loading**: Progressive fallback from local node_modules → unpkg CDN → jsDelivr CDN. Must use ESM builds (`@ffmpeg/core/dist/esm/*`) not UMD for Worker compatibility.

2. **Audio Synchronization**: Video element drives the timeline; Web Audio BufferSource nodes are scheduled with `START_DELAY` (20ms) to align with video playback. No native seek support—stop/restart required.

3. **Audio Graph Per Stem**:
   ```
   BufferSource → GainNode → AnalyserNode → AudioContext.destination
   ```
   - GainNode: 0-2x gain (0-6 dB), controlled by fader
   - AnalyserNode: RMS metering at ~60fps via requestAnimationFrame

4. **State Management**: Single `state` object in `renderer.js` tracks:
   - `isSessionReady`: MP4 loaded, UI built
   - `isAudioRunning`: BufferSources actively playing
   - `currentOffset`: Playback position (synced with video.currentTime)
   - `audioBuffers`: Array of decoded AudioBuffers (one per stem)

### MP4 File Format Requirements

The application expects specially prepared MP4 files with:
- 1 × video track (original video, codec copied)
- 6 × AAC audio tracks (256 kbps each)
- **Critical**: Each audio track must have `handler_name` metadata set (e.g., "Vocals", "Drums", "Bass", "Guitar", "Piano", "Ambience")

**File Preparation Workflow:**

1. Extract stems using Demucs 6-S model:
   ```bash
   demucs -n htdemucs_6s "song.mp4"
   # Outputs: vocals.wav, drums.wav, bass.wav, guitar.wav, piano.wav, other.wav
   ```

2. Mux stems with video using the batch script:
   ```bash
   cd demucs_output_folder
   # Place build_karaoke_six_stem.bat in the folder with stems and original MP4
   build_karaoke_six_stem.bat
   # Creates: "song (karaoke_six_stem).mp4"
   ```

The batch script (`build_karaoke_six_stem.bat`) uses ffmpeg to:
- Map the original video track (no audio from original)
- Map each stem as a separate audio track with `handler_name` metadata
- Encode audio as AAC 256 kbps
- Apply faststart flag for web compatibility

### Known Limitations

1. **No Seek/Scrub**: Current architecture requires stopping and restarting BufferSource nodes. Implementing seek requires re-instantiating all sources with new offset.

2. **First Load Delay**: ffmpeg.wasm demuxing is ~2-3× realtime. Could optimize by moving demux to Electron main process with native ffmpeg for batch processing.

3. **No Master Metering**: Individual stem meters exist, but no master output meter to detect clipping.

4. **Security Hardening**: Development build has contextIsolation but no Content Security Policy. CSP should be added before distribution.

## Troubleshooting Common Issues

### FFmpeg Module Import Errors

**Symptom**: Console shows "Module missing expected exports" or "failed to import ffmpeg-core.js"

**Cause**: Using wrong ffmpeg.wasm API or UMD builds instead of ESM builds

**Solution**:
- Ensure `index.html` imports `FFmpeg` class (not `createFFmpeg()` factory)
- All core URLs must point to ESM artifacts: `@ffmpeg/core/dist/esm/ffmpeg-core.{js,wasm}`
- Use new async API: `ffmpeg.exec()`, `ffmpeg.writeFile()`, `ffmpeg.readFile()`, `ffmpeg.deleteFile()`

### Handler Name Parsing

The application parses stem labels from ffmpeg metadata output via regex in `parseHandlerNames()`:
- Pattern: `/handler_name\s*:\s*([^\r\n]+)/i`
- Filters out generic names like "ISO Media", "SoundHandler", "VideoHandler"
- Falls back to `DEFAULT_LABELS` array if metadata missing

### Transport State Management

The application maintains separate play states for video and audio:
- Video element paused state is the source of truth for UI
- Web Audio sources must be stopped and recreated for each play (BufferSource can only start once)
- `state.currentOffset` tracks resume position on pause

## Development Notes

- **No Tests**: Currently no testing infrastructure
- **No Linting**: No ESLint or Prettier configuration
- **No Build Process**: Direct Electron execution, no bundling/compilation
- **ES Modules**: Both `index.html` and `renderer.js` use native ES modules (not bundled)
- **Styling**: Minimal dark theme in `style.css`, no framework
