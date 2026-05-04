// SoundScape3D - Spatial Audio Source Localization for Meta Quest
// Uses microphone array + TDOA triangulation + AR visualization

import { Scene } from './renderer/scene.js';
import { WebXRManager } from './renderer/webxr.js';
import { SourceMarkers } from './renderer/source-markers.js';
import { MicrophoneArray } from './audio/mic-array.js';
import { SoundTriangulator } from './audio/triangulator.js';

const VERSION = '0.1.0';
console.log(`[SoundScape3D v${VERSION}] Initializing...`);

class SoundScape3D {
  constructor() {
    this.scene = null;
    this.webxr = null;
    this.sourceMarkers = null;
    this.micArray = null;
    this.triangulator = null;

    this.isListening = false;
    this.isInAR = false;

    // Detected sound sources
    this.sources = new Map();  // id -> { position, confidence, color, lastSeen }
    this.nextSourceId = 1;

    // UI elements
    this.startBtn = null;
    this.arBtn = null;
    this.status = null;

    this.render = this.render.bind(this);
  }

  async init() {
    // Get UI elements
    this.startBtn = document.getElementById('start-btn');
    this.arBtn = document.getElementById('ar-btn');
    this.status = document.getElementById('status');
    this.audioViz = document.getElementById('audio-viz');
    this.sourcesContainer = document.getElementById('sources-container');

    // Setup Three.js scene
    const container = document.getElementById('app');
    this.scene = new Scene(container);

    // Setup source markers (AR visualization)
    this.sourceMarkers = new SourceMarkers(this.scene.getScene());

    // Setup WebXR
    this.webxr = new WebXRManager(this.scene);

    // Setup audio processing
    this.micArray = new MicrophoneArray();
    this.triangulator = new SoundTriangulator();

    // UI handlers
    this.startBtn.onclick = () => this.toggleListening();
    this.arBtn.onclick = () => this.toggleAR();

    // Start render loop
    this.scene.startLoop(this.render);

    this.setStatus('Ready - click Start Listening');
  }

  async toggleListening() {
    if (this.isListening) {
      this.stopListening();
    } else {
      await this.startListening();
    }
  }

  async startListening() {
    try {
      this.setStatus('Requesting microphone access...');
      await this.micArray.init();

      // Create mic level visualizers
      this.createMicVisualizers();

      // Subscribe to audio data
      this.micArray.onAudioData = (channelData) => {
        this.processAudioData(channelData);
      };

      this.isListening = true;
      this.startBtn.textContent = 'Stop Listening';
      this.arBtn.disabled = false;
      this.setStatus(`Listening on ${this.micArray.channelCount} channels`);
    } catch (e) {
      console.error('Failed to start listening:', e);
      this.setStatus('Error: ' + e.message);
    }
  }

  stopListening() {
    this.micArray.stop();
    this.isListening = false;
    this.startBtn.textContent = 'Start Listening';
    this.arBtn.disabled = true;
    this.setStatus('Stopped');

    // Clear visualizers
    this.audioViz.innerHTML = '';
  }

  createMicVisualizers() {
    this.audioViz.innerHTML = '';
    this.micLevelFills = [];

    for (let i = 0; i < this.micArray.channelCount; i++) {
      const container = document.createElement('div');
      container.className = 'mic-channel';

      const meter = document.createElement('div');
      meter.className = 'mic-level';

      const fill = document.createElement('div');
      fill.className = 'mic-level-fill';
      fill.style.height = '0%';
      this.micLevelFills.push(fill);

      const label = document.createElement('div');
      label.className = 'mic-label';
      label.textContent = `M${i + 1}`;

      meter.appendChild(fill);
      container.appendChild(meter);
      container.appendChild(label);
      this.audioViz.appendChild(container);
    }
  }

  processAudioData(channelData) {
    // Update mic level visualizers
    for (let i = 0; i < channelData.length; i++) {
      const rms = this.calculateRMS(channelData[i]);
      const level = Math.min(100, rms * 500);  // Scale for visibility
      if (this.micLevelFills[i]) {
        this.micLevelFills[i].style.height = `${level}%`;
      }
    }

    // Triangulate sound sources
    const detectedSources = this.triangulator.process(channelData, this.micArray.sampleRate);

    // Update source tracking
    this.updateSources(detectedSources);
  }

  calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  updateSources(detectedSources) {
    const now = performance.now();

    // Update or add detected sources
    for (const detected of detectedSources) {
      // Try to match with existing source
      let matched = false;
      for (const [id, source] of this.sources) {
        const dist = this.distance3D(detected.position, source.position);
        if (dist < 0.3) {  // Within 30cm = same source
          // Update existing source
          source.position = this.lerp3D(source.position, detected.position, 0.3);
          source.confidence = detected.confidence;
          source.lastSeen = now;
          matched = true;
          break;
        }
      }

      if (!matched && detected.confidence > 0.5) {
        // New source
        const id = this.nextSourceId++;
        const color = this.getSourceColor(id);
        this.sources.set(id, {
          position: detected.position,
          confidence: detected.confidence,
          color: color,
          lastSeen: now
        });
      }
    }

    // Remove stale sources (not seen in 2 seconds)
    for (const [id, source] of this.sources) {
      if (now - source.lastSeen > 2000) {
        this.sources.delete(id);
      }
    }

    // Update visualizations
    this.updateSourcesUI();
    this.sourceMarkers.update(this.sources);
  }

  distance3D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  lerp3D(a, b, t) {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t
    };
  }

  getSourceColor(id) {
    const hue = (id * 137.5) % 360;  // Golden angle for good distribution
    return `hsl(${hue}, 80%, 60%)`;
  }

  updateSourcesUI() {
    if (this.sources.size === 0) {
      this.sourcesContainer.innerHTML = '<div style="color: #666; font-size: 11px;">No sources detected</div>';
      return;
    }

    this.sourcesContainer.innerHTML = '';
    for (const [id, source] of this.sources) {
      const item = document.createElement('div');
      item.className = 'source-item';

      const dot = document.createElement('div');
      dot.className = 'source-dot';
      dot.style.background = source.color;

      const label = document.createElement('span');
      const pos = source.position;
      label.textContent = `Source ${id}: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;

      item.appendChild(dot);
      item.appendChild(label);
      this.sourcesContainer.appendChild(item);
    }
  }

  async toggleAR() {
    if (this.isInAR) {
      await this.webxr.endSession();
      this.isInAR = false;
      this.arBtn.textContent = 'Enter AR';
    } else {
      try {
        await this.webxr.startSession();
        this.isInAR = true;
        this.arBtn.textContent = 'Exit AR';
      } catch (e) {
        console.error('Failed to start AR:', e);
        this.setStatus('AR not available: ' + e.message);
      }
    }
  }

  setStatus(msg) {
    this.status.textContent = msg;
  }

  render(time, frame) {
    // Update XR if in session
    if (this.webxr.isPresenting && frame) {
      this.webxr.update(frame);
    }

    // Render scene
    this.scene.render();
  }
}

// Initialize app
const app = new SoundScape3D();
app.init().then(() => {
  console.log('[SoundScape3D] Initialized');
}).catch(err => {
  console.error('Failed to initialize:', err);
});
