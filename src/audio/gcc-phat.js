// GCC-PHAT (Generalized Cross-Correlation with Phase Transform)
// Robust time delay estimation between two signals
// More resilient to reverberation than basic cross-correlation

export class GCCPHAT {
  constructor(fftSize = 2048) {
    this.fftSize = fftSize;

    // Pre-allocate FFT buffers
    this.realA = new Float32Array(fftSize);
    this.imagA = new Float32Array(fftSize);
    this.realB = new Float32Array(fftSize);
    this.imagB = new Float32Array(fftSize);
    this.realOut = new Float32Array(fftSize);
    this.imagOut = new Float32Array(fftSize);

    // Hanning window for reducing spectral leakage
    this.window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }
  }

  /**
   * Estimate time delay between two signals
   * @param {Float32Array} signalA - First signal
   * @param {Float32Array} signalB - Second signal
   * @param {number} sampleRate - Sample rate in Hz
   * @returns {{ delay: number, confidence: number }} - Delay in seconds and confidence (0-1)
   */
  estimateDelay(signalA, signalB, sampleRate) {
    const N = this.fftSize;

    // Apply window and copy to FFT buffers
    for (let i = 0; i < N; i++) {
      const idx = i < signalA.length ? i : 0;
      this.realA[i] = (signalA[idx] || 0) * this.window[i];
      this.imagA[i] = 0;
      this.realB[i] = (signalB[idx] || 0) * this.window[i];
      this.imagB[i] = 0;
    }

    // FFT of both signals
    this.fft(this.realA, this.imagA);
    this.fft(this.realB, this.imagB);

    // Cross-spectrum with PHAT weighting
    // G = (A * conj(B)) / |A * conj(B)|
    for (let i = 0; i < N; i++) {
      // A * conj(B)
      const crossReal = this.realA[i] * this.realB[i] + this.imagA[i] * this.imagB[i];
      const crossImag = this.imagA[i] * this.realB[i] - this.realA[i] * this.imagB[i];

      // Magnitude
      const mag = Math.sqrt(crossReal * crossReal + crossImag * crossImag) + 1e-10;

      // PHAT weighting (normalize by magnitude)
      this.realOut[i] = crossReal / mag;
      this.imagOut[i] = crossImag / mag;
    }

    // Inverse FFT to get cross-correlation
    this.ifft(this.realOut, this.imagOut);

    // Find peak in correlation
    let maxVal = -Infinity;
    let maxIdx = 0;

    for (let i = 0; i < N; i++) {
      const val = this.realOut[i];
      if (val > maxVal) {
        maxVal = val;
        maxIdx = i;
      }
    }

    // Convert index to delay
    // Handle wrap-around for negative delays
    let delaySamples = maxIdx;
    if (delaySamples > N / 2) {
      delaySamples = delaySamples - N;
    }

    const delaySeconds = delaySamples / sampleRate;

    // Confidence based on peak sharpness
    // Compare peak to average of correlation
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += Math.abs(this.realOut[i]);
    }
    const avg = sum / N;
    const confidence = Math.min(1, maxVal / (avg * 10 + 0.001));

    return { delay: delaySeconds, confidence };
  }

  /**
   * Estimate delays for all microphone pairs
   * @param {Float32Array[]} channelData - Array of channel buffers
   * @param {number} sampleRate - Sample rate
   * @returns {Array<{ i: number, j: number, delay: number, confidence: number }>}
   */
  estimateAllDelays(channelData, sampleRate) {
    const delays = [];
    const n = channelData.length;

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const { delay, confidence } = this.estimateDelay(
          channelData[i],
          channelData[j],
          sampleRate
        );
        delays.push({ i, j, delay, confidence });
      }
    }

    return delays;
  }

  // In-place Cooley-Tukey FFT
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

  // Inverse FFT
  ifft(real, imag) {
    const N = real.length;

    // Conjugate
    for (let i = 0; i < N; i++) {
      imag[i] = -imag[i];
    }

    // Forward FFT
    this.fft(real, imag);

    // Conjugate and scale
    for (let i = 0; i < N; i++) {
      real[i] /= N;
      imag[i] = -imag[i] / N;
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
}
