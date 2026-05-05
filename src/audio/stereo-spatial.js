// Stereo Spatial Analyzer
// Extracts spatial information from hardware-combined stereo mic input
// Uses ITD (Interaural Time Difference) and ILD (Interaural Level Difference)
// Works even when individual mic channels aren't accessible

const SPEED_OF_SOUND = 343;  // m/s

/**
 * Estimates sound source direction from stereo audio
 * Even with hardware mixing, L/R channels retain timing differences
 */
export class StereoSpatialAnalyzer {
  /**
   * @param {number} sampleRate - Audio sample rate (default 48000)
   * @param {number} fftSize - FFT size for frequency analysis (default 2048)
   */
  constructor(sampleRate = 48000, fftSize = 2048) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;

    // Approximate Quest stereo mic separation (left to right)
    // Quest 2: ~0.14m, Quest 3: ~0.16m
    this.micSeparation = 0.15;  // meters

    // Maximum possible ITD based on mic separation
    // ITD = separation / speed_of_sound (for 90° azimuth)
    this.maxITD = this.micSeparation / SPEED_OF_SOUND;  // ~0.44ms
    this.maxDelaySamples = Math.ceil(this.maxITD * sampleRate);  // ~21 samples at 48kHz

    // GCC-PHAT buffers for ITD estimation
    this.realL = new Float32Array(fftSize);
    this.imagL = new Float32Array(fftSize);
    this.realR = new Float32Array(fftSize);
    this.imagR = new Float32Array(fftSize);
    this.crossCorr = new Float32Array(fftSize);

    // Hanning window
    this.window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }

    // Transient detection for repetition analysis
    this.transientHistory = [];
    this.maxTransientHistory = 50;

    // Smoothing for stable direction estimate
    this.azimuthHistory = [];
    this.historySize = 10;

    // Frequency band analysis (different frequencies give different spatial cues)
    this.bandRanges = [
      { name: 'low', min: 100, max: 500 },      // Low freq: mainly ITD
      { name: 'mid', min: 500, max: 2000 },     // Mid freq: ITD + ILD
      { name: 'high', min: 2000, max: 8000 }    // High freq: mainly ILD
    ];
  }

  /**
   * Analyze stereo audio to estimate source direction
   * @param {Float32Array} leftChannel - Left channel samples
   * @param {Float32Array} rightChannel - Right channel samples
   * @returns {Object} { azimuth, confidence, itd, ild, transients }
   */
  analyze(leftChannel, rightChannel) {
    if (!leftChannel || !rightChannel || leftChannel.length === 0) {
      return { azimuth: 0, confidence: 0, itd: 0, ild: 0, transients: [] };
    }

    // 1. Calculate ITD using GCC-PHAT cross-correlation
    const itdResult = this.calculateITD(leftChannel, rightChannel);

    // 2. Calculate ILD (Interaural Level Difference)
    const ild = this.calculateILD(leftChannel, rightChannel);

    // 3. Detect transients and their channel timing
    const transients = this.detectTransients(leftChannel, rightChannel);

    // 4. Frequency-band analysis for robust direction estimate
    const bandAnalysis = this.analyzeBands(leftChannel, rightChannel);

    // 5. Combine ITD and ILD for azimuth estimate
    // ITD gives angle via: sin(θ) = ITD * c / d
    const sinAzimuth = Math.min(1, Math.max(-1,
      (itdResult.delay / this.sampleRate) * SPEED_OF_SOUND / this.micSeparation
    ));
    let azimuthFromITD = Math.asin(sinAzimuth);

    // ILD gives rough direction (positive = louder on right = source on right)
    // ILD in dB, typical max is ~10dB at 90°
    const azimuthFromILD = Math.atan(ild / 6) * 0.5;  // Scale to reasonable range

    // Weight ITD more for low frequencies, ILD more for high
    const itdWeight = 0.7;
    const ildWeight = 0.3;
    let combinedAzimuth = azimuthFromITD * itdWeight + azimuthFromILD * ildWeight;

    // Apply smoothing
    this.azimuthHistory.push(combinedAzimuth);
    if (this.azimuthHistory.length > this.historySize) {
      this.azimuthHistory.shift();
    }
    const smoothedAzimuth = this.azimuthHistory.reduce((a, b) => a + b, 0) / this.azimuthHistory.length;

    // Confidence based on correlation strength and signal level
    const signalLevel = this.calculateRMS(leftChannel) + this.calculateRMS(rightChannel);
    const confidence = Math.min(1, itdResult.confidence * 0.7 + Math.min(signalLevel * 10, 0.3));

    return {
      azimuth: smoothedAzimuth,              // Radians, -π/2 to π/2, 0 = front
      azimuthDegrees: smoothedAzimuth * 180 / Math.PI,
      confidence: confidence,
      itd: itdResult.delay / this.sampleRate * 1000,  // ITD in milliseconds
      itdSamples: itdResult.delay,
      ild: ild,                               // ILD in dB
      transients: transients,
      bandAnalysis: bandAnalysis
    };
  }

  /**
   * Calculate ITD using GCC-PHAT (Generalized Cross-Correlation with Phase Transform)
   */
  calculateITD(left, right) {
    const N = this.fftSize;

    // Window and copy to FFT buffers
    for (let i = 0; i < N; i++) {
      const idx = i < left.length ? i : 0;
      this.realL[i] = (left[idx] || 0) * this.window[i];
      this.imagL[i] = 0;
      this.realR[i] = (right[idx] || 0) * this.window[i];
      this.imagR[i] = 0;
    }

    // FFT both channels
    this.fft(this.realL, this.imagL);
    this.fft(this.realR, this.imagR);

    // Cross-power spectrum with PHAT weighting
    for (let i = 0; i < N; i++) {
      // G_LR = L * conj(R)
      const realCross = this.realL[i] * this.realR[i] + this.imagL[i] * this.imagR[i];
      const imagCross = this.imagL[i] * this.realR[i] - this.realL[i] * this.imagR[i];

      // PHAT weighting: normalize by magnitude
      const mag = Math.sqrt(realCross * realCross + imagCross * imagCross) + 1e-10;
      this.realL[i] = realCross / mag;
      this.imagL[i] = imagCross / mag;
    }

    // Inverse FFT to get cross-correlation
    this.ifft(this.realL, this.imagL);

    // Find peak in valid delay range
    let maxVal = -Infinity;
    let maxIdx = 0;

    // Search only within physical limits (±maxDelaySamples)
    for (let i = 0; i <= this.maxDelaySamples; i++) {
      if (this.realL[i] > maxVal) {
        maxVal = this.realL[i];
        maxIdx = i;
      }
    }
    for (let i = N - this.maxDelaySamples; i < N; i++) {
      if (this.realL[i] > maxVal) {
        maxVal = this.realL[i];
        maxIdx = i - N;  // Negative delay
      }
    }

    // Sub-sample interpolation for better precision
    const delay = this.parabolicInterpolation(this.realL, maxIdx, N);

    // Confidence based on peak sharpness
    const avgCorr = this.realL.reduce((a, b) => a + Math.abs(b), 0) / N;
    const confidence = Math.min(1, maxVal / (avgCorr * 5 + 0.01));

    return { delay, confidence, peak: maxVal };
  }

  /**
   * Calculate ILD (Interaural Level Difference) in dB
   */
  calculateILD(left, right) {
    const rmsL = this.calculateRMS(left);
    const rmsR = this.calculateRMS(right);

    if (rmsL < 1e-10 && rmsR < 1e-10) return 0;

    // ILD in dB: positive = right is louder
    return 20 * Math.log10((rmsR + 1e-10) / (rmsL + 1e-10));
  }

  /**
   * Detect transients (sharp attacks) in both channels
   * Useful for finding timing of impulsive sounds
   */
  detectTransients(left, right) {
    const transients = [];
    const threshold = 0.1;
    const minGap = 50;  // Minimum samples between transients

    let lastTransient = -minGap;

    for (let i = 1; i < left.length - 1; i++) {
      // Simple transient detection: sudden increase in amplitude
      const diffL = Math.abs(left[i]) - Math.abs(left[i-1]);
      const diffR = Math.abs(right[i]) - Math.abs(right[i-1]);

      if ((diffL > threshold || diffR > threshold) && i - lastTransient > minGap) {
        // Find precise timing in each channel using local peak
        const peakL = this.findLocalPeak(left, i, 10);
        const peakR = this.findLocalPeak(right, i, 10);

        const timingDiff = peakR - peakL;  // Positive = arrives at right first

        transients.push({
          sampleIndex: i,
          timingDiffSamples: timingDiff,
          timingDiffMs: timingDiff / this.sampleRate * 1000,
          amplitudeL: Math.abs(left[peakL]),
          amplitudeR: Math.abs(right[peakR])
        });

        lastTransient = i;
      }
    }

    // Store for repetition analysis
    this.transientHistory.push(...transients);
    while (this.transientHistory.length > this.maxTransientHistory) {
      this.transientHistory.shift();
    }

    return transients;
  }

  /**
   * Analyze different frequency bands for more robust spatial estimation
   * Low frequencies: ITD is reliable
   * High frequencies: ILD is reliable
   */
  analyzeBands(left, right) {
    const results = [];

    for (const band of this.bandRanges) {
      // Bandpass filter (simple moving average approximation)
      const filteredL = this.bandpassFilter(left, band.min, band.max);
      const filteredR = this.bandpassFilter(right, band.min, band.max);

      const itd = this.calculateITD(filteredL, filteredR);
      const ild = this.calculateILD(filteredL, filteredR);

      results.push({
        band: band.name,
        freqRange: `${band.min}-${band.max}Hz`,
        itdMs: itd.delay / this.sampleRate * 1000,
        ild: ild,
        confidence: itd.confidence
      });
    }

    return results;
  }

  /**
   * Find repeated sound patterns between channels
   * If the same sound appears in both channels at different times,
   * we can extract the time difference
   */
  findRepetitionOffsets(left, right, windowSize = 512) {
    const offsets = [];
    const searchRange = this.maxDelaySamples * 2;

    // Slide through the audio looking for matching patterns
    for (let i = 0; i < left.length - windowSize; i += windowSize / 2) {
      // Extract window from left channel
      const windowL = left.slice(i, i + windowSize);
      const energyL = this.calculateRMS(windowL);

      if (energyL < 0.01) continue;  // Skip quiet sections

      // Search for best match in right channel with offset
      let bestCorr = 0;
      let bestOffset = 0;

      for (let offset = -searchRange; offset <= searchRange; offset++) {
        const j = i + offset;
        if (j < 0 || j + windowSize > right.length) continue;

        const windowR = right.slice(j, j + windowSize);
        const corr = this.normalizedCorrelation(windowL, windowR);

        if (corr > bestCorr) {
          bestCorr = corr;
          bestOffset = offset;
        }
      }

      if (bestCorr > 0.7) {  // High correlation threshold
        offsets.push({
          position: i,
          offsetSamples: bestOffset,
          offsetMs: bestOffset / this.sampleRate * 1000,
          correlation: bestCorr
        });
      }
    }

    return offsets;
  }

  // === Helper functions ===

  calculateRMS(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  findLocalPeak(samples, center, range) {
    let maxVal = Math.abs(samples[center]);
    let maxIdx = center;

    for (let i = Math.max(0, center - range); i < Math.min(samples.length, center + range); i++) {
      if (Math.abs(samples[i]) > maxVal) {
        maxVal = Math.abs(samples[i]);
        maxIdx = i;
      }
    }

    return maxIdx;
  }

  parabolicInterpolation(data, peakIdx, N) {
    // Handle wrap-around for negative delays
    const getPt = (i) => {
      if (i < 0) i += N;
      if (i >= N) i -= N;
      return data[i];
    };

    const y0 = getPt(peakIdx - 1);
    const y1 = getPt(peakIdx);
    const y2 = getPt(peakIdx + 1);

    const denom = 2 * (2 * y1 - y0 - y2);
    if (Math.abs(denom) < 1e-10) return peakIdx;

    const offset = (y0 - y2) / denom;
    let result = peakIdx + offset;

    // Convert large positive indices to negative delays
    if (result > N / 2) result -= N;

    return result;
  }

  normalizedCorrelation(a, b) {
    if (a.length !== b.length) return 0;

    let sum = 0, sumA2 = 0, sumB2 = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
      sumA2 += a[i] * a[i];
      sumB2 += b[i] * b[i];
    }

    const denom = Math.sqrt(sumA2 * sumB2);
    return denom > 1e-10 ? sum / denom : 0;
  }

  bandpassFilter(samples, lowHz, highHz) {
    // Simple frequency-domain bandpass
    const N = samples.length;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      real[i] = samples[i];
      imag[i] = 0;
    }

    this.fft(real, imag);

    // Zero out frequencies outside band
    const binLow = Math.floor(lowHz * N / this.sampleRate);
    const binHigh = Math.ceil(highHz * N / this.sampleRate);

    for (let i = 0; i < N; i++) {
      if (i < binLow || (i > binHigh && i < N - binHigh) || i > N - binLow) {
        real[i] = 0;
        imag[i] = 0;
      }
    }

    this.ifft(real, imag);

    return real;
  }

  // Simple in-place FFT (Cooley-Tukey)
  fft(real, imag) {
    const N = real.length;
    const bits = Math.log2(N);

    // Bit-reversal permutation
    for (let i = 0; i < N; i++) {
      const j = this.reverseBits(i, bits);
      if (j > i) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Cooley-Tukey FFT
    for (let size = 2; size <= N; size *= 2) {
      const halfSize = size / 2;
      const step = N / size;

      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const angle = -2 * Math.PI * j / size;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);

          const re = real[i + j + halfSize];
          const im = imag[i + j + halfSize];

          const tRe = re * cos - im * sin;
          const tIm = re * sin + im * cos;

          real[i + j + halfSize] = real[i + j] - tRe;
          imag[i + j + halfSize] = imag[i + j] - tIm;
          real[i + j] += tRe;
          imag[i + j] += tIm;
        }
      }
    }
  }

  ifft(real, imag) {
    // Conjugate, FFT, conjugate, scale
    for (let i = 0; i < imag.length; i++) {
      imag[i] = -imag[i];
    }

    this.fft(real, imag);

    const N = real.length;
    for (let i = 0; i < N; i++) {
      real[i] /= N;
      imag[i] = -imag[i] / N;
    }
  }

  reverseBits(n, bits) {
    let result = 0;
    for (let i = 0; i < bits; i++) {
      result = (result << 1) | (n & 1);
      n >>= 1;
    }
    return result;
  }
}
