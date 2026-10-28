import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, sanitizeSettings, loadSettings, saveSettings } from '../lib/settings.js';
import { MSG, detectSiteFromUrl, isSupportedUrl } from '../lib/messages.js';
import { thresholdsForSensitivity, TransientGate } from '../audio/audio-analyzer.js';
import { MuteController } from '../audio/mute-controller.js';
import { StateMachine, STATES, UI_STATES } from '../effects/state-machine.js';
import { sensitivityToThresholds } from '../vision/snap-detector.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: data[key] };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((name) => [name, data[name]]));
      }
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(key) {
      for (const name of Array.isArray(key) ? key : [key]) delete data[name];
    }
  };
}

test('default settings are sanitized and complete', () => {
  const settings = sanitizeSettings({});
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(settings.enabled, true);
  assert.equal(settings.sensitivity, 55);
});

test('settings clamp numbers and reject invalid directions', () => {
  const low = sanitizeSettings({ sensitivity: -20, dustDuration: 10, dustDirection: 'sideways' });
  assert.equal(low.sensitivity, 0);
  assert.equal(low.dustDuration, 600);
  assert.equal(low.dustDirection, DEFAULT_SETTINGS.dustDirection);

  const high = sanitizeSettings({ sensitivity: 900, dustDuration: 99999, dustDirection: 'up' });
  assert.equal(high.sensitivity, 100);
  assert.equal(high.dustDuration, 4000);
  assert.equal(high.dustDirection, 'up');

  const rounded = sanitizeSettings({ sensitivity: 42.7, dustDuration: 1500.6 });
  assert.equal(rounded.sensitivity, 43);
  assert.equal(rounded.dustDuration, 1501);
});

test('settings load and save through a storage shim', async () => {
  const storage = memoryStorage();
  const saved = await saveSettings({ sensitivity: 73, dustDirection: 'left' }, storage);
  assert.equal(saved.sensitivity, 73);
  assert.equal(saved.dustDirection, 'left');

  const loaded = await loadSettings(storage);
  assert.equal(loaded.sensitivity, 73);
  assert.equal(loaded.dustDirection, 'left');
  assert.equal(loaded.audioConfirmation, DEFAULT_SETTINGS.audioConfirmation);
});

test('site detection recognizes supported meeting hosts only', () => {
  assert.equal(detectSiteFromUrl('https://meet.google.com/abc-defg-hij').id, 'meet');
  assert.equal(detectSiteFromUrl('https://teams.microsoft.com/l/meetup-join/x').id, 'teams');
  assert.equal(detectSiteFromUrl('https://teams.live.com/meet/123').id, 'teams');
  assert.equal(detectSiteFromUrl('https://us05web.zoom.us/j/123').id, 'zoom');
  assert.equal(detectSiteFromUrl('https://zoom.us/j/123').webClientLikely, true);
  assert.equal(detectSiteFromUrl('https://zoom.us/pricing').webClientLikely, false);
  assert.equal(detectSiteFromUrl('https://example.com/'), null);
  assert.equal(detectSiteFromUrl('not a url'), null);
  assert.equal(isSupportedUrl('https://meet.google.com/'), true);
  assert.equal(isSupportedUrl('https://example.com/'), false);
  assert.equal(MSG.PREVIEW_READY, 'PREVIEW_READY');
});

test('audio sensitivity lowers thresholds as it rises', () => {
  const low = thresholdsForSensitivity(0);
  const medium = thresholdsForSensitivity(55);
  const high = thresholdsForSensitivity(100);

  assert.ok(low.minPeak > medium.minPeak && medium.minPeak > high.minPeak);
  assert.ok(low.minRms > medium.minRms && medium.minRms > high.minRms);
  assert.ok(low.minHighRatio > medium.minHighRatio && medium.minHighRatio > high.minHighRatio);
  assert.ok(low.refractoryMs > medium.refractoryMs && medium.refractoryMs > high.refractoryMs);
  assert.equal(medium.refractoryMs, 90);
});

test('transient gate detects one onset per refractory window', () => {
  const gate = new TransientGate({ sensitivity: 55 });
  const first = gate.process({ peak: 0.5, rms: 0.1, highRatio: 0.5, timeMs: 1000 });
  assert.ok(first);
  assert.ok(first.strength > 0);
  assert.equal(gate.process({ peak: 0.5, rms: 0.1, highRatio: 0.5, timeMs: 1010 }), null);
  const later = gate.process({ peak: 0.5, rms: 0.1, highRatio: 0.5, timeMs: 1200 });
  assert.ok(later);
});

test('transient gate follows live sensitivity updates', () => {
  const gate = new TransientGate({ sensitivity: 0 });
  const quiet = { peak: 0.04, rms: 0.01, highRatio: 0.4, timeMs: 1000 };
  assert.equal(gate.process(quiet), null);

  gate.setSensitivity(100);
  assert.ok(gate.process({ ...quiet, timeMs: 2000 }));
});

test('mute controller mutes and restores only when it owns the change', () => {
  let muted = false;
  const controller = new MuteController({
    getMuted: () => muted,
    setMuted: (next) => {
      muted = Boolean(next);
      return true;
    }
  });

  const vanish = controller.beginVanish();
  assert.equal(vanish.action, 'muted-for-vanish');
  assert.equal(vanish.weMuted, true);
  assert.equal(muted, true);

  const reappear = controller.beginReappear();
  assert.equal(reappear.restored, true);
  assert.equal(reappear.action, 'restored-user-mic');
  assert.equal(muted, false);
});

test('mute controller respects manual interaction while vanished', () => {
  let muted = false;
  const controller = new MuteController({
    getMuted: () => muted,
    setMuted: (next) => {
      muted = Boolean(next);
      return true;
    }
  });

  controller.beginVanish();
  controller.markUserMicInteraction();
  const reappear = controller.beginReappear();

  assert.equal(reappear.shouldRestore, false);
  assert.equal(reappear.restored, false);
  assert.equal(reappear.action, 'kept-muted-manual-or-override');
  assert.equal(muted, true);
});

test('mute controller detects outside changes and keeps user state', () => {
  let muted = false;
  const controller = new MuteController({
    getMuted: () => muted,
    setMuted: (next) => {
      muted = Boolean(next);
      return true;
    }
  });

  controller.beginVanish();
  muted = false;
  const observed = controller.observe(false);
  assert.equal(observed.override, true);

  const reappear = controller.beginReappear();
  assert.equal(reappear.shouldRestore, false);
  assert.equal(muted, false);
  assert.equal(reappear.action, 'kept-muted-manual-or-override');
});

test('mute controller leaves an already muted user alone', () => {
  let muted = true;
  const controller = new MuteController({
    getMuted: () => muted,
    setMuted: (next) => {
      muted = Boolean(next);
      return true;
    }
  });

  assert.equal(controller.beginVanish().action, 'already-muted');
  assert.equal(muted, true);
  assert.equal(controller.beginReappear().action, 'stayed-user-muted');
  assert.equal(muted, true);
});

test('state machine runs the full vanish and return cycle', () => {
  const machine = new StateMachine({ duration: 1000, cooldown: 500 });
  assert.equal(machine.state, STATES.VISIBLE);
  assert.equal(UI_STATES[machine.state], 'ready');

  const vanish = machine.requestVanish(0);
  assert.equal(vanish.accepted, true);
  assert.equal(machine.state, STATES.DISINTEGRATING);
  assert.equal(machine.update(999).changed, false);
  assert.equal(machine.update(1000).state, STATES.VANISHED);

  const reappear = machine.requestReappear(1000);
  assert.equal(reappear.accepted, true);
  assert.equal(machine.state, STATES.REASSEMBLING);
  assert.equal(machine.update(2000).state, STATES.VISIBLE);

  const blocked = machine.requestVanish(2001);
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(machine.requestVanish(2500).accepted, true);
});

test('state machine handles enable, disable and error recovery', () => {
  const machine = new StateMachine({ duration: 500, cooldown: 100 });
  machine.setEnabled(false);
  assert.equal(machine.state, STATES.DISABLED);
  machine.setEnabled(true);
  assert.equal(machine.state, STATES.VISIBLE);

  machine.setError('test');
  assert.equal(machine.state, STATES.ERROR);
  assert.equal(machine.dissolveAmount(), 0);
  machine.forceVisible('recover');
  assert.equal(machine.state, STATES.VISIBLE);
});

test('snap detector sensitivity thresholds are monotonic', () => {
  const low = sensitivityToThresholds(0);
  const high = sensitivityToThresholds(100);

  assert.ok(low.closeThreshold > high.closeThreshold);
  assert.ok(low.separationDelta > high.separationDelta);
  assert.ok(low.speedThreshold > high.speedThreshold);
  assert.ok(low.confidenceThreshold > high.confidenceThreshold);
  assert.ok(low.cooldownMs > high.cooldownMs);
});
