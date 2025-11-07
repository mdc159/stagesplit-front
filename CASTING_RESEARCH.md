# Video Casting Options for StageSplit

## Executive Summary

Adding casting capabilities to StageSplit presents unique technical challenges due to its architecture: **real-time mixing of 6 independent audio stems synchronized with video playback**. Standard casting solutions are designed for pre-mixed media files, not dynamically mixed Web Audio API output.

This document explores four viable approaches, ranked by feasibility and implementation complexity.

---

## Current Architecture Constraints

**Key Technical Details:**
- Video element plays muted video (timeline reference only)
- Six AAC audio tracks demuxed and decoded into separate AudioBuffers
- Real-time mixing via Web Audio API (6 × GainNode → AnalyserNode → AudioContext.destination)
- User controls fader positions in real-time (0-2× gain per stem)
- Web Audio BufferSource nodes synchronized with video timeline (+20ms START_DELAY)

**Casting Challenge:**
The mixed audio output exists only in the local Web Audio graph—it's not a streamable media file. The video track lacks synchronized audio in the MP4 container.

---

## Approach 1: Real-Time Mix Capture + Cast (Recommended)

### Overview
Capture the mixed Web Audio output as a live MediaStream, combine with video, and cast the unified stream to remote devices.

### Technical Implementation

**Step 1: Capture Mixed Audio**
```javascript
// In renderer.js, after prepareAudioGraph()
const mixerDestination = state.audioCtx.createMediaStreamDestination();

// Create a gain node for the master output
const masterGain = state.audioCtx.createGain();

// Reroute all stem analyzers through master gain to destination
for (let i = 0; i < state.analyserNodes.length; i++) {
  state.analyserNodes[i].disconnect(); // Disconnect from default destination
  state.analyserNodes[i].connect(state.audioCtx.destination); // Keep for local playback
  state.analyserNodes[i].connect(masterGain); // Also send to mixer destination
}

masterGain.connect(mixerDestination);

// mixerDestination.stream is a MediaStream with the mixed audio
const mixedAudioStream = mixerDestination.stream;
```

**Step 2: Combine with Video Stream**
```javascript
// Capture video stream from video element
const videoStream = video.captureStream(); // Returns MediaStream with video track

// Combine audio and video tracks
const combinedStream = new MediaStream([
  ...videoStream.getVideoTracks(),
  ...mixedAudioStream.getAudioTracks()
]);

// combinedStream now contains synchronized video + mixed audio
```

**Step 3: Cast to Device**

#### Option A: Google Cast (Chromecast)
```bash
npm install electron-chromecast
```

**In main.js (preload script):**
```javascript
const electronChromecast = require('electron-chromecast');

electronChromecast.initialize().then(() => {
  console.log('Chromecast enabled');
});
```

**In renderer.js:**
```javascript
// Use Chrome's native Cast API (injected by electron-chromecast)
const castSession = await new Promise((resolve, reject) => {
  chrome.cast.requestSession(
    (session) => resolve(session),
    (error) => reject(error)
  );
});

// Cast the combined stream
// Note: Requires encoding to a format Chromecast understands (WebM/VP8)
const mediaRecorder = new MediaRecorder(combinedStream, {
  mimeType: 'video/webm;codecs=vp8,opus'
});

// Stream chunks to Chromecast via Custom Receiver Application
```

#### Option B: Remote Playback API (Standards-Based)
```javascript
// Use Web API for casting (supported in Chrome/Edge)
const remotePlayback = video.remote;

if (remotePlayback.state === 'disconnected') {
  await remotePlayback.prompt();
}

// Connect combined stream to video element before casting
video.srcObject = combinedStream;
```

### Pros
- ✅ Preserves real-time user control (fader changes reflected immediately)
- ✅ No server infrastructure required
- ✅ Low latency (suitable for live karaoke performance)
- ✅ Works with any cast protocol supporting live streams

### Cons
- ❌ High CPU usage (encoding video + audio in real-time)
- ❌ Requires continuous streaming (can't pause/buffer like file-based casting)
- ❌ Quality depends on network bandwidth and encoding settings
- ❌ Chromecast requires Custom Receiver Application development

### Implementation Complexity
**Medium-High** (~40-60 hours)
- Core MediaStream capture: 4-6 hours
- electron-chromecast integration: 8-12 hours
- Custom Receiver Application: 16-24 hours
- Testing across devices: 8-12 hours
- UI for device selection: 4-6 hours

---

## Approach 2: Server-Side Remux + DLNA/UPnP Casting

### Overview
Start a local DLNA/UPnP media server in the Electron main process, serve the original video file with pre-mixed audio on-the-fly, and advertise to cast receivers.

### Technical Implementation

**Step 1: Install DLNA Server**
```bash
npm install upnp-mediaserver-node node-ssdp
```

**Step 2: Create Local HTTP Server (in main.js)**
```javascript
const { createServer } = require('http');
const UPnPServer = require('upnp-mediaserver-node');
const ffmpeg = require('fluent-ffmpeg'); // Native FFmpeg, not wasm

// Start HTTP server to serve remuxed file
const server = createServer((req, res) => {
  if (req.url === '/karaoke.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });

    // Use FFmpeg to remux stems with current fader gains
    const command = ffmpeg('input.mp4')
      .audioFilters([
        `[0:a:0]volume=${faderValues[0]}[vocals]`,
        `[0:a:1]volume=${faderValues[1]}[drums]`,
        // ... repeat for all 6 stems
        `[vocals][drums]...[ambience]amix=inputs=6:duration=longest[mixed]`
      ])
      .outputOptions('-map 0:v:0', '-map [mixed]')
      .format('mp4');

    command.pipe(res, { end: true });
  }
});

server.listen(0); // Random port

// Advertise via UPnP/DLNA
const upnpServer = new UPnPServer({
  name: 'StageSplit Karaoke',
  files: [{
    path: `http://localhost:${server.address().port}/karaoke.mp4`,
    title: 'Current Karaoke Mix'
  }]
});

upnpServer.start();
```

**Step 3: Cast from DLNA-Compatible Devices**
Users select "StageSplit Karaoke" from their TV/receiver's DLNA menu.

### Pros
- ✅ Works with any DLNA/UPnP device (smart TVs, game consoles, receivers)
- ✅ No custom receiver application needed
- ✅ Standard protocol with wide device support
- ✅ Can leverage native FFmpeg (faster than wasm)

### Cons
- ❌ **Fader changes require re-encoding** (not real-time)
- ❌ High latency (2-10 seconds to remux after fader adjustment)
- ❌ Requires native FFmpeg binary (not cross-platform friendly)
- ❌ Network bandwidth intensive (streams entire video)

### Implementation Complexity
**High** (~50-80 hours)
- DLNA/UPnP server setup: 12-16 hours
- FFmpeg native integration: 12-16 hours
- Dynamic remuxing with fader values: 16-24 hours
- SSDP discovery UI: 8-12 hours
- Cross-platform FFmpeg binaries: 8-16 hours

### Use Case
Best for **presentation mode** where faders are set once and not adjusted during playback (e.g., viewing a pre-configured mix on a big screen).

---

## Approach 3: Pre-Mix and Cast File

### Overview
Render the current mixer settings to a new MP4 file with baked-in audio mix, then cast the file using standard protocols.

### Technical Implementation

**Step 1: Render Mixed File**
```javascript
// Use Web Audio Offline Rendering
async function renderMixedFile() {
  const duration = state.audioBuffers[0].duration;
  const sampleRate = state.audioCtx.sampleRate;

  const offlineCtx = new OfflineAudioContext(2, duration * sampleRate, sampleRate);

  // Create offline audio graph with current fader values
  for (let i = 0; i < state.audioBuffers.length; i++) {
    const source = offlineCtx.createBufferSource();
    source.buffer = state.audioBuffers[i];

    const gain = offlineCtx.createGain();
    gain.gain.value = state.gainNodes[i].gain.value; // Current fader position

    source.connect(gain).connect(offlineCtx.destination);
    source.start(0);
  }

  const renderedBuffer = await offlineCtx.startRendering();

  // Encode to WAV/PCM
  const wavBlob = audioBufferToWav(renderedBuffer);

  return wavBlob;
}
```

**Step 2: Mux Audio with Video (using FFmpeg)**
```javascript
// In main process using native FFmpeg
const mixedAudioPath = '/tmp/mixed.wav';
const outputPath = '/tmp/karaoke_cast.mp4';

await ffmpeg.exec([
  '-i', originalVideoFile,
  '-i', mixedAudioPath,
  '-map', '0:v:0',
  '-map', '1:a:0',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '256k',
  outputPath
]);
```

**Step 3: Cast the File**
```javascript
// Use electron-chromecast or DLNA server to cast outputPath
const media = new chrome.cast.media.MediaInfo(
  `http://localhost:${serverPort}/karaoke_cast.mp4`,
  'video/mp4'
);

const request = new chrome.cast.media.LoadRequest(media);
await castSession.loadMedia(request);
```

### Pros
- ✅ Simple implementation (well-understood workflow)
- ✅ Works with all casting protocols
- ✅ Reliable playback (no streaming issues)
- ✅ No custom receiver needed

### Cons
- ❌ **No real-time fader control** (must re-render for changes)
- ❌ Rendering time: 2-3× song duration (offline rendering + encoding)
- ❌ Requires temporary disk space (uncompressed WAV can be 500MB+)
- ❌ Poor UX for karaoke (can't adjust mix during performance)

### Implementation Complexity
**Medium** (~30-40 hours)
- Offline rendering: 8-10 hours
- WAV encoding utilities: 6-8 hours
- FFmpeg muxing integration: 8-12 hours
- Cast integration: 4-6 hours
- Progress UI: 4-6 hours

### Use Case
Best for **exporting a mix** for later playback or sharing, not live karaoke performance.

---

## Approach 4: Cast Video Only + Local Audio

### Overview
Cast only the muted video to the TV while keeping audio playback on the local computer/speakers.

### Technical Implementation

**Step 1: Extract Video-Only Stream**
```javascript
const videoOnlyStream = video.captureStream();
// Already has no audio (video element is muted)
```

**Step 2: Cast Video Stream**
```javascript
// Use Remote Playback API or electron-chromecast
await remotePlayback.prompt();
video.srcObject = videoOnlyStream;
```

**Step 3: Maintain Local Audio Sync**
```javascript
// Keep existing Web Audio playback in sync with cast video
remotePlayback.addEventListener('connect', () => {
  // Monitor remote playback state
  video.addEventListener('timeupdate', () => {
    // Adjust local audio if cast device seeks/pauses
  });
});
```

### Pros
- ✅ Simplest implementation
- ✅ No audio encoding required
- ✅ Real-time fader control preserved
- ✅ No bandwidth concerns (video-only)

### Cons
- ❌ **Audio plays from computer, not TV** (defeats purpose for most users)
- ❌ Sync can drift between remote video and local audio
- ❌ Requires Bluetooth/aux cable for audio to TV (workaround)

### Implementation Complexity
**Low** (~8-12 hours)
- Video stream capture: 2-3 hours
- Cast integration: 4-6 hours
- Sync monitoring: 2-3 hours

### Use Case
Niche scenario: User has external audio system connected to computer but wants large screen TV display. Not recommended for typical karaoke setups.

---

## Recommended Implementation Path

### Phase 1: Proof of Concept (Approach 1 - Local Only)
**Goal:** Validate MediaStream capture and local playback
**Effort:** 8-12 hours

1. Implement MediaStreamDestinationNode routing
2. Combine audio + video streams
3. Test playback in secondary video element on same machine
4. Verify sync and audio quality

### Phase 2: Basic Cast Support (Chromecast)
**Goal:** Enable casting to Chromecast devices
**Effort:** 20-30 hours

1. Integrate electron-chromecast package
2. Implement device discovery UI
3. Develop minimal Custom Receiver Application
4. Test with real Chromecast device

### Phase 3: Multi-Protocol Support
**Goal:** Add AirPlay (macOS) and DLNA (smart TVs)
**Effort:** 30-40 hours

1. Implement platform-specific casting (AirPlay on macOS via native APIs)
2. Add DLNA/UPnP server option
3. Unified casting UI

### Phase 4: Optimize and Polish
**Goal:** Production-ready feature
**Effort:** 16-24 hours

1. Add quality/bitrate settings
2. Implement reconnection logic
3. Add casting status indicators
4. Performance optimization

**Total Estimated Effort:** 74-106 hours (~2-3 weeks full-time)

---

## Technical Dependencies

### npm Packages
```json
{
  "electron-chromecast": "^1.3.0",     // Chromecast support
  "upnp-mediaserver-node": "^0.3.0",   // DLNA/UPnP (Approach 2)
  "node-ssdp": "^4.0.1",               // Device discovery
  "fluent-ffmpeg": "^2.1.3"            // Native FFmpeg (Approach 2/3)
}
```

### Native Dependencies
- FFmpeg binary (for Approach 2/3, not wasm)
- Bonjour/Avahi (for MDNS discovery on Linux)

### Web APIs Used
- `MediaStreamAudioDestinationNode` (Web Audio API)
- `HTMLVideoElement.captureStream()` (Media Capture API)
- `MediaRecorder` (MediaStream Recording API)
- `RemotePlaybackAPI` (Chrome/Edge only)
- `chrome.cast` API (injected by electron-chromecast)

---

## Security Considerations

### Network Exposure
- Local HTTP server (Approach 2) exposes media on LAN
  - **Mitigation:** Bind to localhost, use token-based URLs
- DLNA/UPnP uses multicast (can't restrict to specific devices)
  - **Mitigation:** Implement device allowlist, require user confirmation

### Content Security Policy
Current app has no CSP. Before adding casting:
```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  media-src 'self' blob: http://localhost:*;
  connect-src 'self' ws://localhost:* wss://*;
  script-src 'self' 'unsafe-eval';
">
```

---

## Performance Benchmarks (Estimated)

| Approach | CPU Usage | RAM Usage | Network Bandwidth | Latency |
|----------|-----------|-----------|-------------------|---------|
| Real-Time Mix Capture | 40-60% | +200MB | 3-8 Mbps | 100-300ms |
| Server-Side Remux | 80-100% | +500MB | 5-15 Mbps | 2-10s (per mix change) |
| Pre-Mix File | 60-80% (during render) | +1GB | 5-15 Mbps | 30-90s (initial render) |
| Video Only | 15-25% | +50MB | 1-3 Mbps | 50-150ms |

---

## Alternative: Hybrid Approach

**For best UX, consider a hybrid implementation:**

1. **Default Mode:** Real-Time Mix Capture (Approach 1)
   - Enables live fader adjustments during performance
   - Best for active karaoke sessions

2. **Presentation Mode:** Pre-Mix File (Approach 3)
   - User finalizes mix, clicks "Cast Mix"
   - Renders once, casts static file
   - Better reliability for passive viewing

3. **Quick Cast:** Video Only (Approach 4)
   - Toggle option for users with external audio systems
   - Minimal overhead

**UI Concept:**
```
┌─────────────────────────────────────┐
│ Cast Options                         │
├─────────────────────────────────────┤
│ ○ Live Mix (adjust faders while     │
│   casting) [Recommended]             │
│                                      │
│ ○ Fixed Mix (render once, stable    │
│   playback)                          │
│                                      │
│ ○ Video Only (audio stays local)    │
│                                      │
│ [Scan for Devices]                  │
└─────────────────────────────────────┘
```

---

## Next Steps

1. **Validate Proof of Concept**
   - Spend 1-2 days implementing MediaStream capture
   - Test on local machine before investing in cast protocols

2. **Choose Primary Protocol**
   - Survey target audience device ecosystem
   - Prioritize Chromecast (consumer) vs. DLNA (enterprise) vs. AirPlay (Apple users)

3. **Prototype Custom Receiver**
   - Required for Chromecast if using live streaming
   - Host on GitHub Pages or Firebase Hosting (free)

4. **User Research**
   - Does target audience need real-time fader control while casting?
   - If not, Approach 3 (Pre-Mix) is significantly simpler

---

## Conclusion

**Recommended:** Start with **Approach 1 (Real-Time Mix Capture)** as it best preserves StageSplit's core value proposition—real-time audio mixing control. While implementation is complex, it provides the most professional karaoke experience.

**Fallback:** If real-time control isn't essential for your users, **Approach 3 (Pre-Mix File)** offers a simpler path with reliable playback at the cost of flexibility.

Avoid **Approach 2** (Server-Side Remux) due to high latency making it unsuitable for live mixing. **Approach 4** (Video Only) is too niche to justify as the primary implementation.
