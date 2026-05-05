// Delay-and-Sum Beamformer
// Focuses audio capture on a specific 3D direction or position
// Uses time delays between microphones to constructively combine signals from target direction

const SPEED_OF_SOUND = 343;  // m/s at ~20C

/**
 * DelayAndSumBeamformer - Spatial audio filtering using microphone array
 *
 * Implements a classic delay-and-sum beamforming algorithm that:
 * 1. Calculates propagation delays from target to each microphone
 * 2. Applies compensating delays to align signals from target direction
 * 3. Sums aligned signals to amplify target while attenuating other directions
 */
export class DelayAndSumBeamformer {
  /**
   * Create a new beamformer instance
   * @param {number} sampleRate - Audio sample rate in Hz (default: 48000)
   * @param {number} maxDelaySamples - Maximum delay buffer size (default: 256)
   */
  constructor(sampleRate = 48000, maxDelaySamples = 256) {
    this.sampleRate = sampleRate;
    this.maxDelaySamples = maxDelaySamples;

    // Quest 3 mic positions (approximate, in meters, relative to headset center)
    // Imported from mic-array.js reference
    this.micPositions = [
      { x: -0.08, y: 0.02, z: 0.05 },   // Mic 0: Left front
      { x: 0.08, y: 0.02, z: 0.05 },    // Mic 1: Right front
      { x: -0.06, y: -0.02, z: -0.03 }, // Mic 2: Left bottom
      { x: 0.06, y: -0.02, z: -0.03 },  // Mic 3: Right bottom
      { x: 0.0, y: 0.04, z: 0.0 }       // Mic 4: Top center
    ];

    // Target direction in spherical coordinates (radians)
    this.azimuth = 0;    // Horizontal angle: 0 = forward, positive = right
    this.elevation = 0;  // Vertical angle: 0 = horizontal, positive = up

    // Alternative: target position in Cartesian coordinates
    this.targetPosition = null;  // { x, y, z } in meters

    // Delay buffers for each channel (circular buffers)
    this.delayBuffers = [];
    this.bufferIndices = [];

    // Calculated delays in samples for each microphone
    this.delays = [];

    // Per-channel weights (can be adjusted for microphone sensitivity differences)
    this.weights = [];

    // Gain normalization factor
    this.normalizationGain = 1.0;

    // Output gain control (0 to 1)
    this.outputGain = 1.0;

    // Initialize with default direction (forward)
    this.updateDelays();
  }

  /**
   * Set microphone positions (e.g., from MicrophoneArray)
   * @param {Array<{x: number, y: number, z: number}>} positions - Mic positions in meters
   */
  setMicPositions(positions) {
    this.micPositions = positions.map(p => ({ x: p.x, y: p.y, z: p.z }));
    this.initializeBuffers();
    this.updateDelays();
  }

  /**
   * Initialize delay buffers for all channels
   * @param {number} numChannels - Number of audio channels (defaults to mic count)
   */
  initializeBuffers(numChannels = null) {
    const count = numChannels || this.micPositions.length;

    this.delayBuffers = [];
    this.bufferIndices = [];
    this.weights = [];

    for (let i = 0; i < count; i++) {
      // Create circular delay buffer filled with zeros
      this.delayBuffers.push(new Float32Array(this.maxDelaySamples));
      this.bufferIndices.push(0);
      // Equal weighting by default
      this.weights.push(1.0);
    }

    // Update normalization gain
    this.updateNormalization();
  }

  /**
   * Set target direction using azimuth and elevation angles
   * @param {number} azimuth - Horizontal angle in radians (0 = forward, positive = right)
   * @param {number} elevation - Vertical angle in radians (0 = horizontal, positive = up)
   */
  setTargetDirection(azimuth, elevation) {
    this.azimuth = azimuth;
    this.elevation = elevation;
    this.targetPosition = null;  // Clear position mode
    this.updateDelays();
  }

  /**
   * Set target direction using degrees (convenience method)
   * @param {number} azimuthDeg - Horizontal angle in degrees
   * @param {number} elevationDeg - Vertical angle in degrees
   */
  setTargetDirectionDegrees(azimuthDeg, elevationDeg) {
    const DEG_TO_RAD = Math.PI / 180;
    this.setTargetDirection(azimuthDeg * DEG_TO_RAD, elevationDeg * DEG_TO_RAD);
  }

  /**
   * Set target position in 3D space (point source mode)
   * @param {number} x - X position in meters (right is positive)
   * @param {number} y - Y position in meters (up is positive)
   * @param {number} z - Z position in meters (forward is positive)
   */
  setTargetPosition(x, y, z) {
    this.targetPosition = { x, y, z };
    this.updateDelays();
  }

  /**
   * Set target position from an object
   * @param {{x: number, y: number, z: number}} position - Target position
   */
  setTargetPositionObject(position) {
    this.setTargetPosition(position.x, position.y, position.z);
  }

  /**
   * Calculate unit direction vector from angles or position
   * @returns {{x: number, y: number, z: number}} - Normalized direction vector
   */
  getTargetDirectionVector() {
    if (this.targetPosition) {
      // Direction from array center to target position
      const dist = Math.sqrt(
        this.targetPosition.x ** 2 +
        this.targetPosition.y ** 2 +
        this.targetPosition.z ** 2
      );

      if (dist < 0.001) {
        // Target at center, default to forward
        return { x: 0, y: 0, z: 1 };
      }

      return {
        x: this.targetPosition.x / dist,
        y: this.targetPosition.y / dist,
        z: this.targetPosition.z / dist
      };
    }

    // Calculate from spherical coordinates
    // Convention: z = forward, x = right, y = up
    const cosElev = Math.cos(this.elevation);
    return {
      x: Math.sin(this.azimuth) * cosElev,
      y: Math.sin(this.elevation),
      z: Math.cos(this.azimuth) * cosElev
    };
  }

  /**
   * Update delay values for all microphones based on current target
   * This is the core of the beamformer - calculating steering delays
   */
  updateDelays() {
    const numMics = this.micPositions.length;

    if (numMics === 0) {
      this.delays = [];
      return;
    }

    // Ensure buffers are initialized
    if (this.delayBuffers.length !== numMics) {
      this.initializeBuffers(numMics);
    }

    let propagationTimes = [];

    if (this.targetPosition) {
      // Point source mode: calculate actual propagation time to each mic
      for (const mic of this.micPositions) {
        const dist = this.distance(this.targetPosition, mic);
        propagationTimes.push(dist / SPEED_OF_SOUND);
      }
    } else {
      // Far-field (plane wave) assumption: use direction vector
      // Delay is proportional to projection of mic position onto direction vector
      const dir = this.getTargetDirectionVector();

      for (const mic of this.micPositions) {
        // Project mic position onto direction vector (dot product)
        // Negative because we want the signal arrival time
        const projection = -(mic.x * dir.x + mic.y * dir.y + mic.z * dir.z);
        propagationTimes.push(projection / SPEED_OF_SOUND);
      }
    }

    // Find the maximum propagation time (earliest arriving signal)
    const maxTime = Math.max(...propagationTimes);

    // Calculate delays: each mic needs to wait until all signals have arrived
    // Convert to samples and offset so minimum delay is 0
    this.delays = propagationTimes.map(time => {
      const delaySamples = (maxTime - time) * this.sampleRate;
      // Clamp to valid range
      return Math.max(0, Math.min(this.maxDelaySamples - 1, Math.round(delaySamples)));
    });
  }

  /**
   * Calculate Euclidean distance between two 3D points
   * @param {{x: number, y: number, z: number}} a - First point
   * @param {{x: number, y: number, z: number}} b - Second point
   * @returns {number} - Distance in meters
   */
  distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Set per-channel weights for beamforming
   * Useful for compensating microphone sensitivity differences
   * @param {number[]} weights - Array of weights for each channel
   */
  setWeights(weights) {
    this.weights = weights.slice();
    this.updateNormalization();
  }

  /**
   * Update the normalization gain to prevent clipping
   * Sum of weighted signals is normalized to unity gain
   */
  updateNormalization() {
    const sumWeights = this.weights.reduce((sum, w) => sum + Math.abs(w), 0);
    this.normalizationGain = sumWeights > 0 ? 1.0 / sumWeights : 1.0;
  }

  /**
   * Set output gain (0 to 1)
   * @param {number} gain - Output gain factor
   */
  setOutputGain(gain) {
    this.outputGain = Math.max(0, Math.min(1, gain));
  }

  /**
   * Process multi-channel audio and return beamformed mono output
   * @param {Float32Array[]} channelData - Array of audio buffers, one per channel
   * @returns {Float32Array} - Beamformed mono output
   */
  process(channelData) {
    const numChannels = channelData.length;

    if (numChannels === 0 || channelData[0].length === 0) {
      return new Float32Array(0);
    }

    const frameLength = channelData[0].length;
    const output = new Float32Array(frameLength);

    // Ensure we have the right number of delay buffers
    if (this.delayBuffers.length !== numChannels) {
      this.initializeBuffers(numChannels);
      this.updateDelays();
    }

    // Process each sample
    for (let n = 0; n < frameLength; n++) {
      let sum = 0;

      for (let ch = 0; ch < numChannels; ch++) {
        // Get current sample
        const inputSample = channelData[ch][n];

        // Get delay for this channel
        const delay = this.delays[ch] || 0;

        // Write to delay buffer
        const writeIdx = this.bufferIndices[ch];
        this.delayBuffers[ch][writeIdx] = inputSample;

        // Read from delay buffer (delayed sample)
        let readIdx = writeIdx - delay;
        if (readIdx < 0) {
          readIdx += this.maxDelaySamples;
        }
        const delayedSample = this.delayBuffers[ch][readIdx];

        // Apply weight and accumulate
        const weight = this.weights[ch] || 1.0;
        sum += delayedSample * weight;

        // Advance buffer index
        this.bufferIndices[ch] = (writeIdx + 1) % this.maxDelaySamples;
      }

      // Normalize and apply output gain
      output[n] = sum * this.normalizationGain * this.outputGain;
    }

    // Apply soft clipping to prevent harsh distortion
    this.softClip(output);

    return output;
  }

  /**
   * Process with fractional delay interpolation for higher precision
   * Uses linear interpolation between samples
   * @param {Float32Array[]} channelData - Array of audio buffers
   * @returns {Float32Array} - Beamformed mono output with interpolation
   */
  processInterpolated(channelData) {
    const numChannels = channelData.length;

    if (numChannels === 0 || channelData[0].length === 0) {
      return new Float32Array(0);
    }

    const frameLength = channelData[0].length;
    const output = new Float32Array(frameLength);

    // Ensure buffers are initialized
    if (this.delayBuffers.length !== numChannels) {
      this.initializeBuffers(numChannels);
      this.updateDelays();
    }

    // Calculate fractional delays
    const fractionalDelays = this.calculateFractionalDelays();

    for (let n = 0; n < frameLength; n++) {
      let sum = 0;

      for (let ch = 0; ch < numChannels; ch++) {
        const inputSample = channelData[ch][n];
        const writeIdx = this.bufferIndices[ch];

        // Write to buffer
        this.delayBuffers[ch][writeIdx] = inputSample;

        // Get fractional delay
        const delay = fractionalDelays[ch] || 0;
        const intDelay = Math.floor(delay);
        const frac = delay - intDelay;

        // Calculate read indices for interpolation
        let readIdx0 = writeIdx - intDelay;
        let readIdx1 = writeIdx - intDelay - 1;

        if (readIdx0 < 0) readIdx0 += this.maxDelaySamples;
        if (readIdx1 < 0) readIdx1 += this.maxDelaySamples;

        // Linear interpolation
        const sample0 = this.delayBuffers[ch][readIdx0];
        const sample1 = this.delayBuffers[ch][readIdx1];
        const interpolated = sample0 * (1 - frac) + sample1 * frac;

        // Accumulate with weight
        const weight = this.weights[ch] || 1.0;
        sum += interpolated * weight;

        // Advance buffer
        this.bufferIndices[ch] = (writeIdx + 1) % this.maxDelaySamples;
      }

      output[n] = sum * this.normalizationGain * this.outputGain;
    }

    this.softClip(output);
    return output;
  }

  /**
   * Calculate fractional delays (not rounded to nearest sample)
   * @returns {number[]} - Array of fractional delay values in samples
   */
  calculateFractionalDelays() {
    const numMics = this.micPositions.length;
    let propagationTimes = [];

    if (this.targetPosition) {
      for (const mic of this.micPositions) {
        const dist = this.distance(this.targetPosition, mic);
        propagationTimes.push(dist / SPEED_OF_SOUND);
      }
    } else {
      const dir = this.getTargetDirectionVector();
      for (const mic of this.micPositions) {
        const projection = -(mic.x * dir.x + mic.y * dir.y + mic.z * dir.z);
        propagationTimes.push(projection / SPEED_OF_SOUND);
      }
    }

    const maxTime = Math.max(...propagationTimes);

    return propagationTimes.map(time => {
      const delaySamples = (maxTime - time) * this.sampleRate;
      return Math.max(0, Math.min(this.maxDelaySamples - 2, delaySamples));
    });
  }

  /**
   * Apply soft clipping to prevent harsh digital clipping
   * Uses tanh-based soft clipper
   * @param {Float32Array} buffer - Audio buffer to process in-place
   */
  softClip(buffer) {
    for (let i = 0; i < buffer.length; i++) {
      const x = buffer[i];
      // Soft clip using tanh for values approaching +-1
      if (Math.abs(x) > 0.8) {
        buffer[i] = Math.tanh(x * 1.5) / Math.tanh(1.5);
      }
    }
  }

  /**
   * Get current beamformer state for debugging/visualization
   * @returns {Object} - State object with delays, direction, etc.
   */
  getState() {
    return {
      azimuth: this.azimuth,
      elevation: this.elevation,
      azimuthDeg: this.azimuth * 180 / Math.PI,
      elevationDeg: this.elevation * 180 / Math.PI,
      targetPosition: this.targetPosition,
      direction: this.getTargetDirectionVector(),
      delays: this.delays.slice(),
      delaysSec: this.delays.map(d => d / this.sampleRate),
      weights: this.weights.slice(),
      normalizationGain: this.normalizationGain,
      outputGain: this.outputGain,
      numChannels: this.delayBuffers.length
    };
  }

  /**
   * Reset all delay buffers to zero
   * Call this when changing targets to avoid artifacts
   */
  reset() {
    for (let i = 0; i < this.delayBuffers.length; i++) {
      this.delayBuffers[i].fill(0);
      this.bufferIndices[i] = 0;
    }
  }

  /**
   * Calculate theoretical beam pattern gain for a given direction
   * Useful for visualization of beamformer directivity
   * @param {number} azimuth - Test azimuth in radians
   * @param {number} elevation - Test elevation in radians
   * @param {number} frequency - Test frequency in Hz (default: 1000)
   * @returns {number} - Beam pattern gain (0 to 1)
   */
  calculateBeamPattern(azimuth, elevation, frequency = 1000) {
    const numMics = this.micPositions.length;
    if (numMics === 0) return 0;

    // Test direction vector
    const cosElev = Math.cos(elevation);
    const testDir = {
      x: Math.sin(azimuth) * cosElev,
      y: Math.sin(elevation),
      z: Math.cos(azimuth) * cosElev
    };

    // Calculate phase shifts for test direction
    const wavelength = SPEED_OF_SOUND / frequency;
    const k = 2 * Math.PI / wavelength;  // Wavenumber

    let realSum = 0;
    let imagSum = 0;

    for (let i = 0; i < numMics; i++) {
      const mic = this.micPositions[i];

      // Phase from test direction
      const pathDiff = mic.x * testDir.x + mic.y * testDir.y + mic.z * testDir.z;
      const phaseTest = k * pathDiff;

      // Phase compensation from steering delays
      const delaySec = (this.delays[i] || 0) / this.sampleRate;
      const phaseComp = 2 * Math.PI * frequency * delaySec;

      // Total phase
      const phase = phaseTest + phaseComp;
      const weight = this.weights[i] || 1.0;

      realSum += weight * Math.cos(phase);
      imagSum += weight * Math.sin(phase);
    }

    // Normalize by number of mics
    const magnitude = Math.sqrt(realSum * realSum + imagSum * imagSum) / numMics;
    return magnitude;
  }
}

// Export alias for simpler import
export { DelayAndSumBeamformer as Beamformer };
