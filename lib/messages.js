export const MSG = Object.freeze({
  GET_STATUS: 'GET_STATUS',
  STATUS: 'STATUS',
  GET_TAB_STATUS: 'GET_TAB_STATUS',
  SET_SETTINGS: 'SET_SETTINGS',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  TRIGGER_SNAP: 'TRIGGER_SNAP',
  CAPTURE_BACKGROUND: 'CAPTURE_BACKGROUND',
  RESET_BACKGROUND: 'RESET_BACKGROUND',
  CONTENT_READY: 'CONTENT_READY',
  CONTENT_STATE: 'CONTENT_STATE',
  CONTENT_ERROR: 'CONTENT_ERROR',
  AUDIO_START: 'AUDIO_START',
  AUDIO_STOP: 'AUDIO_STOP',
  AUDIO_STATUS: 'AUDIO_STATUS',
  AUDIO_QUERY: 'AUDIO_QUERY',
  AUDIO_TRANSIENT: 'AUDIO_TRANSIENT',
  AUDIO_NEEDED: 'AUDIO_NEEDED',
  PLAY_SOUND: 'PLAY_SOUND',
  QUERY_PERMISSIONS: 'QUERY_PERMISSIONS',
  PERMISSIONS: 'PERMISSIONS',
  OPEN_PREVIEW: 'OPEN_PREVIEW',
  PENDING_TRIGGER: 'PENDING_TRIGGER',
  PREVIEW_READY: 'PREVIEW_READY',
  CLEAR_SAVED_BACKGROUND: 'CLEAR_SAVED_BACKGROUND',
  ABSOLUTE_CINEMA_SHOW: 'ABSOLUTE_CINEMA_SHOW'
});

export const SUPPORTED_SITES = Object.freeze({
  'meet.google.com': { id: 'meet', name: 'Google Meet' },
  'teams.microsoft.com': { id: 'teams', name: 'Microsoft Teams' },
  'teams.live.com': { id: 'teams', name: 'Microsoft Teams' },
  'zoom.us': { id: 'zoom', name: 'Zoom Web' }
});

export function detectSiteFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (SUPPORTED_SITES[host]) {
      const site = SUPPORTED_SITES[host];
      if (site.id === 'zoom' && !/\/wc\/|\/j\/|\/s\/|\/my\//.test(new URL(url).pathname)) {
        return { ...site, webClientLikely: false };
      }
      return { ...site, webClientLikely: true };
    }
    if (host.endsWith('.zoom.us')) return { ...SUPPORTED_SITES['zoom.us'], webClientLikely: true };
    return null;
  } catch {
    return null;
  }
}

export function isSupportedUrl(url) {
  return Boolean(detectSiteFromUrl(url));
}
