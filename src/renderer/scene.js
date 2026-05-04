// Three.js Scene Setup for SoundScape3D
// Handles rendering for both desktop and AR modes

import * as THREE from 'three';

export class Scene {
  constructor(container) {
    this.container = container;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.cameraRig = null;

    this.init();
  }

  init() {
    // Renderer with alpha for AR passthrough
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.setClearColor(0x000000, 0);
    this.container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.01,
      100
    );
    this.camera.position.set(0, 1.6, 0);  // Eye height

    // Camera rig for XR
    this.cameraRig = new THREE.Group();
    this.cameraRig.add(this.camera);
    this.scene.add(this.cameraRig);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.5);
    directional.position.set(0, 5, 5);
    this.scene.add(directional);

    // Grid helper for desktop mode
    const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    grid.position.y = 0;
    this.scene.add(grid);
    this.grid = grid;

    // Axes helper
    const axes = new THREE.AxesHelper(1);
    axes.position.set(0, 0.01, 0);
    this.scene.add(axes);

    // Handle resize
    window.addEventListener('resize', () => this.onResize());

    console.log('[Scene] Initialized');
  }

  onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  getRenderer() {
    return this.renderer;
  }

  getScene() {
    return this.scene;
  }

  getCamera() {
    return this.camera;
  }

  getCameraRig() {
    return this.cameraRig;
  }

  // Hide grid and axes for AR mode
  setARMode(enabled) {
    this.grid.visible = !enabled;
    this.scene.background = enabled ? null : new THREE.Color(0x111111);
  }

  startLoop(callback) {
    this.renderer.setAnimationLoop(callback);
  }

  stopLoop() {
    this.renderer.setAnimationLoop(null);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
