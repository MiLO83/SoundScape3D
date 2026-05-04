// Sound Source Triangulator
// Converts time delays from mic pairs into 3D positions
// Uses TDOA (Time Difference of Arrival) with least squares optimization

import { GCCPHAT } from './gcc-phat.js';

const SPEED_OF_SOUND = 343;  // m/s at ~20°C

export class SoundTriangulator {
  constructor() {
    this.gccPhat = new GCCPHAT(2048);

    // Microphone positions (will be updated from MicrophoneArray)
    // Default Quest 3 approximate positions
    this.micPositions = [
      { x: -0.08, y: 0.02, z: 0.05 },   // Mic 0: Left front
      { x: 0.08, y: 0.02, z: 0.05 },    // Mic 1: Right front
      { x: -0.06, y: -0.02, z: -0.03 }, // Mic 2: Left bottom
      { x: 0.06, y: -0.02, z: -0.03 },  // Mic 3: Right bottom
      { x: 0.0, y: 0.04, z: 0.0 }       // Mic 4: Top center
    ];

    // Detection thresholds
    this.minConfidence = 0.3;
    this.minEnergy = 0.01;

    // Smoothing for position estimates
    this.positionHistory = [];
    this.maxHistory = 5;
  }

  setMicPositions(positions) {
    this.micPositions = positions;
  }

  /**
   * Process audio data and detect sound sources
   * @param {Float32Array[]} channelData - Audio buffers from each mic
   * @param {number} sampleRate - Sample rate
   * @returns {Array<{ position: {x,y,z}, confidence: number }>}
   */
  process(channelData, sampleRate) {
    const numChannels = channelData.length;

    // Need at least 2 channels for TDOA
    if (numChannels < 2) {
      return [];
    }

    // Check if there's significant audio energy
    const energy = this.calculateEnergy(channelData);
    if (energy < this.minEnergy) {
      return [];
    }

    // Estimate time delays between all mic pairs
    const delays = this.gccPhat.estimateAllDelays(channelData, sampleRate);

    // Filter low-confidence delays
    const validDelays = delays.filter(d => d.confidence > this.minConfidence);

    if (validDelays.length < 2) {
      return [];
    }

    // Triangulate position using TDOA
    const position = this.triangulate(validDelays, numChannels);

    if (!position) {
      return [];
    }

    // Calculate overall confidence
    const avgConfidence = validDelays.reduce((sum, d) => sum + d.confidence, 0) / validDelays.length;

    // Smooth position with history
    const smoothedPosition = this.smoothPosition(position);

    return [{
      position: smoothedPosition,
      confidence: avgConfidence
    }];
  }

  calculateEnergy(channelData) {
    let totalEnergy = 0;
    for (const channel of channelData) {
      for (let i = 0; i < channel.length; i++) {
        totalEnergy += channel[i] * channel[i];
      }
    }
    return totalEnergy / (channelData.length * channelData[0].length);
  }

  /**
   * Triangulate 3D position from time delays
   * Uses iterative least squares to find position that best matches observed delays
   */
  triangulate(delays, numMics) {
    // Initial guess: center of mic array
    let x = 0, y = 0, z = 1;  // Start 1 meter in front

    const maxIterations = 20;
    const tolerance = 0.001;

    for (let iter = 0; iter < maxIterations; iter++) {
      // Calculate Jacobian and residuals
      const { jacobian, residuals } = this.buildSystem(delays, x, y, z);

      if (jacobian.length < 3) {
        return null;  // Not enough constraints
      }

      // Solve J^T * J * delta = J^T * residuals using pseudo-inverse
      const delta = this.solveLinearSystem(jacobian, residuals);

      if (!delta) {
        return null;
      }

      // Update position
      x += delta[0];
      y += delta[1];
      z += delta[2];

      // Check convergence
      const change = Math.sqrt(delta[0]*delta[0] + delta[1]*delta[1] + delta[2]*delta[2]);
      if (change < tolerance) {
        break;
      }
    }

    // Sanity check: source should be within reasonable range
    const distance = Math.sqrt(x*x + y*y + z*z);
    if (distance > 20 || distance < 0.1) {
      return null;
    }

    return { x, y, z };
  }

  buildSystem(delays, x, y, z) {
    const jacobian = [];
    const residuals = [];

    for (const { i, j, delay } of delays) {
      const mic_i = this.micPositions[i];
      const mic_j = this.micPositions[j];

      if (!mic_i || !mic_j) continue;

      // Distance from source to each mic
      const d_i = this.distance(x, y, z, mic_i.x, mic_i.y, mic_i.z);
      const d_j = this.distance(x, y, z, mic_j.x, mic_j.y, mic_j.z);

      // Expected delay based on current position estimate
      const expectedDelay = (d_i - d_j) / SPEED_OF_SOUND;

      // Residual (observed - expected)
      const residual = delay - expectedDelay;
      residuals.push(residual);

      // Partial derivatives of delay with respect to x, y, z
      const dx_i = (x - mic_i.x) / d_i;
      const dy_i = (y - mic_i.y) / d_i;
      const dz_i = (z - mic_i.z) / d_i;

      const dx_j = (x - mic_j.x) / d_j;
      const dy_j = (y - mic_j.y) / d_j;
      const dz_j = (z - mic_j.z) / d_j;

      const ddx = (dx_i - dx_j) / SPEED_OF_SOUND;
      const ddy = (dy_i - dy_j) / SPEED_OF_SOUND;
      const ddz = (dz_i - dz_j) / SPEED_OF_SOUND;

      jacobian.push([ddx, ddy, ddz]);
    }

    return { jacobian, residuals };
  }

  distance(x1, y1, z1, x2, y2, z2) {
    const dx = x1 - x2;
    const dy = y1 - y2;
    const dz = z1 - z2;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  solveLinearSystem(jacobian, residuals) {
    // Solve J^T * J * x = J^T * b using normal equations
    const m = jacobian.length;
    const n = 3;

    // J^T * J (3x3)
    const JTJ = [[0,0,0], [0,0,0], [0,0,0]];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < m; k++) {
          JTJ[i][j] += jacobian[k][i] * jacobian[k][j];
        }
      }
    }

    // J^T * b (3x1)
    const JTb = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < m; k++) {
        JTb[i] += jacobian[k][i] * residuals[k];
      }
    }

    // Solve 3x3 system using Cramer's rule
    const det = this.det3x3(JTJ);
    if (Math.abs(det) < 1e-10) {
      return null;  // Singular matrix
    }

    const x = [];
    for (let col = 0; col < 3; col++) {
      const modified = JTJ.map((row, i) =>
        row.map((val, j) => j === col ? JTb[i] : val)
      );
      x.push(this.det3x3(modified) / det);
    }

    return x;
  }

  det3x3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  smoothPosition(position) {
    this.positionHistory.push(position);
    if (this.positionHistory.length > this.maxHistory) {
      this.positionHistory.shift();
    }

    // Weighted average, more recent = higher weight
    let x = 0, y = 0, z = 0;
    let totalWeight = 0;

    for (let i = 0; i < this.positionHistory.length; i++) {
      const weight = i + 1;  // Linear weighting
      x += this.positionHistory[i].x * weight;
      y += this.positionHistory[i].y * weight;
      z += this.positionHistory[i].z * weight;
      totalWeight += weight;
    }

    return {
      x: x / totalWeight,
      y: y / totalWeight,
      z: z / totalWeight
    };
  }
}
