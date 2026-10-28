function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function directionVector(direction, random = Math.random) {
  switch (direction) {
    case 'left':
      return [-1, -0.08];
    case 'up':
      return [0.06, -1];
    case 'right':
      return [1, -0.08];
    case 'random':
    default: {
      const angle = -Math.PI * 0.5 + (random() - 0.5) * Math.PI * 1.15;
      return [Math.cos(angle), Math.sin(angle)];
    }
  }
}

export function dissolveToParticleLocal(dissolve, delay = 0) {
  const stagger = delay * 0.38;
  const local = Math.min(1, Math.max(0, (dissolve - stagger) / Math.max(0.05, 1 - stagger)));
  return local * local * (3 - 2 * local);
}

export const PARTICLE_FLOATS = 10;

export class ParticleSystem {
  constructor(options = {}) {
    this.seed = options.seed ?? 1234567;
    this.random = mulberry32(this.seed);
    this.count = 0;
    this.data = null;
    this.silhouettePixels = 0;
    this.lastDirection = null;
    this.lastGeneratedAt = 0;
  }

  generate(sourceData, mask, width, height, options = {}) {
    const target = Math.max(64, Math.min(20000, options.maxParticles || 7000));
    const maskThreshold = options.maskThreshold ?? 110;
    const direction = options.direction || 'right';
    const seed = options.seed ?? Date.now();
    this.seed = seed;
    this.random = mulberry32(seed);
    this.lastGeneratedAt = Date.now();
    this.lastDirection = direction;

    const pixels = sourceData.data;
    const candidates = [];
    let silhouettePixels = 0;

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = row + x;
        if (mask[index] >= maskThreshold) {
          silhouettePixels += 1;
          candidates.push(index);
        }
      }
    }

    this.silhouettePixels = silhouettePixels;
    if (silhouettePixels === 0) {
      this.count = 0;
      this.data = null;
      return { count: 0, coverage: 0, silhouettePixels: 0 };
    }

    const count = Math.min(target, silhouettePixels);
    const stride = silhouettePixels / count;
    const data = new Float32Array(count * PARTICLE_FLOATS);
    const baseDirection = directionVector(direction, this.random);
    const baseAngle = Math.atan2(baseDirection[1], baseDirection[0]);
    const aspectScale = width / Math.max(1, height);

    for (let i = 0; i < count; i += 1) {
      const candidateIndex = candidates[Math.min(silhouettePixels - 1, Math.floor(i * stride))];
      const x = candidateIndex % width;
      const y = Math.floor(candidateIndex / width);
      const pixelOffset = candidateIndex * 4;
      const jitterX = (this.random() - 0.5) * 1.4;
      const jitterY = (this.random() - 0.5) * 1.4;
      const angleJitter = (this.random() - 0.5) * 0.62;
      const angle = baseAngle + angleJitter;
      const speed = 0.55 + this.random() * 0.95;
      const delay = this.random() * 0.92;
      const sizeBase = 1.15 + this.random() * 2.7 + (this.random() > 0.9 ? 1.9 : 0);
      const red = pixels[pixelOffset] / 255;
      const green = pixels[pixelOffset + 1] / 255;
      const blue = pixels[pixelOffset + 2] / 255;
      const brightness = 0.86 + this.random() * 0.3;

      const out = i * PARTICLE_FLOATS;
      data[out] = (x + jitterX) / width;
      data[out + 1] = (y + jitterY) / height;
      data[out + 2] = Math.min(1, red * brightness + 0.06);
      data[out + 3] = Math.min(1, green * brightness + 0.035);
      data[out + 4] = Math.min(1, blue * brightness + 0.01);
      data[out + 5] = this.random();
      data[out + 6] = sizeBase;
      data[out + 7] = delay;
      data[out + 8] = Math.cos(angle) * speed;
      data[out + 9] = Math.sin(angle) * speed * aspectScale * 0.65;
    }

    this.count = count;
    this.data = data;
    return {
      count,
      coverage: silhouettePixels / (width * height),
      silhouettePixels,
      direction,
      data
    };
  }

  clear() {
    this.count = 0;
    this.data = null;
    this.silhouettePixels = 0;
  }

  getBufferData() {
    return this.data;
  }

  getDebug() {
    return {
      count: this.count,
      silhouettePixels: this.silhouettePixels,
      direction: this.lastDirection,
      generatedAt: this.lastGeneratedAt
    };
  }
}
