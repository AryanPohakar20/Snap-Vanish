import {
  COMPOSITE_FRAGMENT_SHADER,
  PARTICLE_FRAGMENT_SHADER,
  PARTICLE_VERTEX_SHADER,
  QUAD_VERTEX_SHADER
} from './shaders.js';
import { dissolveToParticleLocal, PARTICLE_FLOATS } from './particle-system.js';

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${log}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program linking failed: ${log}`);
  }
  return program;
}

function stableNoise(x, y, seed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 13.7) * 43758.5453;
  return value - Math.floor(value);
}

function createTexture(gl) {  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255])
  );
  return texture;
}

export class DustRenderer {
  constructor(options = {}) {
    this.width = options.width || 640;
    this.height = options.height || 360;
    this.canvas = createCanvas(this.width, this.height);
    this.gl = null;
    this.useFallback = false;
    this.particleCount = 0;
    this.particleData = null;
    this.disposed = false;
    this.maskCache = null;
    this.lastMaskVersion = -1;
    this.lastError = null;
    this.initError = null;
    try {
      this.initWebGL();
    } catch (error) {
      this.lastError = error;
      this.initError = error;
      this.useFallback = true;
      this.canvas.getContext('2d');
    }
  }

  initWebGL() {
    const gl =
      this.canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance'
      }) || null;
    if (!gl) throw new Error('WebGL is unavailable');
    this.gl = gl;

    this.compositeProgram = createProgram(
      gl,
      QUAD_VERTEX_SHADER,
      COMPOSITE_FRAGMENT_SHADER
    );
    this.particleProgram = createProgram(
      gl,
      PARTICLE_VERTEX_SHADER,
      PARTICLE_FRAGMENT_SHADER
    );

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    this.quadPositionLocation = gl.getAttribLocation(this.compositeProgram, 'a_position');

    this.compositeUniforms = {
      source: gl.getUniformLocation(this.compositeProgram, 'u_source'),
      background: gl.getUniformLocation(this.compositeProgram, 'u_background'),
      mask: gl.getUniformLocation(this.compositeProgram, 'u_mask'),
      dissolve: gl.getUniformLocation(this.compositeProgram, 'u_dissolve'),
      seed: gl.getUniformLocation(this.compositeProgram, 'u_seed'),
      glowColor: gl.getUniformLocation(this.compositeProgram, 'u_glowColor'),
      glowStrength: gl.getUniformLocation(this.compositeProgram, 'u_glowStrength')
    };

    this.particleUniforms = {
      dissolve: gl.getUniformLocation(this.particleProgram, 'u_dissolve'),
      pixelScale: gl.getUniformLocation(this.particleProgram, 'u_pixelScale'),
      glowColor: gl.getUniformLocation(this.particleProgram, 'u_glowColor')
    };

    this.particleAttributes = {
      position: gl.getAttribLocation(this.particleProgram, 'a_position'),
      color: gl.getAttribLocation(this.particleProgram, 'a_color'),
      seed: gl.getAttribLocation(this.particleProgram, 'a_seed'),
      size: gl.getAttribLocation(this.particleProgram, 'a_size'),
      delay: gl.getAttribLocation(this.particleProgram, 'a_delay'),
      direction: gl.getAttribLocation(this.particleProgram, 'a_direction')
    };

    this.sourceTexture = createTexture(gl);
    this.backgroundTexture = createTexture(gl);
    this.maskTexture = createTexture(gl);
    this.particleBuffer = gl.createBuffer();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  resize(width, height) {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.maskCache = null;
    if (this.gl) {
      this.gl.viewport(0, 0, w, h);
    }
  }

  setParticleData(particleData, count) {
    this.particleData = particleData;
    this.particleCount = count || 0;
    if (!this.gl || !particleData || !this.particleCount) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, particleData, gl.DYNAMIC_DRAW);
  }

  uploadCanvas(texture, canvas) {
    const gl = this.gl;
    if (!canvas) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }

  uploadMask(mask, maskWidth, maskHeight) {
    const gl = this.gl;
    if (!mask || !maskWidth || !maskHeight) return;
    if (
      !this.maskCache ||
      this.maskCache.width !== maskWidth ||
      this.maskCache.height !== maskHeight
    ) {
      this.maskCache = {
        width: maskWidth,
        height: maskHeight,
        data: new Uint8Array(maskWidth * maskHeight * 4)
      };
    }
    const data = this.maskCache.data;
    for (let i = 0; i < mask.length; i += 1) {
      const value = mask[i];
      const offset = i * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      maskWidth,
      maskHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data
    );
  }

  render(options) {
    if (this.disposed) return;
    const {
      source,
      background,
      mask,
      maskWidth,
      maskHeight,
      maskVersion,
      dissolve,
      showParticles,
      glowColor,
      seed
    } = options;

    if (!this.gl) {
      this.renderFallback(options);
      return;
    }

    const gl = this.gl;
    this.resize(source.width || source.videoWidth || this.width, source.height || source.videoHeight || this.height);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.04, 0.045, 0.055, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.uploadCanvas(this.sourceTexture, source);
    this.uploadCanvas(this.backgroundTexture, background);
    if (maskVersion === undefined || maskVersion !== this.lastMaskVersion) {
      this.uploadMask(mask, maskWidth, maskHeight);
      this.lastMaskVersion = maskVersion === undefined ? -1 : maskVersion;
    }

    gl.disable(gl.BLEND);
    gl.useProgram(this.compositeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.quadPositionLocation);
    gl.vertexAttribPointer(this.quadPositionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(this.compositeUniforms.source, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    gl.uniform1i(this.compositeUniforms.background, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(this.compositeUniforms.mask, 2);

    gl.uniform1f(this.compositeUniforms.dissolve, dissolve);
    gl.uniform1f(this.compositeUniforms.seed, (seed || 1) % 997);
    gl.uniform3f(this.compositeUniforms.glowColor, 1.0, 0.72, 0.28);
    gl.uniform1f(this.compositeUniforms.glowStrength, 0.85);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (showParticles && this.particleCount && this.particleData && dissolve > 0.001 && dissolve < 0.999) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.useProgram(this.particleProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
      const stride = PARTICLE_FLOATS * 4;
      const attributes = this.particleAttributes;
      gl.enableVertexAttribArray(attributes.position);
      gl.vertexAttribPointer(attributes.position, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(attributes.color);
      gl.vertexAttribPointer(attributes.color, 3, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(attributes.seed);
      gl.vertexAttribPointer(attributes.seed, 1, gl.FLOAT, false, stride, 20);
      gl.enableVertexAttribArray(attributes.size);
      gl.vertexAttribPointer(attributes.size, 1, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(attributes.delay);
      gl.vertexAttribPointer(attributes.delay, 1, gl.FLOAT, false, stride, 28);
      gl.enableVertexAttribArray(attributes.direction);
      gl.vertexAttribPointer(attributes.direction, 2, gl.FLOAT, false, stride, 32);

      gl.uniform1f(this.particleUniforms.dissolve, dissolve);
      gl.uniform1f(this.particleUniforms.pixelScale, this.width / 640);
      gl.uniform3f(this.particleUniforms.glowColor, 1.0, 0.72, 0.28);
      gl.drawArrays(gl.POINTS, 0, this.particleCount);
      gl.disable(gl.BLEND);
    }
  }

  renderFallback(options) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { source, background, dissolve, showParticles, mask, maskWidth, maskHeight, seed } = options;
    this.resize(source.width || this.width, source.height || this.height);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(background, 0, 0, this.width, this.height);

    if (dissolve < 0.999) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - dissolve * 1.08);
      ctx.drawImage(source, 0, 0, this.width, this.height);
      ctx.restore();
    }

    if (showParticles && this.particleData && this.particleCount && dissolve > 0.001 && dissolve < 0.999) {
      const data = this.particleData;
      const scaleX = this.width;
      const scaleY = this.height;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const sampleStep = Math.max(1, Math.floor(this.particleCount / 1200));
      for (let i = 0; i < this.particleCount; i += sampleStep) {
        const offset = i * PARTICLE_FLOATS;
        const local = dissolveToParticleLocal(dissolve, data[offset + 7]);
        if (local <= 0.02 || local >= 0.98) continue;
        const x = (data[offset] + data[offset + 8] * 0.24 * local) * scaleX;
        const y = (data[offset + 1] + data[offset + 9] * 0.24 * local) * scaleY;
        const alpha = Math.sin(local * Math.PI) * 0.8;
        ctx.fillStyle = `rgba(255, 205, 120, ${alpha})`;
        const size = 1 + data[offset + 6] * 0.7;
        ctx.fillRect(x, y, size, size);
      }
      ctx.restore();
    }

    if (mask && dissolve > 0.01 && dissolve < 0.99 && maskWidth && maskHeight) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#ffcf78';
      const stepX = Math.max(1, Math.floor(maskWidth / 80));
      const stepY = Math.max(1, Math.floor(maskHeight / 50));
      const threshold = Math.sin(dissolve * Math.PI) * 0.5;
      const noiseSeed = seed || 1;
      for (let y = 0; y < maskHeight; y += stepY) {
        for (let x = 0; x < maskWidth; x += stepX) {
          const value = mask[y * maskWidth + x];
          if (value > 200 && stableNoise(x, y, noiseSeed) < threshold) {
            ctx.fillRect((x / maskWidth) * this.width, (y / maskHeight) * this.height, 2, 2);
          }
        }
      }
      ctx.restore();
    }
  }

  getDebug() {
    return {
      width: this.width,
      height: this.height,
      webgl: Boolean(this.gl),
      fallback: this.useFallback,
      particleCount: this.particleCount,
      error: this.lastError ? this.lastError.message : null
    };
  }

  dispose() {
    this.disposed = true;
    const gl = this.gl;
    if (!gl) return;
    try {
      gl.deleteTexture(this.sourceTexture);
      gl.deleteTexture(this.backgroundTexture);
      gl.deleteTexture(this.maskTexture);
      gl.deleteBuffer(this.quadBuffer);
      gl.deleteBuffer(this.particleBuffer);
      gl.deleteProgram(this.compositeProgram);
      gl.deleteProgram(this.particleProgram);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch {
      // Best-effort GPU cleanup.
    }
    this.gl = null;
  }
}
