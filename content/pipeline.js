import { StateMachine, STATES, UI_STATES } from '../effects/state-machine.js';
import { HandTracker } from '../vision/hand-tracker.js';
import { SnapDetector } from '../vision/snap-detector.js';
import { PersonSegmenter } from '../vision/person-segmentation.js';
import { BackgroundReconstruction } from '../vision/background-reconstruction.js';
import { DustRenderer } from '../effects/renderer.js';
import { ParticleSystem } from '../effects/particle-system.js';
import { MuteController } from '../audio/mute-controller.js';
import { sanitizeSettings } from '../lib/settings.js';

const WASM_PATH = 'lib/mediapipe/wasm';
const HAND_MODEL_PATH = 'vision/models/hand_landmarker.task';
const SEGMENTATION_MODEL_PATH = 'vision/models/selfie_segmenter.tflite';

function createCanvas(width = 2, height = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function extensionUrl(path) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(`../${path}`, import.meta.url).href;
}

function smoothstep(edge0, edge1, value) {
  const x = Math.min(1, Math.max(0, (value - edge0) / Math.max(0.00001, edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function blurMask(source, width, height) {
  const horizontal = new Float32Array(source.length);
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = source[row + Math.max(0, x - 1)];
      const center = source[row + x];
      const right = source[row + Math.min(width - 1, x + 1)];
      horizontal[row + x] = (left + center * 2 + right) * 0.25;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const up = Math.max(0, y - 1) * width;
    const row = y * width;
    const down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const value =
        (horizontal[up + x] + horizontal[row + x] * 2 + horizontal[down + x]) * 0.25;
      output[row + x] = Math.round(smoothstep(0.18, 0.78, value / 255) * 255);
    }
  }
  return output;
}

export class SnapVanishPipeline {
  constructor(options = {}) {
    this.settings = sanitizeSettings(options.settings || {});
    this.mic = options.mic || null;
    this.loadPlate = options.loadPlate || null;
    this.onPlate = options.onPlate || (() => {});
    this.onPlateCleared = options.onPlateCleared || (() => {});
    this.onState = options.onState || (() => {});
    this.onError = options.onError || (() => {});
    this.onLog = options.onLog || (() => {});

    this.stateMachine = new StateMachine({
      duration: this.settings.dustDuration,
      cooldown: Math.round(1700 - (this.settings.sensitivity / 100) * 800),
      enabled: this.settings.enabled
    });

    this.detector = new SnapDetector({
      sensitivity: this.settings.sensitivity,
      audioConfirmation: this.settings.audioConfirmation
    });
    this.particles = new ParticleSystem();
    this.background = new BackgroundReconstruction({ maxWidth: 960 });
    this.renderer = null;
    this.handTracker = null;
    this.segmenter = null;

    this.inputCanvas = createCanvas();
    this.inputCtx = this.inputCanvas.getContext('2d', { willReadFrequently: true });
    this.visionCanvas = createCanvas();
    this.visionCtx = this.visionCanvas.getContext('2d', { willReadFrequently: false });
    this.rawMaskCanvas = createCanvas();
    this.rawMaskCtx = this.rawMaskCanvas.getContext('2d', { willReadFrequently: true });
    this.scaledMaskCanvas = createCanvas();
    this.scaledMaskCtx = this.scaledMaskCanvas.getContext('2d', { willReadFrequently: true });
    this.outputCanvas = createCanvas();
    this.outputCtx = this.outputCanvas.getContext('2d', { willReadFrequently: false });
    this.backgroundCanvas = null;
    this.backgroundVersion = -1;
    this.backgroundSize = '';

    this.maskAlpha = null;
    this.maskWidth = 0;
    this.maskHeight = 0;
    this.maskVersion = 0;
    this.maskCoverage = 0;
    this.frozenMask = false;

    this.ready = false;
    this.loading = false;
    this.handReady = false;
    this.segmentationReady = false;
    this.initError = null;
    this.lastError = null;

    this.lastHandAt = 0;
    this.lastSegmentationAt = 0;
    this.lastPlateObserveAt = 0;
    this.lastFrameAt = 0;
    this.frameIntervals = [];
    this.processCosts = [];
    this.averageProcessCost = 0;
    this.fps = 0;
    this.particleBudget = 7000;
    this.qualityScale = 1;
    this.effectSeed = 1;
    this.lastTriggerSource = null;
    this.lastTriggerAt = 0;
    this.lastAudioAt = 0;
    this.audioTransientCount = 0;
    this.audioServiceStatus = { running: false, mode: 'idle' };
    this.muteController = new MuteController({
      getMuted: () => {
        try {
          return this.mic && typeof this.mic.getMuted === 'function' ? Boolean(this.mic.getMuted()) : false;
        } catch {
          return false;
        }
      },
      setMuted: (muted) => {
        if (!this.mic || typeof this.mic.setMuted !== 'function') return false;
        return this.mic.setMuted(Boolean(muted));
      },
      onLog: (entry) => this.onLog(entry)
    });

    this.previousState = this.stateMachine.state;
    this.stateMachine.subscribe((detail) => {
      if (
        detail.state === STATES.VISIBLE &&
        this.previousState === STATES.REASSEMBLING
      ) {
        this.particles.clear();
        if (this.renderer) this.renderer.setParticleData(null, 0);
        this.frozenMask = false;
      }
      if (detail.state === STATES.DISABLED) {
        this.frozenMask = false;
        this.particles.clear();
        if (this.renderer) this.renderer.setParticleData(null, 0);
      }
      this.previousState = detail.state;
      this.notify(`state:${detail.reason || detail.state}`);
    });
  }

  async init() {
    if (this.ready) return this;
    if (this.loading) return this.initPromise;
    this.loading = true;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.loading = false;
    }
    return this;
  }

  async initialize() {
    this.notify('loading');
    try {
      this.renderer = new DustRenderer({ width: 640, height: 360 });
      if (this.renderer.initError) {
        this.onLog({
          message: `WebGL unavailable, using 2D fallback: ${this.renderer.initError.message}`,
          level: 'warning'
        });
      }

      if (this.loadPlate) {
        try {
          const dataUrl = await this.loadPlate();
          if (dataUrl) await this.background.loadFromDataUrl(dataUrl);
        } catch (error) {
          this.onLog({ message: `Stored background could not be loaded: ${error.message}`, level: 'warning' });
        }
      }

      this.handTracker = new HandTracker({
        wasmBasePath: extensionUrl(WASM_PATH),
        modelUrl: extensionUrl(HAND_MODEL_PATH)
      });
      this.segmenter = new PersonSegmenter({
        wasmBasePath: extensionUrl(WASM_PATH),
        modelUrl: extensionUrl(SEGMENTATION_MODEL_PATH)
      });

      const results = await Promise.allSettled([this.handTracker.init(), this.segmenter.init()]);
      const handResult = results[0];
      const segmentationResult = results[1];

      if (handResult.status === 'fulfilled') {
        this.handReady = true;
      } else {
        this.onLog({
          message: `Hand tracking could not start (automatic snap detection disabled): ${handResult.reason?.message || handResult.reason}`,
          level: 'warning'
        });
      }

      if (segmentationResult.status === 'fulfilled') {
        this.segmentationReady = true;
      } else {
        throw new Error(
          `Person segmentation could not start: ${segmentationResult.reason?.message || segmentationResult.reason}`
        );
      }

      this.ready = true;
      this.notify('ready');
      return this;
    } catch (error) {
      this.initError = error;
      this.lastError = error;
      this.onError({ message: error.message, fatal: true });
      this.notify('init-error');
      throw error;
    }
  }

  setSettings(nextSettings) {
    const sanitized = sanitizeSettings(nextSettings);
    const wasEnabled = this.settings.enabled;
    this.settings = sanitized;
    this.stateMachine.setDuration(sanitized.dustDuration);
    this.stateMachine.setCooldown(Math.round(1700 - (sanitized.sensitivity / 100) * 800));
    this.detector.setSensitivity(sanitized.sensitivity);
    this.detector.setAudioConfirmation(sanitized.audioConfirmation);

    if (wasEnabled !== sanitized.enabled) {
      this.setEnabled(sanitized.enabled);
    }
    this.notify('settings');
  }

  setMicInterface(mic) {
    this.mic = mic;
    this.muteController.reset();
    this.notify('mic-interface');
  }

  markUserMicInteraction() {
    this.muteController.markUserMicInteraction();
    this.notify('mic-user-action');
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.settings.enabled !== next) {
      this.settings = sanitizeSettings({ ...this.settings, enabled: next });
    }
    if (!next) {
      if (this.muteController.weMuted) {
        this.muteController.beginReappear();
      }
      this.particles.clear();
      if (this.renderer) this.renderer.setParticleData(null, 0);
      this.frozenMask = false;
      this.stateMachine.setEnabled(false);
    } else {
      this.stateMachine.setEnabled(true);
    }
    this.notify('enabled');
  }

  addAudioTransient(time, strength = 1, meta = {}) {
    this.lastAudioAt = time;
    this.audioTransientCount += 1;
    this.detector.addAudioTransient(time, strength, meta);
    this.notify('audio-transient');
  }

  setAudioServiceStatus(status = {}) {
    this.audioServiceStatus = { ...this.audioServiceStatus, ...status };
    this.notify('audio-status');
  }

  ensureCanvasSize(source) {
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight) return false;

    const scale = Math.min(1, 960 / sourceWidth, 720 / sourceHeight);
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));

    if (this.inputCanvas.width !== width || this.inputCanvas.height !== height) {
      this.inputCanvas.width = width;
      this.inputCanvas.height = height;
      this.outputCanvas.width = width;
      this.outputCanvas.height = height;
      this.visionCanvas.width = Math.max(2, Math.round(Math.min(480, width)));
      this.visionCanvas.height = Math.max(
        2,
        Math.round((height * this.visionCanvas.width) / width)
      );
      if (this.renderer) this.renderer.resize(width, height);
      this.maskAlpha = null;
      this.maskWidth = 0;
      this.maskHeight = 0;
      this.maskVersion += 1;
      this.backgroundCanvas = null;
      this.backgroundVersion = -1;
    }
    return true;
  }

  processFrame(source, timestamp = Date.now()) {
    if (!source) return null;
    if (!this.ensureCanvasSize(source)) return null;

    const started = performance.now();
    this.inputCtx.drawImage(source, 0, 0, this.inputCanvas.width, this.inputCanvas.height);

    if (!this.ready) {
      this.outputCtx.drawImage(this.inputCanvas, 0, 0);
      this.recordPerformance(started, timestamp);
      return this.outputCanvas;
    }

    try {
      this.stateMachine.update(timestamp);
      if (this.mic) {
        this.muteController.observe(this.muteController.isMuted());
      }

      if (this.stateMachine.state === STATES.VISIBLE) {
        this.updateVision(timestamp, false);
        this.observeBackground(timestamp);
      } else if (this.stateMachine.isTransitioning() || this.stateMachine.state === STATES.VANISHED) {
        this.updateHandTrackingOnly(timestamp);
      }

      this.renderFrame(timestamp);
    } catch (error) {
      this.lastError = error;
      this.onLog({ message: `Frame processing error: ${error.message}`, level: 'error' });
      this.outputCtx.drawImage(this.inputCanvas, 0, 0);
    }

    this.recordPerformance(started, timestamp);
    return this.outputCanvas;
  }

  updateVision(timestamp, force) {
    const now = timestamp;
    const handInterval = force ? 0 : 50;
    let visionDrawn = false;
    if (this.handReady && now - this.lastHandAt >= handInterval) {
      this.visionCtx.drawImage(
        this.inputCanvas,
        0,
        0,
        this.visionCanvas.width,
        this.visionCanvas.height
      );
      visionDrawn = true;
      const hand = this.handTracker.detect(this.visionCanvas, now);
      this.lastHandAt = now;
      this.lastHand = hand;
      if (hand && hand.landmarks) {
        const result = this.detector.update(hand.landmarks, now);
        this.lastDetection = result;
        if (result && result.confirmed) {
          if (this.stateMachine.state === STATES.VISIBLE) {
            this.triggerSnap('snap', now);
          }
        }
      } else {
        this.detector.update(null, now);
        this.lastDetection = { detected: false, reason: 'no-hand', confidence: 0 };
      }
    }

    const segmentationInterval = force ? 0 : 120;
    if (this.segmentationReady && now - this.lastSegmentationAt >= segmentationInterval) {
      if (!visionDrawn) {
        this.visionCtx.drawImage(
          this.inputCanvas,
          0,
          0,
          this.visionCanvas.width,
          this.visionCanvas.height
        );
      }
      this.lastSegmentationAt = now;
      this.runSegmentation(now);
    }
  }

  updateHandTrackingOnly(timestamp) {
    const now = timestamp;
    if (!this.handReady || now - this.lastHandAt < 70) return;
    this.visionCtx.drawImage(
      this.inputCanvas,
      0,
      0,
      this.visionCanvas.width,
      this.visionCanvas.height
    );
    const hand = this.handTracker.detect(this.visionCanvas, now);
    this.lastHandAt = now;
    this.lastHand = hand;
    if (hand && hand.landmarks) {
      const result = this.detector.update(hand.landmarks, now);
      this.lastDetection = result;
      if (result && result.confirmed && this.stateMachine.state === STATES.VANISHED) {
        this.triggerSnap('snap', now);
      }
    } else {
      this.detector.update(null, now);
    }
  }

  runSegmentation(timestamp) {
    if (!this.segmentationReady) return false;
    const raw = this.segmenter.segment(this.visionCanvas, timestamp);
    if (!raw) return false;

    const width = raw.width;
    const height = raw.height;
    if (!this.maskAlpha || this.maskWidth !== width || this.maskHeight !== height) {
      this.maskAlpha = new Uint8ClampedArray(width * height);
      this.maskWidth = width;
      this.maskHeight = height;
    }

    const blend = this.maskVersion === 0 ? 1 : 0.55;
    const combined = new Uint8ClampedArray(width * height);
    let coverage = 0;
    for (let i = 0; i < combined.length; i += 1) {
      const value = this.maskAlpha[i] * (1 - blend) + raw.alpha[i] * blend;
      combined[i] = value;
      if (value > 110) coverage += 1;
    }

    const feathered = blurMask(combined, width, height);
    this.maskAlpha = feathered;
    this.maskCoverage = coverage / (width * height);
    this.maskVersion += 1;
    return true;
  }

  buildScaledMask() {
    if (!this.maskAlpha) return null;
    this.rawMaskCanvas.width = this.maskWidth;
    this.rawMaskCanvas.height = this.maskHeight;
    const image = this.rawMaskCtx.createImageData(this.maskWidth, this.maskHeight);
    for (let i = 0; i < this.maskAlpha.length; i += 1) {
      const value = this.maskAlpha[i];
      const offset = i * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = value;
    }
    this.rawMaskCtx.putImageData(image, 0, 0);

    const width = this.inputCanvas.width;
    const height = this.inputCanvas.height;
    if (this.scaledMaskCanvas.width !== width || this.scaledMaskCanvas.height !== height) {
      this.scaledMaskCanvas.width = width;
      this.scaledMaskCanvas.height = height;
    }
    this.scaledMaskCtx.clearRect(0, 0, width, height);
    this.scaledMaskCtx.imageSmoothingEnabled = true;
    this.scaledMaskCtx.drawImage(this.rawMaskCanvas, 0, 0, width, height);
    const data = this.scaledMaskCtx.getImageData(0, 0, width, height).data;
    const mask = new Uint8ClampedArray(width * height);
    for (let i = 0; i < mask.length; i += 1) {
      mask[i] = data[i * 4 + 3];
    }
    return { mask, width, height };
  }

  prepareVanishEffects() {
    if (!this.maskAlpha) return false;
    const scaled = this.buildScaledMask();
    if (!scaled) return false;
    const image = this.inputCtx.getImageData(
      0,
      0,
      this.inputCanvas.width,
      this.inputCanvas.height
    );
    const result = this.particles.generate(image, scaled.mask, scaled.width, scaled.height, {
      maxParticles: Math.round(this.particleBudget * this.qualityScale),
      direction: this.settings.dustDirection,
      seed: this.effectSeed
    });
    this.renderer.setParticleData(result.data, result.count);
    return result.count > 0;
  }

  triggerSnap(source = 'manual', timestamp = Date.now()) {
    if (!this.ready) {
      return { ok: false, reason: 'not-initialized' };
    }
    if (!this.settings.enabled) {
      return { ok: false, reason: 'disabled' };
    }

    this.stateMachine.update(timestamp);

    if (this.stateMachine.state === STATES.ERROR) {
      this.stateMachine.forceVisible('retry');
    }

    if (this.stateMachine.state === STATES.VISIBLE) {
      if (!this.maskAlpha) {
        this.updateVision(timestamp, true);
      }
      if (!this.maskAlpha) {
        this.lastError = new Error('Person mask is not available yet');
        this.onError({ message: 'Person segmentation is not producing a mask yet.', fatal: false });
        return { ok: false, reason: 'no-mask' };
      }

      const result = this.stateMachine.requestVanish(timestamp);
      if (!result.accepted) return { ok: false, reason: result.reason };
      this.effectSeed = Math.floor(Math.random() * 1_000_000_000) || 1;
      this.frozenMask = true;
      this.prepareVanishEffects();
      this.lastTriggerSource = source;
      this.lastTriggerAt = timestamp;
      this.detector.forceCooldown(timestamp);
      const muteResult = this.muteController.beginVanish();
      this.onLog({
        message: `Vanish triggered by ${source}. ${muteResult.action}.`,
        level: 'info'
      });
      this.notify('vanish-start');
      return { ok: true, state: this.stateMachine.state, source, mute: muteResult };
    }

    if (this.stateMachine.state === STATES.VANISHED) {
      const result = this.stateMachine.requestReappear(timestamp);
      if (!result.accepted) return { ok: false, reason: result.reason };
      const muteResult = this.muteController.beginReappear();
      this.lastTriggerSource = source;
      this.lastTriggerAt = timestamp;
      this.detector.forceCooldown(timestamp);
      this.onLog({
        message: `Reappear triggered by ${source}. ${muteResult.action}.`,
        level: 'info'
      });
      this.notify('reappear-start');
      return { ok: true, state: this.stateMachine.state, source, mute: muteResult };
    }

    return {
      ok: false,
      reason: `state-${this.stateMachine.state.toLowerCase()}`,
      state: this.stateMachine.state
    };
  }

  observeBackground(timestamp) {
    if (!this.settings.autoCaptureBackground || !this.maskAlpha) return;
    if (timestamp - this.lastPlateObserveAt < 220) return;
    this.lastPlateObserveAt = timestamp;
    const result = this.background.observe(this.inputCanvas, this.maskCoverage, timestamp, {
      auto: true
    });
    if (result && result.ok) {
      this.handlePlateCaptured(result, 'auto');
    }
  }

  handlePlateCaptured(result, source) {
    this.backgroundCanvas = null;
    this.backgroundVersion = -1;
    if (result.dataUrl && this.settings.persistBackground) {
      try {
        this.onPlate(result.dataUrl, { source, capturedAt: Date.now() });
      } catch (error) {
        this.onLog({ message: `Background plate could not be saved: ${error.message}`, level: 'warning' });
      }
    }
    this.onLog({ message: `Clean background plate captured (${source}).`, level: 'info' });
    this.notify('plate-captured');
  }

  async loadBackgroundPlate(dataUrl, meta = {}) {
    if (!dataUrl) return { ok: false, reason: 'no-image' };
    const loaded = await this.background.loadFromDataUrl(dataUrl);
    if (!loaded) {
      return {
        ok: false,
        reason: 'decode-failed',
        message: this.background.error ? this.background.error.message : 'Background image could not be decoded'
      };
    }
    this.background.plateSource = meta.source || 'uploaded';
    this.background.version += 1;
    this.backgroundCanvas = null;
    this.backgroundVersion = -1;
    if (this.settings.persistBackground) {
      try {
        this.onPlate(dataUrl, {
          source: meta.source || 'uploaded',
          capturedAt: Date.now()
        });
      } catch (error) {
        this.onLog({ message: `Background plate could not be saved: ${error.message}`, level: 'warning' });
      }
    }
    this.notify('plate-loaded');
    return { ok: true };
  }

  async captureBackgroundPlate(options = {}) {
    if (!this.ready) return { ok: false, reason: 'not-initialized' };
    if (!this.maskAlpha) {
      this.updateVision(Date.now(), true);
    }
    const coverage = this.maskCoverage;
    if (!options.force && coverage > 0.08) {
      return {
        ok: false,
        reason: 'person-in-frame',
        coverage,
        message: 'Step out of the camera frame, then capture the empty room.'
      };
    }
    const result = this.background.capture(this.inputCanvas, {
      source: options.force ? 'forced-manual' : 'manual'
    });
    if (result.ok) {
      this.handlePlateCaptured(result, result.source);
    }
    return result;
  }

  async clearBackgroundPlate() {
    this.background.clear();
    this.backgroundCanvas = null;
    this.backgroundVersion = -1;
    try {
      this.onPlateCleared();
    } catch {
      // Best-effort.
    }
    this.notify('plate-cleared');
    return { ok: true };
  }

  ensureBackgroundCanvas() {
    const width = this.inputCanvas.width;
    const height = this.inputCanvas.height;
    const size = `${width}x${height}`;
    if (
      !this.backgroundCanvas ||
      this.backgroundVersion !== this.background.version ||
      this.backgroundSize !== size
    ) {
      const result = this.background.getBackground(width, height);
      this.backgroundCanvas = result.canvas;
      this.backgroundVersion = this.background.version;
      this.backgroundSize = size;
      this.backgroundPlaceholder = result.placeholder;
    }
    return this.backgroundCanvas;
  }

  renderFrame(timestamp) {
    const state = this.stateMachine.state;
    const dissolve = this.stateMachine.dissolveAmount(timestamp);

    if (state === STATES.DISABLED || state === STATES.VISIBLE || state === STATES.ERROR) {
      this.outputCtx.clearRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
      this.outputCtx.drawImage(this.inputCanvas, 0, 0);
      return;
    }

    const background = this.ensureBackgroundCanvas();
    this.renderer.render({
      source: this.inputCanvas,
      background,
      mask: this.maskAlpha,
      maskWidth: this.maskWidth,
      maskHeight: this.maskHeight,
      maskVersion: this.maskVersion,
      dissolve,
      showParticles: this.stateMachine.isTransitioning(),
      glowColor: [1, 0.72, 0.28],
      seed: this.effectSeed
    });

    this.outputCtx.clearRect(0, 0, this.outputCanvas.width, this.outputCanvas.height);
    this.outputCtx.drawImage(this.renderer.canvas, 0, 0, this.outputCanvas.width, this.outputCanvas.height);
  }

  recordPerformance(started, timestamp) {
    const cost = performance.now() - started;
    this.processCosts.push(cost);
    if (this.processCosts.length > 45) this.processCosts.shift();
    this.averageProcessCost =
      this.processCosts.reduce((sum, value) => sum + value, 0) / this.processCosts.length;

    if (this.lastFrameAt) {
      this.frameIntervals.push(timestamp - this.lastFrameAt);
      if (this.frameIntervals.length > 30) this.frameIntervals.shift();
      const averageInterval =
        this.frameIntervals.reduce((sum, value) => sum + value, 0) / this.frameIntervals.length;
      this.fps = averageInterval > 0 ? Math.round(1000 / averageInterval) : 0;
    }
    this.lastFrameAt = timestamp;

    if (this.processCosts.length >= 30) {
      if (this.averageProcessCost > 48 && this.qualityScale > 0.35) {
        this.qualityScale = Math.max(0.35, this.qualityScale - 0.08);
        this.processCosts = [];
      } else if (this.averageProcessCost < 22 && this.qualityScale < 1) {
        this.qualityScale = Math.min(1, this.qualityScale + 0.04);
        this.processCosts = [];
      }
    }
  }

  notify(reason = 'update') {
    const status = this.getStatus();
    status.reason = reason;
    try {
      this.onState(status);
    } catch (error) {
      this.onLog({ message: `Status listener failed: ${error.message}`, level: 'warning' });
    }
  }

  getStatus() {
    const state = this.stateMachine.state;
    return {
      ready: this.ready,
      loading: this.loading,
      enabled: this.settings.enabled,
      state,
      uiState: UI_STATES[state] || 'error',
      progress: this.stateMachine.progress(Date.now()),
      dissolve: this.stateMachine.dissolveAmount(Date.now()),
      duration: this.settings.dustDuration,
      direction: this.settings.dustDirection,
      sensitivity: this.settings.sensitivity,
      hasPlate: this.background.getStatus().hasPlate,
      plateSource: this.background.getStatus().source,
      platePlaceholder: Boolean(this.backgroundCanvas && this.backgroundPlaceholder),
      maskCoverage: this.maskCoverage,
      handPresent: Boolean(this.lastHand && this.lastHand.landmarks),
      handConfidence: this.lastDetection ? this.lastDetection.confidence || 0 : 0,
      lastDetectionReason: this.lastDetection ? this.lastDetection.reason : 'idle',
      audio: {
        ...this.audioServiceStatus,
        lastTransientAt: this.lastAudioAt,
        transientCount: this.audioTransientCount
      },
      mic: {
        muted: this.muteController.isMuted(),
        originalMuted: this.muteController.originalMuted,
        weMuted: this.muteController.weMuted,
        userTouchedMic: this.muteController.userTouchedMic,
        overrideDetected: this.muteController.overrideDetected,
        lastAction: this.muteController.lastAction
      },
      handReady: this.handReady,
      segmentationReady: this.segmentationReady,
      fps: this.fps,
      processCost: Math.round(this.averageProcessCost * 10) / 10,
      qualityScale: Math.round(this.qualityScale * 100) / 100,
      particleBudget: Math.round(this.particleBudget * this.qualityScale),
      particles: this.particles.getDebug(),
      renderer: this.renderer ? this.renderer.getDebug() : null,
      lastTriggerSource: this.lastTriggerSource,
      lastTriggerAt: this.lastTriggerAt,
      error: this.lastError ? this.lastError.message : this.initError ? this.initError.message : null
    };
  }

  getDebugData() {
    return {
      status: this.getStatus(),
      landmarks: this.lastHand && this.lastHand.landmarks ? this.lastHand.landmarks : null,
      detector: this.detector.getDebug(),
      mask: this.maskAlpha,
      maskWidth: this.maskWidth,
      maskHeight: this.maskHeight
    };
  }

  async dispose() {
    try {
      if (this.muteController.weMuted) this.muteController.beginReappear();
      this.stateMachine.setEnabled(false);
      if (this.handTracker) this.handTracker.dispose();
      if (this.segmenter) this.segmenter.dispose();
      if (this.renderer) this.renderer.dispose();
      this.particles.clear();
      this.ready = false;
    } catch (error) {
      this.onLog({ message: `Dispose failed: ${error.message}`, level: 'warning' });
    }
  }
}

export { STATES, UI_STATES };
