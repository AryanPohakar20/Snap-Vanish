function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function drawCover(ctx, source, width, height) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width || width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const dx = (width - drawWidth) / 2;
  const dy = (height - drawHeight) / 2;
  ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
}

export class BackgroundReconstruction {
  constructor(options = {}) {
    this.maxWidth = options.maxWidth || 960;
    this.autoCoverageThreshold = options.autoCoverageThreshold ?? 0.02;
    this.autoHoldMs = options.autoHoldMs || 1400;
    this.plate = null;
    this.plateWidth = 0;
    this.plateHeight = 0;
    this.plateSource = 'none';
    this.plateCapturedAt = 0;
    this.lowCoverageSince = 0;
    this.signatureCanvas = createCanvas(32, 18);
    this.signatureCtx = this.signatureCanvas.getContext('2d', { willReadFrequently: true });
    this.previousSignature = null;
    this.framesWithoutPerson = 0;
    this.placeholderCache = new Map();
    this.error = null;
    this.version = 0;
  }

  async loadFromDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return false;
    try {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Stored background plate could not be decoded'));
      });
      image.src = dataUrl;
      await loaded;

      const scale = Math.min(1, this.maxWidth / image.naturalWidth);
      const width = Math.max(2, Math.round(image.naturalWidth * scale));
      const height = Math.max(2, Math.round(image.naturalHeight * scale));
      const canvas = createCanvas(width, height);
      canvas.getContext('2d').drawImage(image, 0, 0, width, height);
      this.plate = canvas;
      this.plateWidth = width;
      this.plateHeight = height;
      this.plateSource = 'stored';
      this.plateCapturedAt = Date.now();
      this.version += 1;
      return true;
    } catch (error) {
      this.error = error;
      return false;
    }
  }

  capture(source, options = {}) {
    if (!source) return { ok: false, reason: 'no-source' };
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight) return { ok: false, reason: 'source-not-ready' };

    const scale = Math.min(1, this.maxWidth / sourceWidth);
    const width = Math.max(2, Math.round(sourceWidth * scale));
    const height = Math.max(2, Math.round(sourceHeight * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(source, 0, 0, width, height);
    this.plate = canvas;
    this.plateWidth = width;
    this.plateHeight = height;
    this.plateSource = options.source || 'manual';
    this.plateCapturedAt = Date.now();
    this.error = null;
    this.version += 1;

    let dataUrl = null;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    } catch {
      dataUrl = null;
    }
    return { ok: true, width, height, dataUrl, source: this.plateSource };
  }

  computeSignature(source) {
    if (!this.signatureCtx) return 1;
    try {
      this.signatureCtx.drawImage(source, 0, 0, 32, 18);
      const data = this.signatureCtx.getImageData(0, 0, 32, 18).data;
      let previous = this.previousSignature;
      let difference = 0;
      if (previous) {
        for (let i = 0; i < data.length; i += 4) {
          difference +=
            Math.abs(data[i] - previous[i]) +
            Math.abs(data[i + 1] - previous[i + 1]) +
            Math.abs(data[i + 2] - previous[i + 2]);
        }
        difference /= (data.length / 4) * 3 * 255;
      } else {
        difference = 1;
      }
      this.previousSignature = data;
      return difference;
    } catch {
      return 1;
    }
  }

  observe(source, coverage, timestamp = Date.now(), options = {}) {
    const autoEnabled = options.auto !== false;
    if (!autoEnabled) return null;
    const motion = this.computeSignature(source);
    const clear = Number.isFinite(coverage) && coverage <= this.autoCoverageThreshold;
    const stable = motion < 0.025;

    if (clear && stable) {
      if (!this.lowCoverageSince) this.lowCoverageSince = timestamp;
      this.framesWithoutPerson += 1;
    } else {
      this.lowCoverageSince = 0;
      this.framesWithoutPerson = 0;
    }

    if (
      clear &&
      stable &&
      this.framesWithoutPerson >= 4 &&
      timestamp - this.lowCoverageSince >= this.autoHoldMs &&
      timestamp - this.plateCapturedAt > 4000
    ) {
      this.framesWithoutPerson = 0;
      this.lowCoverageSince = 0;
      return this.capture(source, { source: 'auto' });
    }
    return null;
  }

  getPlaceholder(width, height) {
    const key = `${width}x${height}`;
    if (this.placeholderCache.has(key)) return this.placeholderCache.get(key);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#16181d');
    gradient.addColorStop(0.55, '#252a33');
    gradient.addColorStop(1, '#111317');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(242, 185, 89, 0.18)';
    ctx.lineWidth = Math.max(1, width / 480);
    const step = Math.max(24, Math.round(width / 20));
    for (let x = 0; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const titleSize = Math.max(14, Math.round(width * 0.031));
    const bodySize = Math.max(11, Math.round(width * 0.019));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(242, 185, 89, 0.95)';
    ctx.font = `600 ${titleSize}px system-ui, sans-serif`;
    ctx.fillText('Snap Vanish: no clean background plate', width / 2, height / 2 - bodySize);
    ctx.fillStyle = 'rgba(238, 240, 246, 0.72)';
    ctx.font = `400 ${bodySize}px system-ui, sans-serif`;
    ctx.fillText(
      'Step out of frame and capture the empty room in the extension popup.',
      width / 2,
      height / 2 + titleSize * 0.9
    );

    this.placeholderCache.set(key, canvas);
    return canvas;
  }

  getBackground(width, height) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (this.plate) {
      ctx.drawImage(this.plate, 0, 0, width, height);
      return { canvas, hasPlate: true, placeholder: false };
    }
    ctx.drawImage(this.getPlaceholder(width, height), 0, 0);
    return { canvas, hasPlate: false, placeholder: true };
  }

  clear() {
    this.plate = null;
    this.plateWidth = 0;
    this.plateHeight = 0;
    this.plateSource = 'none';
    this.plateCapturedAt = 0;
    this.lowCoverageSince = 0;
    this.framesWithoutPerson = 0;
    this.previousSignature = null;
    this.error = null;
    this.version += 1;
  }

  getStatus() {
    return {
      hasPlate: Boolean(this.plate),
      width: this.plateWidth,
      height: this.plateHeight,
      source: this.plateSource,
      capturedAt: this.plateCapturedAt,
      error: this.error ? this.error.message : null
    };
  }
}
