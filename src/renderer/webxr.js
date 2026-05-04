// WebXR Manager for SoundScape3D
// Handles AR passthrough mode on Quest

export class WebXRManager {
  constructor(scene) {
    this.scene = scene;
    this.renderer = scene.getRenderer();
    this.xrSession = null;
    this.xrRefSpace = null;
    this.isPresenting = false;

    // Check for WebXR support
    this.isSupported = false;
    this.checkSupport();
  }

  async checkSupport() {
    if (!navigator.xr) {
      console.log('[WebXR] Not supported');
      return;
    }

    try {
      // Check for AR with passthrough
      this.isSupported = await navigator.xr.isSessionSupported('immersive-ar');
      console.log(`[WebXR] AR supported: ${this.isSupported}`);
    } catch (e) {
      console.warn('[WebXR] Support check failed:', e);
    }
  }

  async startSession() {
    if (!navigator.xr) {
      throw new Error('WebXR not supported');
    }

    try {
      // Request AR session with passthrough
      const sessionOptions = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: [
          'bounded-floor',
          'hand-tracking',
          'hit-test'
        ]
      };

      this.xrSession = await navigator.xr.requestSession('immersive-ar', sessionOptions);

      // Setup session
      this.xrSession.addEventListener('end', () => this.onSessionEnd());

      // Set renderer to use XR
      await this.renderer.xr.setSession(this.xrSession);

      // Get reference space
      this.xrRefSpace = await this.xrSession.requestReferenceSpace('local-floor');

      // Enable AR mode in scene (hide grid, make background transparent)
      this.scene.setARMode(true);

      this.isPresenting = true;
      console.log('[WebXR] AR session started');

    } catch (e) {
      console.error('[WebXR] Failed to start session:', e);
      throw e;
    }
  }

  async endSession() {
    if (this.xrSession) {
      await this.xrSession.end();
    }
  }

  onSessionEnd() {
    this.xrSession = null;
    this.xrRefSpace = null;
    this.isPresenting = false;

    // Restore desktop mode
    this.scene.setARMode(false);

    console.log('[WebXR] Session ended');
  }

  update(frame) {
    if (!this.isPresenting || !frame) return;

    // Get viewer pose
    const pose = frame.getViewerPose(this.xrRefSpace);
    if (!pose) return;

    // The renderer.xr automatically updates camera from pose
    // We can access viewer position for audio processing
    const position = pose.transform.position;
    const orientation = pose.transform.orientation;

    // Store for potential use in audio processing
    this.viewerPosition = {
      x: position.x,
      y: position.y,
      z: position.z
    };

    this.viewerOrientation = {
      x: orientation.x,
      y: orientation.y,
      z: orientation.z,
      w: orientation.w
    };
  }

  getViewerPosition() {
    return this.viewerPosition || { x: 0, y: 1.6, z: 0 };
  }

  getViewerOrientation() {
    return this.viewerOrientation || { x: 0, y: 0, z: 0, w: 1 };
  }
}
