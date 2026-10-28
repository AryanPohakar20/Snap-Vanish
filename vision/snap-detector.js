const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const WRIST = 0;
const MIDDLE_MCP = 9;

const MAX_SAMPLES = 48;

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function sensitivityToThresholds(sensitivity = 55) {
  const s = Math.min(1, Math.max(0, Number(sensitivity) / 100));
  return {
    closeThreshold: 0.36 + (1 - s) * 0.12,
    separationDelta: 0.24 + (1 - s) * 0.10,
    speedThreshold: 4.5 - s * 2.5,
    confidenceThreshold: 0.70 - s * 0.26,
    cooldownMs: 1700 - s * 800,
    audioWindowMs: 320,
    minAudioStrength: 0.12,
    minHandScale: 0.035
  };
}

export class SnapDetector {
  constructor(options = {}) {
    this.sensitivity = options.sensitivity ?? 55;
    this.audioConfirmation = options.audioConfirmation !== false;
    this.thresholds = sensitivityToThresholds(this.sensitivity);
    this.samples = [];
    this.audioTransients = [];
    this.lastTriggerAt = -Infinity;
    this.suppressUntil = 0;
    this.handLostAt = 0;
    this.expectingPreparation = true;
    this.lastResult = null;
    this.lastConfirmed = null;
    this.lastLandmarkAt = 0;
  }

  setSensitivity(sensitivity) {
    this.sensitivity = sensitivity;
    this.thresholds = sensitivityToThresholds(sensitivity);
  }

  setAudioConfirmation(enabled) {
    this.audioConfirmation = Boolean(enabled);
  }

  addAudioTransient(time, strength = 1, meta = {}) {
    if (!Number.isFinite(time)) return;
    this.audioTransients.push({
      time,
      strength: clamp01(strength),
      source: meta.source || 'microphone'
    });
    const cutoff = time - 3000;
    this.audioTransients = this.audioTransients.filter((item) => item.time >= cutoff);
  }

  findMatchingTransient(gestureTime) {
    const windowMs = this.thresholds.audioWindowMs;
    let best = null;
    let bestDelta = Infinity;
    for (const transient of this.audioTransients) {
      const delta = Math.abs(transient.time - gestureTime);
      if (delta <= windowMs && delta < bestDelta) {
        best = transient;
        bestDelta = delta;
      }
    }
    if (best && best.strength < this.thresholds.minAudioStrength) return null;
    return best ? { ...best, delta: bestDelta } : null;
  }

  resetSequence() {
    this.samples = [];
    this.expectingPreparation = true;
  }

  update(landmarks, timestamp = Date.now()) {
    if (!Array.isArray(landmarks) || landmarks.length < 21) {
      this.onHandMissing(timestamp);
      return { detected: false, reason: 'no-hand', confidence: 0, confirmed: false };
    }

    const now = Number.isFinite(timestamp) ? timestamp : Date.now();
    this.lastLandmarkAt = now;
    this.handLostAt = 0;
    const wrist = landmarks[WRIST];
    const middleMcp = landmarks[MIDDLE_MCP];
    const indexMcp = landmarks[INDEX_MCP];

    const handScale = Math.max(
      0.0001,
      (distance(wrist, middleMcp) + distance(wrist, indexMcp)) * 0.5
    );

    const thumbTip = landmarks[THUMB_TIP];
    const middleTip = landmarks[MIDDLE_TIP];
    const middlePip = landmarks[MIDDLE_PIP];

    const pinchDistance = distance(thumbTip, middleTip);
    const pinch = pinchDistance / handScale;
    const middleExtension =
      distance(middleTip, wrist) / Math.max(0.0001, distance(middlePip, wrist));
    const palm = {
      x: (wrist.x + middleMcp.x + indexMcp.x) / 3,
      y: (wrist.y + middleMcp.y + indexMcp.y) / 3
    };

    const previous = this.samples[this.samples.length - 1];
    const dt = previous ? Math.max(0.001, (now - previous.t) / 1000) : 0.033;
    const tipSpeed = previous
      ? Math.hypot(middleTip.x - previous.middleTip.x, middleTip.y - previous.middleTip.y) /
        (handScale * dt)
      : 0;
    const palmSpeed = previous
      ? Math.hypot(palm.x - previous.palm.x, palm.y - previous.palm.y) / (handScale * dt)
      : 0;

    const sample = {
      t: now,
      pinch,
      pinchDistance,
      handScale,
      tipSpeed,
      palmSpeed,
      middleExtension,
      thumbTip: { x: thumbTip.x, y: thumbTip.y },
      middleTip: { x: middleTip.x, y: middleTip.y },
      palm
    };

    this.samples.push(sample);
    const cutoff = now - 1200;
    this.samples = this.samples.filter((item) => item.t >= cutoff);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    const thresholds = this.thresholds;

    if (!this.expectingPreparation && pinch <= thresholds.closeThreshold) {
      this.expectingPreparation = true;
    }

    if (now < this.suppressUntil) {
      return {
        detected: false,
        reason: 'cooldown',
        confidence: 0,
        confirmed: false,
        debug: { pinch, handScale, tipSpeed, middleExtension }
      };
    }

    if (handScale < thresholds.minHandScale) {
      return {
        detected: false,
        reason: 'hand-too-small',
        confidence: 0,
        confirmed: false,
        debug: { pinch, handScale, tipSpeed, middleExtension }
      };
    }

    const recent = this.samples.filter((item) => item.t >= now - 480 && item.t <= now - 40);
    if (recent.length < 3) {
      return {
        detected: false,
        reason: 'building-sequence',
        confidence: 0,
        confirmed: false,
        debug: { pinch, handScale, tipSpeed, middleExtension }
      };
    }

    const minSample = recent.reduce((best, item) => (item.pinch < best.pinch ? item : best));
    const releaseDuration = now - minSample.t;
    const separation = pinch - minSample.pinch;
    const closeEnough = minSample.pinch <= thresholds.closeThreshold;
    const sharpEnough = releaseDuration <= 240;
    const separatedEnough = separation >= thresholds.separationDelta;
    const fastEnough = tipSpeed >= thresholds.speedThreshold;
    const preparationDepth = clamp01(
      (thresholds.closeThreshold - minSample.pinch) / Math.max(0.001, thresholds.closeThreshold)
    );
    const palmMotionDuringRelease = median(
      this.samples
        .filter((item) => item.t >= minSample.t)
        .map((item) => item.palmSpeed)
    );

    if (!closeEnough) {
      this.expectingPreparation = true;
      return {
        detected: false,
        reason: 'no-pinch-preparation',
        confidence: 0,
        confirmed: false,
        debug: { pinch, handScale, tipSpeed, middleExtension, minPinch: minSample.pinch }
      };
    }

    const waving = palmMotionDuringRelease > Math.max(11, tipSpeed * 1.9);
    if (waving) {
      return {
        detected: false,
        reason: 'rejected-wave',
        confidence: 0,
        confirmed: false,
        debug: { pinch, handScale, tipSpeed, palmMotionDuringRelease }
      };
    }

    if (!sharpEnough || !separatedEnough || !fastEnough) {
      return {
        detected: false,
        reason: !sharpEnough
          ? 'release-too-slow'
          : !separatedEnough
            ? 'separation-too-small'
            : 'finger-speed-too-low',
        confidence: 0,
        confirmed: false,
        debug: {
          pinch,
          handScale,
          tipSpeed,
          separation,
          releaseDuration,
          minPinch: minSample.pinch
        }
      };
    }

    if (!this.expectingPreparation) {
      return {
        detected: false,
        reason: 'awaiting-new-preparation',
        confidence: 0,
        confirmed: false,
        debug: { pinch, handScale, tipSpeed }
      };
    }

    const sepNorm = clamp01(separation / 0.5);
    const speedNorm = clamp01(tipSpeed / 14);
    const sharpness = 1 - clamp01(releaseDuration / 260);
    const extensionFactor = 0.78 + 0.22 * clamp01((middleExtension - 0.9) / 0.8);
    let confidence =
      (0.30 * sepNorm + 0.32 * speedNorm + 0.18 * preparationDepth + 0.20 * sharpness) *
      extensionFactor;

    const audio = this.findMatchingTransient(now);
    let audioConfirmed = !this.audioConfirmation;

    if (this.audioConfirmation) {
      if (audio) {
        audioConfirmed = true;
        confidence = Math.min(1, confidence * (0.78 + 0.22 * audio.strength) + 0.08);
      } else {
        audioConfirmed = false;
      }
    }

    const candidate = {
      detected: true,
      confirmed: false,
      confidence,
      audioConfirmed,
      audio: audio ? { strength: audio.strength, delta: audio.delta } : null,
      timestamp: now,
      reason: audioConfirmed ? 'gesture-and-audio' : 'awaiting-audio-confirmation',
      debug: {
        pinch,
        handScale,
        tipSpeed,
        separation,
        releaseDuration,
        preparationDepth,
        middleExtension,
        minPinch: minSample.pinch,
        confidenceThreshold: thresholds.confidenceThreshold
      }
    };

    this.lastResult = candidate;

    if (
      audioConfirmed &&
      confidence >= thresholds.confidenceThreshold &&
      now - this.lastTriggerAt >= thresholds.cooldownMs
    ) {
      this.lastTriggerAt = now;
      this.suppressUntil = now + 750;
      this.expectingPreparation = false;
      this.lastConfirmed = { ...candidate, confirmed: true, reason: 'confirmed-snap' };
      return this.lastConfirmed;
    }

    if (audioConfirmed && confidence < thresholds.confidenceThreshold) {
      candidate.reason = 'low-confidence';
    }
    return candidate;
  }

  onHandMissing(timestamp = Date.now()) {
    if (!this.handLostAt) this.handLostAt = timestamp;
    if (timestamp - this.handLostAt > 350) this.resetSequence();
  }

  finishFrame(landmarks, timestamp = Date.now()) {
    if (Array.isArray(landmarks) && landmarks.length >= 21) {
      this.handLostAt = 0;
    }
  }

  forceCooldown(timestamp = Date.now()) {
    this.lastTriggerAt = timestamp;
    this.suppressUntil = timestamp + 750;
    this.expectingPreparation = false;
  }

  getDebug() {
    return {
      sensitivity: this.sensitivity,
      thresholds: this.thresholds,
      audioTransients: this.audioTransients.slice(-4),
      lastResult: this.lastResult,
      lastConfirmed: this.lastConfirmed,
      samples: this.samples.length
    };
  }
}
