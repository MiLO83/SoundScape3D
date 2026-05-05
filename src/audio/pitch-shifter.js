// Pitch Shifter using Phase Vocoder technique
// Converts any frequency to human speech range (85-255Hz fundamental)
// Uses FFT/IFFT with overlap-add for smooth real-time processing

/**
 * FFT utilities for pitch shifting
 * Extracted for reuse across audio modules
 */
class FFTProcessor {
  constructor(fftSize) {
    this.fftSize = fftSize;
    this.bits = Math.log2(fftSize);

    // Pre-compute bit-reversal table
    this.bitReversalTable = new Uint32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.bitReversalTable[i] = this.reverseBits(i, this.bits);
    }

    // Pre-compute twiddle factors
    this.twiddleReal = new Float32Array(fftSize / 2);
    this.twiddleImag = new Float32Array(fftSize / 2);
    for (let i = 0; i < fftSize / 2; i++) {
      const angle = -2 * Math.PI * i / fftSize;
      this.twiddleReal[i] = Math.cos(angle);
      this.twiddleImag[i] = Math.sin(angle);
    }
  }

  reverseBits(n, bits) {
    let reversed = 0;
    for (let i = 0; i < bits; i++) {
      reversed = (reversed << 1) | (n & 1);
      n >>= 1;
    }
    return reversed;
  }

  /**
   * In-place Cooley-Tukey FFT
   * @param {Float32Array} real - Real part (modified in-place)
   * @param {Float32Array} imag - Imaginary part (modified in-place)
   */
  fft(real, imag) {
    const N = this.fftSize;

    // Bit-reversal permutation
    for (let i = 0; i < N; i++) {
      const j = this.bitReversalTable[i];
      if (j > i) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Cooley-Tukey iterative FFT
    for (let size = 2; size <= N; size *= 2) {
      const halfSize = size / 2;
      const step = N / size;

      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const twiddleIdx = j * step;
          const tReal = this.twiddleReal[twiddleIdx];
          const tImag = this.twiddleImag[twiddleIdx];

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
   * Inverse FFT
   * @param {Float32Array} real - Real part (modified in-place)
   * @param {Float32Array} imag - Imaginary part (modified in-place)
   */
  ifft(real, imag) {
    const N = this.fftSize;

    // Conjugate
    for (let i = 0; i < N; i++) {
      imag[i] = -imag[i];
    }

    // Forward FFT
    this.fft(real, imag);

    // Conjugate and scale
    const scale = 1 / N;
    for (let i = 0; i < N; i++) {
      real[i] *= scale;
      imag[i] = -imag[i] * scale;
    }
  }
}

/**
 * PitchShifter - Real-time pitch shifting using phase vocoder
 *
 * Key features:
 * - Phase vocoder with FFT/IFFT for high-quality pitch shifting
 * - Overlap-add synthesis for smooth transitions
 * - Auto-detection of fundamental frequency
 * - Auto-shift to human speech range (85-255Hz, target ~150Hz)
 * - Low-latency processing suitable for real-time applications
 */
export class PitchShifter {
  /**
   * Create a new PitchShifter
   * @param {Object} options - Configuration options
   * @param {number} options.fftSize - FFT size (default: 2048, must be power of 2)
   * @param {number} options.hopSize - Hop size in samples (default: fftSize/4 for 75% overlap)
   * @param {number} options.sampleRate - Sample rate in Hz (default: 48000)
   */
  constructor(options = {}) {
    // FFT configuration
    this.fftSize = options.fftSize || 2048;
    this.hopSize = options.hopSize || this.fftSize / 4;  // 75% overlap
    this.sampleRate = options.sampleRate || 48000;

    // Validate FFT size is power of 2
    if (this.fftSize & (this.fftSize - 1)) {
      throw new Error('FFT size must be a power of 2');
    }

    // Pitch shift parameters
    this.shiftSemitones = 0;
    this.shiftRatio = 1.0;

    // Auto-shift to speech range
    this.autoShiftEnabled = false;
    this.targetFrequency = 150;  // Target fundamental frequency in Hz
    this.speechRangeMin = 85;    // Minimum speech fundamental
    this.speechRangeMax = 255;   // Maximum speech fundamental

    // FFT processor
    this.fftProcessor = new FFTProcessor(this.fftSize);

    // Analysis/synthesis windows (Hann window for smooth overlap-add)
    this.analysisWindow = new Float32Array(this.fftSize);
    this.synthesisWindow = new Float32Array(this.fftSize);
    this.createWindows();

    // FFT buffers
    this.real = new Float32Array(this.fftSize);
    this.imag = new Float32Array(this.fftSize);

    // Phase vocoder state
    this.lastAnalysisPhase = new Float32Array(this.fftSize / 2 + 1);
    this.lastSynthesisPhase = new Float32Array(this.fftSize / 2 + 1);
    this.phaseDiff = new Float32Array(this.fftSize / 2 + 1);

    // Input/output buffers for overlap-add
    this.inputBuffer = new Float32Array(this.fftSize * 2);
    this.outputBuffer = new Float32Array(this.fftSize * 2);
    this.inputWritePos = 0;
    this.outputReadPos = 0;
    this.samplesAvailable = 0;

    // Fundamental frequency detection
    this.detectedF0 = 0;
    this.f0ConfidenceThreshold = 0.3;

    // Pre-compute constants
    this.twoPi = 2 * Math.PI;
    this.expectedPhaseDiff = this.twoPi * this.hopSize / this.fftSize;
  }

  /**
   * Create analysis and synthesis windows (Hann window)
   * Using Hann window for COLA (Constant Overlap-Add) property
   */
  createWindows() {
    const N = this.fftSize;

    for (let i = 0; i < N; i++) {
      // Hann window
      const hannValue = 0.5 * (1 - Math.cos(this.twoPi * i / N));
      this.analysisWindow[i] = hannValue;
      this.synthesisWindow[i] = hannValue;
    }

    // Normalize for overlap-add reconstruction
    // With 75% overlap (hopSize = fftSize/4), sum of squared Hann windows = 1.5
    const overlapFactor = this.fftSize / this.hopSize;
    const normFactor = Math.sqrt(2 / 3);  // Compensation for 75% overlap

    for (let i = 0; i < N; i++) {
      this.synthesisWindow[i] *= normFactor;
    }
  }

  /**
   * Set pitch shift in semitones
   * @param {number} semitones - Number of semitones to shift (positive = up, negative = down)
   */
  setShiftSemitones(semitones) {
    this.shiftSemitones = semitones;
    this.shiftRatio = Math.pow(2, semitones / 12);

    // When manually setting semitones, disable auto-shift
    if (semitones !== 0) {
      this.autoShiftEnabled = false;
    }
  }

  /**
   * Set pitch shift as a ratio
   * @param {number} ratio - Pitch ratio (2.0 = octave up, 0.5 = octave down)
   */
  setShiftRatio(ratio) {
    this.shiftRatio = ratio;
    this.shiftSemitones = 12 * Math.log2(ratio);

    if (ratio !== 1) {
      this.autoShiftEnabled = false;
    }
  }

  /**
   * Enable/disable automatic shifting to speech range
   * When enabled, detects fundamental frequency and shifts to target ~150Hz
   * @param {boolean} enable - Enable auto-shifting
   * @param {number} targetF0 - Target fundamental frequency (default: 150Hz)
   */
  autoShiftToSpeechRange(enable, targetF0 = 150) {
    this.autoShiftEnabled = enable;
    this.targetFrequency = targetF0;

    if (!enable) {
      this.shiftRatio = 1.0;
      this.shiftSemitones = 0;
    }
  }

  /**
   * Detect fundamental frequency using autocorrelation
   * @param {Float32Array} signal - Input signal
   * @returns {{ f0: number, confidence: number }} - Detected F0 and confidence
   */
  detectFundamentalFrequency(signal) {
    const N = Math.min(signal.length, this.fftSize);

    // Compute autocorrelation using FFT for efficiency
    // R(tau) = IFFT(|FFT(x)|^2)

    // Zero-pad and apply window
    for (let i = 0; i < this.fftSize; i++) {
      this.real[i] = i < N ? signal[i] * this.analysisWindow[i] : 0;
      this.imag[i] = 0;
    }

    // Forward FFT
    this.fftProcessor.fft(this.real, this.imag);

    // Power spectrum
    for (let i = 0; i < this.fftSize; i++) {
      this.real[i] = this.real[i] * this.real[i] + this.imag[i] * this.imag[i];
      this.imag[i] = 0;
    }

    // Inverse FFT for autocorrelation
    this.fftProcessor.ifft(this.real, this.imag);

    // Find peak in autocorrelation (excluding lag 0)
    // Search within plausible F0 range (50Hz - 500Hz)
    const minLag = Math.floor(this.sampleRate / 500);  // 500 Hz max
    const maxLag = Math.floor(this.sampleRate / 50);   // 50 Hz min

    let maxCorr = 0;
    let bestLag = 0;
    const r0 = this.real[0];  // Autocorrelation at lag 0

    for (let lag = minLag; lag < Math.min(maxLag, N / 2); lag++) {
      const corr = this.real[lag] / r0;
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    // Parabolic interpolation for more accurate peak
    if (bestLag > 0 && bestLag < N / 2 - 1) {
      const y1 = this.real[bestLag - 1];
      const y2 = this.real[bestLag];
      const y3 = this.real[bestLag + 1];
      const d = (y1 - y3) / (2 * (y1 - 2 * y2 + y3));
      bestLag += d;
    }

    const f0 = bestLag > 0 ? this.sampleRate / bestLag : 0;

    return {
      f0,
      confidence: maxCorr
    };
  }

  /**
   * Process a frame using the phase vocoder
   * @param {Float32Array} inputFrame - Input samples (fftSize length)
   * @returns {Float32Array} - Pitch-shifted output samples
   */
  processFrame(inputFrame) {
    const N = this.fftSize;
    const halfN = N / 2;

    // Apply analysis window and prepare FFT input
    for (let i = 0; i < N; i++) {
      this.real[i] = inputFrame[i] * this.analysisWindow[i];
      this.imag[i] = 0;
    }

    // Forward FFT
    this.fftProcessor.fft(this.real, this.imag);

    // Phase vocoder processing
    const shiftedReal = new Float32Array(N);
    const shiftedImag = new Float32Array(N);

    for (let bin = 0; bin <= halfN; bin++) {
      // Convert to magnitude and phase
      const mag = Math.sqrt(this.real[bin] * this.real[bin] + this.imag[bin] * this.imag[bin]);
      const phase = Math.atan2(this.imag[bin], this.real[bin]);

      // Calculate true frequency for this bin
      // Phase difference from expected
      let phaseDiff = phase - this.lastAnalysisPhase[bin];
      this.lastAnalysisPhase[bin] = phase;

      // Expected phase advance
      const expectedAdvance = this.expectedPhaseDiff * bin;

      // Phase deviation (heterodyned phase difference)
      phaseDiff -= expectedAdvance;

      // Wrap to [-pi, pi]
      phaseDiff = phaseDiff - this.twoPi * Math.round(phaseDiff / this.twoPi);

      // True frequency deviation in radians per sample
      const trueFreqDev = phaseDiff / this.hopSize;

      // True frequency in bins
      const trueFreq = bin + trueFreqDev * N / this.twoPi;

      // Shift frequency
      const shiftedBin = Math.round(trueFreq * this.shiftRatio);

      if (shiftedBin >= 0 && shiftedBin <= halfN) {
        // Accumulate magnitude (handles multiple bins mapping to same output)
        const shiftedPhaseAdvance = this.expectedPhaseDiff * shiftedBin * this.shiftRatio;

        // Calculate new phase
        let newPhase = this.lastSynthesisPhase[shiftedBin] + shiftedPhaseAdvance + phaseDiff * this.shiftRatio;

        // Add to output (accumulate for overlapping contributions)
        shiftedReal[shiftedBin] += mag * Math.cos(newPhase);
        shiftedImag[shiftedBin] += mag * Math.sin(newPhase);

        this.lastSynthesisPhase[shiftedBin] = newPhase;
      }
    }

    // Fill negative frequencies (conjugate symmetry)
    for (let i = 1; i < halfN; i++) {
      shiftedReal[N - i] = shiftedReal[i];
      shiftedImag[N - i] = -shiftedImag[i];
    }

    // Inverse FFT
    this.fftProcessor.ifft(shiftedReal, shiftedImag);

    // Apply synthesis window
    const outputFrame = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      outputFrame[i] = shiftedReal[i] * this.synthesisWindow[i];
    }

    return outputFrame;
  }

  /**
   * Process input samples and return pitch-shifted output
   * Uses overlap-add for continuous processing
   * @param {Float32Array} inputSamples - Input audio samples
   * @returns {Float32Array} - Pitch-shifted output samples
   */
  process(inputSamples) {
    const input = inputSamples;
    const inputLength = input.length;

    // Auto-detect and adjust shift ratio if enabled
    if (this.autoShiftEnabled && inputLength >= this.fftSize) {
      const { f0, confidence } = this.detectFundamentalFrequency(input);

      if (confidence > this.f0ConfidenceThreshold && f0 > 30 && f0 < 2000) {
        this.detectedF0 = f0;

        // Check if F0 is outside speech range
        if (f0 < this.speechRangeMin || f0 > this.speechRangeMax) {
          // Calculate shift needed to bring to target
          this.shiftRatio = this.targetFrequency / f0;
          this.shiftSemitones = 12 * Math.log2(this.shiftRatio);

          // Clamp shift to reasonable range (max 2 octaves)
          if (this.shiftRatio > 4) this.shiftRatio = 4;
          if (this.shiftRatio < 0.25) this.shiftRatio = 0.25;
        } else {
          // Already in speech range, no shift needed
          this.shiftRatio = 1.0;
          this.shiftSemitones = 0;
        }
      }
    }

    // If no shift needed, return input directly
    if (Math.abs(this.shiftRatio - 1.0) < 0.001) {
      return new Float32Array(input);
    }

    // Write input to circular buffer
    for (let i = 0; i < inputLength; i++) {
      this.inputBuffer[this.inputWritePos] = input[i];
      this.inputWritePos = (this.inputWritePos + 1) % this.inputBuffer.length;
      this.samplesAvailable++;
    }

    // Process complete frames
    const outputSamples = [];

    while (this.samplesAvailable >= this.fftSize) {
      // Extract input frame
      const inputFrame = new Float32Array(this.fftSize);
      const readPos = (this.inputWritePos - this.samplesAvailable + this.inputBuffer.length) % this.inputBuffer.length;

      for (let i = 0; i < this.fftSize; i++) {
        inputFrame[i] = this.inputBuffer[(readPos + i) % this.inputBuffer.length];
      }

      // Process frame
      const outputFrame = this.processFrame(inputFrame);

      // Overlap-add to output buffer
      for (let i = 0; i < this.fftSize; i++) {
        const outPos = (this.outputReadPos + i) % this.outputBuffer.length;
        this.outputBuffer[outPos] += outputFrame[i];
      }

      // Extract hopSize samples from output
      for (let i = 0; i < this.hopSize; i++) {
        outputSamples.push(this.outputBuffer[this.outputReadPos]);
        this.outputBuffer[this.outputReadPos] = 0;  // Clear for next overlap
        this.outputReadPos = (this.outputReadPos + 1) % this.outputBuffer.length;
      }

      this.samplesAvailable -= this.hopSize;
    }

    return new Float32Array(outputSamples);
  }

  /**
   * Get current pitch shift in semitones
   * @returns {number} - Current shift in semitones
   */
  getShiftSemitones() {
    return this.shiftSemitones;
  }

  /**
   * Get current pitch shift ratio
   * @returns {number} - Current shift ratio
   */
  getShiftRatio() {
    return this.shiftRatio;
  }

  /**
   * Get the last detected fundamental frequency
   * @returns {number} - Detected F0 in Hz (0 if not detected)
   */
  getDetectedF0() {
    return this.detectedF0;
  }

  /**
   * Check if auto-shift is enabled
   * @returns {boolean} - True if auto-shift is enabled
   */
  isAutoShiftEnabled() {
    return this.autoShiftEnabled;
  }

  /**
   * Set sample rate (for reconfiguration)
   * @param {number} sampleRate - New sample rate in Hz
   */
  setSampleRate(sampleRate) {
    this.sampleRate = sampleRate;
    this.expectedPhaseDiff = this.twoPi * this.hopSize / this.fftSize;
  }

  /**
   * Reset the processor state
   * Call this when starting a new audio stream
   */
  reset() {
    this.lastAnalysisPhase.fill(0);
    this.lastSynthesisPhase.fill(0);
    this.inputBuffer.fill(0);
    this.outputBuffer.fill(0);
    this.inputWritePos = 0;
    this.outputReadPos = 0;
    this.samplesAvailable = 0;
    this.detectedF0 = 0;
  }

  /**
   * Get processing latency in samples
   * @returns {number} - Latency in samples
   */
  getLatencySamples() {
    return this.fftSize;
  }

  /**
   * Get processing latency in milliseconds
   * @returns {number} - Latency in milliseconds
   */
  getLatencyMs() {
    return (this.fftSize / this.sampleRate) * 1000;
  }
}

// Export FFT processor for potential reuse
export { FFTProcessor };
