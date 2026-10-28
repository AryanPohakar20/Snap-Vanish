import { SnapVanishPipeline } from './pipeline.js';
import { loadSettings, sanitizeSettings } from '../lib/settings.js';
import { PLATE_KEY, PLATE_META_KEY } from '../lib/storage-keys.js';

const state = {
  pipeline: null,
  settings: null,
  ready: false,
  loading: false,
  error: null,
  micMuted: false,
  queuedTransients: [],
  queue: Promise.resolve(),
  lastLog: null
};

function post(message, transfer) {
  try {
    window.parent.postMessage({ __svVision: true, ...message }, '*', transfer || []);
  } catch (error) {
    console.warn('[Snap Vanish] Vision frame postMessage failed:', error);
  }
}

function currentStatus() {
  if (!state.pipeline) {
    return {
      ready: false,
      loading: state.loading,
      enabled: state.settings ? state.settings.enabled : true,
      state: 'LOADING',
      uiState: 'ready',
      hasPlate: false,
      audio: { running: false, mode: 'idle' },
      mic: { muted: state.micMuted },
      handReady: false,
      segmentationReady: false,
      error: state.error
    };
  }
  return state.pipeline.getStatus();
}

async function boot() {
  if (state.loading || state.pipeline) return;
  state.loading = true;
  try {
    state.settings = await loadSettings();
    state.pipeline = new SnapVanishPipeline({
      settings: state.settings,
      mic: {
        getMuted: () => Boolean(state.micMuted),
        setMuted: (muted) => {
          state.micMuted = Boolean(muted);
          post({ type: 'SET_MUTED', muted: state.micMuted });
          return true;
        }
      },
      loadPlate: async () => {
        const stored = await chrome.storage.local.get(PLATE_KEY);
        return stored[PLATE_KEY] || null;
      },
      onPlate: async (dataUrl, meta) => {
        if (!state.settings || !state.settings.persistBackground) return;
        await chrome.storage.local.set({
          [PLATE_KEY]: dataUrl,
          [PLATE_META_KEY]: {
            ...meta,
            createdAt: Date.now()
          }
        });
      },
      onPlateCleared: async () => {
        await chrome.storage.local.remove([PLATE_KEY, PLATE_META_KEY]);
      },
      onState: (status) => {
        post({ type: 'STATUS', reason: status.reason || 'update', status });
      },
      onError: (error) => {
        state.error = error.message;
        post({ type: 'ERROR', error: error.message, fatal: Boolean(error.fatal) });
      },
      onLog: (entry) => {
        state.lastLog = entry.message;
        post({ type: 'LOG', entry });
      }
    });

    await state.pipeline.init();
    state.ready = true;
    state.error = null;
    for (const transient of state.queuedTransients.splice(0)) {
      state.pipeline.addAudioTransient(transient.time, transient.strength, transient);
    }
    post({ type: 'READY', status: state.pipeline.getStatus() });
  } catch (error) {
    state.error = error.message;
    state.ready = false;
    post({ type: 'ERROR', error: error.message, fatal: true, status: currentStatus() });
  } finally {
    state.loading = false;
  }
}

function closeBitmap(bitmap) {
  try {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch {
    // Best-effort.
  }
}

async function processFrame(data) {
  const bitmap = data.bitmap;
  if (!bitmap) {
    post({ type: 'PROCESSED', requestId: data.requestId, bitmap: null });
    return;
  }

  if (!state.ready || !state.pipeline) {
    post(
      {
        type: 'PROCESSED',
        requestId: data.requestId,
        bitmap,
        status: currentStatus(),
        processingMs: 0,
        passthrough: true
      },
      [bitmap]
    );
    return;
  }

  const started = performance.now();
  let output = null;
  try {
    const canvas = state.pipeline.processFrame(bitmap, data.timestamp || Date.now());
    if (canvas) output = await createImageBitmap(canvas);
  } catch (error) {
    state.lastLog = error.message;
    post({ type: 'LOG', entry: { message: `Vision frame failed: ${error.message}`, level: 'error' } });
  } finally {
    closeBitmap(bitmap);
  }

  post(
    {
      type: 'PROCESSED',
      requestId: data.requestId,
      bitmap: output,
      status: state.pipeline.getStatus(),
      processingMs: Math.round((performance.now() - started) * 10) / 10
    },
    output ? [output] : []
  );
}

async function handleRequest(data) {
  const requestId = data.requestId;
  const respond = (type, payload, transfer) => {
    post({ type, requestId, ...payload }, transfer);
  };

  if (data.type === 'SET_SETTINGS') {
    if (!state.settings) {
      respond('SETTINGS_APPLIED', { ok: false, reason: 'not-loaded' });
      return;
    }
    state.settings = sanitizeSettings({ ...state.settings, ...(data.settings || {}) });
    if (state.pipeline) {
      state.pipeline.setSettings(state.settings);
      respond('SETTINGS_APPLIED', { ok: true, settings: state.settings, status: state.pipeline.getStatus() });
    } else {
      respond('SETTINGS_APPLIED', { ok: true, settings: state.settings });
    }
    return;
  }

  if (data.type === 'MIC_STATE') {
    state.micMuted = Boolean(data.muted);
    if (data.userInteraction && state.pipeline) {
      state.pipeline.markUserMicInteraction();
    }
    return;
  }

  if (data.type === 'AUDIO_TRANSIENT') {
    const transient = data.transient || {};
    const time = transient.time || Date.now();
    if (state.pipeline && state.ready) {
      state.pipeline.addAudioTransient(time, transient.strength, transient);
    } else {
      state.queuedTransients.push({ ...transient, time });
      if (state.queuedTransients.length > 24) state.queuedTransients.shift();
    }
    return;
  }

  if (data.type === 'AUDIO_STATUS') {
    if (state.pipeline) state.pipeline.setAudioServiceStatus(data.status || {});
    return;
  }

  if (data.type === 'TRIGGER') {
    if (!state.pipeline) {
      respond('TRIGGER_RESULT', {
        result: { ok: false, reason: 'not-initialized' },
        status: currentStatus()
      });
      return;
    }
    try {
      const result = state.pipeline.triggerSnap(data.source || 'iframe', data.timestamp || Date.now());
      respond('TRIGGER_RESULT', { result, status: state.pipeline.getStatus() });
    } catch (error) {
      respond('TRIGGER_RESULT', {
        result: { ok: false, reason: 'trigger-error', message: error.message },
        status: state.pipeline.getStatus()
      });
    }
    return;
  }

  if (data.type === 'CAPTURE_BACKGROUND') {
    if (!state.pipeline) {
      respond('CAPTURE_RESULT', {
        result: { ok: false, reason: 'not-initialized' },
        status: currentStatus()
      });
      return;
    }
    try {
      const result = await state.pipeline.captureBackgroundPlate(data.options || {});
      respond('CAPTURE_RESULT', { result, status: state.pipeline.getStatus() });
    } catch (error) {
      respond('CAPTURE_RESULT', {
        result: { ok: false, reason: 'capture-error', message: error.message },
        status: state.pipeline.getStatus()
      });
    }
    return;
  }

  if (data.type === 'RESET_BACKGROUND') {
    if (!state.pipeline) {
      respond('RESET_RESULT', {
        result: { ok: false, reason: 'not-initialized' },
        status: currentStatus()
      });
      return;
    }
    try {
      const result = await state.pipeline.clearBackgroundPlate();
      respond('RESET_RESULT', { result, status: state.pipeline.getStatus() });
    } catch (error) {
      respond('RESET_RESULT', {
        result: { ok: false, reason: 'reset-error', message: error.message },
        status: state.pipeline.getStatus()
      });
    }
    return;
  }

  if (data.type === 'GET_STATUS') {
    respond('STATUS_SNAPSHOT', {
      ready: state.ready,
      loading: state.loading,
      error: state.error,
      status: currentStatus()
    });
    return;
  }

  if (data.type === 'LOG') {
    if (data.entry && data.entry.level !== 'info') {
      console[data.entry.level === 'error' ? 'error' : 'warn'](
        '[Snap Vanish vision]',
        data.entry.message
      );
    }
    return;
  }

  if (data.type === 'DISPOSE') {
    if (state.pipeline) await state.pipeline.dispose();
    post({ type: 'DISPOSED' });
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.__svVision !== true) return;

  if (data.type === 'PROCESS') {
    state.queue = state.queue
      .then(() => processFrame(data))
      .catch((error) => {
        closeBitmap(data.bitmap);
        post({
          type: 'PROCESSED',
          requestId: data.requestId,
          bitmap: null,
          status: currentStatus(),
          error: error.message
        });
      });
    return;
  }

  if (data.type === 'PING') {
    post({ type: 'PONG', requestId: data.requestId });
    return;
  }

  state.queue = state.queue
    .then(() => handleRequest(data))
    .catch((error) => {
      post({ type: 'ERROR', error: error.message, fatal: false, status: currentStatus() });
    });
});

boot();
