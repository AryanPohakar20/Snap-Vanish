import { ImageSegmenter } from '../lib/mediapipe/tasks-vision/vision_bundle.mjs';
import { createTaskWithFallback, getVisionFileset } from '../lib/mediapipe-loader.js';

export class PersonSegmenter {
  constructor(options = {}) {
    this.wasmBasePath = options.wasmBasePath;
    this.modelUrl = options.modelUrl;
    this.segmenter = null;
    this.lastTimestamp = 0;
    this.timestampOrigin = null;
    this.lastError = null;
    this.errorCount = 0;
    this.delegate = 'unknown';
    this.labels = [];
  }

  async init() {
    if (this.segmenter) return this;
    if (!this.modelUrl) throw new Error('Selfie segmentation model URL is missing');
    const fileset = await getVisionFileset(this.wasmBasePath);
    let selectedDelegate = 'GPU';
    this.segmenter = await createTaskWithFallback(
      (opts) => ImageSegmenter.createFromOptions(fileset, opts),
      {
        baseOptions: {
          modelAssetPath: this.modelUrl
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      }
    ).catch((error) => {
      selectedDelegate = 'CPU';
      throw error;
    });
    this.delegate = selectedDelegate;
    try {
      this.labels = this.segmenter.getLabels ? this.segmenter.getLabels() : [];
    } catch {
      this.labels = [];
    }
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

  segment(source, timestampMs = Date.now()) {
    if (!this.segmenter || !source) return null;
    try {
      const mediaTimestamp = this.nextMediaTimestamp(timestampMs);
      const result = this.segmenter.segmentForVideo(source, mediaTimestamp);
      this.errorCount = 0;
      const parsed = this.extractMask(result);
      if (result && typeof result.close === 'function') result.close();
      return parsed;
    } catch (error) {
      this.errorCount += 1;
      this.lastError = error;
      if (this.errorCount === 3) {
        console.warn('[Snap Vanish] Segmentation failed repeatedly:', error);
      }
      return null;
    }
  }

  extractMask(result) {
    if (!result) return null;

    const masks = result.confidenceMasks;
    if (masks && masks.length) {
      const personMask = masks.length > 1 ? masks[1] : masks[0];
      const width = personMask.width;
      const height = personMask.height;
      const floats = personMask.getAsFloat32Array();
      const alpha = new Uint8ClampedArray(width * height);
      for (let i = 0; i < alpha.length; i += 1) {
        alpha[i] = Math.max(0, Math.min(1, floats[i])) * 255;
      }
      return { alpha, width, height, source: 'confidence' };
    }

    if (result.categoryMask) {
      const mask = result.categoryMask;
      const width = mask.width;
      const height = mask.height;
      const values = mask.getAsUint8Array();
      const alpha = new Uint8ClampedArray(width * height);
      let personIndex = 1;
      if (this.labels && this.labels.length) {
        const found = this.labels.findIndex((label) =>
          /person|selfie|foreground|human/i.test(String(label))
        );
        if (found >= 0) personIndex = found;
      }
      for (let i = 0; i < alpha.length; i += 1) {
        alpha[i] = values[i] === personIndex ? 255 : 0;
      }
      return { alpha, width, height, source: 'category' };
    }

    return null;
  }

  dispose() {
    try {
      if (this.segmenter) this.segmenter.close();
    } catch {
      // Best-effort cleanup.
    }
    this.segmenter = null;
  }
}
