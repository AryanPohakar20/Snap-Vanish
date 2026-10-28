export const ABSOLUTE_CINEMA_CYCLE_MS = 5000;
export const ABSOLUTE_CINEMA_MEME_PATH = 'assets/images/CINEMA.jpeg';

export function createAbsoluteCinemaController({
  duration = ABSOLUTE_CINEMA_CYCLE_MS,
  onStart = null,
  onStop = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  let timer = 0;
  let token = 0;
  let active = false;

  function clearTimer() {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = 0;
  }

  function cancel() {
    const wasActive = active;
    token += 1;
    clearTimer();
    active = false;
    return wasActive;
  }

  function start() {
    const wasActive = active;
    const id = ++token;
    clearTimer();
    active = true;
    timer = setTimeoutFn(() => {
      timer = 0;
      if (id !== token) return;
      active = false;
      if (onStop) onStop({ reason: 'expired' });
    }, Math.max(0, duration));
    if (onStart) onStart({ restarted: wasActive });
    return { ok: true, restarted: wasActive, duration };
  }

  function stop(reason = 'manual') {
    const wasActive = active;
    token += 1;
    clearTimer();
    active = false;
    if (wasActive && onStop) onStop({ reason });
    return { ok: true, wasActive };
  }

  function dispose() {
    token += 1;
    clearTimer();
    active = false;
  }

  return {
    start,
    stop,
    cancel,
    dispose,
    isActive: () => active,
    cycleMs: duration
  };
}
