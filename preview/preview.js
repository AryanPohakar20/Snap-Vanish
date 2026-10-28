import { SnapVanishPipeline } from '../content/pipeline.js';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings } from '../lib/settings.js';
import { PLATE_KEY, PLATE_META_KEY } from '../lib/storage-keys.js';
import { MSG } from '../lib/messages.js';

const els = {
  video: document.getElementById('sourceVideo'),
  display: document.getElementById('displayCanvas'),
  placeholder: document.getElementById('stagePlaceholder'),
  stageDot: document.getElementById('stageDot'),
  stageLabel: document.getElementById('stageLabel'),
  stageHint: document.getElementById('stageHint'),
  snapBtn: document.getElementById('snapBtn'),
  captureBtn: document.getElementById('captureBtn'),
  resetPlateBtn: document.getElementById('resetPlateBtn'),
  mediaBtn: document.getElementById('mediaBtn'),
  stopMediaBtn: document.getElementById('stopMediaBtn'),
  sensitivity: document.getElementById('sensitivity'),
  sensitivityValue: document.getElementById('sensitivityValue'),
  dustDuration: document.getElementById('dustDuration'),
  durationValue: document.getElementById('durationValue'),
  dustDirection: document.getElementById('dustDirection'),
  audioConfirmation: document.getElementById('audioConfirmation'),
  playSnapSound: document.getElementById('playSnapSound'),
  autoCaptureBackground: document.getElementById('autoCaptureBackground'),
  persistBackground: document.getElementById('persistBackground'),
  cameraPermission: document.getElementById('cameraPermission'),
  microphonePermission: document.getElementById('microphonePermission'),
  sessionBadge: document.getElementById('sessionBadge'),
  setupMessage: document.getElementById('setupMessage'),
  mediaError: document.getElementById('mediaError'),
  diagPipeline: document.getElementById('diagPipeline'),
  diagHand: document.getElementById('diagHand'),
  diagSegmentation: document.getElementById('diagSegmentation'),
  diagWasm: document.getElementById('diagWasm'),
  diagRenderer: document.getElementById('diagRenderer'),
  diagFps: document.getElementById('diagFps'),
  diagCost: document.getElementById('diagCost'),
  diagMask: document.getElementById('diagMask'),
  diagDetector: document.getElementById('diagDetector'),
  diagAudio: document.getElementById('diagAudio'),
  diagMic: document.getElementById('diagMic'),
  diagPlate: document.getElementById('diagPlate'),
  diagError: document.getElementById('diagError'),
  logList: document.getElementById('logList'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  versionText: document.getElementById('versionText'),
  toast: document.getElementById('toast')
};

let settings = sanitizeSettings(DEFAULT_SETTINGS);
let pipeline = null;
let pipelineReady = false;
let pipelineError = null;
let stream = null;
let running = false;
let rafId = 0;
let lastProcessAt = 0;
let mediaBusy = false;
let micError = null;
let pendingTrigger = false;
let pendingAttempts = 0;
let lastPendingAttempt = 0;
let audioService = { running: false, mode: 'idle', error: null, transients: 0 };
let plateMeta = null;
let saveTimer = null;
let toastTimer = null;
let diagnosticsTimer = null;
let displayCtx = null;
let previousLogReason = '';
let editing = false;
let queuedTransients = [];
let assets = {
  wasm: 'checking',
  hand: 'checking',
  segmentation: 'checking',
  bundle: 'checking'
};
const logs = [];

function sendToBackground(type, payload = {}, timeout = 12000) {
  return Promise.race([
    chrome.runtime.sendMessage({ target: 'background', type, ...payload }).catch((error) => ({
      ok: false,
      error: error.message
    })),
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, error: 'The extension did not respond in time.' }), timeout);
    })
  ]);
}

function permissionLabel(value) {
  switch (value) {
    case 'granted':
      return 'Granted';
    case 'denied':
      return 'Denied';
    case 'prompt':
      return 'Not asked';
    case 'unavailable':
      return 'Unavailable';
    case 'error':
      return 'Error';
    default:
      return 'Unknown';
  }
}

function describeMediaError(error, device) {
  if (!error) return `${device === 'camera' ? 'Camera' : 'Microphone'} unavailable.`;
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${device === 'camera' ? 'Camera' : 'Microphone'} permission was denied. Allow access in Chrome's site settings for this extension, then try again.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return `No ${device} was found.`;
    case 'NotReadableError':
    case 'TrackStartError':
      return `The ${device} is busy in another application.`;
    case 'OverconstrainedError':
      return `The requested ${device} settings are unavailable on this device.`;
    case 'AbortError':
      return `The ${device} could not start. Try again.`;
    default:
      return `${device === 'camera' ? 'Camera' : 'Microphone'} error: ${error.message}`;
  }
}

function showToast(message, kind = 'info', duration = 4800) {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast hidden';
  }, duration);
}

function addLog(level, message) {
  if (!message) return;
  const entry = {
    level,
    message: String(message),
    at: new Date()
  };
  logs.push(entry);
  if (logs.length > 60) logs.shift();
  renderLogs();
  if (level === 'error') console.error('[Snap Vanish preview]', message);
  else if (level === 'warning') console.warn('[Snap Vanish preview]', message);
  else console.info('[Snap Vanish preview]', message);
}

function renderLogs() {
  if (!els.logList) return;
  els.logList.textContent = '';
  if (!logs.length) {
    const item = document.createElement('li');
    item.className = 'empty';
    const text = document.createElement('span');
    text.textContent = 'No activity yet.';
    item.appendChild(text);
    els.logList.appendChild(item);
    return;
  }
  for (const entry of logs.slice().reverse()) {
    const item = document.createElement('li');
    item.className = entry.level;
    const time = document.createElement('time');
    time.textContent = entry.at.toLocaleTimeString([], { hour12: false });
    const text = document.createElement('span');
    text.textContent = entry.message;
    item.append(time, text);
    els.logList.appendChild(item);
  }
}

function setHidden(element, hidden) {
  if (element) element.classList.toggle('hidden', Boolean(hidden));
}

function showMediaError(message) {
  if (!els.mediaError) return;
  els.mediaError.textContent = message || '';
  setHidden(els.mediaError, !message);
}

function setSetupMessage(message) {
  if (els.setupMessage) els.setupMessage.textContent = message;
}

function setSessionBadge(text, kind = '') {
  if (!els.sessionBadge) return;
  els.sessionBadge.textContent = text;
  els.sessionBadge.className = `pill ${kind}`.trim();
}

function setStageHint(message) {
  if (!els.stageHint) return;
  els.stageHint.textContent = message || '';
  setHidden(els.stageHint, !message);
}

function setDiag(element, text, kind = '') {
  if (!element) return;
  element.textContent = text;
  element.className = kind;
}

function syncForm(nextSettings, force = false) {
  settings = sanitizeSettings(nextSettings);
  if (editing && !force) return;
  els.sensitivity.value = String(settings.sensitivity);
  els.sensitivityValue.textContent = String(settings.sensitivity);
  els.dustDuration.value = String(settings.dustDuration);
  els.durationValue.textContent = `${(settings.dustDuration / 1000).toFixed(1)} s`;
  els.dustDirection.value = settings.dustDirection;
  els.audioConfirmation.checked = settings.audioConfirmation;
  els.playSnapSound.checked = settings.playSnapSound;
  els.autoCaptureBackground.checked = settings.autoCaptureBackground;
  els.persistBackground.checked = settings.persistBackground;
}

function collectSettings() {
  return sanitizeSettings({
    ...settings,
    sensitivity: Number(els.sensitivity.value),
    dustDuration: Number(els.dustDuration.value),
    dustDirection: els.dustDirection.value,
    audioConfirmation: els.audioConfirmation.checked,
    playSnapSound: els.playSnapSound.checked,
    autoCaptureBackground: els.autoCaptureBackground.checked,
    persistBackground: els.persistBackground.checked
  });
}

async function applySettings(nextSettings, { notify = true } = {}) {
  const next = sanitizeSettings(nextSettings);
  settings = next;
  syncForm(next, true);
  if (pipeline) pipeline.setSettings(next);
  if (notify) {
    const response = await sendToBackground(MSG.SET_SETTINGS, { settings: next });
    if (response && response.settings) {
      settings = sanitizeSettings(response.settings);
      syncForm(settings, true);
      if (pipeline) pipeline.setSettings(settings);
    }
  }
  renderDiagnostics();
}

function scheduleSettingsSave(immediate = false) {
  settings = collectSettings();
  els.sensitivityValue.textContent = String(settings.sensitivity);
  els.durationValue.textContent = `${(settings.dustDuration / 1000).toFixed(1)} s`;
  if (saveTimer) clearTimeout(saveTimer);
  const commit = () => {
    saveTimer = null;
    applySettings(settings, { notify: true });
  };
  if (immediate) commit();
  else saveTimer = setTimeout(commit, 180);
}

function setMediaBusy(busy) {
  mediaBusy = busy;
  els.mediaBtn.disabled = busy;
  els.mediaBtn.textContent = busy ? 'Starting...' : stream ? 'Camera and microphone ready' : 'Enable camera and microphone';
  els.stopMediaBtn.disabled = busy;
}

function hasMicTrack() {
  return Boolean(stream && stream.getAudioTracks().some((track) => track.readyState === 'live'));
}

function currentMicMuted() {
  if (!stream) return false;
  const tracks = stream.getAudioTracks().filter((track) => track.readyState === 'live');
  return tracks.length > 0 && tracks.every((track) => !track.enabled);
}

function applyMicMuted(muted) {
  if (!stream) return false;
  for (const track of stream.getAudioTracks()) {
    try {
      track.enabled = !muted;
    } catch {
      // Ignore ended tracks.
    }
  }
  renderDiagnostics();
  return true;
}

function createPipeline() {
  return new SnapVanishPipeline({
    settings,
    mic: {
      getMuted: () => currentMicMuted(),
      setMuted: (muted) => applyMicMuted(muted)
    },
    loadPlate: async () => {
      const stored = await chrome.storage.local.get(PLATE_KEY);
      return stored[PLATE_KEY] || null;
    },
    onPlate: async (dataUrl, meta) => {
      plateMeta = { ...meta, createdAt: Date.now() };
      if (!settings.persistBackground) return;
      await chrome.storage.local.set({
        [PLATE_KEY]: dataUrl,
        [PLATE_META_KEY]: plateMeta
      });
      addLog('info', 'Saved room plate to local extension storage.');
    },
    onPlateCleared: async () => {
      plateMeta = null;
      await chrome.storage.local.remove([PLATE_KEY, PLATE_META_KEY]);
    },
    onState: (status) => {
      pipelineReady = Boolean(status.ready);
      if (status.ready) pipelineError = null;
      if (status.reason && status.reason !== previousLogReason) {
        if (
          status.reason.startsWith('state:') ||
          status.reason === 'vanish-start' ||
          status.reason === 'reappear-start' ||
          status.reason === 'plate-captured' ||
          status.reason === 'plate-cleared' ||
          status.reason === 'plate-loaded' ||
          status.reason === 'ready'
        ) {
          const label = status.reason.replace('state:', 'state ');
          addLog(status.uiState === 'error' ? 'error' : 'info', `Pipeline ${label} (${status.state}).`);
        }
        previousLogReason = status.reason;
      }
      renderDiagnostics(status);
      renderStage(status);
      updateControls(status);
    },
    onError: (error) => {
      pipelineError = error.message;
      addLog('error', error.message);
      showToast(error.message, 'error', 7000);
      renderDiagnostics();
      renderStage();
      updateControls();
    },
    onLog: (entry) => {
      addLog(entry.level || 'info', entry.message);
    }
  });
}

async function initPipeline() {
  renderStage();
  renderDiagnostics();
  try {
    pipeline = createPipeline();
    await pipeline.init();
    pipelineReady = true;
    pipelineError = null;
    pipeline.setAudioServiceStatus(audioService);
    for (const transient of queuedTransients.splice(0)) {
      pipeline.addAudioTransient(transient.time, transient.strength, transient);
    }
    addLog('info', 'Local vision pipeline is ready.');
  } catch (error) {
    pipelineReady = false;
    pipelineError = error.message;
    addLog('error', `Local vision failed to start: ${error.message}`);
    showToast('Local vision failed to start. See diagnostics for details.', 'error', 8000);
  }
  renderStage();
  renderDiagnostics();
  updateControls();
}

async function checkPermissions() {
  const result = { camera: 'unknown', microphone: 'unknown' };
  for (const name of ['camera', 'microphone']) {
    try {
      const state = await navigator.permissions.query({ name });
      result[name] = state.state;
      state.onchange = () => checkPermissions();
    } catch {
      result[name] = 'unknown';
    }
  }
  els.cameraPermission.textContent = permissionLabel(result.camera);
  els.microphonePermission.textContent = permissionLabel(result.microphone);
  return result;
}

async function checkAsset(url) {
  const absolute = chrome.runtime.getURL(url);
  try {
    const response = await fetch(absolute, { method: 'HEAD', cache: 'no-store' });
    if (response.ok) return true;
  } catch {
    // Fall back to a GET without consuming the body.
  }
  try {
    const response = await fetch(absolute, { cache: 'no-store' });
    const ok = response.ok;
    try {
      if (response.body) await response.body.cancel();
    } catch {
      // Ignore.
    }
    return ok;
  } catch {
    return false;
  }
}

async function verifyAssets() {
  const checks = {
    wasm: 'lib/mediapipe/wasm/vision_wasm_internal.wasm',
    hand: 'vision/models/hand_landmarker.task',
    segmentation: 'vision/models/selfie_segmenter.tflite',
    bundle: 'lib/mediapipe/tasks-vision/vision_bundle.mjs'
  };
  await Promise.all(
    Object.entries(checks).map(async ([key, url]) => {
      const ok = await checkAsset(url);
      assets[key] = ok ? 'ok' : 'missing';
    })
  );
  renderDiagnostics();
}

async function enableMedia() {
  if (stream || mediaBusy) return Boolean(stream);
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    showMediaError('This browser does not expose camera or microphone access to extension pages.');
    addLog('error', 'getUserMedia is unavailable in this browser context.');
    return false;
  }

  setMediaBusy(true);
  showMediaError('');
  micError = null;
  setSetupMessage('Requesting camera access...');
  const videoTracks = [];
  const audioTracks = [];

  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: 'user'
      },
      audio: false
    });
    videoTracks.push(...videoStream.getVideoTracks());
  } catch (error) {
    const message = describeMediaError(error, 'camera');
    showMediaError(message);
    addLog('error', message);
    setSetupMessage('Camera access is required to test the local pipeline.');
    setMediaBusy(false);
    return false;
  }

  setSetupMessage('Requesting microphone access...');
  try {
    let audioStream;
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });
    } catch {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    audioTracks.push(...audioStream.getAudioTracks());
  } catch (error) {
    micError = describeMediaError(error, 'microphone');
    addLog('warning', `${micError} Audio-confirmed snaps will be unavailable until the microphone is allowed.`);
  }

  stream = new MediaStream([...videoTracks, ...audioTracks]);
  els.video.srcObject = stream;
  try {
    await els.video.play();
  } catch (error) {
    addLog('warning', `The camera preview could not autoplay: ${error.message}`);
  }

  running = true;
  setHidden(els.placeholder, true);
  setHidden(els.stopMediaBtn, false);
  els.mediaBtn.textContent = hasMicTrack() ? 'Camera and microphone ready' : 'Camera ready (no microphone)';
  setMediaBusy(false);
  if (micError) {
    showMediaError(`Microphone unavailable: ${micError}`);
    setSetupMessage('Camera is running. Turn off "Require audio confirmation" to test gesture-only snapping.');
  } else {
    showMediaError('');
    setSetupMessage('Camera and microphone are running locally. Capture a clean room plate before vanishing.');
  }
  setSessionBadge('Running', 'ready');
  startLoop();
  await checkPermissions();
  renderDiagnostics();
  updateControls();

  if (hasMicTrack()) {
    const response = await sendToBackground(MSG.AUDIO_NEEDED);
    if (response && response.status) {
      audioService = { ...audioService, ...response.status, error: response.error || response.status.error || null };
    } else if (response && response.error) {
      audioService = { ...audioService, running: false, error: response.error };
    }
    if (pipeline) pipeline.setAudioServiceStatus(audioService);
    renderDiagnostics();
  }

  return true;
}

function stopMedia() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
  }
  stream = null;
  if (els.video) els.video.srcObject = null;
  if (pipeline) {
    const status = pipeline.getStatus();
    if (status.state !== 'VISIBLE' && status.state !== 'DISABLED') {
      pipeline.setEnabled(false);
      pipeline.setEnabled(true);
    }
  }
  if (displayCtx && els.display) {
    displayCtx.clearRect(0, 0, els.display.width, els.display.height);
  }
  setHidden(els.placeholder, false);
  setHidden(els.stopMediaBtn, true);
  els.mediaBtn.textContent = 'Enable camera and microphone';
  els.mediaBtn.disabled = false;
  setSessionBadge('Idle');
  setStageHint('');
  setSetupMessage('Preview stopped. The local vision pipeline remains loaded for meeting tabs.');
  updateControls();
  renderStage();
  renderDiagnostics();
}

function drawRawVideo() {
  if (!displayCtx || !els.video || els.video.readyState < 2) return;
  const width = els.video.videoWidth;
  const height = els.video.videoHeight;
  if (!width || !height) return;
  if (els.display.width !== width || els.display.height !== height) {
    els.display.width = width;
    els.display.height = height;
  }
  displayCtx.drawImage(els.video, 0, 0, width, height);
}

function startLoop() {
  if (rafId) return;
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!running || !els.video || els.video.readyState < 2) return;
    const now = Date.now();
    if (now - lastProcessAt < 33) return;
    lastProcessAt = now;

    if (!pipelineReady || !pipeline) {
      drawRawVideo();
      return;
    }

    try {
      const output = pipeline.processFrame(els.video, now);
      if (!output) return;
      if (els.display.width !== output.width || els.display.height !== output.height) {
        els.display.width = output.width;
        els.display.height = output.height;
      }
      displayCtx.drawImage(output, 0, 0, els.display.width, els.display.height);
      maybeRunPendingTrigger(now);
    } catch (error) {
      addLog('error', `Frame processing failed: ${error.message}`);
    }
  };
  rafId = requestAnimationFrame(tick);
}

function maybeRunPendingTrigger(now) {
  if (!pendingTrigger) return;
  if (!pipelineReady || !pipeline || !running) return;
  if (now - lastPendingAttempt < 650) return;
  lastPendingAttempt = now;
  pendingAttempts += 1;
  const result = triggerVanish('preview-pending');
  if (result && result.ok) {
    pendingTrigger = false;
    pendingAttempts = 0;
  } else if (pendingAttempts >= 10) {
    pendingTrigger = false;
    pendingAttempts = 0;
    showToast('The queued snap could not run. Capture a frame and use the Snap button.', 'warning', 6000);
  }
}

function triggerVanish(source = 'preview') {
  if (!pipelineReady || !pipeline) {
    showToast('Local vision is still starting.', 'warning');
    return { ok: false, reason: 'not-ready' };
  }
  if (!running) {
    showToast('Enable the camera before triggering the effect.', 'warning');
    return { ok: false, reason: 'no-camera' };
  }
  const status = pipeline.getStatus();
  if (!status.ready) {
    showToast('The local pipeline is not ready yet.', 'warning');
    return { ok: false, reason: 'not-ready' };
  }
  const result = pipeline.triggerSnap(source, Date.now());
  if (!result.ok) {
    const messages = {
      'no-mask': 'The person mask is not ready yet. Wait a moment and try again.',
      cooldown: 'The effect is cooling down. Try again shortly.',
      disabled: 'Snap Vanish is disabled in settings.'
    };
    showToast(messages[result.reason] || `Snap ignored: ${result.reason}`, 'warning');
  } else if (settings.playSnapSound) {
    sendToBackground(MSG.PLAY_SOUND, { sound: 'snap' }).catch(() => {});
  }
  renderDiagnostics();
  renderStage();
  updateControls();
  return result;
}

async function capturePlate() {
  if (!pipelineReady || !pipeline) {
    showToast('Local vision is still starting.', 'warning');
    return { ok: false, reason: 'not-ready' };
  }
  if (!running) {
    showToast('Enable the camera before capturing a room plate.', 'warning');
    return { ok: false, reason: 'no-camera' };
  }
  const result = await pipeline.captureBackgroundPlate({});
  if (result.ok) {
    addLog('info', `Room plate captured (${result.source || 'manual'}).`);
    showToast('Room plate captured.', 'success');
  } else {
    const message = result.message || `Room plate capture failed: ${result.reason}`;
    addLog('warning', message);
    showToast(message, 'warning', 6000);
  }
  renderDiagnostics();
  return result;
}

async function resetPlate() {
  if (!pipeline) {
    showToast('Local vision is still starting.', 'warning');
    return { ok: false, reason: 'not-ready' };
  }
  const result = await pipeline.clearBackgroundPlate();
  addLog('info', 'Saved room plate cleared.');
  showToast('Room plate cleared.', 'success');
  renderDiagnostics();
  return result;
}

function renderStage(statusOverride) {
  const status = statusOverride || (pipeline ? pipeline.getStatus() : null);
  let dot = 'connecting';
  let label = 'Starting local vision...';

  if (pipelineError) {
    dot = 'error';
    label = 'Vision failed to start';
  } else if (!pipelineReady) {
    dot = 'connecting';
    label = 'Loading local models...';
  } else if (!running) {
    dot = 'disabled';
    label = 'Pipeline ready - camera off';
  } else if (status) {
    const labels = {
      ready: ['ready', 'Live - snap to vanish'],
      vanishing: ['vanishing', 'Vanishing...'],
      vanished: ['vanished', 'Vanished - snap to return'],
      reappearing: ['reappearing', 'Reappearing...'],
      disabled: ['disabled', 'Disabled in settings'],
      error: ['error', 'Pipeline error']
    };
    const mapped = labels[status.uiState] || labels.ready;
    dot = mapped[0];
    label = mapped[1];
  }

  els.stageDot.className = `dot ${dot}`;
  els.stageLabel.textContent = label;

  if (pipelineReady && running && status) {
    if (status.hasPlate) {
      setStageHint('');
    } else {
      setStageHint('No room plate yet. Step out of frame and capture one for a believable empty room.');
    }
  } else if (micError && pipelineReady && running) {
    setStageHint('Microphone unavailable. Disable audio confirmation for gesture-only snaps.');
  }
}

function updateControls(statusOverride) {
  const status = statusOverride || (pipeline ? pipeline.getStatus() : null);
  const state = status ? status.state : '';
  const transitioning = state === 'DISINTEGRATING' || state === 'REASSEMBLING';
  els.snapBtn.textContent = state === 'VANISHED' ? 'Reappear' : 'Snap';
  els.snapBtn.disabled = !pipelineReady || !running || transitioning || Boolean(pipelineError);
  els.captureBtn.disabled = !pipelineReady || !running;
  els.resetPlateBtn.disabled = !pipelineReady;
  if (!running) {
    els.mediaBtn.disabled = mediaBusy;
  }
}

function renderDiagnostics(statusOverride) {
  const status = statusOverride || (pipeline ? pipeline.getStatus() : null);

  if (pipelineError) {
    setDiag(els.diagPipeline, 'Failed', 'bad');
  } else if (!pipeline) {
    setDiag(els.diagPipeline, 'Starting', 'warn');
  } else if (!pipelineReady) {
    setDiag(els.diagPipeline, 'Loading models', 'warn');
  } else {
    setDiag(els.diagPipeline, `${status.state} (${status.uiState})`, status.uiState === 'error' ? 'bad' : 'good');
  }

  const handOk = status ? status.handReady : false;
  const segmentationOk = status ? status.segmentationReady : false;
  setDiag(
    els.diagHand,
    handOk ? 'Ready (local)' : pipelineError ? 'Failed' : assets.hand === 'missing' ? 'Asset missing' : 'Loading',
    handOk ? 'good' : pipelineError ? 'bad' : 'warn'
  );
  setDiag(
    els.diagSegmentation,
    segmentationOk
      ? 'Ready (local)'
      : pipelineError
        ? 'Failed'
        : assets.segmentation === 'missing'
          ? 'Asset missing'
          : 'Loading',
    segmentationOk ? 'good' : pipelineError ? 'bad' : 'warn'
  );

  const assetMissing = Object.values(assets).some((value) => value === 'missing');
  setDiag(
    els.diagWasm,
    pipelineReady ? 'Loaded locally' : assetMissing ? 'Local asset missing' : assets.wasm === 'ok' ? 'Present' : 'Checking',
    pipelineReady ? 'good' : assetMissing ? 'bad' : 'warn'
  );

  if (status && status.renderer) {
    setDiag(
      els.diagRenderer,
      status.renderer.webgl ? `WebGL ${status.renderer.width}x${status.renderer.height}` : 'Canvas 2D fallback',
      status.renderer.webgl ? 'good' : 'warn'
    );
  } else {
    setDiag(els.diagRenderer, 'Pending', 'warn');
  }

  setDiag(els.diagFps, status && status.fps ? `${status.fps} fps` : '-');
  setDiag(els.diagCost, status ? `${status.processCost || 0} ms` : '-');
  setDiag(els.diagMask, status ? `${(Math.round((status.maskCoverage || 0) * 1000) / 10).toFixed(1)}%` : '-');
  setDiag(
    els.diagDetector,
    status && status.lastDetectionReason
      ? `${status.lastDetectionReason}${status.handConfidence ? ` (${Math.round(status.handConfidence * 100)}%)` : ''}`
      : '-'
  );

  if (audioService.error) {
    setDiag(els.diagAudio, `Error: ${audioService.error}`, 'bad');
  } else if (audioService.running) {
    setDiag(
      els.diagAudio,
      `${audioService.mode || 'running'} · ${audioService.transients || 0} transient${(audioService.transients || 0) === 1 ? '' : 's'}`,
      'good'
    );
  } else {
    setDiag(els.diagAudio, 'Idle', 'warn');
  }

  if (status && status.mic) {
    const parts = [status.mic.muted ? 'Muted' : 'Live', status.mic.lastAction || 'idle'];
    if (status.mic.originalMuted) parts.push('was muted');
    if (status.mic.userTouchedMic) parts.push('manual action');
    setDiag(els.diagMic, parts.join(' · '), status.mic.muted ? 'warn' : 'good');
  } else {
    setDiag(els.diagMic, hasMicTrack() ? (currentMicMuted() ? 'Muted' : 'Live') : 'No track', 'warn');
  }

  if (status && status.hasPlate) {
    setDiag(els.diagPlate, `Captured (${status.plateSource || plateMeta?.source || 'saved'})`, 'good');
  } else {
    setDiag(els.diagPlate, 'Not captured', 'warn');
  }

  const errorText = (status && status.error) || pipelineError || micError || '';
  setDiag(els.diagError, errorText || 'None', errorText ? 'bad' : 'good');

  if (pipelineReady && running) {
    const micText = hasMicTrack() ? 'Microphone available.' : 'No microphone track.';
    if (!pipelineError) {
      setSetupMessage(
        status && status.hasPlate
          ? `Ready. ${micText} Snap or use the shortcut while this preview is active.`
          : `Ready. ${micText} Capture a clean room plate for the empty-room effect.`
      );
    }
    if (!els.sessionBadge.classList.contains('error')) setSessionBadge('Running', 'ready');
  }
}

function buildTabStatus() {
  if (!pipeline) {
    return {
      ready: false,
      loading: !pipelineError,
      enabled: settings.enabled,
      state: pipelineError ? 'ERROR' : 'LOADING',
      uiState: pipelineError ? 'error' : 'ready',
      hasPlate: false,
      handReady: false,
      segmentationReady: false,
      audio: { ...audioService },
      mic: { muted: currentMicMuted(), lastAction: 'idle' },
      renderer: null,
      error: pipelineError || micError || null,
      site: { id: 'preview', name: 'Local preview' },
      visionReady: false,
      adapterReady: true
    };
  }
  return {
    ...pipeline.getStatus(),
    site: { id: 'preview', name: 'Local preview' },
    visionReady: pipelineReady,
    adapterReady: true,
    plateInfo: plateMeta,
    audioService: { ...audioService },
    error: pipeline.getStatus().error || pipelineError || micError || null
  };
}

function onRuntimeMessage(message, _sender, sendResponse) {
  if (!message) return false;
  if (message.target && message.target !== 'preview') return false;

  if (message.type === MSG.SETTINGS_CHANGED) {
    if (message.settings) {
      applySettings(message.settings, { notify: false });
      sendResponse({ ok: true });
      return false;
    }
    loadSettings()
      .then((next) => {
        applySettings(next, { notify: false });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === MSG.TRIGGER_SNAP) {
    const result = triggerVanish(message.source || 'background');
    sendResponse({ ...result, site: { id: 'preview', name: 'Local preview' } });
    return false;
  }

  if (message.type === MSG.CAPTURE_BACKGROUND) {
    capturePlate()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: 'capture-error', message: error.message }));
    return true;
  }

  if (message.type === MSG.RESET_BACKGROUND) {
    resetPlate()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: 'reset-error', message: error.message }));
    return true;
  }

  if (message.type === MSG.GET_TAB_STATUS) {
    sendResponse({
      ok: true,
      site: { id: 'preview', name: 'Local preview' },
      visionReady: pipelineReady,
      adapterReady: true,
      status: buildTabStatus()
    });
    return false;
  }

  if (message.type === MSG.AUDIO_TRANSIENT) {
    const transient = message.transient || {};
    if (pipelineReady && pipeline) {
      pipeline.addAudioTransient(transient.time || Date.now(), transient.strength, transient);
    } else if (transient) {
      queuedTransients.push(transient);
      if (queuedTransients.length > 24) queuedTransients.shift();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MSG.AUDIO_STATUS) {
    if (message.status) {
      audioService = { ...audioService, ...message.status };
      if (pipeline) pipeline.setAudioServiceStatus(audioService);
      renderDiagnostics();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
}

function bindEvents() {
  els.mediaBtn.addEventListener('click', () => enableMedia());
  els.stopMediaBtn.addEventListener('click', stopMedia);
  els.snapBtn.addEventListener('click', () => triggerVanish('preview-button'));
  els.captureBtn.addEventListener('click', () => capturePlate());
  els.resetPlateBtn.addEventListener('click', () => resetPlate());
  els.clearLogBtn.addEventListener('click', () => {
    logs.length = 0;
    renderLogs();
  });

  for (const field of [els.sensitivity, els.dustDuration]) {
    field.addEventListener('input', () => {
      if (field === els.sensitivity) els.sensitivityValue.textContent = field.value;
      if (field === els.dustDuration) els.durationValue.textContent = `${(Number(field.value) / 1000).toFixed(1)} s`;
      scheduleSettingsSave();
    });
  }

  for (const field of [
    els.dustDirection,
    els.audioConfirmation,
    els.playSnapSound,
    els.autoCaptureBackground,
    els.persistBackground
  ]) {
    field.addEventListener('change', () => scheduleSettingsSave(true));
  }

  for (const field of [
    els.sensitivity,
    els.dustDuration,
    els.dustDirection,
    els.audioConfirmation,
    els.playSnapSound,
    els.autoCaptureBackground,
    els.persistBackground
  ]) {
    field.addEventListener('focus', () => {
      editing = true;
    });
    field.addEventListener('blur', () => {
      editing = false;
    });
  }

  window.addEventListener('pagehide', cleanup);
}

async function boot() {
  displayCtx = els.display.getContext('2d', { alpha: false });
  els.versionText.textContent = `v${chrome.runtime.getManifest().version}`;
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  bindEvents();
  renderLogs();

  settings = await loadSettings();
  syncForm(settings, true);
  const stored = await chrome.storage.local.get(PLATE_META_KEY);
  plateMeta = stored[PLATE_META_KEY] || null;
  await checkPermissions();
  renderStage();
  renderDiagnostics();
  updateControls();
  verifyAssets();

  const early = await sendToBackground(MSG.PREVIEW_READY, { ready: false });
  if (early && early.settings) {
    settings = sanitizeSettings(early.settings);
    syncForm(settings, true);
  }
  if (early && early.pendingTrigger) {
    pendingTrigger = true;
    addLog('info', 'A snap was queued from outside the preview. Starting the camera.');
    enableMedia();
  }

  await initPipeline();

  const readyResponse = await sendToBackground(MSG.PREVIEW_READY, {
    ready: pipelineReady,
    error: pipelineError
  });
  if (readyResponse && readyResponse.settings) {
    settings = sanitizeSettings(readyResponse.settings);
    syncForm(settings, true);
    if (pipeline) pipeline.setSettings(settings);
  }
  if (readyResponse && readyResponse.pendingTrigger && !pendingTrigger) {
    pendingTrigger = true;
    if (!stream) enableMedia();
  }

  diagnosticsTimer = setInterval(() => {
    renderDiagnostics();
    renderStage();
    updateControls();
  }, 700);
}

function cleanup() {
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
  if (saveTimer) clearTimeout(saveTimer);
  if (toastTimer) clearTimeout(toastTimer);
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore.
      }
    }
  }
  stream = null;
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  if (pipeline) {
    pipeline.dispose().catch(() => {});
    pipeline = null;
  }
}

boot().catch((error) => {
  pipelineError = error.message;
  addLog('error', `Preview initialization failed: ${error.message}`);
  showToast(error.message, 'error', 8000);
  renderDiagnostics();
  renderStage();
});
