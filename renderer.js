/* renderer.js – Electron renderer logic for StageSplit mixer */

const filePicker = document.getElementById('filePicker');
const video = document.getElementById('video');
const mixer = document.getElementById('mixer');
const playBtn = document.getElementById('play');
const pauseBtn = document.getElementById('pause');
const stopBtn = document.getElementById('stop');
const statusLabel = document.getElementById('status');

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
  [playBtn, pauseBtn, stopBtn].forEach((btn) => {
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

  const startTime = state.audioCtx.currentTime + START_DELAY;
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
