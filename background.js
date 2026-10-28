import { MSG, detectSiteFromUrl } from './lib/messages.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, sanitizeSettings } from './lib/settings.js';
import { PLATE_KEY, PLATE_META_KEY } from './lib/storage-keys.js';

const OFFSCREEN_URL = 'offscreen.html';
const PREVIEW_URL = 'preview/preview.html';
const AUDIO_START_TIMEOUT = 12000;

let offscreenCreating = null;
let audioStatus = {
  running: false,
  mode: 'idle',
  error: null,
  state: 'closed',
  transients: 0,
  updatedAt: 0
};
let pendingPreviewTrigger = false;
let tabStates = {};

async function restoreSession() {
  try {
    const stored = await chrome.storage.session.get(['tabStates', 'audioStatus', 'pendingPreviewTrigger']);
    if (stored.tabStates && typeof stored.tabStates === 'object') tabStates = stored.tabStates;
    if (stored.audioStatus) audioStatus = stored.audioStatus;
    if (stored.pendingPreviewTrigger) pendingPreviewTrigger = true;
  } catch {
    // storage.session may be unavailable very early during startup.
  }
}

async function persistSession() {
  try {
    await chrome.storage.session.set({
      tabStates,
      audioStatus,
      pendingPreviewTrigger
    });
  } catch {
    // Best-effort.
  }
}

function rememberTabState(tabId, state) {
  tabStates[String(tabId)] = {
    ...state,
    tabId,
    updatedAt: Date.now()
  };
  persistSession();
}

async function getStoredSettings() {
  return loadSettings();
}

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return true;
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification:
        'Analyze microphone transients locally for snap confirmation and play an optional local snap sound.'
    })
    .then(() => true)
    .catch(async (error) => {
      if (String(error.message || '').includes('single offscreen')) return true;
      console.warn('[Snap Vanish] Could not create offscreen document:', error);
      updateAudioStatus({ running: false, error: error.message });
      return false;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  return offscreenCreating;
}

async function sendToOffscreen(message) {
  const ready = await ensureOffscreen();
  if (!ready) throw new Error('Offscreen document is unavailable');
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

function updateAudioStatus(patch) {
  audioStatus = {
    ...audioStatus,
    ...patch,
    updatedAt: Date.now()
  };
  persistSession();
}

async function startAudio(settingsOverride) {
  const settings = settingsOverride || (await getStoredSettings());
  if (!settings.enabled) return { running: false, reason: 'disabled' };
  try {
    const response = await Promise.race([
      sendToOffscreen({ type: MSG.AUDIO_START, sensitivity: settings.sensitivity }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Audio analyzer start timed out')), AUDIO_START_TIMEOUT)
      )
    ]);
    if (response && response.status) {
      updateAudioStatus({ ...response.status, error: response.error || null });
    } else if (response && response.error) {
      updateAudioStatus({ running: false, error: response.error });
    }
    return response;
  } catch (error) {
    updateAudioStatus({ running: false, error: error.message });
    return { running: false, error: error.message };
  }
}

async function stopAudio() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: MSG.AUDIO_STOP });
    }
  } catch {
    // Best-effort.
  }
  updateAudioStatus({ running: false, mode: 'idle', error: null });
}

async function playSnapSound() {
  try {
    await sendToOffscreen({ type: MSG.PLAY_SOUND, sound: 'snap' });
  } catch {
    // Sound is optional.
  }
}

function isPreviewUrl(url) {
  return Boolean(url && url.startsWith(chrome.runtime.getURL(PREVIEW_URL)));
}

async function messageTab(tab, message) {
  if (!tab || tab.id === undefined || tab.id === null) {
    throw new Error('The target tab is unavailable');
  }
  if (isPreviewUrl(tab.url)) {
    return chrome.runtime.sendMessage({ target: 'preview', tabId: tab.id, ...message });
  }
  return chrome.tabs.sendMessage(tab.id, { target: 'content', ...message });
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  const sends = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    if (isPreviewUrl(tab.url) || detectSiteFromUrl(tab.url)) {
      sends.push(messageTab(tab, message).catch(() => {}));
    }
  }
  await Promise.allSettled(sends);
}

async function findPreviewTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => isPreviewUrl(tab.url)) || null;
}

async function findActiveTarget() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) return { tab: null, kind: 'none' };
  if (active.url && active.url.startsWith(chrome.runtime.getURL(PREVIEW_URL))) {
    return { tab: active, kind: 'preview' };
  }
  if (detectSiteFromUrl(active.url)) {
    return { tab: active, kind: 'meeting', site: detectSiteFromUrl(active.url) };
  }
  return { tab: active, kind: 'other' };
}

async function openPreview() {
  const existing = await findPreviewTab();
  if (existing && existing.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url: chrome.runtime.getURL(PREVIEW_URL) });
}

async function triggerSnap(source = 'manual') {
  const target = await findActiveTarget();
  if (target.kind === 'meeting' || target.kind === 'preview') {
    try {
      const response = await messageTab(target.tab, {
        type: MSG.TRIGGER_SNAP,
        source
      });
      return response || { ok: true, state: 'sent' };
    } catch (error) {
      const preview = await openPreview();
      pendingPreviewTrigger = true;
      await persistSession();
      return { ok: false, reason: 'opened-preview', previewTabId: preview.id, message: error.message };
    }
  }

  const preview = await findPreviewTab();
  if (preview && preview.id) {
    try {
      const response = await messageTab(preview, {
        type: MSG.TRIGGER_SNAP,
        source
      });
      return response || { ok: true, state: 'sent' };
    } catch {
      pendingPreviewTrigger = true;
      await persistSession();
      return { ok: false, reason: 'preview-loading' };
    }
  }

  const created = await openPreview();
  pendingPreviewTrigger = true;
  await persistSession();
  return { ok: false, reason: 'opened-preview', previewTabId: created.id };
}

async function captureBackground() {
  const target = await findActiveTarget();
  if (target.kind === 'meeting' || target.kind === 'preview') {
    try {
      return await messageTab(target.tab, { type: MSG.CAPTURE_BACKGROUND });
    } catch (error) {
      return { ok: false, reason: 'no-content', message: error.message };
    }
  }
  return { ok: false, reason: 'no-meeting-tab' };
}

async function resetBackground() {
  const target = await findActiveTarget();
  if (target.kind === 'meeting' || target.kind === 'preview') {
    try {
      return await messageTab(target.tab, { type: MSG.RESET_BACKGROUND });
    } catch (error) {
      return { ok: false, reason: 'no-content', message: error.message };
    }
  }
  return { ok: false, reason: 'no-meeting-tab' };
}

async function getActiveTabState() {
  const target = await findActiveTarget();
  if (!target.tab) return { kind: 'none', site: null };
  const site = detectSiteFromUrl(target.tab.url);
  let contentState = null;
  if (target.kind === 'meeting' || target.kind === 'preview') {
    try {
      contentState = await messageTab(target.tab, { type: MSG.GET_TAB_STATUS });
    } catch {
      contentState = null;
    }
  }
  const cached = tabStates[String(target.tab.id)] || null;
  return {
    kind: target.kind,
    tabId: target.tab.id,
    url: target.tab.url,
    site,
    content: contentState && contentState.status ? contentState.status : cached
  };
}

async function getFullStatus() {
  const active = await getActiveTabState();
  const settings = await getStoredSettings();
  return {
    settings,
    active,
    audio: audioStatus,
    supportedSites: ['Google Meet', 'Microsoft Teams Web', 'Zoom Web'],
    previewUrl: chrome.runtime.getURL(PREVIEW_URL),
    version: chrome.runtime.getManifest().version
  };
}

async function queryExtensionPermissions() {
  const permissions = { camera: 'unknown', microphone: 'unknown' };
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const camera = await navigator.permissions.query({ name: 'camera' });
      permissions.camera = camera.state;
      const microphone = await navigator.permissions.query({ name: 'microphone' });
      permissions.microphone = microphone.state;
    }
  } catch {
    // Service worker permission queries are not available in every Chrome build.
  }
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) {
      const result = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: MSG.QUERY_PERMISSIONS
      });
      if (result && result.permissions) {
        permissions.camera = result.permissions.camera || permissions.camera;
        permissions.microphone = result.permissions.microphone || permissions.microphone;
      }
    }
  } catch {
    // Ignore.
  }
  return permissions;
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored || !stored.settings) {
    await saveSettings(DEFAULT_SETTINGS);
  }
  await restoreSession();
});

chrome.runtime.onStartup.addListener(() => {
  restoreSession();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.target === 'offscreen' || message.target === 'preview' || message.target === 'content') return false;
  if (message.target && message.target !== 'background') return false;
  const type = message.type;
  const tabId = sender.tab && sender.tab.id;

  if (type === MSG.CONTENT_READY || type === MSG.CONTENT_STATE) {
    if (tabId) {
      rememberTabState(tabId, {
        site: message.site || (sender.tab && detectSiteFromUrl(sender.tab.url)),
        state: message.state,
        status: message.status,
        error: message.error || null
      });
    }
    if (type === MSG.CONTENT_READY) {
      startAudio();
    }
    sendResponse({ ok: true, settings: null });
    return false;
  }

  if (type === MSG.AUDIO_NEEDED) {
    startAudio().then((result) => sendResponse(result));
    return true;
  }

  if (type === MSG.AUDIO_TRANSIENT) {
    updateAudioStatus({
      running: true,
      lastTransientAt: message.transient && message.transient.time,
      transients: (audioStatus.transients || 0) + 1
    });
    broadcast({
      type: MSG.AUDIO_TRANSIENT,
      transient: message.transient
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (type === MSG.AUDIO_STATUS) {
    updateAudioStatus(message.status || {});
    broadcast({ type: MSG.AUDIO_STATUS, status: audioStatus }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (type === MSG.GET_STATUS) {
    getFullStatus()
      .then(async (status) => {
        status.permissions = await queryExtensionPermissions();
        sendResponse({ ok: true, ...status });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === MSG.SET_SETTINGS) {
    saveSettings(message.settings)
      .then(async (settings) => {
        broadcast({ type: MSG.SETTINGS_CHANGED, settings }).catch(() => {});
        if (settings.enabled) {
          const target = await findActiveTarget();
          if (target.kind === 'meeting' || target.kind === 'preview') startAudio(settings);
        } else {
          await stopAudio();
        }
        sendResponse({ ok: true, settings });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === MSG.TRIGGER_SNAP) {
    triggerSnap(message.source || 'popup').then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (type === MSG.CAPTURE_BACKGROUND) {
    captureBackground().then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (type === MSG.RESET_BACKGROUND) {
    resetBackground().then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (type === MSG.CLEAR_SAVED_BACKGROUND) {
    chrome.storage.local
      .remove([PLATE_KEY, PLATE_META_KEY])
      .then(() => {
        broadcast({ type: MSG.SETTINGS_CHANGED }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === MSG.OPEN_PREVIEW) {
    openPreview().then((tab) => sendResponse({ ok: true, tabId: tab.id })).catch((error) =>
      sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (type === MSG.PREVIEW_READY) {
    getStoredSettings().then((settings) => {
      const ready = message.ready === true;
      const shouldTrigger = pendingPreviewTrigger;
      if (ready) {
        pendingPreviewTrigger = false;
        persistSession();
        startAudio(settings);
      }
      sendResponse({ ok: true, settings, pendingTrigger: shouldTrigger, ready });
    });
    return true;
  }

  if (type === MSG.PLAY_SOUND) {
    playSnapSound().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-snap-vanish') {
    await triggerSnap('keyboard');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[String(tabId)];
  persistSession();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !detectSiteFromUrl(changeInfo.url)) {
    delete tabStates[String(tabId)];
    persistSession();
  }
  if (changeInfo.status === 'complete' && tab.url) {
    const site = detectSiteFromUrl(tab.url);
    if (site) {
      chrome.tabs
        .sendMessage(tabId, { type: MSG.SETTINGS_CHANGED, target: 'content' })
        .catch(() => {});
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const settings = sanitizeSettings(changes.settings.newValue || {});
    if (!settings.enabled) stopAudio();
  }
});

restoreSession();
