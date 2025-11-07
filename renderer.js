/* renderer.js – Electron renderer logic for StageSplit mixer */

const filePicker = document.getElementById('filePicker');
const video = document.getElementById('video');
const mixer = document.getElementById('mixer');
const playBtn = document.getElementById('play');
const pauseBtn = document.getElementById('pause');
const stopBtn = document.getElementById('stop');
const statusLabel = document.getElementById('status');
const castBtn = document.getElementById('castBtn');
const demoCastBtn = document.getElementById('demoCastBtn');
const castControls = document.getElementById('castControls');
const castStatus = document.getElementById('castStatus');
const disconnectCastBtn = document.getElementById('disconnectCast');
const syncOffsetSlider = document.getElementById('syncOffset');
const offsetValueLabel = document.getElementById('offsetValue');
const syncEarlierBtn = document.getElementById('syncEarlier');
const syncResetBtn = document.getElementById('syncReset');
const syncLaterBtn = document.getElementById('syncLater');

const STEM_COUNT = 6;
const DEFAULT_LABELS = ['Vocals', 'Drums', 'Bass', 'Guitar', 'Piano', 'Ambience'];
const COLORS = ['#33ff66', '#33d0ff', '#ff6b33', '#ff33a8', '#d833ff', '#ffee33'];
const START_DELAY = 0.02; // seconds between scheduling and playback start

const state = {
  audioCtx: null,
  ffmpeg: null,
  audioBuffers: [],
  gainNodes: [],
  analyserNodes: [],
  analyserData: [],
  meterRaf: null,
  sourceNodes: [],
  activeSourceCount: 0,
  currentOffset: 0,
  isSessionReady: false,
  isAudioRunning: false,
  mediaUrl: null,
  // Casting state
  isCasting: false,
  castVideoOffset: 0, // milliseconds to offset audio (positive = audio plays later)
  remotePlayback: null,
  castVideoStream: null,
  demoCastWindow: null, // window reference for demo mode
  isDemoMode: false,
};

let FFmpegCtor = null;
let fetchFileHelper = null;
let ffmpegLoadConfig = null;

const meterElements = [];

setTransportEnabled(false);
setStatus('Load a six-stem MP4 to begin.');

filePicker.addEventListener('change', handleFileSelection);
playBtn.addEventListener('click', () => startTransport());
pauseBtn.addEventListener('click', () => pauseTransport());
stopBtn.addEventListener('click', () => stopTransport());
castBtn.addEventListener('click', () => initiateCast());
demoCastBtn.addEventListener('click', () => initiateDemoCast());
disconnectCastBtn.addEventListener('click', () => disconnectCast());
syncOffsetSlider.addEventListener('input', () => updateSyncOffset());
syncEarlierBtn.addEventListener('click', () => adjustSyncOffset(-50));
syncResetBtn.addEventListener('click', () => resetSyncOffset());
syncLaterBtn.addEventListener('click', () => adjustSyncOffset(50));

video.addEventListener('ended', () => stopTransport(true));
video.addEventListener('timeupdate', () => {
  if (!video.paused) {
    state.currentOffset = video.currentTime;
  }
});

window.addEventListener('beforeunload', () => {
  stopPlayback(true);
  stopMeters();
  if (state.mediaUrl) {
    URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
  }
});

/* ───────────────── helpers ───────────────── */

function getRMS(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const centered = values[i] - 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / values.length) / 128;
}

function setStatus(message, isError = false) {
  if (!statusLabel) return;
  statusLabel.textContent = message;
  statusLabel.classList.toggle('is-error', isError);
}

function setLoading(isLoading) {
  document.body.classList.toggle('is-loading', isLoading);
}

function setTransportEnabled(enabled) {
  [playBtn, pauseBtn, stopBtn, castBtn, demoCastBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.setAttribute('aria-disabled', String(!enabled));
  });
}

function reportError(message) {
  setStatus(message, true);
}

function once(target, event) {
  return new Promise((resolve) => target.addEventListener(event, resolve, { once: true }));
}

async function ensureFFmpeg() {
  if (!FFmpegCtor || !fetchFileHelper) {
    throw new Error('FFmpeg helpers not initialised.');
  }
  if (!state.ffmpeg) {
    state.ffmpeg = new FFmpegCtor();
  }
  if (!state.ffmpeg.loaded) {
    await state.ffmpeg.load(ffmpegLoadConfig || undefined);
  }
  return state.ffmpeg;
}

function parseHandlerNames(logLines) {
  const names = [];
  const pattern = /handler_name\s*:\s*([^\r\n]+)/i;
  logLines.forEach((line) => {
    const match = line.match(pattern);
    if (match) {
      const label = match[1].trim();
      if (!/ISO Media|SoundHandler|VideoHandler/i.test(label)) {
        names.push(label);
      }
    }
  });
  return names;
}

function resolveLabels(labels, count) {
  const resolved = [];
  for (let i = 0; i < count; i += 1) {
    resolved.push(labels[i] || DEFAULT_LABELS[i] || `Stem ${i + 1}`);
  }
  return resolved;
}

function prepareAudioGraph(stemCount) {
  state.gainNodes.forEach((node) => {
    try { node.disconnect(); } catch (err) { /* noop */ }
  });
  state.analyserNodes.forEach((node) => {
    try { node.disconnect(); } catch (err) { /* noop */ }
  });

  state.gainNodes = [];
  state.analyserNodes = [];
  state.analyserData = [];

  for (let i = 0; i < stemCount; i += 1) {
    const gain = state.audioCtx.createGain();
    gain.gain.value = 1;

    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;

    gain.connect(analyser).connect(state.audioCtx.destination);

    state.gainNodes.push(gain);
    state.analyserNodes.push(analyser);
    state.analyserData.push(new Uint8Array(analyser.fftSize));
  }
}

function buildMixerUI(labels) {
  mixer.innerHTML = '';
  meterElements.length = 0;

  labels.forEach((label, index) => {
    const strip = document.createElement('div');
    strip.className = 'strip';

    const meter = document.createElement('div');
    meter.className = 'meter';

    const fill = document.createElement('div');
    fill.className = 'meter-fill';
    fill.style.backgroundColor = COLORS[index % COLORS.length];
    meter.appendChild(fill);

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.min = '0';
    fader.max = '2';
    fader.step = '0.01';
    fader.value = '1';
    fader.className = 'fader';

    fader.addEventListener('input', () => {
      const gain = state.gainNodes[index];
      if (gain) {
        gain.gain.value = parseFloat(fader.value);
      }
    });

    fader.addEventListener('dblclick', () => {
      fader.value = '1';
      const gain = state.gainNodes[index];
      if (gain) {
        gain.gain.value = 1;
      }
    });

    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = label;

    strip.append(meter, fader, labelDiv);
    mixer.appendChild(strip);

    meterElements[index] = fill;
  });
}

function startMeters() {
  stopMeters();
  if (!state.analyserNodes.length) return;

  const update = () => {
    state.analyserNodes.forEach((analyser, index) => {
      const data = state.analyserData[index];
      analyser.getByteTimeDomainData(data);
      const rms = getRMS(data);
      const meter = meterElements[index];
      if (meter) {
        meter.style.height = `${Math.min(100, rms * 140)}%`;
      }
    });
    state.meterRaf = requestAnimationFrame(update);
  };

  state.meterRaf = requestAnimationFrame(update);
}

function stopMeters() {
  if (state.meterRaf) {
    cancelAnimationFrame(state.meterRaf);
    state.meterRaf = null;
  }
}

function stopPlayback(resetOffset = false) {
  if (state.sourceNodes.length) {
    state.sourceNodes.forEach((source) => {
      try { source.stop(); } catch (err) { /* noop */ }
      try { source.disconnect(); } catch (err) { /* noop */ }
    });
  }
  state.sourceNodes = [];
  state.activeSourceCount = 0;
  state.isAudioRunning = false;
  if (resetOffset) {
    state.currentOffset = 0;
  }
}

function startPlaybackAt(offsetSeconds) {
  if (!state.audioCtx || !state.audioBuffers.length) return;

  stopPlayback(false);

  // Apply cast sync offset to audio timing if casting
  const audioDelay = state.isCasting
    ? START_DELAY + (state.castVideoOffset / 1000)
    : START_DELAY;

  const startTime = state.audioCtx.currentTime + audioDelay;
  state.activeSourceCount = state.audioBuffers.length;

  state.sourceNodes = state.audioBuffers.map((buffer, index) => {
    const source = state.audioCtx.createBufferSource();
    source.buffer = buffer;

    const gain = state.gainNodes[index];
    if (gain) {
      source.connect(gain);
    }

    const clampedOffset = Math.max(0, Math.min(offsetSeconds, Math.max(buffer.duration - 0.01, 0)));
    source.start(startTime, clampedOffset);

    source.onended = () => {
      state.activeSourceCount -= 1;
      if (state.activeSourceCount <= 0) {
        state.isAudioRunning = false;
        if (video.ended) {
          stopTransport(true);
        }
      }
    };

    return source;
  });

  state.isAudioRunning = true;
}

async function loadSong(file) {
  await teardownSession();

  state.audioCtx = new AudioContext();
  video.preload = 'metadata';

  const mediaUrl = URL.createObjectURL(file);
  state.mediaUrl = mediaUrl;
  video.src = mediaUrl;
  await once(video, 'loadedmetadata');
  video.pause();
  video.currentTime = 0;

  const { buffers, labels } = await demuxToBuffers(file);
  state.audioBuffers = buffers;

  prepareAudioGraph(buffers.length);
  buildMixerUI(labels);
  startMeters();

  state.currentOffset = 0;
  state.isSessionReady = true;
  state.isAudioRunning = false;

  setTransportEnabled(true);
}

async function demuxToBuffers(file) {
  const ffmpeg = await ensureFFmpeg();
  const logLines = [];

  const logHandler = ({ type, message }) => {
    if (type === 'fferr' || type === 'ffout') {
      logLines.push(message);
    }
  };

  ffmpeg.on('log', logHandler);

  try {
    try {
      await ffmpeg.deleteFile('input.mp4');
    } catch (err) {
      /* ignore missing */
    }

    const fileData = await fetchFileHelper(file);
    await ffmpeg.writeFile('input.mp4', fileData);

    await ffmpeg.exec(['-hide_banner', '-i', 'input.mp4']);

    const labels = parseHandlerNames(logLines).slice(0, STEM_COUNT);
    const buffers = [];

    for (let index = 0; index < STEM_COUNT; index += 1) {
      const stemFile = `stem_${index}.aac`;
      const exitCode = await ffmpeg.exec([
        '-hide_banner',
        '-i',
        'input.mp4',
        '-map',
        `0:a:${index}`,
        '-c:a',
        'copy',
        stemFile,
      ]);

      if (exitCode !== 0) {
        if (index === 0) {
          throw new Error('No AAC stems found in this MP4.');
        }
        break;
      }

      const data = await ffmpeg.readFile(stemFile);
      try {
        await ffmpeg.deleteFile(stemFile);
      } catch (err) {
        /* ignore */
      }

      if (!(data instanceof Uint8Array)) {
        throw new Error('FFmpeg returned non-binary data.');
      }

      const audioData = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const audioBuffer = await state.audioCtx.decodeAudioData(audioData);
      buffers.push(audioBuffer);
    }

    if (!buffers.length) {
      throw new Error('Unable to decode any stems from the MP4.');
    }

    return { buffers, labels: resolveLabels(labels, buffers.length) };
  } finally {
    try {
      await ffmpeg.deleteFile('input.mp4');
    } catch (err) {
      /* ignore */
    }
    ffmpeg.off('log', logHandler);
  }
}

async function handleFileSelection(event) {
  const [file] = event.target.files || [];
  if (!file) return;

  filePicker.disabled = true;
  setLoading(true);
  setStatus(`Loading “${file.name}”…`);

  try {
    await loadSong(file);
    setStatus(`Ready: ${file.name}`);
  } catch (error) {
    console.error('Failed to load file', error);
    reportError(error?.message || 'Failed to load MP4.');
  } finally {
    setLoading(false);
    filePicker.disabled = false;
    filePicker.value = '';
  }
}

function startTransport() {
  if (!state.isSessionReady || !state.audioCtx) return;
  if (!video.paused) return;

  state.audioCtx.resume().catch(() => {});
  startPlaybackAt(state.currentOffset);

  video.currentTime = state.currentOffset;
  video.play().catch((err) => {
    console.error('Video playback failed', err);
    reportError('Unable to start playback.');
    stopPlayback(false);
  });
}

function pauseTransport() {
  if (!state.isSessionReady) return;

  if (!video.paused) {
    video.pause();
  }
  state.currentOffset = video.currentTime;
  stopPlayback(false);

  if (state.audioCtx && state.audioCtx.state === 'running') {
    state.audioCtx.suspend().catch(() => {});
  }
}

function stopTransport(fromEnded = false) {
  if (!state.isSessionReady) return;

  if (!fromEnded) {
    video.pause();
  }
  video.currentTime = 0;
  state.currentOffset = 0;

  stopPlayback(true);

  if (state.audioCtx) {
    state.audioCtx.suspend().catch(() => {});
  }
}

async function teardownSession() {
  stopMeters();
  stopPlayback(true);

  video.pause();
  video.removeAttribute('src');
  video.load();

  if (state.mediaUrl) {
    URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = null;
  }

  if (state.audioCtx) {
    try {
      await state.audioCtx.close();
    } catch (err) {
      /* noop */
    }
    state.audioCtx = null;
  }

  state.audioBuffers = [];
  state.gainNodes = [];
  state.analyserNodes = [];
  state.analyserData = [];
  state.isSessionReady = false;
  state.isAudioRunning = false;
  state.currentOffset = 0;

  setTransportEnabled(false);
  mixer.innerHTML = '';
}

/* ───────────────── casting functions ───────────────── */

async function initiateCast() {
  if (!state.isSessionReady) return;

  try {
    console.log('[Cast] Initiating cast...');

    // Check if Remote Playback API is available
    if (!video.remote) {
      reportError('Casting not supported in this browser. Try Chrome or Edge.');
      console.error('[Cast] video.remote is undefined');
      return;
    }

    console.log('[Cast] Remote Playback API available');
    console.log('[Cast] Current state:', video.remote.state);
    console.log('[Cast] Video src:', video.src);
    console.log('[Cast] Video readyState:', video.readyState);

    state.remotePlayback = video.remote;

    // Check current state
    if (state.remotePlayback.state === 'connected') {
      console.warn('[Cast] Already connected to a remote device');
      reportError('Already connected to a remote device. Disconnect first.');
      return;
    }

    // Set up event listeners (remove old ones first to avoid duplicates)
    state.remotePlayback.removeEventListener('connecting', handleCastConnecting);
    state.remotePlayback.removeEventListener('connect', handleCastConnected);
    state.remotePlayback.removeEventListener('disconnect', handleCastDisconnected);

    state.remotePlayback.addEventListener('connecting', handleCastConnecting);
    state.remotePlayback.addEventListener('connect', handleCastConnected);
    state.remotePlayback.addEventListener('disconnect', handleCastDisconnected);

    console.log('[Cast] Event listeners attached');

    // Capture video-only stream (video element is already muted)
    if (!state.castVideoStream) {
      state.castVideoStream = video.captureStream();
      console.log('[Cast] Video stream captured');
    }

    // Prompt user to select a cast device
    console.log('[Cast] Showing device picker...');
    await state.remotePlayback.prompt();
    console.log('[Cast] Prompt completed successfully');

  } catch (error) {
    console.error('[Cast] Error during cast initiation:', error);
    console.error('[Cast] Error name:', error.name);
    console.error('[Cast] Error message:', error.message);

    if (error.name === 'NotSupportedError') {
      reportError('Remote playback is not supported on this device.');
    } else if (error.name === 'InvalidStateError') {
      reportError('A remote playback session is already active.');
    } else if (error.name === 'NotAllowedError') {
      // This can mean: user cancelled OR video not ready OR autoplay policy
      console.warn('[Cast] NotAllowedError - possible causes:');
      console.warn('[Cast]   - User cancelled the dialog');
      console.warn('[Cast]   - Video not loaded/ready');
      console.warn('[Cast]   - Browser autoplay policy');

      // Check if video is ready
      if (video.readyState < 2) {
        reportError('Video not ready for casting. Wait for video to load.');
      } else {
        setStatus('Cast cancelled or not allowed by browser.');
      }
    } else {
      reportError(`Failed to cast: ${error.message}`);
    }
  }
}

function handleCastConnecting() {
  console.log('[Cast] Event: connecting');
  castStatus.textContent = '🟡 Connecting...';
  setStatus('Connecting to cast device...');
}

function handleCastConnected() {
  console.log('[Cast] Event: connected');
  state.isCasting = true;
  castBtn.style.display = 'none';
  demoCastBtn.style.display = 'none';
  disconnectCastBtn.style.display = 'inline-block';
  castControls.style.display = 'block';
  castStatus.textContent = '🟢 Casting';
  setStatus('Casting video to remote device. Audio plays locally.');

  console.log('[Cast] UI updated, casting active');

  // If currently playing, restart to apply sync offset
  if (!video.paused) {
    console.log('[Cast] Video is playing, restarting with sync offset');
    const currentPos = state.currentOffset;
    pauseTransport();
    setTimeout(() => {
      state.currentOffset = currentPos;
      startTransport();
    }, 100);
  }
}

function handleCastDisconnected() {
  console.log('[Cast] Event: disconnected');
  state.isCasting = false;
  castBtn.style.display = 'inline-block';
  demoCastBtn.style.display = 'inline-block';
  disconnectCastBtn.style.display = 'none';
  castControls.style.display = 'none';
  castStatus.textContent = '🔴 Not Casting';
  setStatus('Cast disconnected.');

  // Clean up event listeners
  if (state.remotePlayback) {
    state.remotePlayback.removeEventListener('connecting', handleCastConnecting);
    state.remotePlayback.removeEventListener('connect', handleCastConnected);
    state.remotePlayback.removeEventListener('disconnect', handleCastDisconnected);
    state.remotePlayback = null;
  }

  console.log('[Cast] Cleaned up, UI restored');

  // If playing, restart without offset
  if (!video.paused) {
    const currentPos = state.currentOffset;
    pauseTransport();
    setTimeout(() => {
      state.currentOffset = currentPos;
      startTransport();
    }, 50);
  }
}

async function disconnectCast() {
  // Handle demo mode disconnect
  if (state.isDemoMode) {
    handleDemoCastDisconnected();
    return;
  }

  // Handle real cast disconnect
  if (!state.remotePlayback) return;

  try {
    // Note: Remote Playback API doesn't have a direct disconnect method
    // We need to stop the video, which will disconnect
    const wasPlaying = !video.paused;
    const currentPos = state.currentOffset;

    stopTransport();

    // Wait a bit for disconnect
    await new Promise(resolve => setTimeout(resolve, 500));

    // Restore playback position if was playing
    if (wasPlaying) {
      state.currentOffset = currentPos;
      video.currentTime = currentPos;
    }
  } catch (error) {
    console.error('Failed to disconnect cast:', error);
    reportError('Failed to disconnect cast.');
  }
}

function updateSyncOffset() {
  const newOffset = parseInt(syncOffsetSlider.value);
  offsetValueLabel.textContent = newOffset;
  state.castVideoOffset = newOffset;

  // If currently playing, restart to apply new offset
  if (!video.paused && state.isCasting) {
    const currentPos = state.currentOffset;
    pauseTransport();
    setTimeout(() => {
      state.currentOffset = currentPos;
      startTransport();
    }, 50);
  }
}

function adjustSyncOffset(deltaMs) {
  const currentOffset = parseInt(syncOffsetSlider.value);
  const newOffset = Math.max(-500, Math.min(500, currentOffset + deltaMs));
  syncOffsetSlider.value = newOffset;
  updateSyncOffset();
}

function resetSyncOffset() {
  syncOffsetSlider.value = 0;
  updateSyncOffset();
}

/* ───────────────── demo cast functions (for local testing) ───────────────── */

function initiateDemoCast() {
  if (!state.isSessionReady) return;

  console.log('[Demo Cast] Initiating demo cast mode...');

  try {
    // Create a new window for the "remote" video display
    const castWindow = window.open('', 'StageSplit Cast Display', 'width=960,height=600');

    if (!castWindow) {
      reportError('Could not open cast window. Check popup blocker.');
      return;
    }

    state.demoCastWindow = castWindow;
    state.isDemoMode = true;

    // Build the cast window HTML
    castWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>StageSplit - Cast Display</title>
        <style>
          body {
            margin: 0;
            padding: 0;
            background: #000;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: 'Segoe UI', sans-serif;
          }
          .cast-badge {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(51, 255, 102, 0.9);
            color: #000;
            padding: 8px 16px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 14px;
            z-index: 1000;
          }
          video {
            max-width: 100%;
            max-height: 90vh;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
          }
          .info {
            color: #fff;
            margin-top: 20px;
            font-size: 14px;
            opacity: 0.7;
          }
        </style>
      </head>
      <body>
        <div class="cast-badge">🟢 DEMO CAST ACTIVE</div>
        <video id="castVideo" autoplay muted playsinline></video>
        <div class="info">Audio plays on main window • This simulates a cast device</div>
      </body>
      </html>
    `);
    castWindow.document.close();

    // Get the video element in the cast window
    const castVideo = castWindow.document.getElementById('castVideo');

    // Share the video source with the cast window
    castVideo.src = video.src;
    castVideo.currentTime = video.currentTime;

    // Sync playback state
    if (!video.paused) {
      castVideo.play().catch(err => console.warn('[Demo Cast] Auto-play failed:', err));
    }

    // Set up synchronization
    setupDemoCastSync(castVideo);

    // Update UI to show casting is active
    handleDemoCastConnected();

    // Monitor if window is closed
    const checkWindowInterval = setInterval(() => {
      if (castWindow.closed) {
        clearInterval(checkWindowInterval);
        handleDemoCastDisconnected();
      }
    }, 500);

    console.log('[Demo Cast] Demo cast window opened successfully');

  } catch (error) {
    console.error('[Demo Cast] Failed to initiate demo cast:', error);
    reportError(`Demo cast failed: ${error.message}`);
    state.isDemoMode = false;
    state.demoCastWindow = null;
  }
}

function setupDemoCastSync(castVideo) {
  // Sync play/pause/seek from main video to cast video
  const syncPlay = () => {
    if (state.demoCastWindow && !state.demoCastWindow.closed) {
      console.log('[Demo Cast] Syncing play to cast window');
      castVideo.play().catch(err => console.warn('[Demo Cast] Play failed:', err));
    }
  };

  const syncPause = () => {
    if (state.demoCastWindow && !state.demoCastWindow.closed) {
      console.log('[Demo Cast] Syncing pause to cast window');
      castVideo.pause();
    }
  };

  const syncSeek = () => {
    if (state.demoCastWindow && !state.demoCastWindow.closed) {
      castVideo.currentTime = video.currentTime;
      console.log('[Demo Cast] Syncing seek to:', video.currentTime);
    }
  };

  // Store sync functions so we can remove them later
  state.demoCastSyncHandlers = { syncPlay, syncPause, syncSeek };

  video.addEventListener('play', syncPlay);
  video.addEventListener('pause', syncPause);
  video.addEventListener('seeked', syncSeek);
}

function handleDemoCastConnected() {
  state.isCasting = true;
  castBtn.style.display = 'none';
  demoCastBtn.style.display = 'none';
  disconnectCastBtn.style.display = 'inline-block';
  castControls.style.display = 'block';
  castStatus.textContent = '🟢 Demo Casting (Window)';
  setStatus('Demo cast active. Video in separate window, audio plays locally.');

  console.log('[Demo Cast] Connected');
}

function handleDemoCastDisconnected() {
  console.log('[Demo Cast] Disconnecting...');

  state.isCasting = false;
  state.isDemoMode = false;

  // Clean up event listeners
  if (state.demoCastSyncHandlers) {
    video.removeEventListener('play', state.demoCastSyncHandlers.syncPlay);
    video.removeEventListener('pause', state.demoCastSyncHandlers.syncPause);
    video.removeEventListener('seeked', state.demoCastSyncHandlers.syncSeek);
    state.demoCastSyncHandlers = null;
  }

  // Close window if still open
  if (state.demoCastWindow && !state.demoCastWindow.closed) {
    state.demoCastWindow.close();
  }
  state.demoCastWindow = null;

  // Update UI
  castBtn.style.display = 'inline-block';
  demoCastBtn.style.display = 'inline-block';
  disconnectCastBtn.style.display = 'none';
  castControls.style.display = 'none';
  castStatus.textContent = '🔴 Not Casting';
  setStatus('Demo cast disconnected.');

  console.log('[Demo Cast] Disconnected');
}

// Public API expected by index.html
export async function init({ FFmpegClass, fetchFile, coreConfig }) {
  if (typeof FFmpegClass !== 'function' || typeof fetchFile !== 'function') {
    throw new Error('init requires { FFmpegClass, fetchFile }');
  }
  if (state.ffmpeg) {
    try {
      state.ffmpeg.terminate();
    } catch (err) {
      /* ignore */
    }
    state.ffmpeg = null;
  }
  FFmpegCtor = FFmpegClass;
  fetchFileHelper = fetchFile;
  ffmpegLoadConfig = coreConfig || null;
  setStatus('Ready. Choose a six-stem MP4 to start mixing.');
  return Promise.resolve();
}
