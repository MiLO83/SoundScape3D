// Speech Recognition Module
// Uses Web Speech API to transcribe audio to text
// Supports both live microphone input and processed audio buffers

/**
 * Speech recognizer with support for displaying transcripts at 3D positions
 */
export class SpeechRecognizer {
  constructor() {
    // Check for Web Speech API support
    this.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!this.SpeechRecognition;

    if (!this.supported) {
      console.warn('[SpeechRecognizer] Web Speech API not supported in this browser');
    }

    this.recognition = null;
    this.isListening = false;

    // Transcript history per source
    this.transcripts = new Map();  // sourceId -> { text, timestamp, position }

    // Callbacks
    this.onTranscript = null;  // (sourceId, text, position) => void
    this.onInterim = null;     // (sourceId, text, position) => void

    // Settings
    this.language = 'en-US';
    this.continuous = true;
    this.interimResults = true;

    // For processing audio buffers (workaround since Web Speech API needs mic)
    this.audioContext = null;
    this.mediaStreamDestination = null;

    // Active recognizers per source
    this.sourceRecognizers = new Map();
  }

  /**
   * Initialize the speech recognizer
   */
  async init() {
    if (!this.supported) {
      throw new Error('Web Speech API not supported');
    }

    // Create audio context for routing processed audio
    this.audioContext = new AudioContext();
    this.mediaStreamDestination = this.audioContext.createMediaStreamDestination();

    console.log('[SpeechRecognizer] Initialized');
  }

  /**
   * Start recognition for a specific source
   * @param {string|number} sourceId - Source identifier
   * @param {Object} position - 3D position {x, y, z}
   */
  startForSource(sourceId, position = { x: 0, y: 0, z: 0 }) {
    if (!this.supported) return;

    // Stop existing recognizer for this source
    this.stopForSource(sourceId);

    const recognition = new this.SpeechRecognition();
    recognition.lang = this.language;
    recognition.continuous = this.continuous;
    recognition.interimResults = this.interimResults;

    recognition.onresult = (event) => {
      this.handleResult(sourceId, position, event);
    };

    recognition.onerror = (event) => {
      console.error(`[SpeechRecognizer] Error for source ${sourceId}:`, event.error);
      if (event.error === 'no-speech' || event.error === 'audio-capture') {
        // Restart on recoverable errors
        setTimeout(() => {
          if (this.sourceRecognizers.has(sourceId)) {
            this.startForSource(sourceId, position);
          }
        }, 1000);
      }
    };

    recognition.onend = () => {
      // Restart if still active
      if (this.sourceRecognizers.has(sourceId)) {
        recognition.start();
      }
    };

    try {
      recognition.start();
      this.sourceRecognizers.set(sourceId, { recognition, position });
      console.log(`[SpeechRecognizer] Started for source ${sourceId}`);
    } catch (e) {
      console.error('[SpeechRecognizer] Failed to start:', e);
    }
  }

  /**
   * Stop recognition for a source
   * @param {string|number} sourceId
   */
  stopForSource(sourceId) {
    const recognizer = this.sourceRecognizers.get(sourceId);
    if (recognizer) {
      try {
        recognizer.recognition.stop();
      } catch (e) {}
      this.sourceRecognizers.delete(sourceId);
    }
  }

  /**
   * Handle recognition result
   */
  handleResult(sourceId, position, event) {
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        finalTranscript += transcript + ' ';
      } else {
        interimTranscript += transcript;
      }
    }

    // Update transcript history
    if (finalTranscript) {
      const existing = this.transcripts.get(sourceId) || { text: '', history: [] };
      existing.history.push({
        text: finalTranscript.trim(),
        timestamp: Date.now(),
        position: { ...position }
      });

      // Keep only last 10 transcripts per source
      if (existing.history.length > 10) {
        existing.history.shift();
      }

      existing.text = finalTranscript.trim();
      existing.position = position;
      existing.timestamp = Date.now();

      this.transcripts.set(sourceId, existing);

      if (this.onTranscript) {
        this.onTranscript(sourceId, finalTranscript.trim(), position);
      }
    }

    if (interimTranscript && this.onInterim) {
      this.onInterim(sourceId, interimTranscript, position);
    }
  }

  /**
   * Process audio buffer through speech recognition
   * This is a workaround - we play the audio through speakers and hope the mic picks it up
   * Or we use a virtual audio device
   * @param {Float32Array} samples - Audio samples
   * @param {number} sampleRate - Sample rate
   * @param {string|number} sourceId - Source identifier
   * @param {Object} position - 3D position
   */
  async processAudioBuffer(samples, sampleRate, sourceId, position) {
    if (!this.audioContext) {
      await this.init();
    }

    // Note: Web Speech API doesn't support direct audio buffer input
    // This creates an audio buffer that could be played
    // For real transcription of processed audio, you'd need:
    // 1. A cloud speech API (Google, Azure, etc.)
    // 2. Local Whisper model via WebAssembly
    // 3. Play audio and have mic pick it up (echo-based, not ideal)

    // For now, we'll store the audio and mark it as needing transcription
    const audioData = {
      samples: new Float32Array(samples),
      sampleRate,
      sourceId,
      position: { ...position },
      timestamp: Date.now(),
      transcribed: false
    };

    // Store for potential cloud transcription
    if (!this.pendingTranscriptions) {
      this.pendingTranscriptions = [];
    }
    this.pendingTranscriptions.push(audioData);

    // Keep only last 5 pending
    while (this.pendingTranscriptions.length > 5) {
      this.pendingTranscriptions.shift();
    }

    return audioData;
  }

  /**
   * Get transcript for a source
   * @param {string|number} sourceId
   * @returns {Object|null} { text, position, timestamp, history }
   */
  getTranscript(sourceId) {
    return this.transcripts.get(sourceId) || null;
  }

  /**
   * Get all transcripts
   * @returns {Map}
   */
  getAllTranscripts() {
    return this.transcripts;
  }

  /**
   * Clear transcripts
   */
  clearTranscripts() {
    this.transcripts.clear();
  }

  /**
   * Stop all recognizers
   */
  stopAll() {
    for (const sourceId of this.sourceRecognizers.keys()) {
      this.stopForSource(sourceId);
    }
  }

  /**
   * Set language for recognition
   * @param {string} lang - Language code (e.g., 'en-US', 'es-ES')
   */
  setLanguage(lang) {
    this.language = lang;
  }
}

/**
 * Alternative: Use local Whisper model via Transformers.js
 * This provides offline speech recognition without cloud APIs
 */
export class WhisperRecognizer {
  constructor() {
    this.pipeline = null;
    this.loading = false;
    this.ready = false;
  }

  /**
   * Load Whisper model (requires transformers.js)
   */
  async load() {
    if (this.loading || this.ready) return;
    this.loading = true;

    try {
      // Dynamic import to avoid bundling if not used
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.0');

      console.log('[WhisperRecognizer] Loading Whisper model...');
      this.pipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
      this.ready = true;
      console.log('[WhisperRecognizer] Model loaded');
    } catch (e) {
      console.error('[WhisperRecognizer] Failed to load:', e);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Transcribe audio buffer
   * @param {Float32Array} samples - Audio samples (must be 16kHz)
   * @returns {Promise<string>} Transcription
   */
  async transcribe(samples) {
    if (!this.ready) {
      await this.load();
    }

    if (!this.pipeline) {
      throw new Error('Whisper model not loaded');
    }

    const result = await this.pipeline(samples);
    return result.text;
  }
}
