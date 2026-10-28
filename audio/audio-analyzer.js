const WORKLET_URL = 'audio/snap-worklet.js';

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

export function thresholdsForSensitivity(sensitivity = 55) {
  const normalized = clamp01(Number(sensitivity) / 100);
  return {
    minPeak: round4(0.0575 - 0.05 * normalized),
    minHighRatio: round4(0.24 - 0.11 * normalized),
    minRms: round4(0.0145 - 0.012 * normalized),
    refractoryMs: Math.round(145 - 100 * normalized)
  };
}

export class TransientGate {
  constructor(options = {}) {
    this.noiseFloor = Number(options.noiseFloor) || 0.0025;
    this.sensitivity = Number.isFinite(Number(options.sensitivity)) ? Number(options.sensitivity) : 55;
    const thresholds = thresholdsForSensitivity(this.sensitivity);
    this.refractoryMs = Math.max(
      40,
      Number(options.refractoryMs) || thresholds.refractoryMs
    );
    this.minPeak = Number(options.minPeak) || thresholds.minPeak;
    this.minHighRatio = Number(options.minHighRatio) || thresholds.minHighRatio;
    this.minRms = Number(options.minRms) || thresholds.minRms;
    this.lastOnsetMs = -Infinity;
  }

  setSensitivity(sensitivity) {
    const value = Number(sensitivity);
    this.sensitivity = Number.isFinite(value) ? clamp01(value / 100) * 100 : 55;
    const thresholds = thresholdsForSensitivity(this.sensitivity);
    this.refractoryMs = thresholds.refractoryMs;
    this.minPeak = thresholds.minPeak;
    this.minHighRatio = thresholds.minHighRatio;
    this.minRms = thresholds.minRms;
  }

  process({ peak, rms, highRatio, timeMs }) {
    const threshold = Math.max(this.minPeak, this.noiseFloor * 5);
    const isTransient =
      peak > threshold &&
      highRatio > this.minHighRatio &&
      rms > this.minRms &&
      timeMs - this.lastOnsetMs > this.refractoryMs;

    if (isTransient) {
      this.lastOnsetMs = timeMs;
    }

    if (peak < threshold) {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
    } else {
      this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
    }
    this.noiseFloor = Math.min(0.08, Math.max(0.0002, this.noiseFloor));

    if (!isTransient) return null;
    return {
      timeMs,
      strength: clamp01((peak - threshold) / 0.35),
      peak,
      rms,
      highRatio
    };
  }
}

function bytesToFeatures(samples) {
  let peak = 0;
  let energy = 0;
  let derivativeEnergy = 0;
  let previous = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const absolute = Math.abs(sample);
    if (absolute > peak) peak = absolute;
    energy += sample * sample;
    const derivative = sample - previous;
    derivativeEnergy += derivative * derivative;
    previous = sample;
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  const highFrequency = Math.sqrt(derivativeEnergy / Math.max(1, samples.length - 1));
  return {
    peak,
    rms,
    highRatio: highFrequency / (rms + 0.000001)
  };
}

export class AudioAnalyzer {
  constructor(options = {}) {
    this.onTransient = typeof options.onTransient === 'function' ? options.onTransient : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    const initialSensitivity = Number.isFinite(Number(options.sensitivity))
      ? Number(options.sensitivity)
      : 55;
    this.sensitivity = Math.min(100, Math.max(0, initialSensitivity));
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.scriptNode = null;
    this.silentGain = null;
    this.gate = new TransientGate({ sensitivity: this.sensitivity });
    this.transients = [];
    this.running = false;
    this.mode = 'idle';
  }

  async start(stream) {
    if (this.running) return this.getStatus();
    this.stream = stream;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio API is not available');

    this.context = new AudioContextClass({ latencyHint: 'interactive' });
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        // Autoplay policy may require a user gesture; reported below.
      }
    }

    this.source = this.context.createMediaStreamSource(stream);
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;

    let workletLoaded = false;
    if (this.context.audioWorklet) {
      try {
        const url = chrome.runtime.getURL ? chrome.runtime.getURL(WORKLET_URL) : WORKLET_URL;
        await this.context.audioWorklet.addModule(url);
        this.worklet = new AudioWorkletNode(this.context, 'snap-transient-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1
        });
        this.worklet.port.onmessage = (event) => {
          const data = event.data || {};
          if (data.type === 'transient') {
            this.handleTransient({
              time: Date.now(),
              strength: data.strength,
              peak: data.peak,
              rms: data.rms,
              highRatio: data.highRatio,
              source: 'microphone'
            });
          }
        };
        this.source.connect(this.worklet);
        this.worklet.connect(this.silentGain);
        this.postWorkletConfig();
        workletLoaded = true;
        this.mode = 'worklet';
      } catch (error) {
        this.onError({ message: `AudioWorklet unavailable: ${error.message}` });
      }
    }

    if (!workletLoaded) {
      this.scriptNode = this.context.createScriptProcessor(512, 1, 1);
      this.scriptNode.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        const features = bytesToFeatures(samples);
        const result = this.gate.process({
          ...features,
          timeMs: Date.now()
        });
        if (result) {
          this.handleTransient({
            time: result.timeMs,
            strength: result.strength,
            peak: result.peak,
            rms: result.rms,
            highRatio: result.highRatio,
            source: 'microphone'
          });
        }
      };
      this.source.connect(this.scriptNode);
      this.scriptNode.connect(this.silentGain);
      this.mode = 'script-processor';
    }

    this.silentGain.connect(this.context.destination);
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        this.onStatus({ running: false, reason: 'track-ended' });
        this.running = false;
      });
    }

    this.running = true;
    const status = this.getStatus();
    this.onStatus(status);
    return status;
  }

  postWorkletConfig() {
    if (!this.worklet) return;
    const thresholds = thresholdsForSensitivity(this.sensitivity);
    try {
      this.worklet.port.postMessage({ type: 'config', sensitivity: this.sensitivity, ...thresholds });
    } catch {
      // The worklet may be shutting down.
    }
  }

  setSensitivity(sensitivity) {
    const value = Number(sensitivity);
    this.sensitivity = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 55;
    this.gate.setSensitivity(this.sensitivity);
    this.postWorkletConfig();
    return this.sensitivity;
  }

  handleTransient(transient) {
    this.transients.push(transient);
    const cutoff = transient.time - 5000;
    this.transients = this.transients.filter((item) => item.time >= cutoff);
    this.onTransient(transient);
  }

  async stop() {
    this.running = false;
    try {
      if (this.scriptNode) {
        this.scriptNode.onaudioprocess = null;
        this.scriptNode.disconnect();
      }
      if (this.worklet) {
        this.worklet.port.onmessage = null;
        this.worklet.disconnect();
      }
      if (this.source) this.source.disconnect();
      if (this.silentGain) this.silentGain.disconnect();
      if (this.context && this.context.state !== 'closed') await this.context.close();
    } catch {
      // Cleanup is best-effort.
    }
    this.context = null;
    this.source = null;
    this.worklet = null;
    this.scriptNode = null;
    this.silentGain = null;
    this.stream = null;
    this.mode = 'idle';
    const status = this.getStatus();
    this.onStatus(status);
    return status;
  }

  recentTransients(maxAgeMs = 1000) {
    const cutoff = Date.now() - maxAgeMs;
    return this.transients.filter((item) => item.time >= cutoff);
  }

  getStatus() {
    return {
      running: this.running,
      mode: this.mode,
      state: this.context ? this.context.state : 'closed',
      sensitivity: this.sensitivity,
      transients: this.transients.length
    };
  }
}
