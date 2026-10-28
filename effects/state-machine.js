export const STATES = Object.freeze({
  DISABLED: 'DISABLED',
  VISIBLE: 'VISIBLE',
  DISINTEGRATING: 'DISINTEGRATING',
  VANISHED: 'VANISHED',
  REASSEMBLING: 'REASSEMBLING',
  ERROR: 'ERROR'
});

export const UI_STATES = Object.freeze({
  [STATES.DISABLED]: 'disabled',
  [STATES.VISIBLE]: 'ready',
  [STATES.DISINTEGRATING]: 'vanishing',
  [STATES.VANISHED]: 'vanished',
  [STATES.REASSEMBLING]: 'reappearing',
  [STATES.ERROR]: 'error'
});

const VALID_TRANSITIONS = Object.freeze({
  [STATES.DISABLED]: [STATES.VISIBLE],
  [STATES.VISIBLE]: [STATES.DISINTEGRATING, STATES.DISABLED, STATES.ERROR],
  [STATES.DISINTEGRATING]: [STATES.VANISHED, STATES.DISABLED, STATES.ERROR],
  [STATES.VANISHED]: [STATES.REASSEMBLING, STATES.DISABLED, STATES.ERROR],
  [STATES.REASSEMBLING]: [STATES.VISIBLE, STATES.DISABLED, STATES.ERROR],
  [STATES.ERROR]: [STATES.VISIBLE, STATES.DISABLED]
});

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class StateMachine {
  constructor(options = {}) {
    this.duration = Math.max(100, Number(options.duration) || 1400);
    this.cooldown = Math.max(0, Number(options.cooldown) || 900);
    this.enabled = options.enabled !== false;
    this.state = this.enabled ? STATES.VISIBLE : STATES.DISABLED;
    this.startedAt = 0;
    this.cooldownUntil = 0;
    this.listeners = new Set();
    this.lastTransition = { state: this.state, at: 0, reason: 'init' };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason) {
    const detail = {
      state: this.state,
      uiState: UI_STATES[this.state] || 'error',
      reason,
      at: this.startedAt,
      enabled: this.enabled
    };
    this.lastTransition = detail;
    for (const listener of this.listeners) {
      try {
        listener(detail);
      } catch {
        // Listener failures must not break the animation clock.
      }
    }
    return detail;
  }

  canTransition(target) {
    const allowed = VALID_TRANSITIONS[this.state] || [];
    return allowed.includes(target);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled && this.state !== STATES.DISABLED) {
      this.state = STATES.DISABLED;
      this.emit('disabled');
      return { accepted: true, state: this.state };
    }
    if (this.enabled && this.state === STATES.DISABLED) {
      this.state = STATES.VISIBLE;
      this.emit('enabled');
      return { accepted: true, state: this.state };
    }
    return { accepted: false, state: this.state };
  }

  setDuration(duration) {
    this.duration = Math.max(100, Number(duration) || this.duration);
  }

  setCooldown(cooldown) {
    this.cooldown = Math.max(0, Number(cooldown) || 0);
  }

  requestVanish(now = Date.now()) {
    if (this.state !== STATES.VISIBLE) {
      return { accepted: false, reason: `state-${this.state.toLowerCase()}`, state: this.state };
    }
    if (now < this.cooldownUntil) {
      return { accepted: false, reason: 'cooldown', state: this.state };
    }
    if (!this.canTransition(STATES.DISINTEGRATING)) {
      return { accepted: false, reason: 'invalid-transition', state: this.state };
    }
    this.state = STATES.DISINTEGRATING;
    this.startedAt = now;
    this.emit('vanish-requested');
    return { accepted: true, state: this.state, progress: 0 };
  }

  requestReappear(now = Date.now()) {
    if (this.state !== STATES.VANISHED) {
      return { accepted: false, reason: `state-${this.state.toLowerCase()}`, state: this.state };
    }
    if (!this.canTransition(STATES.REASSEMBLING)) {
      return { accepted: false, reason: 'invalid-transition', state: this.state };
    }
    this.state = STATES.REASSEMBLING;
    this.startedAt = now;
    this.emit('reappear-requested');
    return { accepted: true, state: this.state, progress: 0 };
  }

  update(now = Date.now()) {
    if (this.state === STATES.DISINTEGRATING && now - this.startedAt >= this.duration) {
      this.state = STATES.VANISHED;
      this.emit('vanished');
      return { changed: true, state: this.state };
    }
    if (this.state === STATES.REASSEMBLING && now - this.startedAt >= this.duration) {
      this.state = STATES.VISIBLE;
      this.cooldownUntil = now + this.cooldown;
      this.emit('visible');
      return { changed: true, state: this.state };
    }
    return { changed: false, state: this.state };
  }

  progress(now = Date.now()) {
    if (this.state !== STATES.DISINTEGRATING && this.state !== STATES.REASSEMBLING) {
      return this.state === STATES.VANISHED ? 1 : 0;
    }
    const raw = Math.min(1, Math.max(0, (now - this.startedAt) / this.duration));
    return easeInOutCubic(raw);
  }

  dissolveAmount(now = Date.now()) {
    if (this.state === STATES.VISIBLE || this.state === STATES.DISABLED) return 0;
    if (this.state === STATES.VANISHED) return 1;
    if (this.state === STATES.ERROR) return 0;
    const progress = this.progress(now);
    return this.state === STATES.DISINTEGRATING ? progress : 1 - progress;
  }

  isTransitioning() {
    return this.state === STATES.DISINTEGRATING || this.state === STATES.REASSEMBLING;
  }

  isInvisible() {
    return this.state === STATES.VANISHED || this.state === STATES.REASSEMBLING;
  }

  isActive() {
    return this.enabled && this.state !== STATES.DISABLED && this.state !== STATES.ERROR;
  }

  setError(message = 'unknown') {
    if (this.state === STATES.DISABLED) return null;
    this.state = STATES.ERROR;
    const detail = this.emit(`error:${message}`);
    return detail;
  }

  forceVisible(reason = 'reset') {
    if (this.state === STATES.DISABLED) return null;
    this.state = STATES.VISIBLE;
    this.cooldownUntil = 0;
    return this.emit(reason);
  }
}
