// Microphone Array Handler
// Captures multi-channel audio from device microphones

export class MicrophoneArray {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.analyserNodes = [];
    this.scriptProcessor = null;  // For raw audio data access

    this.channelCount = 0;
    this.sampleRate = 48000;
    this.bufferSize = 2048;  // ~42ms at 48kHz - good balance for TDOA

    // Callback for audio data
    this.onAudioData = null;

    // Quest 3 mic positions (approximate, in meters, relative to headset center)
    // These are estimates - actual positions may vary
    this.micPositions = [
      { x: -0.08, y: 0.02, z: 0.05 },   // Left front
      { x: 0.08, y: 0.02, z: 0.05 },    // Right front
      { x: -0.06, y: -0.02, z: -0.03 }, // Left bottom
      { x: 0.06, y: -0.02, z: -0.03 },  // Right bottom
      { x: 0.0, y: 0.04, z: 0.0 }       // Top center
    ];
  }

  async init() {
    try {
      // Request audio with specific constraints for multi-channel
      // Note: Browser support for multi-channel getUserMedia varies
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,  // We want raw audio
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 5 },  // Request 5 channels for Quest
          sampleRate: { ideal: 48000 }
        }
      });

      // Create audio context
      this.audioContext = new AudioContext({ sampleRate: 48000 });
      this.sampleRate = this.audioContext.sampleRate;

      // Create source from stream
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Get actual channel count
      const tracks = this.mediaStream.getAudioTracks();
      const settings = tracks[0].getSettings();
      this.channelCount = settings.channelCount || 1;

      console.log(`[MicArray] Initialized with ${this.channelCount} channels at ${this.sampleRate}Hz`);

      // If only 1 channel, we can still do basic processing but no TDOA
      if (this.channelCount < 2) {
        console.warn('[MicArray] Only 1 channel available - TDOA triangulation disabled');
      }

      // Create channel splitter
      const splitter = this.audioContext.createChannelSplitter(this.channelCount);
      this.sourceNode.connect(splitter);

      // Create analyser for each channel
      for (let i = 0; i < this.channelCount; i++) {
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = this.bufferSize * 2;
        splitter.connect(analyser, i);
        this.analyserNodes.push(analyser);
      }

      // Use AudioWorklet for better performance (if available) or ScriptProcessor
      if (this.audioContext.audioWorklet) {
        await this.setupAudioWorklet();
      } else {
        this.setupScriptProcessor();
      }

      return true;
    } catch (e) {
      console.error('[MicArray] Init failed:', e);
      throw e;
    }
  }

  async setupAudioWorklet() {
    try {
      // Create inline worklet code
      const workletCode = `
        class AudioCaptureProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.buffers = [];
            this.bufferSize = 2048;
          }

          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (input.length === 0) return true;

            // Collect samples
            const channelData = [];
            for (let ch = 0; ch < input.length; ch++) {
              channelData.push(new Float32Array(input[ch]));
            }

            // Send to main thread
            this.port.postMessage({ channelData });

            return true;
          }
        }
        registerProcessor('audio-capture', AudioCaptureProcessor);
      `;

      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);

      await this.audioContext.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const workletNode = new AudioWorkletNode(this.audioContext, 'audio-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: this.channelCount
      });

      this.sourceNode.connect(workletNode);

      // Handle messages from worklet
      let accumulatedBuffers = Array(this.channelCount).fill(null).map(() => []);

      workletNode.port.onmessage = (e) => {
        const { channelData } = e.data;

        // Accumulate samples until we have enough for processing
        for (let ch = 0; ch < channelData.length; ch++) {
          accumulatedBuffers[ch].push(...channelData[ch]);
        }

        // Process when we have enough samples
        if (accumulatedBuffers[0].length >= this.bufferSize) {
          const processBuffers = accumulatedBuffers.map(buf =>
            new Float32Array(buf.slice(0, this.bufferSize))
          );

          // Keep remaining samples
          accumulatedBuffers = accumulatedBuffers.map(buf =>
            buf.slice(this.bufferSize)
          );

          if (this.onAudioData) {
            this.onAudioData(processBuffers);
          }
        }
      };

      console.log('[MicArray] Using AudioWorklet');
    } catch (e) {
      console.warn('[MicArray] AudioWorklet failed, falling back to ScriptProcessor:', e);
      this.setupScriptProcessor();
    }
  }

  setupScriptProcessor() {
    // Fallback for browsers without AudioWorklet
    this.scriptProcessor = this.audioContext.createScriptProcessor(
      this.bufferSize,
      this.channelCount,
      this.channelCount
    );

    this.sourceNode.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);

    this.scriptProcessor.onaudioprocess = (e) => {
      const channelData = [];
      for (let i = 0; i < this.channelCount; i++) {
        channelData.push(new Float32Array(e.inputBuffer.getChannelData(i)));
      }

      if (this.onAudioData) {
        this.onAudioData(channelData);
      }
    };

    console.log('[MicArray] Using ScriptProcessor (deprecated)');
  }

  getMicPositions() {
    return this.micPositions.slice(0, this.channelCount);
  }

  stop() {
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.analyserNodes = [];
    console.log('[MicArray] Stopped');
  }
}
