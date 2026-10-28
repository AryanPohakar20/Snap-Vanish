class SnapTransientProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.noiseFloor = 0.0025;
    this.lastOnsetMs = -Infinity;
    this.previousSample = 0;
    this.refractoryMs = 90;
    this.minPeak = 0.03;
    this.minHighRatio = 0.18;
    this.minRms = 0.008;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type !== 'config') return;
      if (Number.isFinite(data.refractoryMs)) {
        this.refractoryMs = Math.max(40, data.refractoryMs);
      }
      if (Number.isFinite(data.minPeak)) this.minPeak = Math.max(0.001, data.minPeak);
      if (Number.isFinite(data.minHighRatio)) {
        this.minHighRatio = Math.max(0.02, data.minHighRatio);
      }
      if (Number.isFinite(data.minRms)) this.minRms = Math.max(0.0005, data.minRms);
    };
  }

  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    let peak = 0;
    let energy = 0;
    let derivativeEnergy = 0;
    let derivativeCount = 0;
    let previous = this.previousSample;

    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      const absolute = Math.abs(sample);
      if (absolute > peak) peak = absolute;
      energy += sample * sample;
      if (i > 0 || previous !== 0) {
        const derivative = sample - previous;
        derivativeEnergy += derivative * derivative;
        derivativeCount += 1;
      }
      previous = sample;
    }
    this.previousSample = previous;

    const rms = Math.sqrt(energy / channel.length);
    const highFrequency = Math.sqrt(derivativeEnergy / Math.max(1, derivativeCount));
    const highRatio = highFrequency / (rms + 0.000001);
    const timeMs = currentTime * 1000;
    const threshold = Math.max(this.minPeak, this.noiseFloor * 5);

    if (
      peak > threshold &&
      highRatio > this.minHighRatio &&
      rms > this.minRms &&
      timeMs - this.lastOnsetMs > this.refractoryMs
    ) {
      this.lastOnsetMs = timeMs;
      const strength = Math.min(1, Math.max(0, (peak - threshold) / 0.35));
      this.port.postMessage({
        type: 'transient',
        workletTimeMs: timeMs,
        strength,
        peak,
        rms,
        highRatio
      });
    }

    if (peak < threshold) {
      this.noiseFloor = this.noiseFloor * 0.995 + rms * 0.005;
    } else {
      this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
    }
    this.noiseFloor = Math.min(0.08, Math.max(0.0002, this.noiseFloor));

    return true;
  }
}

registerProcessor('snap-transient-processor', SnapTransientProcessor);
