/* renderer.js – Electron renderer logic for StageSplit mixer */

const filePicker = document.getElementById('filePicker');
const video = document.getElementById('video');
const mixer = document.getElementById('mixer');
const playBtn = document.getElementById('play');
const pauseBtn = document.getElementById('pause');
const stopBtn = document.getElementById('stop');
const statusLabel = document.getElementById('status');
const castBtn = document.getElementById('castBtn');
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
  [playBtn, pauseBtn, stopBtn, castBtn].forEach((btn) => {
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
    // Check if Remote Playback API is available
    if (!video.remote) {
      reportError('Casting not supported in this browser. Try Chrome or Edge.');
      return;
    }

    state.remotePlayback = video.remote;

    // Set up event listeners
    state.remotePlayback.addEventListener('connecting', handleCastConnecting);
    state.remotePlayback.addEventListener('connect', handleCastConnected);
    state.remotePlayback.addEventListener('disconnect', handleCastDisconnected);

    // Capture video-only stream (video element is already muted)
    if (!state.castVideoStream) {
      state.castVideoStream = video.captureStream();
    }

    // Prompt user to select a cast device
    await state.remotePlayback.prompt();

  } catch (error) {
    console.error('Failed to initiate cast:', error);
    if (error.name === 'NotSupportedError') {
      reportError('Remote playback is not supported on this device.');
    } else if (error.name === 'InvalidStateError') {
      reportError('A remote playback session is already active.');
    } else if (error.name === 'NotAllowedError') {
      // User cancelled the prompt - not an error
      setStatus('Cast cancelled.');
    } else {
      reportError(`Failed to cast: ${error.message}`);
    }
  }
}

function handleCastConnecting() {
  castStatus.textContent = '🟡 Connecting...';
  setStatus('Connecting to cast device...');
}

function handleCastConnected() {
  state.isCasting = true;
  castBtn.style.display = 'none';
  disconnectCastBtn.style.display = 'inline-block';
  castControls.style.display = 'block';
  castStatus.textContent = '🟢 Casting';
  setStatus('Casting video to remote device. Audio plays locally.');

  // If currently playing, restart to apply sync offset
  if (!video.paused) {
    const wasPlaying = true;
    const currentPos = state.currentOffset;
    pauseTransport();
    setTimeout(() => {
      state.currentOffset = currentPos;
      startTransport();
    }, 100);
  }
}

function handleCastDisconnected() {
  state.isCasting = false;
  castBtn.style.display = 'inline-block';
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
