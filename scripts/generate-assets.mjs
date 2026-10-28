import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

function over(dst, src, alpha) {
  const a = clamp01(alpha);
  if (a <= 0) return dst;
  return [
    dst[0] + (src[0] - dst[0]) * a,
    dst[1] + (src[1] - dst[1]) * a,
    dst[2] + (src[2] - dst[2]) * a
  ];
}

function roundedRectDistance(x, y, half, radius) {
  const qx = Math.abs(x) - (half - radius);
  const qy = Math.abs(y) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy || 0.000001;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSq);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function sampleIcon(x, y) {
  let color = [0, 0, 0];
  let alpha = 0;

  const body = roundedRectDistance(x - 0.5, y - 0.5, 0.5, 0.22);
  const bodyAlpha = clamp01(0.5 - body * 0.5) * 0.98;
  if (bodyAlpha > 0) {
    const vertical = 0.11 + 0.06 * y;
    color = mix([0x1b, 0x1f, 0x27], [0x10, 0x12, 0x17], clamp01(vertical));
    alpha = bodyAlpha;
  }

  const glow = Math.hypot(x - 0.5, y - 0.47);
  const glowRadius = 0.36;
  if (glow < glowRadius) {
    const glowAlpha = Math.pow(1 - glow / glowRadius, 2.2) * 0.32;
    color = over(color, [0xf2, 0xb9, 0x59], glowAlpha);
    alpha = Math.max(alpha, Math.min(1, alpha + glowAlpha * 0.6));
  }

  const radius = 0.255;
  if (glow < radius) {
    const t = clamp01(glow / radius);
    const shade = t < 0.55 ? mix([0xff, 0xe1, 0xa0], [0xf2, 0xb9, 0x59], t / 0.55) : mix([0xf2, 0xb9, 0x59], [0x8a, 0x5b, 0x16], (t - 0.55) / 0.45);
    const edge = clamp01((radius - glow) * 26);
    color = over(color, shade, edge);
    alpha = Math.max(alpha, Math.min(1, alpha + edge));
    const highlight = Math.hypot(x - 0.43, y - 0.39);
    if (highlight < 0.085) {
      color = over(color, [0xff, 0xf3, 0xd0], (1 - highlight / 0.085) * 0.55);
    }
  }

  const starX = 0.645;
  const starY = 0.435;
  const arm = 0.135;
  const width = 0.02;
  const starDist = Math.min(
    segmentDistance(x, y, starX - arm, starY, starX + arm, starY),
    segmentDistance(x, y, starX, starY - arm, starX, starY + arm),
    segmentDistance(x, y, starX - arm * 0.62, starY - arm * 0.62, starX + arm * 0.62, starY + arm * 0.62),
    segmentDistance(x, y, starX - arm * 0.62, starY + arm * 0.62, starX + arm * 0.62, starY - arm * 0.62)
  );
  if (starDist < width) {
    const starAlpha = clamp01((width - starDist) / width) * 0.95;
    color = over(color, [0xff, 0xfb, 0xef], starAlpha);
    alpha = Math.max(alpha, Math.min(1, alpha + starAlpha * 0.9));
  }

  for (let i = 0; i < 5; i += 1) {
    const px = 0.7 + i * 0.055;
    const py = 0.6 + (i % 2 === 0 ? 0 : 0.035);
    const dot = Math.hypot(x - px, y - py);
    const dotRadius = 0.023 - i * 0.002;
    if (dot < dotRadius) {
      const dotAlpha = clamp01((dotRadius - dot) / dotRadius) * (0.85 - i * 0.1);
      color = over(color, [0xff, 0xdc, 0x9b], dotAlpha);
      alpha = Math.max(alpha, Math.min(1, alpha + dotAlpha));
    }
  }

  return [color[0], color[1], color[2], alpha * 255];
}

function renderIcon(size) {
  const scale = 4;
  const hi = size * scale;
  const samples = new Float32Array(hi * hi * 4);
  for (let y = 0; y < hi; y += 1) {
    for (let x = 0; x < hi; x += 1) {
      const [r, g, b, a] = sampleIcon((x + 0.5) / hi, (y + 0.5) / hi);
      const offset = (y * hi + x) * 4;
      samples[offset] = r * (a / 255);
      samples[offset + 1] = g * (a / 255);
      samples[offset + 2] = b * (a / 255);
      samples[offset + 3] = a / 255;
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  const total = scale * scale;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const offset = ((y * scale + sy) * hi + (x * scale + sx)) * 4;
          r += samples[offset];
          g += samples[offset + 1];
          b += samples[offset + 2];
          a += samples[offset + 3];
        }
      }
      const out = (y * size + x) * 4;
      if (a > 0) {
        rgba[out] = Math.round(clamp01(r / a) * 255);
        rgba[out + 1] = Math.round(clamp01(g / a) * 255);
        rgba[out + 2] = Math.round(clamp01(b / a) * 255);
      }
      rgba[out + 3] = Math.round(clamp01(a / total) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

function makeSnapWav() {
  const sampleRate = 44100;
  const duration = 0.18;
  const sampleCount = Math.floor(sampleRate * duration);
  const samples = new Int16Array(sampleCount);

  let noiseState = 0x12345678;
  const noise = () => {
    noiseState ^= noiseState << 13;
    noiseState ^= noiseState >>> 17;
    noiseState ^= noiseState << 5;
    return ((noiseState >>> 0) / 4294967296) * 2 - 1;
  };

  const filtered = { value: 0 };
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const click = Math.exp(-t * 420) * (Math.sin(2 * Math.PI * 3100 * t) * 0.48 + Math.sin(2 * Math.PI * 5200 * t) * 0.2);
    const rawNoise = noise();
    filtered.value += (rawNoise - filtered.value) * 0.62;
    const burst = filtered.value * Math.exp(-t * 190) * 0.7;
    const tail = Math.sin(2 * Math.PI * 1180 * t) * Math.exp(-t * 34) * 0.08;
    const fade = t > duration - 0.03 ? (duration - t) / 0.03 : 1;
    const value = clamp01((click + burst + tail + 0.5) * 0.5) * fade;
    const signed = value * 2 - 1;
    samples[i] = Math.round(Math.max(-1, Math.min(1, signed * 0.72)) * 32767);
  }

  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

export function generateAssets(root = ROOT, log = console.log) {
  const iconDir = path.join(root, 'assets', 'icons');
  const soundDir = path.join(root, 'assets', 'sounds');
  mkdirSync(iconDir, { recursive: true });
  mkdirSync(soundDir, { recursive: true });

  for (const size of [16, 32, 48, 128]) {
    const file = path.join(iconDir, `icon${size}.png`);
    writeFileSync(file, renderIcon(size));
    log(`icons: ${path.relative(root, file)}`);
  }

  const soundFile = path.join(soundDir, 'snap.wav');
  writeFileSync(soundFile, makeSnapWav());
  log(`sound: ${path.relative(root, soundFile)}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  generateAssets();
}
