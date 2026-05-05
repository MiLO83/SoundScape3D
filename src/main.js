// SoundScape3D - Spatial Audio Source Localization for Meta Quest
// Uses microphone array + TDOA triangulation + AR visualization

import { Scene } from './renderer/scene.js';
import { WebXRManager } from './renderer/webxr.js';
import { SourceMarkers } from './renderer/source-markers.js';
import { MicrophoneArray } from './audio/mic-array.js';
import { SoundTriangulator } from './audio/triangulator.js';
import { Beamformer } from './audio/beamformer.js';
import { PitchShifter } from './audio/pitch-shifter.js';
import { CarrierDetector } from './audio/carrier-detector.js';
import { StereoSpatialAnalyzer } from './audio/stereo-spatial.js';
import { Demodulator } from './audio/demodulator.js';
import { SpeechRecognizer } from './audio/speech-recognizer.js';
import { TextLabels } from './renderer/text-labels.js';
import { VideoRecorder } from './recorder/video-recorder.js';
import { DepthSensing } from './renderer/depth-sensing.js';

const VERSION = '0.1.0';
console.log(`[SoundScape3D v${VERSION}] Initializing...`);

class SoundScape3D {
  constructor() {
    this.scene = null;
    this.webxr = null;
    this.sourceMarkers = null;
    this.micArray = null;
    this.triangulator = null;

    // New audio processing modules
    this.beamformer = null;
    this.pitchShifter = null;
    this.carrierDetector = null;
    this.stereoSpatial = null;  // Fallback for stereo-only input
    this.demodulator = null;    // AM/FM demodulation
    this.speechRecognizer = null;  // Speech-to-text
    this.textLabels = null;     // 3D text display
    this.videoRecorder = null;  // Video recording
    this.depthSensing = null;   // Depth sensing for Quest 3

    // Audio output context for speaker playback
    this.outputAudioContext = null;
    this.outputGainNode = null;

    this.isListening = false;
    this.isInAR = false;

    // Detected sound sources
    this.sources = new Map();  // id -> { position, confidence, color, lastSeen, isCarrier, carrierFreq, transcript }
    this.nextSourceId = 1;

    // Selected source for beamforming
    this.selectedSourceId = null;
    this.isBeamforming = false;

    // Feature toggles
    this.pitchShiftEnabled = false;
    this.carrierDetectEnabled = false;
    this.speechRecognitionEnabled = false;
    this.demodulateCarriers = false;

    // UI elements
    this.startBtn = null;
    this.arBtn = null;
    this.status = null;
    this.isolateBtn = null;
    this.pitchShiftToggle = null;
    this.carrierDetectToggle = null;

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

    // Setup new audio processing modules
    this.beamformer = new Beamformer();
    this.pitchShifter = new PitchShifter();
    this.carrierDetector = new CarrierDetector();
    this.stereoSpatial = new StereoSpatialAnalyzer();  // Works with stereo-only input
    this.demodulator = new Demodulator();

    // Setup speech recognition (will init on first use)
    this.speechRecognizer = new SpeechRecognizer();

    // Setup 3D text labels for transcripts
    this.textLabels = new TextLabels(this.scene.getScene());

    // Setup video recorder
    this.videoRecorder = new VideoRecorder({
      canvas: this.scene.getCanvas(),
      frameRate: 30,
      videoBitsPerSecond: 8000000,
      outputFormat: 'webm'
    });

    this.videoRecorder.onProgress = (progress) => {
      if (this.recordBtn) {
        const mins = Math.floor(progress.duration / 60);
        const secs = Math.floor(progress.duration % 60);
        const mb = (progress.size / 1024 / 1024).toFixed(1);
        this.recordBtn.textContent = `REC ${mins}:${secs.toString().padStart(2, '0')} (${mb}MB)`;
      }
    };

    this.videoRecorder.onStop = (blob) => {
      // Auto-download when recording stops
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this.videoRecorder.download(blob, `soundscape3d-${timestamp}`);
    };

    // Setup depth sensing (initialized when AR starts)
    this.depthSensing = new DepthSensing(this.scene.getScene(), this.scene.getRenderer());

    // Connect depth sensing to WebXR manager
    this.webxr.setDepthSensing(this.depthSensing);

    // Connect depth sensing to video recorder
    this.videoRecorder.setDepthSensing(this.depthSensing);

    // Wire up speech recognition callbacks
    this.speechRecognizer.onTranscript = (sourceId, text, position) => {
      console.log(`[Speech] Source ${sourceId}: "${text}"`);
      // Display transcript at source position
      this.textLabels.setLabel(sourceId, text, position);
      // Store transcript in source data
      if (this.sources.has(sourceId)) {
        const source = this.sources.get(sourceId);
        source.transcript = text;
        this.updateSourcesUI();
      }
    };

    this.speechRecognizer.onInterim = (sourceId, text, position) => {
      // Show interim results with different styling
      this.textLabels.setLabel(`interim-${sourceId}`, text, position, {
        backgroundColor: 'rgba(50, 50, 100, 0.7)',
        textColor: '#aaaaff'
      });
    };

    // UI handlers
    this.startBtn.onclick = () => this.toggleListening();
    this.arBtn.onclick = () => this.toggleAR();

    // Create new UI controls
    this.createAudioControls();

    // Start render loop
    this.scene.startLoop(this.render);

    this.setStatus('Ready - click Start Listening');
  }

  createAudioControls() {
    // Find or create controls container
    let controlsContainer = document.getElementById('audio-controls');
    if (!controlsContainer) {
      controlsContainer = document.createElement('div');
      controlsContainer.id = 'audio-controls';
      controlsContainer.className = 'audio-controls';
      // Insert after existing controls
      const existingControls = this.startBtn.parentElement;
      existingControls.parentElement.insertBefore(controlsContainer, existingControls.nextSibling);
    }

    // Isolate Source button
    this.isolateBtn = document.createElement('button');
    this.isolateBtn.id = 'isolate-btn';
    this.isolateBtn.className = 'control-btn';
    this.isolateBtn.textContent = 'Isolate Source';
    this.isolateBtn.disabled = true;
    this.isolateBtn.onclick = () => this.toggleIsolation();
    controlsContainer.appendChild(this.isolateBtn);

    // Shift to Speech toggle
    const pitchShiftLabel = document.createElement('label');
    pitchShiftLabel.className = 'toggle-label';
    this.pitchShiftToggle = document.createElement('input');
    this.pitchShiftToggle.type = 'checkbox';
    this.pitchShiftToggle.id = 'pitch-shift-toggle';
    this.pitchShiftToggle.onchange = () => this.togglePitchShift();
    pitchShiftLabel.appendChild(this.pitchShiftToggle);
    pitchShiftLabel.appendChild(document.createTextNode(' Shift to Speech'));
    controlsContainer.appendChild(pitchShiftLabel);

    // Detect Carriers toggle
    const carrierLabel = document.createElement('label');
    carrierLabel.className = 'toggle-label';
    this.carrierDetectToggle = document.createElement('input');
    this.carrierDetectToggle.type = 'checkbox';
    this.carrierDetectToggle.id = 'carrier-detect-toggle';
    this.carrierDetectToggle.onchange = () => this.toggleCarrierDetect();
    carrierLabel.appendChild(this.carrierDetectToggle);
    carrierLabel.appendChild(document.createTextNode(' Detect Carriers'));
    controlsContainer.appendChild(carrierLabel);

    // Demodulate Carriers toggle
    const demodLabel = document.createElement('label');
    demodLabel.className = 'toggle-label';
    this.demodulateToggle = document.createElement('input');
    this.demodulateToggle.type = 'checkbox';
    this.demodulateToggle.id = 'demodulate-toggle';
    this.demodulateToggle.onchange = () => this.toggleDemodulation();
    demodLabel.appendChild(this.demodulateToggle);
    demodLabel.appendChild(document.createTextNode(' Demodulate'));
    controlsContainer.appendChild(demodLabel);

    // Transcribe Speech toggle
    const transcribeLabel = document.createElement('label');
    transcribeLabel.className = 'toggle-label';
    this.transcribeToggle = document.createElement('input');
    this.transcribeToggle.type = 'checkbox';
    this.transcribeToggle.id = 'transcribe-toggle';
    this.transcribeToggle.onchange = () => this.toggleTranscription();
    transcribeLabel.appendChild(this.transcribeToggle);
    transcribeLabel.appendChild(document.createTextNode(' Transcribe'));
    controlsContainer.appendChild(transcribeLabel);

    // Separator
    const separator = document.createElement('div');
    separator.style.borderTop = '1px solid #444';
    separator.style.margin = '8px 0';
    controlsContainer.appendChild(separator);

    // Recording controls
    const recordingSection = document.createElement('div');
    recordingSection.className = 'recording-section';

    // Format selector
    const formatLabel = document.createElement('label');
    formatLabel.className = 'toggle-label';
    formatLabel.textContent = 'Format: ';
    this.formatSelect = document.createElement('select');
    this.formatSelect.id = 'format-select';
    this.formatSelect.innerHTML = `
      <option value="webm">WebM</option>
      <option value="mp4">MP4</option>
      <option value="mkv">MKV</option>
    `;
    this.formatSelect.onchange = () => {
      this.videoRecorder.setOutputFormat(this.formatSelect.value);
    };
    formatLabel.appendChild(this.formatSelect);
    recordingSection.appendChild(formatLabel);

    // Depth composite selector
    const depthLabel = document.createElement('label');
    depthLabel.className = 'toggle-label';
    depthLabel.textContent = 'Depth: ';
    this.depthCompositeSelect = document.createElement('select');
    this.depthCompositeSelect.id = 'depth-composite-select';
    this.depthCompositeSelect.innerHTML = `
      <option value="none">None</option>
      <option value="overlay">Overlay</option>
      <option value="side-by-side">Side-by-Side</option>
      <option value="picture-in-picture">PIP</option>
    `;
    this.depthCompositeSelect.onchange = () => {
      const mode = this.depthCompositeSelect.value;
      this.videoRecorder.setDepthCompositeMode(mode, 0.4);
      this.depthSensing.setVisualizationEnabled(mode !== 'none');
    };
    depthLabel.appendChild(this.depthCompositeSelect);
    recordingSection.appendChild(depthLabel);

    // Record button
    this.recordBtn = document.createElement('button');
    this.recordBtn.id = 'record-btn';
    this.recordBtn.className = 'control-btn record-btn';
    this.recordBtn.textContent = 'Record';
    this.recordBtn.onclick = () => this.toggleRecording();
    recordingSection.appendChild(this.recordBtn);

    // Screenshot button
    this.screenshotBtn = document.createElement('button');
    this.screenshotBtn.id = 'screenshot-btn';
    this.screenshotBtn.className = 'control-btn';
    this.screenshotBtn.textContent = 'Screenshot';
    this.screenshotBtn.onclick = () => this.takeScreenshot();
    recordingSection.appendChild(this.screenshotBtn);

    // Note about passthrough
    const passthroughNote = document.createElement('div');
    passthroughNote.className = 'passthrough-note';
    passthroughNote.textContent = 'Records 3D overlay only. Use Quest recording for passthrough.';
    recordingSection.appendChild(passthroughNote);

    controlsContainer.appendChild(recordingSection);
  }

  async initAudioOutput() {
    if (this.outputAudioContext) {
      return;  // Already initialized
    }

    // Create audio context for speaker output
    this.outputAudioContext = new AudioContext({ sampleRate: this.micArray.sampleRate });

    // Create gain node for volume control
    this.outputGainNode = this.outputAudioContext.createGain();
    this.outputGainNode.gain.value = 1.0;
    this.outputGainNode.connect(this.outputAudioContext.destination);

    console.log('[SoundScape3D] Audio output initialized');
  }

  toggleIsolation() {
    if (!this.selectedSourceId) {
      this.setStatus('Select a source first');
      return;
    }

    this.isBeamforming = !this.isBeamforming;

    if (this.isBeamforming) {
      this.isolateBtn.textContent = 'Stop Isolation';
      this.isolateBtn.classList.add('active');
      this.setStatus(`Isolating Source ${this.selectedSourceId}`);
    } else {
      this.isolateBtn.textContent = 'Isolate Source';
      this.isolateBtn.classList.remove('active');
      this.setStatus(`Listening on ${this.micArray.channelCount} channels`);
    }
  }

  togglePitchShift() {
    this.pitchShiftEnabled = this.pitchShiftToggle.checked;
    console.log(`[SoundScape3D] Pitch shift: ${this.pitchShiftEnabled ? 'enabled' : 'disabled'}`);
  }

  toggleCarrierDetect() {
    this.carrierDetectEnabled = this.carrierDetectToggle.checked;
    console.log(`[SoundScape3D] Carrier detection: ${this.carrierDetectEnabled ? 'enabled' : 'disabled'}`);

    // Update markers to show/hide carrier indicators
    this.updateSourcesUI();
    this.sourceMarkers.update(this.sources);
  }

  toggleDemodulation() {
    this.demodulateCarriers = this.demodulateToggle.checked;
    console.log(`[SoundScape3D] Demodulation: ${this.demodulateCarriers ? 'enabled' : 'disabled'}`);

    // Auto-enable carrier detection if demodulation is turned on
    if (this.demodulateCarriers && !this.carrierDetectEnabled) {
      this.carrierDetectToggle.checked = true;
      this.toggleCarrierDetect();
    }
  }

  async toggleTranscription() {
    this.speechRecognitionEnabled = this.transcribeToggle.checked;
    console.log(`[SoundScape3D] Transcription: ${this.speechRecognitionEnabled ? 'enabled' : 'disabled'}`);

    if (this.speechRecognitionEnabled) {
      // Initialize speech recognizer if not already
      if (!this.speechRecognizer.supported) {
        this.setStatus('Speech recognition not supported in this browser');
        this.transcribeToggle.checked = false;
        this.speechRecognitionEnabled = false;
        return;
      }

      try {
        await this.speechRecognizer.init();
        this.setStatus('Speech recognition ready');
      } catch (e) {
        console.error('Failed to init speech recognizer:', e);
        this.setStatus('Speech recognition failed: ' + e.message);
        this.transcribeToggle.checked = false;
        this.speechRecognitionEnabled = false;
      }
    } else {
      // Stop all active recognizers
      this.speechRecognizer.stopAll();
    }
  }

  async toggleRecording() {
    if (this.videoRecorder.isRecording) {
      // Stop recording
      this.setStatus('Stopping recording...');
      await this.videoRecorder.stop();
      this.recordBtn.textContent = 'Record';
      this.recordBtn.classList.remove('recording');
      this.formatSelect.disabled = false;
      this.setStatus('Recording saved');
    } else {
      // Start recording
      try {
        // Set audio source if available
        if (this.outputAudioContext && this.outputGainNode) {
          this.videoRecorder.setAudioSource(this.outputAudioContext, this.outputGainNode);
        }

        // Check if MP4/MKV selected - warn about longer processing
        const format = this.formatSelect.value;
        if (format === 'mp4' || format === 'mkv') {
          this.setStatus(`Recording to ${format.toUpperCase()} (transcoding on stop)...`);
        } else {
          this.setStatus('Recording...');
        }

        await this.videoRecorder.start();
        this.recordBtn.textContent = 'REC 0:00';
        this.recordBtn.classList.add('recording');
        this.formatSelect.disabled = true;
      } catch (e) {
        console.error('Failed to start recording:', e);
        this.setStatus('Recording failed: ' + e.message);
      }
    }
  }

  async takeScreenshot() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await this.videoRecorder.downloadScreenshot(`soundscape3d-${timestamp}`, 'png');
      this.setStatus('Screenshot saved');
    } catch (e) {
      console.error('Screenshot failed:', e);
      this.setStatus('Screenshot failed: ' + e.message);
    }
  }

  selectSource(id) {
    this.selectedSourceId = id;
    this.isolateBtn.disabled = false;

    // Update UI to show selection
    this.updateSourcesUI();

    // Update beamformer target if beamforming is active
    if (this.isBeamforming && this.sources.has(id)) {
      const source = this.sources.get(id);
      this.beamformer.setTarget(source.position);
    }
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

      // Initialize audio output for beamformed audio playback
      await this.initAudioOutput();

      // Initialize beamformer with mic positions
      this.beamformer.init(this.micArray.getMicPositions(), this.micArray.sampleRate);

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
    this.isBeamforming = false;
    this.startBtn.textContent = 'Start Listening';
    this.arBtn.disabled = true;
    this.isolateBtn.disabled = true;
    this.isolateBtn.textContent = 'Isolate Source';
    this.isolateBtn.classList.remove('active');
    this.setStatus('Stopped');

    // Close audio output context
    if (this.outputAudioContext) {
      this.outputAudioContext.close();
      this.outputAudioContext = null;
      this.outputGainNode = null;
    }

    // Stop speech recognition
    if (this.speechRecognizer) {
      this.speechRecognizer.stopAll();
    }

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
    // Use full triangulation if we have 3+ channels, otherwise fall back to stereo analysis
    let detectedSources;
    let stereoAnalysis = null;

    if (channelData.length >= 3) {
      // Multi-channel: use TDOA triangulation
      detectedSources = this.triangulator.process(channelData, this.micArray.sampleRate);
    } else if (channelData.length === 2) {
      // Stereo only: extract direction from L/R timing differences
      stereoAnalysis = this.stereoSpatial.analyze(channelData[0], channelData[1]);

      if (stereoAnalysis.confidence > 0.3) {
        // Convert azimuth to 3D position (assume 2m distance, horizontal plane)
        const distance = 2.0;
        const x = Math.sin(stereoAnalysis.azimuth) * distance;
        const z = -Math.cos(stereoAnalysis.azimuth) * distance;

        detectedSources = [{
          position: { x, y: 0, z },
          confidence: stereoAnalysis.confidence,
          itdMs: stereoAnalysis.itd,
          ild: stereoAnalysis.ild,
          method: 'stereo-ITD'
        }];

        // Log stereo analysis details periodically
        if (!this._lastStereoLog || Date.now() - this._lastStereoLog > 2000) {
          this._lastStereoLog = Date.now();
          console.log(`[Stereo] Azimuth: ${stereoAnalysis.azimuthDegrees.toFixed(1)}°, ITD: ${stereoAnalysis.itd.toFixed(2)}ms, ILD: ${stereoAnalysis.ild.toFixed(1)}dB`);
        }
      } else {
        detectedSources = [];
      }
    } else {
      // Mono: can't determine direction
      detectedSources = [];
    }

    // Detect carrier frequencies if enabled
    let carrierInfo = null;
    if (this.carrierDetectEnabled) {
      carrierInfo = this.carrierDetector.detect(channelData, this.micArray.sampleRate);
    }

    // Update source tracking with carrier info
    this.updateSources(detectedSources, carrierInfo);

    // Process carrier demodulation and speech recognition pipeline
    if (this.demodulateCarriers && carrierInfo && carrierInfo.carriers) {
      this.processCarrierSpeech(channelData, carrierInfo, detectedSources);
    }

    // Process beamforming and audio output
    if (this.isBeamforming && this.selectedSourceId && this.sources.has(this.selectedSourceId)) {
      const source = this.sources.get(this.selectedSourceId);
      this.beamformer.setTarget(source.position);

      // Beamform audio toward selected source
      let outputSamples = this.beamformer.process(channelData);

      // Apply pitch shifting if enabled
      if (this.pitchShiftEnabled) {
        outputSamples = this.pitchShifter.process(outputSamples);
      }

      // Route to speakers
      this.playAudioToSpeakers(outputSamples);
    }
  }

  /**
   * Process carrier frequencies through demodulation → pitch shift → speech recognition
   */
  processCarrierSpeech(channelData, carrierInfo, detectedSources) {
    // Use the first channel (or combine channels) as input
    const inputSamples = channelData[0];
    const sampleRate = this.micArray.sampleRate;

    for (const carrier of carrierInfo.carriers) {
      // Skip carriers outside typical modulated range (too low or too high)
      if (carrier.frequency < 1000 || carrier.frequency > 20000) {
        continue;
      }

      // Check signal strength
      if (carrier.amplitude < 0.01) {
        continue;
      }

      // Demodulate the carrier
      const demodResult = this.demodulator.demodulate(inputSamples, carrier);
      let audioSamples = demodResult.audio;

      // Pitch shift to speech range if needed
      // Most carriers above 8kHz need to be shifted down
      if (this.pitchShiftEnabled && carrier.frequency > 4000) {
        // Calculate pitch ratio to bring carrier down to ~300Hz (speech fundamental)
        const targetPitch = 300;
        const ratio = targetPitch / carrier.frequency;

        // Use pitch shifter
        this.pitchShifter.setShiftRatio(ratio);
        audioSamples = this.pitchShifter.process(audioSamples);
      }

      // Find the closest detected source position for this carrier
      let sourcePosition = { x: 0, y: 0, z: 0 };
      let sourceId = `carrier-${Math.round(carrier.frequency)}`;

      // Try to match carrier to a tracked source
      for (const [id, source] of this.sources) {
        if (source.isCarrier && Math.abs(source.carrierFreq - carrier.frequency) < 100) {
          sourcePosition = source.position;
          sourceId = id;
          break;
        }
      }

      // If no matched source, use detected source position if available
      if (sourceId.startsWith('carrier-') && detectedSources.length > 0) {
        sourcePosition = detectedSources[0].position;
      }

      // Send to speech recognizer if enabled
      if (this.speechRecognitionEnabled) {
        // Process audio buffer through speech recognition
        this.speechRecognizer.processAudioBuffer(
          audioSamples,
          sampleRate,
          sourceId,
          sourcePosition
        );

        // Also start live recognition for this source if not already active
        if (!this.speechRecognizer.sourceRecognizers.has(sourceId)) {
          this.speechRecognizer.startForSource(sourceId, sourcePosition);
        }
      }

      // Optionally play the demodulated audio
      if (this.isBeamforming) {
        this.playAudioToSpeakers(audioSamples);
      }
    }
  }

  playAudioToSpeakers(samples) {
    if (!this.outputAudioContext || !this.outputGainNode) {
      return;
    }

    // Create buffer and fill with processed audio
    const buffer = this.outputAudioContext.createBuffer(
      1,  // mono output
      samples.length,
      this.outputAudioContext.sampleRate
    );
    buffer.getChannelData(0).set(samples);

    // Create buffer source and play
    const source = this.outputAudioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputGainNode);
    source.start();
  }

  calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  updateSources(detectedSources, carrierInfo = null) {
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
          lastSeen: now,
          isCarrier: false,
          carrierFreq: null
        });
      }
    }

    // Update carrier detection info for sources
    if (carrierInfo && carrierInfo.carriers && carrierInfo.carriers.length > 0) {
      for (const [id, source] of this.sources) {
        // Check if any carrier frequency is associated with this source direction
        const matchingCarrier = this.carrierDetector.matchSourceToCarrier(
          source.position,
          carrierInfo.carriers
        );
        if (matchingCarrier) {
          source.isCarrier = true;
          source.carrierFreq = matchingCarrier.frequency;
        } else {
          source.isCarrier = false;
          source.carrierFreq = null;
        }
      }
    } else {
      // Clear carrier flags when detection is disabled
      for (const [id, source] of this.sources) {
        source.isCarrier = false;
        source.carrierFreq = null;
      }
    }

    // Remove stale sources (not seen in 2 seconds)
    for (const [id, source] of this.sources) {
      if (now - source.lastSeen > 2000) {
        this.sources.delete(id);
        // Clear selection if deleted
        if (this.selectedSourceId === id) {
          this.selectedSourceId = null;
          this.isolateBtn.disabled = true;
          if (this.isBeamforming) {
            this.toggleIsolation();
          }
        }
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
      if (this.selectedSourceId === id) {
        item.classList.add('selected');
      }

      // Make items clickable for selection
      item.onclick = () => this.selectSource(id);
      item.style.cursor = 'pointer';

      const dot = document.createElement('div');
      dot.className = 'source-dot';
      dot.style.background = source.color;

      // Add carrier indicator if applicable
      if (source.isCarrier && this.carrierDetectEnabled) {
        dot.classList.add('carrier-indicator');
        dot.title = `Carrier: ${source.carrierFreq.toFixed(0)} Hz`;
      }

      const label = document.createElement('span');
      const pos = source.position;
      let labelText = `Source ${id}: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;

      // Add carrier frequency info
      if (source.isCarrier && this.carrierDetectEnabled) {
        labelText += ` [${source.carrierFreq.toFixed(0)} Hz]`;
      }
      label.textContent = labelText;

      // Add transcript if available
      if (source.transcript && this.speechRecognitionEnabled) {
        const transcriptEl = document.createElement('div');
        transcriptEl.className = 'source-transcript';
        transcriptEl.textContent = `"${source.transcript}"`;
        transcriptEl.style.fontSize = '10px';
        transcriptEl.style.color = '#88ff88';
        transcriptEl.style.fontStyle = 'italic';
        transcriptEl.style.marginLeft = '20px';
        transcriptEl.style.maxWidth = '200px';
        transcriptEl.style.overflow = 'hidden';
        transcriptEl.style.textOverflow = 'ellipsis';
        transcriptEl.style.whiteSpace = 'nowrap';
        item.appendChild(transcriptEl);
      }

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

    // Update text labels (billboarding and fading)
    if (this.textLabels) {
      this.textLabels.update(this.scene.getCamera());
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
