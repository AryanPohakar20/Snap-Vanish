import { MSG } from '../lib/messages.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../lib/settings.js';

const els = {
  enabled: document.getElementById('enabled'),
  stateDot: document.getElementById('stateDot'),
  stateLabel: document.getElementById('stateLabel'),
  stateDetail: document.getElementById('stateDetail'),
  siteValue: document.getElementById('siteValue'),
  cameraValue: document.getElementById('cameraValue'),
  micValue: document.getElementById('micValue'),
  plateValue: document.getElementById('plateValue'),
  errorText: document.getElementById('errorText'),
  snapBtn: document.getElementById('snapBtn'),
  previewBtn: document.getElementById('previewBtn'),
  cinemaBtn: document.getElementById('cinemaBtn'),
  captureBtn: document.getElementById('captureBtn'),
  resetPlateBtn: document.getElementById('resetPlateBtn'),
  sensitivity: document.getElementById('sensitivity'),
  sensitivityValue: document.getElementById('sensitivityValue'),
  dustDuration: document.getElementById('dustDuration'),
  durationValue: document.getElementById('durationValue'),
  dustDirection: document.getElementById('dustDirection'),
  audioConfirmation: document.getElementById('audioConfirmation'),
  playSnapSound: document.getElementById('playSnapSound'),
  autoCaptureBackground: document.getElementById('autoCaptureBackground'),
  persistBackground: document.getElementById('persistBackground'),
  showDebugOverlay: document.getElementById('showDebugOverlay'),
  version: document.getElementById('version'),
  refreshBtn: document.getElementById('refreshBtn'),
  toast: document.getElementById('toast')
};

let settings = sanitizeSettings(DEFAULT_SETTINGS);
let currentStatus = null;
let saveTimer = null;
let toastTimer = null;
let pollTimer = null;
let editing = false;

function sendToBackground(type, payload = {}, timeout = 9000) {
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

function capitalize(value) {
  if (!value) return '-';
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function setOutput(el, text) {
  if (el) el.textContent = text;
}

function syncForm(nextSettings, force = false) {
  settings = sanitizeSettings(nextSettings);
  if (editing && !force) return;
  els.enabled.checked = settings.enabled;
  els.sensitivity.value = String(settings.sensitivity);
  setOutput(els.sensitivityValue, String(settings.sensitivity));
  els.dustDuration.value = String(settings.dustDuration);
  setOutput(els.durationValue, `${(settings.dustDuration / 1000).toFixed(1)} s`);
  els.dustDirection.value = settings.dustDirection;
  els.audioConfirmation.checked = settings.audioConfirmation;
  els.playSnapSound.checked = settings.playSnapSound;
  els.autoCaptureBackground.checked = settings.autoCaptureBackground;
  els.persistBackground.checked = settings.persistBackground;
  els.showDebugOverlay.checked = settings.showDebugOverlay;
}

function collectSettings() {
  return sanitizeSettings({
    ...settings,
    enabled: els.enabled.checked,
    sensitivity: Number(els.sensitivity.value),
    dustDuration: Number(els.dustDuration.value),
    dustDirection: els.dustDirection.value,
    audioConfirmation: els.audioConfirmation.checked,
    playSnapSound: els.playSnapSound.checked,
    autoCaptureBackground: els.autoCaptureBackground.checked,
    persistBackground: els.persistBackground.checked,
    showDebugOverlay: els.showDebugOverlay.checked
  });
}

function showToast(message, kind = 'info', duration = 4200) {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast hidden';
  }, duration);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.busy = busy ? '1' : '';
}

function renderStatus(status) {
  currentStatus = status;
  if (!status || status.ok === false) {
    els.stateDot.className = 'dot error';
    els.stateLabel.textContent = 'Status unavailable';
    els.stateDetail.textContent = (status && status.error) || 'The background service did not respond.';
    els.errorText.textContent = (status && status.error) || '';
    els.errorText.classList.toggle('hidden', !(status && status.error));
    return;
  }

  const active = status.active || {};
  const content = active.content || null;
  const audio = status.audio || {};
  const permissions = status.permissions || {};
  const activeIsTarget = active.kind === 'meeting' || active.kind === 'preview';

  let dot = 'connecting';
  let label = 'Connecting...';
  let detail = 'Checking the active tab.';

  if (!settings.enabled) {
    dot = 'disabled';
    label = 'Paused';
    detail = 'Snap Vanish is disabled.';
  } else if (!activeIsTarget) {
    dot = 'disabled';
    label = 'No meeting tab';
    detail = 'Open Google Meet, Teams Web or Zoom Web, or use the test preview.';
  } else if (!content) {
    dot = 'connecting';
    label = 'Connecting to page...';
    detail = active.kind === 'preview' ? 'The preview is loading.' : 'The page script has not responded yet.';
  } else if (content.error) {
    dot = 'error';
    label = 'Error';
    detail = content.error;
  } else if (content.loading || !content.ready) {
    dot = 'connecting';
    label = 'Loading local vision...';
    detail = 'MediaPipe models and WASM are starting.';
  } else {
    const state = content.uiState || 'ready';
    const labels = {
      ready: ['ready', 'Ready to snap', 'Snap your fingers or use the button.'],
      vanishing: ['vanishing', 'Vanishing...', 'Dust effect in progress.'],
      vanished: ['vanished', 'Vanished', 'Your camera is muted and hidden.'],
      reappearing: ['reappearing', 'Reappearing...', 'Reassembling the camera feed.'],
      disabled: ['disabled', 'Disabled', 'Enable Snap Vanish to use it.'],
      error: ['error', 'Effect error', content.error || 'The local pipeline reported an error.']
    };
    const mapped = labels[state] || labels.ready;
    dot = mapped[0];
    label = mapped[1];
    detail = mapped[2];
    if (active.kind === 'preview') detail = 'Local test preview is active.';
  }

  if (audio.error && dot !== 'error') {
    detail = audio.error;
  }

  els.stateDot.className = `dot ${dot}`;
  els.stateLabel.textContent = label;
  els.stateDetail.textContent = detail;

  els.siteValue.textContent = active.site
    ? active.site.name
    : active.kind === 'preview'
      ? 'Local preview'
      : 'None';

  const cameraPermission = permissionLabel(permissions.camera);
  if (content && content.ready) {
    els.cameraValue.textContent = content.handReady === false ? `${cameraPermission} (hands off)` : cameraPermission;
  } else {
    els.cameraValue.textContent = cameraPermission;
  }

  const micPermission = permissionLabel(permissions.microphone);
  if (audio.running) {
    els.micValue.textContent = `${micPermission} (listening)`;
  } else if (audio.error) {
    els.micValue.textContent = `${micPermission} (error)`;
  } else {
    els.micValue.textContent = micPermission;
  }

  if (content && content.hasPlate) {
    els.plateValue.textContent = `Captured (${capitalize(content.plateSource || content.plateInfo?.source || 'saved')})`;
  } else if (content && content.plateInfo) {
    els.plateValue.textContent = 'Saved';
  } else {
    els.plateValue.textContent = 'Not captured';
  }

  const errors = [];
  if (content && content.error) errors.push(content.error);
  if (content && content.adapterTimedOut) errors.push('The meeting camera patch was not detected. Refresh the meeting tab after installing the extension.');
  if (audio.error) errors.push(audio.error);
  els.errorText.textContent = errors.join(' ');
  els.errorText.classList.toggle('hidden', errors.length === 0);

  els.captureBtn.disabled = !activeIsTarget;
  els.resetPlateBtn.disabled = !activeIsTarget;
  if (status.version) els.version.textContent = `v${status.version}`;
}

async function refreshStatus({ quiet = true } = {}) {
  const response = await sendToBackground(MSG.GET_STATUS);
  if (response && response.ok) {
    if (response.settings) syncForm(response.settings);
    renderStatus(response);
  } else {
    renderStatus(response);
    if (!quiet) showToast((response && response.error) || 'Could not read status.', 'error');
  }
  return response;
}

function scheduleSave(immediate = false) {
  settings = collectSettings();
  setOutput(els.sensitivityValue, String(settings.sensitivity));
  setOutput(els.durationValue, `${(settings.dustDuration / 1000).toFixed(1)} s`);
  if (saveTimer) clearTimeout(saveTimer);
  const commit = async () => {
    saveTimer = null;
    const response = await sendToBackground(MSG.SET_SETTINGS, { settings });
    if (!response || response.ok === false) {
      showToast((response && response.error) || 'Settings could not be saved.', 'error');
      return;
    }
    if (response.settings) syncForm(response.settings, true);
    await refreshStatus();
  };
  if (immediate) commit();
  else saveTimer = setTimeout(commit, 180);
}

async function runAction(button, action, successMessage) {
  setBusy(button, true);
  try {
    const response = await action();
    if (response && response.ok) {
      if (successMessage) showToast(successMessage, 'success');
    } else {
      const message =
        (response && (response.message || response.reason || response.error)) || 'The action could not be completed.';
      showToast(message, response && response.reason === 'opened-preview' ? 'warning' : 'error');
    }
    await refreshStatus();
    return response;
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  for (const field of [els.sensitivity, els.dustDuration]) {
    field.addEventListener('input', () => {
      if (field === els.sensitivity) setOutput(els.sensitivityValue, field.value);
      if (field === els.dustDuration) setOutput(els.durationValue, `${(Number(field.value) / 1000).toFixed(1)} s`);
      scheduleSave();
    });
  }

  for (const field of [
    els.dustDirection,
    els.audioConfirmation,
    els.playSnapSound,
    els.autoCaptureBackground,
    els.persistBackground,
    els.showDebugOverlay
  ]) {
    field.addEventListener('change', () => scheduleSave(true));
  }

  els.enabled.addEventListener('change', () => scheduleSave(true));

  for (const field of [
    els.enabled,
    els.sensitivity,
    els.dustDuration,
    els.dustDirection,
    els.audioConfirmation,
    els.playSnapSound,
    els.autoCaptureBackground,
    els.persistBackground,
    els.showDebugOverlay
  ]) {
    field.addEventListener('focus', () => {
      editing = true;
    });
    field.addEventListener('blur', () => {
      editing = false;
    });
  }

  els.snapBtn.addEventListener('click', () => {
    runAction(els.snapBtn, () => sendToBackground(MSG.TRIGGER_SNAP, { source: 'popup' }), 'Snap sent to the active tab.');
  });

  els.previewBtn.addEventListener('click', async () => {
    setBusy(els.previewBtn, true);
    const response = await sendToBackground(MSG.OPEN_PREVIEW);
    setBusy(els.previewBtn, false);
    if (response && response.ok) {
      window.close();
    } else {
      showToast((response && response.error) || 'The preview could not be opened.', 'error');
    }
  });

  els.cinemaBtn.addEventListener('click', async () => {
    setBusy(els.cinemaBtn, true);
    const response = await sendToBackground(MSG.ABSOLUTE_CINEMA_SHOW);
    setBusy(els.cinemaBtn, false);
    if (response && response.ok) {
      showToast('Absolute Cinema is live on your outgoing camera for five seconds.', 'success', 3000);
    } else {
      const message =
        (response && (response.message || response.reason || response.error)) ||
        'Absolute Cinema could not start.';
      showToast(message, 'error');
    }
  });

  els.captureBtn.addEventListener('click', () => {
    runAction(
      els.captureBtn,
      () => sendToBackground(MSG.CAPTURE_BACKGROUND),
      'Room plate captured.'
    );
  });

  els.resetPlateBtn.addEventListener('click', () => {
    runAction(
      els.resetPlateBtn,
      () => sendToBackground(MSG.RESET_BACKGROUND),
      'Saved room plate cleared.'
    );
  });

  els.refreshBtn.addEventListener('click', () => refreshStatus({ quiet: false }));

  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (saveTimer) clearTimeout(saveTimer);
    if (toastTimer) clearTimeout(toastTimer);
  });
}

async function init() {
  bindEvents();
  await refreshStatus({ quiet: false });
  pollTimer = setInterval(() => refreshStatus({ quiet: true }), 1800);
}

init().catch((error) => {
  renderStatus({ ok: false, error: error.message });
});
