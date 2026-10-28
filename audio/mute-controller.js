export class MuteController {
  constructor(options = {}) {
    this.getMuted = typeof options.getMuted === 'function' ? options.getMuted : () => false;
    this.setMuted = typeof options.setMuted === 'function' ? options.setMuted : () => false;
    this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};

    this.originalMuted = false;
    this.weMuted = false;
    this.userTouchedMic = false;
    this.overrideDetected = false;
    this.lastMuted = null;
    this.expectedMuted = null;
    this.lastAction = 'idle';
  }

  observe(muted) {
    const value = Boolean(muted);
    if (this.lastMuted === null) {
      this.lastMuted = value;
      return { changed: false, override: false };
    }
    if (value === this.lastMuted) {
      return { changed: false, override: false };
    }

    const expected = this.expectedMuted;
    this.lastMuted = value;
    this.expectedMuted = null;

    if (expected !== null && value === expected) {
      return { changed: true, override: false };
    }

    if (this.weMuted) {
      this.overrideDetected = true;
      this.lastAction = 'manual-change-detected';
      this.onLog({
        message: 'Microphone state changed outside Snap Vanish; respecting user action.',
        level: 'info'
      });
      return { changed: true, override: true };
    }
    return { changed: true, override: false };
  }

  markUserMicInteraction() {
    if (this.weMuted) {
      this.userTouchedMic = true;
      this.onLog({
        message: 'User interacted with microphone controls while vanished; automatic restore disabled.',
        level: 'info'
      });
    }
  }

  beginVanish() {
    this.originalMuted = Boolean(this.getMuted());
    this.weMuted = false;
    this.userTouchedMic = false;
    this.overrideDetected = false;
    this.expectedMuted = null;
    this.lastMuted = this.originalMuted;

    if (!this.originalMuted) {
      this.applyMute(true);
      this.weMuted = true;
      this.lastAction = 'muted-for-vanish';
    } else {
      this.lastAction = 'already-muted';
    }
    return {
      originalMuted: this.originalMuted,
      weMuted: this.weMuted,
      action: this.lastAction
    };
  }

  applyMute(muted) {
    this.expectedMuted = Boolean(muted);
    try {
      this.setMuted(Boolean(muted));
      this.lastMuted = Boolean(muted);
      this.lastAction = muted ? 'muted' : 'unmuted';
      return true;
    } catch (error) {
      this.expectedMuted = null;
      this.onLog({ message: `Microphone update failed: ${error.message}`, level: 'error' });
      return false;
    }
  }

  beginReappear() {
    const shouldRestore = Boolean(
      this.weMuted && !this.originalMuted && !this.userTouchedMic && !this.overrideDetected
    );

    let restored = false;
    if (shouldRestore) {
      restored = this.applyMute(false);
      this.lastAction = restored ? 'restored-user-mic' : 'restore-failed';
    } else if (this.weMuted) {
      this.lastAction = 'kept-muted-manual-or-override';
    } else {
      this.lastAction = this.originalMuted ? 'stayed-user-muted' : 'no-change';
    }

    const result = {
      restored,
      shouldRestore,
      originalMuted: this.originalMuted,
      userTouchedMic: this.userTouchedMic,
      overrideDetected: this.overrideDetected,
      action: this.lastAction
    };

    this.weMuted = false;
    this.userTouchedMic = false;
    this.overrideDetected = false;
    this.expectedMuted = null;
    return result;
  }

  isMuted() {
    try {
      return Boolean(this.getMuted());
    } catch {
      return false;
    }
  }

  reset() {
    this.originalMuted = false;
    this.weMuted = false;
    this.userTouchedMic = false;
    this.overrideDetected = false;
    this.lastMuted = null;
    this.expectedMuted = null;
    this.lastAction = 'reset';
  }
}
