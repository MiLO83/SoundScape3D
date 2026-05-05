// Audio Demodulator - Extracts audio from AM/FM carrier frequencies
// Useful for detecting hidden ultrasonic audio channels

/**
 * Demodulates AM and FM carriers to extract baseband audio
 */
export class Demodulator {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;

    // Demodulation parameters
    this.carrierFreq = 0;
    this.bandwidth = 4000;  // Hz - typical speech bandwidth

    // AM demodulation state
    this.amEnvelope = 0;
    this.amAlpha = 0.1;  // Envelope follower smoothing

    // FM demodulation state
    this.fmLastPhase = 0;
    this.fmLastSample = 0;

    // Lowpass filter for demodulated audio
    this.lpfCutoff = 4000;
    this.lpfState = 0;

    // DC blocking filter
    this.dcBlockState = 0;
    this.dcBlockAlpha = 0.995;

    // Output buffer
    this.outputBuffer = null;
  }

  /**
   * Set carrier frequency to demodulate
   * @param {number} freq - Carrier frequency in Hz
   */
  setCarrierFrequency(freq) {
    this.carrierFreq = freq;
  }

  /**
   * Set bandwidth for demodulation
   * @param {number} bw - Bandwidth in Hz
   */
  setBandwidth(bw) {
    this.bandwidth = bw;
    this.lpfCutoff = bw;
  }

  /**
   * Demodulate AM carrier
   * @param {Float32Array} samples - Input samples
   * @param {number} carrierFreq - Carrier frequency
   * @returns {Float32Array} Demodulated audio
   */
  demodulateAM(samples, carrierFreq) {
    const output = new Float32Array(samples.length);
    const omega = 2 * Math.PI * carrierFreq / this.sampleRate;

    for (let i = 0; i < samples.length; i++) {
      // Mix down to baseband (multiply by carrier)
      const t = i;
      const mixedI = samples[i] * Math.cos(omega * t);
      const mixedQ = samples[i] * Math.sin(omega * t);

      // Envelope detection (magnitude)
      const envelope = Math.sqrt(mixedI * mixedI + mixedQ * mixedQ);

      // Smooth envelope
      this.amEnvelope = this.amAlpha * envelope + (1 - this.amAlpha) * this.amEnvelope;

      // DC block
      const dcBlocked = this.dcBlock(this.amEnvelope);

      // Lowpass filter
      output[i] = this.lowpass(dcBlocked);
    }

    return output;
  }

  /**
   * Demodulate FM carrier
   * @param {Float32Array} samples - Input samples
   * @param {number} carrierFreq - Carrier frequency
   * @returns {Float32Array} Demodulated audio
   */
  demodulateFM(samples, carrierFreq) {
    const output = new Float32Array(samples.length);
    const omega = 2 * Math.PI * carrierFreq / this.sampleRate;

    for (let i = 0; i < samples.length; i++) {
      // Mix down to baseband
      const t = i;
      const mixedI = samples[i] * Math.cos(omega * t);
      const mixedQ = samples[i] * Math.sin(omega * t);

      // Calculate instantaneous phase
      const phase = Math.atan2(mixedQ, mixedI);

      // Differentiate phase to get frequency deviation
      let phaseDiff = phase - this.fmLastPhase;

      // Unwrap phase
      while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
      while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;

      this.fmLastPhase = phase;

      // Scale and filter
      const demod = phaseDiff * this.sampleRate / (2 * Math.PI);
      output[i] = this.lowpass(demod / 1000);  // Normalize
    }

    return output;
  }

  /**
   * Auto-detect modulation type and demodulate
   * @param {Float32Array} samples - Input samples
   * @param {Object} carrierInfo - Carrier info from CarrierDetector
   * @returns {Object} { audio: Float32Array, type: string }
   */
  demodulate(samples, carrierInfo) {
    if (!carrierInfo || !carrierInfo.frequency) {
      return { audio: new Float32Array(samples.length), type: 'none' };
    }

    const freq = carrierInfo.frequency;
    const modType = carrierInfo.modulationType || 'AM';

    let audio;
    if (modType === 'FM') {
      audio = this.demodulateFM(samples, freq);
    } else {
      // Default to AM for unknown or AM
      audio = this.demodulateAM(samples, freq);
    }

    // Normalize output
    const maxAmp = Math.max(...audio.map(Math.abs));
    if (maxAmp > 0.01) {
      for (let i = 0; i < audio.length; i++) {
        audio[i] /= maxAmp;
      }
    }

    return { audio, type: modType };
  }

  /**
   * Bandpass filter around carrier frequency
   * @param {Float32Array} samples - Input samples
   * @param {number} centerFreq - Center frequency
   * @param {number} bandwidth - Filter bandwidth
   * @returns {Float32Array} Filtered samples
   */
  bandpass(samples, centerFreq, bandwidth) {
    const output = new Float32Array(samples.length);
    const omega = 2 * Math.PI * centerFreq / this.sampleRate;
    const bw = bandwidth / this.sampleRate;

    // Simple IIR bandpass (biquad approximation)
    const Q = centerFreq / bandwidth;
    const alpha = Math.sin(omega) / (2 * Q);

    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(omega);
    const a2 = 1 - alpha;

    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;

      output[i] = y0;

      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }

    return output;
  }

  // Simple lowpass filter
  lowpass(sample) {
    const alpha = this.lpfCutoff / (this.lpfCutoff + this.sampleRate / (2 * Math.PI));
    this.lpfState = alpha * sample + (1 - alpha) * this.lpfState;
    return this.lpfState;
  }

  // DC blocking filter
  dcBlock(sample) {
    const output = sample - this.dcBlockState + this.dcBlockAlpha * (this.dcBlockState || 0);
    this.dcBlockState = sample;
    return output;
  }

  /**
   * Reset demodulator state
   */
  reset() {
    this.amEnvelope = 0;
    this.fmLastPhase = 0;
    this.fmLastSample = 0;
    this.lpfState = 0;
    this.dcBlockState = 0;
  }
}
