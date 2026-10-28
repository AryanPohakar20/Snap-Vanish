import { AudioAnalyzer } from './audio/audio-analyzer.js';
import { MSG } from './lib/messages.js';

let analyzer = null;
let stream = null;
let starting = null;
let lastError = null;

function permissionState(error) {
  if (!error) return 'unknown';
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'denied';
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'unavailable';
  return 'error';
}

function describeMicError(error) {
  if (!error) return 'Microphone unavailable';
  switch (error.name) {
    case 'NotAllowedError':
      return 'Microphone permission was denied. Open the Snap Vanish setup preview and allow microphone access.';
    case 'NotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
      return 'The microphone is busy in another application.';
    case 'OverconstrainedError':
      return 'The requested microphone settings are unavailable.';
    default:
      return `Microphone error: ${error.message}`;
  }
}

async function startAudio(sensitivity = 55) {
  if (starting) return starting;
  if (analyzer && analyzer.running) {
    analyzer.setSensitivity(sensitivity);
    return { status: analyzer.getStatus() };
  }

  starting = (async () => {
    try {
      lastError = null;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });
      if (analyzer) await analyzer.stop();
      analyzer = new AudioAnalyzer({
        sensitivity,
        onTransient: (transient) => {
          chrome.runtime.sendMessage({
            type: MSG.AUDIO_TRANSIENT,
            transient
          }).catch(() => {});
        },
        onStatus: (status) => {
          chrome.runtime.sendMessage({
            type: MSG.AUDIO_STATUS,
            status: { ...status, error: lastError }
          }).catch(() => {});
        },
        onError: (error) => {
          lastError = error.message;
          chrome.runtime.sendMessage({
            type: MSG.AUDIO_STATUS,
            status: { running: false, error: lastError }
          }).catch(() => {});
        }
      });
      const status = await analyzer.start(stream);
      return { status: { ...status, error: null } };
    } catch (error) {
      lastError = describeMicError(error);
      const status = {
        running: false,
        mode: 'idle',
        error: lastError,
        permission: permissionState(error)
      };
      chrome.runtime.sendMessage({
        type: MSG.AUDIO_STATUS,
        status
      }).catch(() => {});
      return { status, error: lastError };
    } finally {
      starting = null;
    }
  })();

  return starting;
}

async function stopAudio() {
  try {
    if (analyzer) await analyzer.stop();
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
  } finally {
    analyzer = null;
    stream = null;
    chrome.runtime.sendMessage({
      type: MSG.AUDIO_STATUS,
      status: { running: false, mode: 'idle', error: null }
    }).catch(() => {});
    return { status: { running: false, mode: 'idle', error: null } };
  }
}

async function playSound(name) {
  try {
    const audio = new Audio(chrome.runtime.getURL(`assets/sounds/${name || 'snap'}.wav`));
    audio.volume = 0.32;
    await audio.play();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function queryPermissions() {
  const permissions = { camera: 'unknown', microphone: 'unknown' };
  for (const name of ['camera', 'microphone']) {
    try {
      const result = await navigator.permissions.query({ name });
      permissions[name] = result.state;
    } catch {
      permissions[name] = 'unknown';
    }
  }
  return permissions;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  if (message.type === MSG.AUDIO_START) {
    startAudio(message.sensitivity).then(sendResponse);
    return true;
  }

  if (message.type === MSG.AUDIO_STOP) {
    stopAudio().then(sendResponse);
    return true;
  }

  if (message.type === MSG.AUDIO_QUERY) {
    sendResponse({ status: analyzer ? analyzer.getStatus() : { running: false }, error: lastError });
    return false;
  }

  if (message.type === MSG.PLAY_SOUND) {
    playSound(message.sound).then(sendResponse);
    return true;
  }

  if (message.type === MSG.QUERY_PERMISSIONS) {
    queryPermissions().then((permissions) => sendResponse({ permissions }));
    return true;
  }

  return false;
});

window.addEventListener('beforeunload', () => {
  if (analyzer) analyzer.stop();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
});
