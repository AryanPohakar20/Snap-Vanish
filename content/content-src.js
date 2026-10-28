import { MSG, detectSiteFromUrl } from '../lib/messages.js';
import { loadSettings, sanitizeSettings } from '../lib/settings.js';
import { PLATE_META_KEY } from '../lib/storage-keys.js';
import {
  ABSOLUTE_CINEMA_CYCLE_MS,
  ABSOLUTE_CINEMA_MEME_PATH,
  createAbsoluteCinemaController
} from './absolute-cinema/controller.js';

const SITE = detectSiteFromUrl(location.href);

if (SITE) {
  start();
}

function start() {
  const session = `sv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let settings = null;
  let ui = null;
  let plateInfo = null;
  let lastLog = null;

  let adapterReady = false;
  let adapterInfo = null;
  let adapterAudio = { hasTracks: false, muted: false, trackCount: 0, at: 0 };
  let adapterInitialized = false;
  let adapterTimedOut = false;

  let audioService = { running: false, mode: 'idle', error: null };
  let visionFrame = null;
  let visionReady = false;
  let visionInitializing = true;
  let visionError = null;
  let visionStatus = null;
  let visionRequestCounter = 0;
  let visionRequests = new Map();
  let frameRequestCounter = 0;
  let pendingFrames = new Map();
  let visionTimeoutTimer = null;

  let handshakeTimer = null;
  let lastStatusSentAt = 0;
  let lastStatusSignature = '';
  let lastRenderAt = 0;
  let renderTimer = null;
  let suppressMicInteraction = false;
  let cinemaSequence = 0;
  let cinemaModeId = 0;
  let cinemaRequestCounter = 0;
  let cinemaBlobPromise = null;
  const cinemaPending = new Map();
  const absoluteCinema = createAbsoluteCinemaController({
    onStop: () => {
      if (!cinemaModeId) return;
      postToPage({
        type: 'SV_ABSOLUTE_CINEMA',
        active: false,
        modeId: cinemaModeId,
        session
      });
    }
  });

  init().catch((error) => {
    console.error('[Snap Vanish] Content initialization failed:', error);
    showToast(error.message, 'error');
  });

  async function init() {
    settings = await loadSettings();
    plateInfo = await readPlateMeta();
    ui = createOverlay();
    renderUi();
    installMicInteractionTracking();
    createVisionFrame();

    handshakeTimer = setInterval(() => {
      postToPage({ type: 'SV_CLIENT_HELLO', site: SITE.id });
    }, 600);

    window.addEventListener('message', onWindowMessage);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
    window.addEventListener('pagehide', dispose);

    postToPage({ type: 'SV_CLIENT_HELLO', site: SITE.id });
    chrome.runtime
      .sendMessage({
        type: MSG.CONTENT_READY,
        site: SITE
      })
      .catch(() => {});

    setTimeout(() => {
      if (!adapterReady) {
        adapterTimedOut = true;
        showToast(
          'Meeting camera patch was not detected. The local preview still works. Refresh the meeting tab after installing Snap Vanish.',
          'warning',
          8000
        );
        updateStatusChip('error', 'Camera patch unavailable');
      }
    }, 7000);
  }

  function createVisionFrame() {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('content/vision-frame.html');
    frame.title = 'Snap Vanish local vision service';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.dataset.snapVanishVision = '1';
    frame.style.cssText =
      'position:fixed;left:-10000px;top:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none;';
    document.documentElement.appendChild(frame);
    visionFrame = frame;

    frame.addEventListener('load', () => {
      if (!visionReady && frame.contentWindow) {
        frame.contentWindow.postMessage(
          { __svVision: true, type: 'PING', requestId: 'load' },
          '*'
        );
      }
    });

    visionTimeoutTimer = setTimeout(() => {
      if (visionReady) return;
      visionInitializing = false;
      visionError =
        'The local vision service did not start. Reload the meeting tab. If this keeps happening, open the local preview for diagnostics.';
      lastLog = visionError;
      showToast(visionError, 'error', 12000);
      renderUi();
    }, 30000);
  }

  function postToPage(message, transfer) {
    try {
      window.postMessage({ __snapVanish: true, ...message }, '*', transfer || []);
      return true;
    } catch (error) {
      console.warn('[Snap Vanish] postMessage failed:', error);
      return false;
    }
  }

  function postToVision(message, transfer) {
    if (!visionAvailable()) return false;
    try {
      visionFrame.contentWindow.postMessage({ __svVision: true, ...message }, '*', transfer || []);
      return true;
    } catch (error) {
      lastLog = error.message;
      return false;
    }
  }

  function visionAvailable() {
    return Boolean(visionReady && visionFrame && visionFrame.contentWindow);
  }

  function visionRequest(type, payload = {}, timeout = 12000) {
    if (!visionAvailable()) {
      return Promise.reject(new Error('The local vision service is not ready'));
    }
    const requestId = ++visionRequestCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        visionRequests.delete(requestId);
        reject(new Error(`Vision service timed out while handling ${type}`));
      }, timeout);
      visionRequests.set(requestId, { resolve, reject, timer });
      if (
        !postToVision({
          type,
          requestId,
          ...payload
        })
      ) {
        clearTimeout(timer);
        visionRequests.delete(requestId);
        reject(new Error('The local vision service is unavailable'));
      }
    });
  }

  function resolveVisionRequest(data) {
    const pending = visionRequests.get(data.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    visionRequests.delete(data.requestId);
    pending.resolve(data);
    return true;
  }

  function onWindowMessage(event) {
    const data = event.data;
    if (!data) return;

    if (
      data.__svVision === true &&
      visionFrame &&
      event.source === visionFrame.contentWindow
    ) {
      onVisionMessage(data);
      return;
    }

    if (data.__snapVanish !== true || event.source !== window) return;

    if (data.type === 'SV_ABSOLUTE_CINEMA_RESULT') {
      const pending = cinemaPending.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        cinemaPending.delete(data.requestId);
        pending.resolve(data);
      }
      return;
    }

    if (data.type === 'SV_ADAPTER_READY') {
      adapterReady = true;
      adapterInfo = data;
      if (data.audio) adapterAudio = data.audio;
      if (handshakeTimer) {
        clearInterval(handshakeTimer);
        handshakeTimer = null;
      }
      if (visionReady) maybeInitAdapter();
      renderUi();
      return;
    }

    if (data.type === 'SV_AUDIO_STATE' && data.audio) {
      adapterAudio = data.audio;
      sendVisionMicState();
      scheduleRender();
      return;
    }

    if (data.type === 'SV_FRAME') {
      handleFrame(data);
      return;
    }

    if (data.type === 'SV_STATUS') {
      adapterInfo = { ...adapterInfo, ...data };
      scheduleRender();
      return;
    }

    if (data.type === 'SV_ADAPTER_ERROR') {
      showToast(data.reason || 'Meeting adapter error', 'error', 9000);
      updateStatusChip('error', 'Camera patch error');
    }
  }

  function onVisionMessage(data) {
    if (data.type === 'READY') {
      visionReady = true;
      visionInitializing = false;
      visionError = null;
      if (visionTimeoutTimer) {
        clearTimeout(visionTimeoutTimer);
        visionTimeoutTimer = null;
      }
      visionStatus = data.status || visionStatus;
      if (settings) {
        postToVision({ type: 'SET_SETTINGS', settings });
      }
      sendVisionMicState();
      maybeInitAdapter();
      requestAudio();
      renderUi();
      return;
    }

    if (data.type === 'STATUS') {
      if (data.status) visionStatus = data.status;
      handleVisionStatus(data.reason || (data.status && data.status.reason), data.status);
      scheduleRender();
      return;
    }

    if (data.type === 'PROCESSED') {
      handleProcessedFrame(data);
      return;
    }

    if (
      data.type === 'TRIGGER_RESULT' ||
      data.type === 'CAPTURE_RESULT' ||
      data.type === 'RESET_RESULT' ||
      data.type === 'STATUS_SNAPSHOT' ||
      data.type === 'SETTINGS_APPLIED'
    ) {
      if (data.status) visionStatus = data.status;
      resolveVisionRequest(data);
      scheduleRender();
      return;
    }

    if (data.type === 'SET_MUTED') {
      adapterAudio = {
        ...adapterAudio,
        muted: Boolean(data.muted),
        at: Date.now()
      };
      postToPage({ type: 'SV_SET_MUTED', muted: Boolean(data.muted) });
      scheduleRender();
      return;
    }

    if (data.type === 'ERROR') {
      visionError = data.error || 'Local vision error';
      lastLog = visionError;
      if (data.fatal) visionInitializing = false;
      showToast(visionError, 'error', 9000);
      scheduleRender();
      return;
    }

    if (data.type === 'LOG') {
      const entry = data.entry || {};
      lastLog = entry.message || lastLog;
      if (entry.level && entry.level !== 'info') {
        console[entry.level === 'error' ? 'error' : 'warn']('[Snap Vanish]', entry.message);
      }
    }
  }

  function handleFrame(data) {
    const started = performance.now();

    if (!visionAvailable()) {
      postProcessed(data, data.bitmap, started);
      return;
    }

    const requestId = ++frameRequestCounter;
    const timeout = setTimeout(() => {
      pendingFrames.delete(requestId);
    }, 5000);
    pendingFrames.set(requestId, {
      adapterId: data.adapterId,
      frameId: data.frameId,
      started,
      timeout
    });

    if (
      !postToVision(
        {
          type: 'PROCESS',
          requestId,
          timestamp: data.timestamp || Date.now(),
          bitmap: data.bitmap
        },
        [data.bitmap]
      )
    ) {
      clearTimeout(timeout);
      pendingFrames.delete(requestId);
      postProcessed(data, data.bitmap, started);
    }
  }

  function handleProcessedFrame(data) {
    const pending = pendingFrames.get(data.requestId);
    if (!pending) {
      closeBitmap(data.bitmap);
      return;
    }
    clearTimeout(pending.timeout);
    pendingFrames.delete(data.requestId);
    if (data.status) visionStatus = data.status;
    postToPage(
      {
        type: 'SV_PROCESSED',
        session,
        adapterId: pending.adapterId,
        frameId: pending.frameId,
        processingMs: data.processingMs || Math.round((performance.now() - pending.started) * 10) / 10,
        bitmap: data.bitmap || null
      },
      data.bitmap ? [data.bitmap] : []
    );
    scheduleRender();
  }

  function postProcessed(data, bitmap, started) {
    postToPage(
      {
        type: 'SV_PROCESSED',
        session,
        adapterId: data.adapterId,
        frameId: data.frameId,
        processingMs: Math.round((performance.now() - started) * 10) / 10,
        bitmap: bitmap || null
      },
      bitmap ? [bitmap] : []
    );
  }

  function closeBitmap(bitmap) {
    try {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    } catch {
      // Best-effort.
    }
  }

  function maybeInitAdapter() {
    if (!adapterReady || !visionReady || adapterInitialized || !settings) return;
    adapterInitialized = true;
    adapterTimedOut = false;
    postToPage({
      type: 'SV_INIT',
      session,
      enabled: settings.enabled,
      settings
    });
    postToPage({ type: 'SV_REQUEST_AUDIO_STATE' });
    sendVisionMicState();
    requestAudio();
    renderUi();
  }

  function sendVisionMicState() {
    postToVision({
      type: 'MIC_STATE',
      muted: Boolean(adapterAudio.muted),
      hasTracks: Boolean(adapterAudio.hasTracks)
    });
  }

  function handleVisionStatus(reason, status) {
    if (reason === 'vanish-start') {
      syncSiteMute('vanish', status);
      if (settings.playSnapSound) {
        chrome.runtime.sendMessage({ type: MSG.PLAY_SOUND, sound: 'snap' }).catch(() => {});
      }
    } else if (reason === 'reappear-start') {
      syncSiteMute('reappear', status);
    }

    const force =
      reason === 'vanish-start' ||
      reason === 'reappear-start' ||
      (typeof reason === 'string' && reason.startsWith('state:'));
    sendContentState(force);
  }

  function sendContentState(force) {
    if (!settings) return;
    const status = buildStatus();
    const signature = [
      status.state,
      status.ready,
      status.hasPlate,
      status.error,
      status.audio && status.audio.lastTransientAt,
      status.mic && status.mic.lastAction
    ].join('|');
    const now = Date.now();
    if (!force && signature === lastStatusSignature && now - lastStatusSentAt < 2500) return;
    lastStatusSignature = signature;
    lastStatusSentAt = now;
    chrome.runtime
      .sendMessage({
        type: MSG.CONTENT_STATE,
        site: SITE,
        state: status.state,
        status,
        error: status.error
      })
      .catch(() => {});
  }

  function loadCinemaBlob() {
    if (cinemaBlobPromise) return cinemaBlobPromise;
    cinemaBlobPromise = fetch(chrome.runtime.getURL(ABSOLUTE_CINEMA_MEME_PATH))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`The Absolute Cinema image could not be loaded (${response.status}).`);
        }
        return response.blob();
      })
      .catch((error) => {
        cinemaBlobPromise = null;
        throw error;
      });
    return cinemaBlobPromise;
  }

  function requestPageAbsoluteCinema(payload, transfer, timeout = 3000) {
    const requestId = ++cinemaRequestCounter;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cinemaPending.delete(requestId);
        resolve({
          ok: false,
          reason: 'adapter-timeout',
          message: 'The camera renderer did not respond. Reload the tab and try again.'
        });
      }, timeout);
      cinemaPending.set(requestId, { resolve, timer });
      if (
        !postToPage(
          {
            ...payload,
            requestId,
            session
          },
          transfer
        )
      ) {
        clearTimeout(timer);
        cinemaPending.delete(requestId);
        resolve({
          ok: false,
          reason: 'adapter-unavailable',
          message: 'The meeting camera renderer is unavailable. Reload the tab and try again.',
          transferFailed: true
        });
      }
    });
  }

  async function showAbsoluteCinema() {
    if (!adapterReady) {
      return {
        ok: false,
        reason: 'adapter-not-ready',
        message: 'The meeting camera patch is still starting. Try again in a moment.'
      };
    }

    if (typeof createImageBitmap !== 'function') {
      return {
        ok: false,
        reason: 'image-unavailable',
        message: 'This browser cannot prepare the Absolute Cinema image.'
      };
    }

    absoluteCinema.cancel();
    const modeId = ++cinemaSequence;
    cinemaModeId = modeId;

    let bitmap;
    try {
      const blob = await loadCinemaBlob();
      bitmap = await createImageBitmap(blob);
    } catch (error) {
      if (modeId === cinemaSequence) {
        postToPage({
          type: 'SV_ABSOLUTE_CINEMA',
          active: false,
          modeId,
          session
        });
      }
      return { ok: false, reason: 'image-unavailable', message: error.message };
    }

    if (modeId !== cinemaSequence) {
      try {
        bitmap.close();
      } catch {
        // Ignore.
      }
      return { ok: true, superseded: true };
    }

    const response = await requestPageAbsoluteCinema(
      {
        type: 'SV_ABSOLUTE_CINEMA',
        active: true,
        modeId,
        durationMs: ABSOLUTE_CINEMA_CYCLE_MS,
        bitmap
      },
      [bitmap]
    );

    if (response.transferFailed) {
      try {
        bitmap.close();
      } catch {
        // Ignore.
      }
    }

    if (modeId !== cinemaSequence) {
      return { ok: true, superseded: true };
    }

    if (!response || response.ok !== true || response.superseded) {
      postToPage({
        type: 'SV_ABSOLUTE_CINEMA',
        active: false,
        modeId,
        session
      });
      return {
        ok: false,
        reason: (response && (response.reason || (response.superseded ? 'superseded' : null))) || 'activation-failed',
        message:
          (response && response.message) ||
          'The camera renderer could not start Absolute Cinema. Reload the tab and try again.'
      };
    }

    absoluteCinema.start();
    return {
      ok: true,
      restarted: Boolean(response.restarted),
      modeId,
      site: SITE
    };
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message) return false;
    if (message.target && message.target !== 'content') return false;

    if (message.type === MSG.SETTINGS_CHANGED) {
      if (message.settings) {
        settings = sanitizeSettings(message.settings);
        applySettings();
      } else {
        loadSettings().then((next) => {
          settings = next;
          applySettings();
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MSG.TRIGGER_SNAP) {
      if (!visionAvailable()) {
        sendResponse({ ok: false, reason: 'vision-not-ready', site: SITE });
        showToast('Local vision is still starting. Try again in a moment.', 'warning');
        return false;
      }
      visionRequest('TRIGGER', { source: message.source || 'popup' }, 8000)
        .then((data) => {
          const result = data.result || { ok: false, reason: 'no-result' };
          if (data.status) visionStatus = data.status;
          if (!result.ok) {
            showToast(
              result.reason === 'no-mask'
                ? 'Segmentation is still warming up. Try again in a moment.'
                : `Snap ignored: ${result.reason}`,
              'warning'
            );
          }
          renderUi();
          sendContentState(true);
          sendResponse({ ...result, site: SITE });
        })
        .catch((error) => {
          sendResponse({ ok: false, reason: 'vision-timeout', message: error.message });
        });
      return true;
    }

    if (message.type === MSG.CAPTURE_BACKGROUND) {
      visionRequest('CAPTURE_BACKGROUND', {}, 20000)
        .then((data) => {
          const result = data.result || { ok: false, reason: 'no-result' };
          if (data.status) visionStatus = data.status;
          if (!result.ok) {
            showToast(result.message || `Background capture failed: ${result.reason}`, 'warning', 6000);
          } else {
            showToast('Clean background plate captured.', 'success');
          }
          renderUi();
          sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, reason: 'vision-timeout', message: error.message }));
      return true;
    }

    if (message.type === MSG.RESET_BACKGROUND) {
      visionRequest('RESET_BACKGROUND', {}, 10000)
        .then((data) => {
          const result = data.result || { ok: false, reason: 'no-result' };
          if (data.status) visionStatus = data.status;
          showToast('Saved background plate cleared.', 'success');
          renderUi();
          sendResponse(result);
        })
        .catch((error) => sendResponse({ ok: false, reason: 'vision-timeout', message: error.message }));
      return true;
    }

    if (message.type === MSG.GET_TAB_STATUS) {
      const respond = (status, extra = {}) => {
        sendResponse({
          ok: true,
          site: SITE,
          adapter: adapterInfo,
          adapterReady,
          audioService,
          status: {
            ...status,
            site: SITE,
            adapterReady,
            adapterTimedOut,
            adapterAudio,
            audioService,
            plateInfo,
            ...extra
          }
        });
      };

      if (visionAvailable()) {
        visionRequest('GET_STATUS', {}, 5000)
          .then((data) => {
            respond(data.status || buildStatus(), { visionReady: true });
          })
          .catch(() => respond(buildStatus()));
        return true;
      }

      respond(buildStatus());
      return false;
    }

    if (message.type === MSG.AUDIO_TRANSIENT) {
      if (message.transient) {
        postToVision({ type: 'AUDIO_TRANSIENT', transient: message.transient });
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MSG.AUDIO_STATUS) {
      if (message.status) {
        audioService = { ...audioService, ...message.status };
        postToVision({ type: 'AUDIO_STATUS', status: audioService });
        scheduleRender();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MSG.ABSOLUTE_CINEMA_SHOW) {
      showAbsoluteCinema()
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, reason: 'render-mode-error', message: error.message })
        );
      return true;
    }

    return false;
  }

  function applySettings() {
    if (visionReady) postToVision({ type: 'SET_SETTINGS', settings });
    postToPage({
      type: 'SV_CONFIG',
      session,
      enabled: settings.enabled,
      settings
    });
    if (settings.enabled) requestAudio();
    renderUi();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.settings && changes.settings.newValue) {
      settings = sanitizeSettings(changes.settings.newValue);
      applySettings();
    }
    if (changes[PLATE_META_KEY]) {
      plateInfo = changes[PLATE_META_KEY].newValue || null;
      scheduleRender();
    }
  }

  function requestAudio() {
    chrome.runtime
      .sendMessage({ type: MSG.AUDIO_NEEDED })
      .then((response) => {
        if (response && response.status) {
          audioService = {
            ...audioService,
            ...response.status,
            error: response.error || response.status.error || null
          };
        } else if (response && response.error) {
          audioService = { ...audioService, running: false, error: response.error };
        }
        postToVision({ type: 'AUDIO_STATUS', status: audioService });
        scheduleRender();
      })
      .catch(() => {});
  }

  async function readPlateMeta() {
    try {
      const stored = await chrome.storage.local.get(PLATE_META_KEY);
      return stored[PLATE_META_KEY] || null;
    } catch {
      return null;
    }
  }

  function buildStatus() {
    if (visionStatus) {
      return {
        ...visionStatus,
        site: SITE,
        adapterReady,
        adapterTimedOut,
        adapterAudio,
        audioService,
        plateInfo,
        visionReady,
        error: visionError || visionStatus.error || null
      };
    }
    return {
      ready: false,
      loading: visionInitializing,
      enabled: settings ? settings.enabled : true,
      state: visionError ? 'ERROR' : 'LOADING',
      uiState: visionError ? 'error' : 'ready',
      site: SITE,
      adapterReady,
      adapterTimedOut,
      adapterAudio,
      audioService,
      plateInfo,
      visionReady,
      handReady: false,
      segmentationReady: false,
      audio: { ...audioService },
      mic: { muted: Boolean(adapterAudio.muted), lastAction: 'idle' },
      error: visionError || lastLog || null
    };
  }

  function scheduleRender() {
    const now = performance.now();
    if (now - lastRenderAt < 220) {
      if (!renderTimer) {
        renderTimer = setTimeout(() => {
          renderTimer = null;
          renderUi();
        }, 220);
      }
      return;
    }
    lastRenderAt = now;
    renderUi();
    sendContentState(false);
  }

  function dispose() {
    absoluteCinema.dispose();
    cinemaModeId = 0;
    for (const pending of cinemaPending.values()) clearTimeout(pending.timer);
    cinemaPending.clear();
    if (handshakeTimer) clearInterval(handshakeTimer);
    if (visionTimeoutTimer) clearTimeout(visionTimeoutTimer);
    if (renderTimer) clearTimeout(renderTimer);
    for (const pending of visionRequests.values()) clearTimeout(pending.timer);
    visionRequests.clear();
    for (const pending of pendingFrames.values()) clearTimeout(pending.timeout);
    pendingFrames.clear();
    postToVision({ type: 'DISPOSE' });
  }

  function createOverlay() {
    const existing = document.getElementById('snap-vanish-root');
    if (existing) existing.remove();
    const host = document.createElement('div');
    host.id = 'snap-vanish-root';
    host.setAttribute('data-site', SITE.id);
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: 252px;
        padding: 12px 13px 11px;
        border-radius: 14px;
        background: rgba(15, 17, 22, 0.94);
        color: #eef0f6;
        border: 1px solid rgba(242, 185, 89, 0.34);
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.38);
        font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif;
        font-size: 12px;
        line-height: 1.35;
        backdrop-filter: blur(14px);
        user-select: none;
      }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .mark {
        width: 21px; height: 21px; border-radius: 50%;
        background: radial-gradient(circle at 34% 30%, #ffe1a0, #f2b959 46%, #8a5b16 100%);
        box-shadow: 0 0 14px rgba(242, 185, 89, 0.45);
        flex: 0 0 auto;
      }
      .title { font-weight: 650; font-size: 12.5px; letter-spacing: 0.01em; flex: 1; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b93a6; box-shadow: 0 0 8px currentColor; }
      .dot.ready { background: #64d89a; color: #64d89a; }
      .dot.vanishing, .dot.vanished { background: #f2b959; color: #f2b959; }
      .dot.reappearing { background: #78b7ff; color: #78b7ff; }
      .dot.error, .dot.disabled { background: #8b93a6; color: #8b93a6; }
      .state { color: #b9c0d0; font-size: 11.5px; margin-bottom: 6px; }
      .state strong { color: #eef0f6; font-weight: 600; }
      .row { display: flex; gap: 6px; margin-top: 7px; }
      button {
        flex: 1;
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.075);
        color: #eef0f6;
        border-radius: 8px;
        padding: 6px 8px;
        font: inherit;
        font-size: 11.5px;
        cursor: pointer;
      }
      button.primary {
        background: linear-gradient(180deg, #f4c46d, #d99a35);
        color: #1b1407;
        border-color: rgba(255, 224, 160, 0.7);
        font-weight: 650;
      }
      button.cinema {
        background: linear-gradient(180deg, rgba(255, 217, 138, 0.18), rgba(154, 103, 28, 0.16));
        border-color: rgba(242, 185, 89, 0.45);
        color: #f2c36e;
        font-weight: 650;
      }
      button.cinema:hover { border-color: rgba(255, 217, 138, 0.72); }
      button:hover { filter: brightness(1.08); }
      .hint { margin-top: 7px; color: #8b93a6; font-size: 10.5px; }
      .warn {
        margin-top: 7px;
        padding: 6px 8px;
        border-radius: 7px;
        background: rgba(242, 185, 89, 0.12);
        color: #f3ca84;
        font-size: 10.5px;
      }
      .toast {
        margin-top: 7px;
        padding: 6px 8px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.07);
        font-size: 10.5px;
        color: #d8deeb;
        display: none;
      }
      .toast.visible { display: block; }
      .toast.error { background: rgba(255, 98, 98, 0.14); color: #ffb4b4; }
      .toast.warning { background: rgba(242, 185, 89, 0.14); color: #f3ca84; }
      .toast.success { background: rgba(100, 216, 154, 0.14); color: #9be8bd; }
      .debug {
        display: none;
        margin-top: 7px;
        padding: 6px 8px;
        border-radius: 7px;
        background: rgba(0, 0, 0, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #aab3c5;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 10px;
        line-height: 1.45;
        white-space: pre-line;
        user-select: text;
      }
    `;
    shadow.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head">
        <div class="mark"></div>
        <div class="title">Snap Vanish</div>
        <div class="dot" data-role="dot"></div>
      </div>
      <div class="state" data-role="state">Loading…</div>
      <div class="row">
        <button class="primary" data-role="snap" type="button">Snap</button>
        <button data-role="capture" type="button">Room plate</button>
      </div>
      <div class="row">
        <button class="cinema" data-role="cinema" type="button">Absolute Cinema</button>
      </div>
      <div class="warn" data-role="warn" style="display:none"></div>
      <div class="debug" data-role="debug" style="display:none"></div>
      <div class="toast" data-role="toast"></div>
      <div class="hint">Alt+Shift+V · processed locally</div>
    `;
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);

    const refs = {
      host,
      shadow,
      dot: shadow.querySelector('[data-role="dot"]'),
      state: shadow.querySelector('[data-role="state"]'),
      warn: shadow.querySelector('[data-role="warn"]'),
      debug: shadow.querySelector('[data-role="debug"]'),
      toast: shadow.querySelector('[data-role="toast"]'),
      snap: shadow.querySelector('[data-role="snap"]'),
      capture: shadow.querySelector('[data-role="capture"]'),
      cinema: shadow.querySelector('[data-role="cinema"]'),
      toastTimer: null
    };

    refs.snap.addEventListener('click', () => {
      if (!visionAvailable()) {
        showToast('Local vision is still starting.', 'warning');
        return;
      }
      visionRequest('TRIGGER', { source: 'overlay' }, 8000)
        .then((data) => {
          if (data.status) visionStatus = data.status;
          if (!data.result || !data.result.ok) {
            showToast(`Snap ignored: ${(data.result && data.result.reason) || 'unknown'}`, 'warning');
          }
          renderUi();
          sendContentState(true);
        })
        .catch((error) => showToast(error.message, 'error'));
    });

    refs.capture.addEventListener('click', () => {
      if (!visionAvailable()) {
        showToast('Local vision is still starting.', 'warning');
        return;
      }
      visionRequest('CAPTURE_BACKGROUND', {}, 20000)
        .then((data) => {
          if (data.status) visionStatus = data.status;
          const result = data.result || {};
          if (!result.ok) {
            showToast(result.message || `Capture failed: ${result.reason}`, 'warning', 7000);
          } else {
            showToast('Clean room plate captured.', 'success');
          }
          renderUi();
        })
        .catch((error) => showToast(error.message, 'error'));
    });

    refs.cinema.addEventListener('click', () => {
      showAbsoluteCinema()
        .then((result) => {
          if (result && result.ok) {
            if (!result.superseded) {
              showToast('Absolute Cinema is live for five seconds.', 'success', 3000);
            }
          } else {
            showToast(
              (result && (result.message || result.reason)) || 'Absolute Cinema could not start.',
              'error',
              6000
            );
          }
        })
        .catch((error) => showToast(error.message, 'error', 6000));
    });

    return refs;
  }

  function debugSummary(status) {
    const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
    const bool = (value) => (value ? 'yes' : 'no');
    const mic = status.mic || {};
    const audio = status.audio || {};
    return [
      `state: ${status.state} (${status.uiState})`,
      `ready: ${bool(status.ready)}  vision: ${bool(visionReady)}  adapter: ${bool(adapterReady)}`,
      `fps: ${Math.round(Number(status.fps) || 0)}  cost: ${Math.round(Number(status.processCost) || 0)}ms`,
      `hand: ${bool(status.handReady)} present ${bool(status.handPresent)} conf ${pct(status.handConfidence)}`,
      `mask: ${pct(status.maskCoverage)}  seg: ${bool(status.segmentationReady)}`,
      `plate: ${bool(status.hasPlate)} ${status.plateSource || ''}${status.platePlaceholder ? ' placeholder' : ''}`,
      `mic: muted ${bool(mic.muted)} we ${bool(mic.weMuted)} touch ${bool(mic.userTouchedMic)} override ${bool(mic.overrideDetected)}`,
      `audio: ${audio.running ? 'running' : 'idle'} ${audio.mode || ''} sens ${status.sensitivity}${audio.error ? ` · ${audio.error}` : ''}`
    ].join('\n');
  }

  function updateStatusChip(uiState, label) {
    if (!ui) return;
    ui.dot.className = `dot ${uiState || 'ready'}`;
    ui.state.innerHTML = `<strong>${escapeHtml(label || uiState || 'Ready')}</strong>`;
  }

  function renderUi(errorMessage) {
    if (!ui) return;
    const status = buildStatus();
    let uiState = 'ready';
    let label = 'Ready';
    let warn = null;

    if (!settings) {
      label = 'Loading…';
    } else if (!settings.enabled) {
      uiState = 'disabled';
      label = 'Disabled';
    } else if (!adapterReady && !visionReady) {
      label = 'Connecting to meeting…';
    } else if (!visionReady) {
      label = visionError ? 'Vision service error' : 'Starting local vision…';
      if (visionError) {
        uiState = 'error';
        warn = visionError;
      }
    } else {
      uiState = status.uiState || 'ready';
      const stateLabels = {
        ready: 'Ready · snap to vanish',
        vanishing: 'Vanishing…',
        vanished: 'Vanished · snap to return',
        reappearing: 'Reappearing…',
        disabled: 'Disabled',
        error: 'Error'
      };
      label = status.loading ? 'Loading models…' : stateLabels[uiState] || 'Ready';
      if (status.error) {
        uiState = 'error';
        label = 'Effect error';
        warn = status.error;
      } else if (status.uiState === 'vanished' && !status.hasPlate) {
        warn = 'No clean room plate. Capture one so the empty room is real, not a placeholder.';
      } else if (!status.hasPlate && status.ready) {
        warn = 'Room plate not captured. Step out of frame and press “Room plate”.';
      }
      if (status.audio && status.audio.running === false && status.audio.error) {
        warn = status.audio.error;
      }
      if (!status.handReady && status.ready) {
        warn = 'Automatic hand tracking is unavailable; use Snap or the shortcut.';
      }
      if (adapterTimedOut) {
        warn = 'Meeting camera patch is unavailable. Refresh this tab after installing the extension.';
      }
    }

    if (errorMessage) {
      uiState = 'error';
      label = 'Error';
      warn = errorMessage;
    }

    ui.dot.className = `dot ${uiState}`;
    ui.state.innerHTML = `<strong>${escapeHtml(label)}</strong>`;
    const showDebug = Boolean(settings && settings.showDebugOverlay);
    ui.debug.style.display = showDebug ? 'block' : 'none';
    if (showDebug) ui.debug.textContent = debugSummary(status);
    if (warn) {
      ui.warn.textContent = warn;
      ui.warn.style.display = 'block';
    } else {
      ui.warn.style.display = 'none';
    }
    ui.snap.textContent = status.uiState === 'vanished' ? 'Return' : 'Snap';
  }

  function showToast(message, kind = 'info', duration = 4500) {
    if (!ui) return;
    ui.toast.className = `toast visible ${kind}`;
    ui.toast.textContent = message;
    if (ui.toastTimer) clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      ui.toast.className = 'toast';
    }, duration);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function findMicButton() {
    const candidates = [...document.querySelectorAll('button,[role="button"]')].filter(isVisible);
    if (SITE.id === 'teams') {
      const teamsButton = document.querySelector('[data-tid="toggle-mute"]');
      if (teamsButton && isVisible(teamsButton)) return teamsButton;
    }
    const patterns = [
      /turn (on|off) microphone/i,
      /(un)?mute (microphone|mic)/i,
      /^(un)?mute$/i,
      /microphone (on|off)/i
    ];
    for (const button of candidates) {
      const label = [
        button.getAttribute('aria-label'),
        button.getAttribute('title'),
        button.getAttribute('data-tooltip'),
        button.getAttribute('data-tooltip-content'),
        button.textContent
      ]
        .filter(Boolean)
        .join(' ');
      if (patterns.some((pattern) => pattern.test(label))) {
        if (/more|settings|devices|audio settings/i.test(label)) continue;
        return button;
      }
    }
    return null;
  }

  function micButtonState(button) {
    if (!button) return { found: false, muted: null, label: '' };
    const label = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-tooltip'),
      button.getAttribute('data-tooltip-content'),
      button.textContent
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    const pressed = button.getAttribute('aria-pressed');
    let muted = null;
    if (/unmute/i.test(label) || /turn on microphone/i.test(label)) muted = true;
    else if (/mute/i.test(label) || /turn off microphone/i.test(label)) muted = false;
    if (muted === null && pressed !== null) muted = pressed === 'true';
    return { found: true, muted, label };
  }

  function syncSiteMute(phase, status) {
    try {
      const button = findMicButton();
      const state = micButtonState(button);
      if (!button || state.muted === null) return;

      if (phase === 'vanish') {
        if (status && status.mic && status.mic.lastAction !== 'muted-for-vanish') return;
        if (state.muted === false) {
          suppressMicInteraction = true;
          button.click();
          suppressMicInteraction = false;
          console.info('[Snap Vanish] Clicked meeting mute control.');
        }
      } else if (phase === 'reappear') {
        if (!status || !status.mic || status.mic.lastAction !== 'restored-user-mic') return;
        if (state.muted === true) {
          suppressMicInteraction = true;
          button.click();
          suppressMicInteraction = false;
          console.info('[Snap Vanish] Clicked meeting unmute control.');
        }
      }
    } catch (error) {
      console.warn('[Snap Vanish] Could not sync meeting microphone UI:', error);
    }
  }

  function installMicInteractionTracking() {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('button,[role="button"]');
        if (!button) return;
        const state = micButtonState(button);
        if (!suppressMicInteraction && state.found && state.muted !== null) {
          postToVision({ type: 'MIC_STATE', muted: !state.muted, userInteraction: true });
        }
      },
      true
    );
  }
}
