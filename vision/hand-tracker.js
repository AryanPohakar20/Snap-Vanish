import { HandLandmarker } from '../lib/mediapipe/tasks-vision/vision_bundle.mjs';
import { createTaskWithFallback, getVisionFileset } from '../lib/mediapipe-loader.js';

export const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
]);

export class HandTracker {
  constructor(options = {}) {
    this.wasmBasePath = options.wasmBasePath;
    this.modelUrl = options.modelUrl;
    this.numHands = options.numHands || 1;
    this.landmarker = null;
    this.lastResult = null;
    this.lastTimestamp = 0;
    this.timestampOrigin = null;
    this.errorCount = 0;
    this.lastError = null;
    this.delegate = 'unknown';
  }

  async init() {
    if (this.landmarker) return this;
    if (!this.modelUrl) throw new Error('Hand landmarker model URL is missing');
    const fileset = await getVisionFileset(this.wasmBasePath);
    let selectedDelegate = 'GPU';
    this.landmarker = await createTaskWithFallback(
      (opts) => HandLandmarker.createFromOptions(fileset, opts),
      {
        baseOptions: {
          modelAssetPath: this.modelUrl
        },
        runningMode: 'VIDEO',
        numHands: this.numHands,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.45,
        minTrackingConfidence: 0.45
      }
    ).catch((error) => {
      selectedDelegate = 'CPU';
      throw error;
    });
    this.delegate = selectedDelegate;
    return this;
  }

  nextMediaTimestamp(timestampMs) {
    const numeric = Number.isFinite(timestampMs) ? timestampMs : Date.now();
    if (this.timestampOrigin === null) this.timestampOrigin = numeric;
    let relative = Math.round(numeric - this.timestampOrigin) + 1;
    if (!Number.isFinite(relative) || relative < 1) relative = 1;
    if (relative <= this.lastTimestamp) relative = this.lastTimestamp + 1;
    this.lastTimestamp = relative;
    return relative;
  }

  detect(source, timestampMs = Date.now()) {
    if (!this.landmarker || !source) return null;
    try {
      const mediaTimestamp = this.nextMediaTimestamp(timestampMs);
      const result = this.landmarker.detectForVideo(source, mediaTimestamp);
      this.errorCount = 0;
      const landmarks = result && result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
      const handedness =
        result && result.handedness && result.handedness[0] && result.handedness[0][0]
          ? result.handedness[0][0]
          : null;
      this.lastResult = landmarks ? { landmarks, handedness, at: Date.now() } : null;
      return this.lastResult;
    } catch (error) {
      this.errorCount += 1;
      this.lastError = error;
      if (this.errorCount === 3) {
        console.warn('[Snap Vanish] Hand tracking failed repeatedly:', error);
      }
      return null;
    }
  }

  dispose() {
    try {
      if (this.landmarker) this.landmarker.close();
    } catch {
      // Best-effort cleanup.
    }
    this.landmarker = null;
  }
}
