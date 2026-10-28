export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  sensitivity: 55,
  dustDuration: 1400,
  dustDirection: 'right',
  audioConfirmation: true,
  autoCaptureBackground: true,
  persistBackground: true,
  showDebugOverlay: false,
  playSnapSound: true
});

export const DUST_DIRECTIONS = Object.freeze(['left', 'right', 'up', 'random']);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const direction = DUST_DIRECTIONS.includes(source.dustDirection)
    ? source.dustDirection
    : DEFAULT_SETTINGS.dustDirection;

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.enabled,
    sensitivity: Math.round(clampNumber(source.sensitivity, 0, 100, DEFAULT_SETTINGS.sensitivity)),
    dustDuration: Math.round(
      clampNumber(source.dustDuration, 600, 4000, DEFAULT_SETTINGS.dustDuration)
    ),
    dustDirection: direction,
    audioConfirmation:
      typeof source.audioConfirmation === 'boolean'
        ? source.audioConfirmation
        : DEFAULT_SETTINGS.audioConfirmation,
    autoCaptureBackground:
      typeof source.autoCaptureBackground === 'boolean'
        ? source.autoCaptureBackground
        : DEFAULT_SETTINGS.autoCaptureBackground,
    persistBackground:
      typeof source.persistBackground === 'boolean'
        ? source.persistBackground
        : DEFAULT_SETTINGS.persistBackground,
    showDebugOverlay:
      typeof source.showDebugOverlay === 'boolean'
        ? source.showDebugOverlay
        : DEFAULT_SETTINGS.showDebugOverlay,
    playSnapSound:
      typeof source.playSnapSound === 'boolean'
        ? source.playSnapSound
        : DEFAULT_SETTINGS.playSnapSound
  };
}

export async function loadSettings(storage = chrome.storage.local) {
  const data = await storage.get('settings');
  return sanitizeSettings(data && data.settings ? data.settings : {});
}

export async function saveSettings(settings, storage = chrome.storage.local) {
  const sanitized = sanitizeSettings(settings);
  await storage.set({ settings: sanitized });
  return sanitized;
}

export function settingsEqual(a, b) {
  const x = sanitizeSettings(a);
  const y = sanitizeSettings(b);
  return JSON.stringify(x) === JSON.stringify(y);
}
