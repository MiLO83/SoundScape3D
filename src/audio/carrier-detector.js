// Carrier Frequency Detection Module
// Detects steady carrier tones that may carry modulated information
// Useful for identifying ultrasonic beacons, pilot tones, and AM/FM signals

/**
 * @typedef {Object} CarrierInfo
 * @property {number} frequency - Carrier frequency in Hz
 * @property {number} amplitude - Carrier amplitude (0-1 normalized)
 * @property {'none'|'AM'|'FM'|'unknown'} modulationType - Detected modulation type
 * @property {number} confidence - Detection confidence (0-1)
 * @property {number} persistence - Number of frames this carrier has persisted
 * @property {number} modulationDepth - Modulation depth for AM, deviation for FM
 */

/**
 * @typedef {Object} PeakHistory
 * @property {number} frequency - Peak frequency in Hz
 * @property {number[]} amplitudes - Recent amplitude history
 * @property {number[]} phases - Recent phase history (for FM detection)
 * @property {number} frameCount - Number of frames this peak has been tracked
 * @property {number} lastSeen - Frame number when last detected
 */

export class CarrierDetector {
  /**
   * Create a carrier frequency detector
   * @param {number} fftSize - FFT size (power of 2, default 4096 for good frequency resolution)
   */
  constructor(fftSize = 4096) {
    this.fftSize = fftSize;

    // Detection parameters
    this.minPersistence = 5;      // Frames a peak must persist to be considered carrier
    this.minAmplitude = 0.01;     // Minimum amplitude threshold (0-1)
    this.peakWidthBins = 3;       // Width around peak to consider as same frequency
    this.frequencyTolerance = 10; // Hz tolerance for matching peaks across frames

    // Modulation detection parameters
    this.amThreshold = 0.15;      // Amplitude variation threshold for AM detection
    this.fmThreshold = 0.1;       // Phase variation threshold for FM detection
    this.modulationHistorySize = 20; // Frames to analyze for modulation

    // FFT buffers
    this.real = new Float32Array(fftSize);
    this.imag = new Float32Array(fftSize);
    this.magnitudes = new Float32Array(fftSize / 2);
    this.phases = new Float32Array(fftSize / 2);

    // Hanning window for spectral leakage reduction
    this.window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }

    // Peak tracking history
    /** @type {Map<number, PeakHistory>} */
    this.peakHistory = new Map();
    this.frameNumber = 0;
    this.maxHistoryFrames = 100; // Clean up peaks older than this

    // Ultrasonic frequency ranges of interest
    this.ultrasonicRanges = [
      { min: 17000, max: 20000, name: 'near-ultrasonic' },
      { min: 20000, max: 24000, name: 'ultrasonic' }
    ];
  }

  /**
   * Set minimum persistence frames for carrier detection
   * @param {number} frames - Number of frames a peak must persist
   */
  setMinPersistence(frames) {
    this.minPersistence = Math.max(1, Math.floor(frames));
  }

  /**
   * Set minimum amplitude threshold
   * @param {number} threshold - Minimum amplitude (0-1)
   */
  setMinAmplitude(threshold) {
    this.minAmplitude = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Set frequency tolerance for peak matching across frames
   * @param {number} toleranceHz - Tolerance in Hz
   */
  setFrequencyTolerance(toleranceHz) {
    this.frequencyTolerance = Math.max(1, toleranceHz);
  }

  /**
   * Detect carrier frequencies in audio samples
   * @param {Float32Array} samples - Audio sample buffer
   * @param {number} sampleRate - Sample rate in Hz
   * @returns {CarrierInfo[]} Array of detected carriers
   */
  detect(samples, sampleRate) {
    this.frameNumber++;
    const binWidth = sampleRate / this.fftSize;
    const nyquist = sampleRate / 2;

    // Apply window and prepare FFT input
    const N = Math.min(samples.length, this.fftSize);
    this.real.fill(0);
    this.imag.fill(0);

    for (let i = 0; i < N; i++) {
      this.real[i] = samples[i] * this.window[i];
    }

    // Perform FFT
    this.fft(this.real, this.imag);

    // Calculate magnitudes and phases
    let maxMagnitude = 0;
    for (let i = 0; i < this.fftSize / 2; i++) {
      const re = this.real[i];
      const im = this.imag[i];
      this.magnitudes[i] = Math.sqrt(re * re + im * im);
      this.phases[i] = Math.atan2(im, re);
      if (this.magnitudes[i] > maxMagnitude) {
        maxMagnitude = this.magnitudes[i];
      }
    }

    // Normalize magnitudes
    if (maxMagnitude > 0) {
      for (let i = 0; i < this.fftSize / 2; i++) {
        this.magnitudes[i] /= maxMagnitude;
      }
    }

    // Find spectral peaks
    const peaks = this.findPeaks(binWidth, nyquist);

    // Update peak history
    this.updatePeakHistory(peaks, binWidth);

    // Clean up old peaks
    this.cleanupHistory();

    // Identify carriers from persistent peaks
    const carriers = this.identifyCarriers(sampleRate);

    return carriers;
  }

  /**
   * Find spectral peaks above threshold
   * @param {number} binWidth - Frequency resolution per bin
   * @param {number} nyquist - Nyquist frequency
   * @returns {Array<{bin: number, frequency: number, amplitude: number, phase: number}>}
   */
  findPeaks(binWidth, nyquist) {
    const peaks = [];
    const halfFFT = this.fftSize / 2;

    for (let i = this.peakWidthBins; i < halfFFT - this.peakWidthBins; i++) {
      const amplitude = this.magnitudes[i];

      // Check if above threshold
      if (amplitude < this.minAmplitude) continue;

      // Check if local maximum
      let isPeak = true;
      for (let j = -this.peakWidthBins; j <= this.peakWidthBins; j++) {
        if (j !== 0 && this.magnitudes[i + j] >= amplitude) {
          isPeak = false;
          break;
        }
      }

      if (isPeak) {
        // Parabolic interpolation for more accurate frequency
        const alpha = this.magnitudes[i - 1];
        const beta = this.magnitudes[i];
        const gamma = this.magnitudes[i + 1];

        const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma + 1e-10);
        const interpolatedBin = i + p;
        const frequency = interpolatedBin * binWidth;

        // Only include if below Nyquist
        if (frequency < nyquist) {
          peaks.push({
            bin: i,
            frequency,
            amplitude,
            phase: this.phases[i]
          });
        }
      }
    }

    return peaks;
  }

  /**
   * Update peak history with new frame data
   * @param {Array<{bin: number, frequency: number, amplitude: number, phase: number}>} peaks
   * @param {number} binWidth
   */
  updatePeakHistory(peaks, binWidth) {
    const matched = new Set();

    // Match new peaks to existing history
    for (const peak of peaks) {
      let bestMatch = null;
      let bestDistance = this.frequencyTolerance;

      for (const [key, history] of this.peakHistory) {
        if (matched.has(key)) continue;

        const distance = Math.abs(history.frequency - peak.frequency);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = key;
        }
      }

      if (bestMatch !== null) {
        // Update existing history
        const history = this.peakHistory.get(bestMatch);
        history.frequency = peak.frequency; // Update to current frequency
        history.amplitudes.push(peak.amplitude);
        history.phases.push(peak.phase);
        history.frameCount++;
        history.lastSeen = this.frameNumber;

        // Limit history size
        if (history.amplitudes.length > this.modulationHistorySize) {
          history.amplitudes.shift();
          history.phases.shift();
        }

        matched.add(bestMatch);
      } else {
        // Create new history entry
        const key = Math.round(peak.frequency);
        this.peakHistory.set(key, {
          frequency: peak.frequency,
          amplitudes: [peak.amplitude],
          phases: [peak.phase],
          frameCount: 1,
          lastSeen: this.frameNumber
        });
      }
    }
  }

  /**
   * Remove old peaks that haven't been seen recently
   */
  cleanupHistory() {
    const cutoff = this.frameNumber - this.maxHistoryFrames;
    const toDelete = [];

    for (const [key, history] of this.peakHistory) {
      if (history.lastSeen < cutoff) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      this.peakHistory.delete(key);
    }
  }

  /**
   * Identify carriers from persistent peaks and detect modulation
   * @param {number} sampleRate
   * @returns {CarrierInfo[]}
   */
  identifyCarriers(sampleRate) {
    const carriers = [];

    for (const [, history] of this.peakHistory) {
      // Must persist for minimum frames
      if (history.frameCount < this.minPersistence) continue;

      // Must have been seen recently
      if (this.frameNumber - history.lastSeen > 2) continue;

      // Analyze modulation
      const modulation = this.analyzeModulation(history);

      // Calculate confidence based on persistence and stability
      const persistenceScore = Math.min(1, history.frameCount / (this.minPersistence * 2));
      const stabilityScore = 1 - modulation.amplitudeVariation;
      const confidence = (persistenceScore * 0.6 + stabilityScore * 0.4);

      // Get average amplitude
      const avgAmplitude = history.amplitudes.reduce((a, b) => a + b, 0) / history.amplitudes.length;

      carriers.push({
        frequency: history.frequency,
        amplitude: avgAmplitude,
        modulationType: modulation.type,
        confidence,
        persistence: history.frameCount,
        modulationDepth: modulation.depth
      });
    }

    // Sort by confidence descending
    carriers.sort((a, b) => b.confidence - a.confidence);

    return carriers;
  }

  /**
   * Analyze modulation characteristics of a persistent peak
   * @param {PeakHistory} history
   * @returns {{type: 'none'|'AM'|'FM'|'unknown', depth: number, amplitudeVariation: number}}
   */
  analyzeModulation(history) {
    if (history.amplitudes.length < 3) {
      return { type: 'none', depth: 0, amplitudeVariation: 0 };
    }

    // Calculate amplitude variation (for AM detection)
    const amplitudes = history.amplitudes;
    const avgAmp = amplitudes.reduce((a, b) => a + b, 0) / amplitudes.length;
    let ampVariance = 0;
    for (const amp of amplitudes) {
      ampVariance += (amp - avgAmp) * (amp - avgAmp);
    }
    ampVariance /= amplitudes.length;
    const ampStdDev = Math.sqrt(ampVariance);
    const amplitudeVariation = avgAmp > 0 ? ampStdDev / avgAmp : 0;

    // Calculate phase variation (for FM detection)
    const phases = history.phases;
    let phaseVariation = 0;
    for (let i = 1; i < phases.length; i++) {
      let diff = phases[i] - phases[i - 1];
      // Unwrap phase
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      phaseVariation += Math.abs(diff);
    }
    phaseVariation /= (phases.length - 1) || 1;

    // Determine modulation type
    let type = 'none';
    let depth = 0;

    if (amplitudeVariation > this.amThreshold && phaseVariation > this.fmThreshold) {
      // Both AM and FM characteristics - likely complex modulation
      type = 'unknown';
      depth = Math.max(amplitudeVariation, phaseVariation);
    } else if (amplitudeVariation > this.amThreshold) {
      // Amplitude Modulation detected
      type = 'AM';
      depth = amplitudeVariation;
    } else if (phaseVariation > this.fmThreshold) {
      // Frequency Modulation detected
      type = 'FM';
      depth = phaseVariation;
    }

    return { type, depth, amplitudeVariation };
  }

  /**
   * Check if a frequency is in ultrasonic range
   * @param {number} frequency
   * @returns {{isUltrasonic: boolean, range: string|null}}
   */
  isUltrasonic(frequency) {
    for (const range of this.ultrasonicRanges) {
      if (frequency >= range.min && frequency <= range.max) {
        return { isUltrasonic: true, range: range.name };
      }
    }
    return { isUltrasonic: false, range: null };
  }

  /**
   * Get all currently tracked peaks (for debugging/visualization)
   * @returns {Array<{frequency: number, frameCount: number, amplitude: number}>}
   */
  getTrackedPeaks() {
    const peaks = [];
    for (const [, history] of this.peakHistory) {
      const avgAmp = history.amplitudes.reduce((a, b) => a + b, 0) / history.amplitudes.length;
      peaks.push({
        frequency: history.frequency,
        frameCount: history.frameCount,
        amplitude: avgAmp
      });
    }
    return peaks.sort((a, b) => b.amplitude - a.amplitude);
  }

  /**
   * Filter carriers by frequency range
   * @param {CarrierInfo[]} carriers
   * @param {number} minFreq - Minimum frequency in Hz
   * @param {number} maxFreq - Maximum frequency in Hz
   * @returns {CarrierInfo[]}
   */
  filterByFrequency(carriers, minFreq, maxFreq) {
    return carriers.filter(c => c.frequency >= minFreq && c.frequency <= maxFreq);
  }

  /**
   * Get ultrasonic carriers only
   * @param {CarrierInfo[]} carriers
   * @returns {CarrierInfo[]}
   */
  getUltrasonicCarriers(carriers) {
    return carriers.filter(c => {
      const { isUltrasonic } = this.isUltrasonic(c.frequency);
      return isUltrasonic;
    });
  }

  /**
   * Reset all tracking history
   */
  reset() {
    this.peakHistory.clear();
    this.frameNumber = 0;
  }

  /**
   * In-place Cooley-Tukey FFT (radix-2)
   * @param {Float32Array} real - Real components
   * @param {Float32Array} imag - Imaginary components
   */
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

    // Cooley-Tukey iterative FFT
    for (let size = 2; size <= N; size *= 2) {
      const halfSize = size / 2;
      const angleStep = -2 * Math.PI / size;

      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const angle = angleStep * j;
          const tReal = Math.cos(angle);
          const tImag = Math.sin(angle);

          const evenIdx = i + j;
          const oddIdx = i + j + halfSize;

          const oddReal = real[oddIdx] * tReal - imag[oddIdx] * tImag;
          const oddImag = real[oddIdx] * tImag + imag[oddIdx] * tReal;

          real[oddIdx] = real[evenIdx] - oddReal;
          imag[oddIdx] = imag[evenIdx] - oddImag;
          real[evenIdx] = real[evenIdx] + oddReal;
          imag[evenIdx] = imag[evenIdx] + oddImag;
        }
      }
    }
  }

  /**
   * Reverse bits of an integer
   * @param {number} n - Integer to reverse
   * @param {number} bits - Number of bits
   * @returns {number}
   */
  reverseBits(n, bits) {
    let reversed = 0;
    for (let i = 0; i < bits; i++) {
      reversed = (reversed << 1) | (n & 1);
      n >>= 1;
    }
    return reversed;
  }
}

/**
 * Convenience function to create a carrier detector with common presets
 * @param {'default'|'ultrasonic'|'highResolution'} preset
 * @returns {CarrierDetector}
 */
export function createCarrierDetector(preset = 'default') {
  let detector;

  switch (preset) {
    case 'ultrasonic':
      // Optimized for ultrasonic beacon detection
      detector = new CarrierDetector(8192);
      detector.setMinPersistence(3);
      detector.setMinAmplitude(0.005);
      detector.setFrequencyTolerance(5);
      break;

    case 'highResolution':
      // High frequency resolution for precise carrier identification
      detector = new CarrierDetector(16384);
      detector.setMinPersistence(10);
      detector.setMinAmplitude(0.02);
      detector.setFrequencyTolerance(2);
      break;

    case 'default':
    default:
      detector = new CarrierDetector(4096);
      detector.setMinPersistence(5);
      detector.setMinAmplitude(0.01);
      detector.setFrequencyTolerance(10);
      break;
  }

  return detector;
}
