// Depth Sensing Module for Meta Quest 3
// Uses WebXR Depth Sensing API for occlusion and spatial understanding

import * as THREE from 'three';

/**
 * Handles depth sensing from Quest 3's depth sensors
 * Provides depth-based occlusion and surface detection
 */
export class DepthSensing {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    // Depth data
    this.depthTexture = null;
    this.depthDataTexture = null;
    this.depthWidth = 0;
    this.depthHeight = 0;
    this.rawDepthData = null;

    // Depth sensing state
    this.isSupported = false;
    this.isActive = false;
    this.usageMode = 'cpu-optimized';  // or 'gpu-optimized'
    this.dataFormat = 'luminance-alpha';  // or 'float32'

    // Note: Occlusion disabled - markers/labels always render on top

    // Depth visualization
    this.visualizationEnabled = false;
    this.depthVisualizerMesh = null;
    this.depthVisualizerMaterial = null;

    // Depth range (Quest 3 typical range)
    this.nearDepth = 0.1;   // 10cm
    this.farDepth = 10.0;   // 10m

    // Surface detection
    this.surfacePoints = [];
    this.surfaceUpdateInterval = 100;  // ms
    this.lastSurfaceUpdate = 0;

    // Callbacks
    this.onDepthUpdate = null;
    this.onSurfaceDetected = null;
  }

  /**
   * Check if depth sensing is supported
   */
  static async checkSupport() {
    if (!navigator.xr) return false;

    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar');
      if (!supported) return false;

      // Check for depth-sensing feature
      // This is a basic check - actual support determined at session request
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get session init options for depth sensing
   */
  getSessionInit() {
    return {
      requiredFeatures: ['local-floor'],
      optionalFeatures: [
        'depth-sensing',
        'dom-overlay',
        'hit-test'
      ],
      depthSensing: {
        usagePreference: [this.usageMode],
        dataFormatPreference: [this.dataFormat]
      }
    };
  }

  /**
   * Initialize depth sensing for an XR session
   * @param {XRSession} session
   */
  init(session) {
    if (!session.depthUsage) {
      console.warn('[DepthSensing] Depth sensing not available in this session');
      this.isSupported = false;
      return false;
    }

    this.isSupported = true;
    this.usageMode = session.depthUsage;
    this.dataFormat = session.depthDataFormat;

    console.log(`[DepthSensing] Initialized: ${this.usageMode}, ${this.dataFormat}`);

    // Create depth visualizer (no occlusion - markers always on top)
    this.createDepthVisualizer();

    this.isActive = true;
    return true;
  }

  /**
   * Create depth visualization mesh
   */
  createDepthVisualizer() {
    // Plane to display depth texture
    const geometry = new THREE.PlaneGeometry(0.3, 0.2);

    this.depthVisualizerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        depthTexture: { value: null },
        nearDepth: { value: this.nearDepth },
        farDepth: { value: this.farDepth }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D depthTexture;
        uniform float nearDepth;
        uniform float farDepth;
        varying vec2 vUv;

        vec3 heatmap(float t) {
          // Blue -> Cyan -> Green -> Yellow -> Red
          vec3 c;
          if (t < 0.25) {
            c = mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), t * 4.0);
          } else if (t < 0.5) {
            c = mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), (t - 0.25) * 4.0);
          } else if (t < 0.75) {
            c = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.5) * 4.0);
          } else {
            c = mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (t - 0.75) * 4.0);
          }
          return c;
        }

        void main() {
          vec4 depthSample = texture2D(depthTexture, vUv);
          float depth = depthSample.r + depthSample.g / 255.0;

          // Normalize to 0-1 range
          float normalizedDepth = clamp(depth, 0.0, 1.0);

          // Apply heatmap coloring
          vec3 color = heatmap(normalizedDepth);

          gl_FragColor = vec4(color, 0.8);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide
    });

    this.depthVisualizerMesh = new THREE.Mesh(geometry, this.depthVisualizerMaterial);
    this.depthVisualizerMesh.visible = false;
    this.depthVisualizerMesh.renderOrder = 1000;

    // Position in corner of view
    this.depthVisualizerMesh.position.set(0.25, -0.15, -0.5);

    this.scene.add(this.depthVisualizerMesh);
  }

  /**
   * Update depth data from XR frame
   * @param {XRFrame} frame
   * @param {XRReferenceSpace} referenceSpace
   * @param {XRView} view
   */
  update(frame, referenceSpace, view) {
    if (!this.isActive || !this.isSupported) return;

    try {
      // Get depth information for this view
      const depthInfo = frame.getDepthInformation(view);
      if (!depthInfo) return;

      this.depthWidth = depthInfo.width;
      this.depthHeight = depthInfo.height;

      // Get raw depth data
      if (this.usageMode === 'cpu-optimized') {
        this.updateCPUDepth(depthInfo);
      } else {
        this.updateGPUDepth(depthInfo);
      }

      // Update visualizer position to follow camera
      if (this.depthVisualizerMesh && this.visualizationEnabled) {
        const camera = this.renderer.xr.getCamera();
        this.depthVisualizerMesh.position.copy(camera.position);
        this.depthVisualizerMesh.quaternion.copy(camera.quaternion);
        this.depthVisualizerMesh.translateX(0.25);
        this.depthVisualizerMesh.translateY(-0.15);
        this.depthVisualizerMesh.translateZ(-0.5);
      }

      // Detect surfaces periodically
      const now = performance.now();
      if (now - this.lastSurfaceUpdate > this.surfaceUpdateInterval) {
        this.detectSurfaces(depthInfo, view);
        this.lastSurfaceUpdate = now;
      }

      if (this.onDepthUpdate) {
        this.onDepthUpdate(depthInfo);
      }
    } catch (e) {
      // Depth info may not be available for all frames
    }
  }

  /**
   * Update depth using CPU-optimized mode
   */
  updateCPUDepth(depthInfo) {
    // Get depth data as ArrayBuffer
    const depthBuffer = depthInfo.data;
    this.rawDepthData = new Float32Array(depthBuffer);

    // Create or update Three.js texture
    if (!this.depthDataTexture ||
        this.depthDataTexture.image.width !== this.depthWidth ||
        this.depthDataTexture.image.height !== this.depthHeight) {

      // Convert to RGBA for texture
      const rgbaData = new Uint8Array(this.depthWidth * this.depthHeight * 4);

      this.depthDataTexture = new THREE.DataTexture(
        rgbaData,
        this.depthWidth,
        this.depthHeight,
        THREE.RGBAFormat,
        THREE.UnsignedByteType
      );
      this.depthDataTexture.minFilter = THREE.LinearFilter;
      this.depthDataTexture.magFilter = THREE.LinearFilter;
    }

    // Convert depth to RGBA
    const rgbaData = this.depthDataTexture.image.data;
    for (let i = 0; i < this.rawDepthData.length; i++) {
      const depth = this.rawDepthData[i];
      const normalized = Math.min(1, Math.max(0, (depth - this.nearDepth) / (this.farDepth - this.nearDepth)));

      // Encode as luminance-alpha (high byte in R, low byte in G)
      const encoded = Math.floor(normalized * 65535);
      rgbaData[i * 4] = (encoded >> 8) & 0xFF;      // R: high byte
      rgbaData[i * 4 + 1] = encoded & 0xFF;         // G: low byte
      rgbaData[i * 4 + 2] = 0;                       // B: unused
      rgbaData[i * 4 + 3] = 255;                     // A: fully opaque
    }

    this.depthDataTexture.needsUpdate = true;

    // Update visualizer shader
    if (this.depthVisualizerMaterial) {
      this.depthVisualizerMaterial.uniforms.depthTexture.value = this.depthDataTexture;
    }
  }

  /**
   * Update depth using GPU-optimized mode
   */
  updateGPUDepth(depthInfo) {
    // GPU mode provides WebGL texture directly
    const glBinding = this.renderer.xr.getBinding();
    if (!glBinding) return;

    const depthTexture = glBinding.getDepthInformation(depthInfo);
    if (!depthTexture) return;

    // Use the GPU texture directly
    // Note: This requires WebXR layers support
    this.depthTexture = depthTexture;

    if (this.depthVisualizerMaterial) {
      this.depthVisualizerMaterial.uniforms.depthTexture.value = this.depthTexture;
    }
  }

  /**
   * Detect surfaces from depth data
   */
  detectSurfaces(depthInfo, view) {
    if (!this.rawDepthData) return;

    this.surfacePoints = [];

    // Sample depth at grid points
    const gridSize = 8;
    const stepX = Math.floor(this.depthWidth / gridSize);
    const stepY = Math.floor(this.depthHeight / gridSize);

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const px = x * stepX + stepX / 2;
        const py = y * stepY + stepY / 2;
        const idx = py * this.depthWidth + px;

        if (idx < this.rawDepthData.length) {
          const depth = this.rawDepthData[idx];

          if (depth > this.nearDepth && depth < this.farDepth) {
            // Convert to 3D point using depth info transform
            const normX = (px / this.depthWidth) * 2 - 1;
            const normY = 1 - (py / this.depthHeight) * 2;

            // Use view projection to get world position
            // This is approximate - real implementation needs proper unprojection
            const point = {
              x: normX * depth * 0.5,
              y: normY * depth * 0.5,
              z: -depth,
              depth: depth
            };

            this.surfacePoints.push(point);
          }
        }
      }
    }

    if (this.onSurfaceDetected && this.surfacePoints.length > 0) {
      this.onSurfaceDetected(this.surfacePoints);
    }
  }

  /**
   * Get depth at a specific screen position
   * @param {number} screenX - X position (0-1)
   * @param {number} screenY - Y position (0-1)
   * @returns {number|null} Depth in meters, or null if not available
   */
  getDepthAt(screenX, screenY) {
    if (!this.rawDepthData || !this.depthWidth || !this.depthHeight) {
      return null;
    }

    const px = Math.floor(screenX * this.depthWidth);
    const py = Math.floor(screenY * this.depthHeight);
    const idx = py * this.depthWidth + px;

    if (idx >= 0 && idx < this.rawDepthData.length) {
      return this.rawDepthData[idx];
    }

    return null;
  }

  /**
   * Get average depth in a region
   * @param {number} centerX - Center X (0-1)
   * @param {number} centerY - Center Y (0-1)
   * @param {number} radius - Radius in normalized coords
   * @returns {number|null} Average depth in meters
   */
  getAverageDepth(centerX, centerY, radius = 0.05) {
    if (!this.rawDepthData) return null;

    let sum = 0;
    let count = 0;

    const radiusPx = Math.floor(radius * Math.max(this.depthWidth, this.depthHeight));
    const cx = Math.floor(centerX * this.depthWidth);
    const cy = Math.floor(centerY * this.depthHeight);

    for (let dy = -radiusPx; dy <= radiusPx; dy++) {
      for (let dx = -radiusPx; dx <= radiusPx; dx++) {
        if (dx * dx + dy * dy <= radiusPx * radiusPx) {
          const px = cx + dx;
          const py = cy + dy;

          if (px >= 0 && px < this.depthWidth && py >= 0 && py < this.depthHeight) {
            const idx = py * this.depthWidth + px;
            const depth = this.rawDepthData[idx];

            if (depth > this.nearDepth && depth < this.farDepth) {
              sum += depth;
              count++;
            }
          }
        }
      }
    }

    return count > 0 ? sum / count : null;
  }

  /**
   * Enable/disable depth visualization
   */
  setVisualizationEnabled(enabled) {
    this.visualizationEnabled = enabled;
    if (this.depthVisualizerMesh) {
      this.depthVisualizerMesh.visible = enabled;
    }
  }

  /**
   * Get current depth statistics
   */
  getStats() {
    if (!this.rawDepthData) {
      return { available: false };
    }

    let min = Infinity, max = -Infinity, sum = 0, count = 0;

    for (let i = 0; i < this.rawDepthData.length; i++) {
      const d = this.rawDepthData[i];
      if (d > this.nearDepth && d < this.farDepth) {
        min = Math.min(min, d);
        max = Math.max(max, d);
        sum += d;
        count++;
      }
    }

    return {
      available: true,
      width: this.depthWidth,
      height: this.depthHeight,
      minDepth: min,
      maxDepth: max,
      avgDepth: count > 0 ? sum / count : 0,
      validPixels: count,
      totalPixels: this.rawDepthData.length
    };
  }

  /**
   * Cleanup
   */
  dispose() {
    if (this.depthDataTexture) {
      this.depthDataTexture.dispose();
    }

    if (this.depthVisualizerMesh) {
      this.scene.remove(this.depthVisualizerMesh);
      this.depthVisualizerMesh.geometry.dispose();
    }

    if (this.depthVisualizerMaterial) {
      this.depthVisualizerMaterial.dispose();
    }

    this.isActive = false;
  }
}
