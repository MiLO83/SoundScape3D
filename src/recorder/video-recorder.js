// Video Recorder - Records 3D scene + audio to video files
// Supports WebM (native), MP4, and MKV (via ffmpeg.wasm)
// Supports depth map compositing for Quest 3

/**
 * Records the WebGL canvas and audio to video files
 * Can composite depth map as overlay or side-by-side
 */
export class VideoRecorder {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.audioContext = options.audioContext || null;
    this.audioSource = options.audioSource || null;  // AudioNode to record

    // Recording state
    this.isRecording = false;
    this.isPaused = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // Recording settings
    this.frameRate = options.frameRate || 30;
    this.videoBitsPerSecond = options.videoBitsPerSecond || 8000000;  // 8 Mbps
    this.audioBitsPerSecond = options.audioBitsPerSecond || 128000;   // 128 kbps

    // Output format
    this.outputFormat = options.outputFormat || 'webm';  // 'webm', 'mp4', 'mkv'

    // Depth compositing
    this.depthSensing = options.depthSensing || null;
    this.depthCompositeMode = options.depthCompositeMode || 'none';  // 'none', 'overlay', 'side-by-side', 'picture-in-picture'
    this.depthOpacity = options.depthOpacity || 0.5;
    this.compositeCanvas = null;
    this.compositeCtx = null;

    // FFmpeg for transcoding (loaded on demand)
    this.ffmpeg = null;
    this.ffmpegLoaded = false;

    // Recording duration tracking
    this.startTime = 0;
    this.duration = 0;

    // Animation frame for compositing
    this.compositeAnimationId = null;

    // Callbacks
    this.onStart = null;
    this.onStop = null;
    this.onPause = null;
    this.onResume = null;
    this.onProgress = null;
    this.onError = null;
  }

  /**
   * Set the canvas to record
   * @param {HTMLCanvasElement} canvas
   */
  setCanvas(canvas) {
    this.canvas = canvas;
  }

  /**
   * Set audio source to record
   * @param {AudioContext} audioContext
   * @param {AudioNode} audioSource - The audio node to record from
   */
  setAudioSource(audioContext, audioSource) {
    this.audioContext = audioContext;
    this.audioSource = audioSource;
  }

  /**
   * Set output format
   * @param {'webm'|'mp4'|'mkv'} format
   */
  setOutputFormat(format) {
    this.outputFormat = format.toLowerCase();
  }

  /**
   * Set depth sensing source for compositing
   * @param {DepthSensing} depthSensing
   */
  setDepthSensing(depthSensing) {
    this.depthSensing = depthSensing;
  }

  /**
   * Set depth composite mode
   * @param {'none'|'overlay'|'side-by-side'|'picture-in-picture'} mode
   * @param {number} opacity - Opacity for overlay mode (0-1)
   */
  setDepthCompositeMode(mode, opacity = 0.5) {
    this.depthCompositeMode = mode;
    this.depthOpacity = opacity;

    // Create composite canvas if needed
    if (mode !== 'none' && !this.compositeCanvas) {
      this.createCompositeCanvas();
    }
  }

  /**
   * Create canvas for compositing main view + depth
   */
  createCompositeCanvas() {
    if (!this.canvas) return;

    this.compositeCanvas = document.createElement('canvas');

    if (this.depthCompositeMode === 'side-by-side') {
      // Double width for side-by-side
      this.compositeCanvas.width = this.canvas.width * 2;
      this.compositeCanvas.height = this.canvas.height;
    } else {
      // Same size for overlay and PIP
      this.compositeCanvas.width = this.canvas.width;
      this.compositeCanvas.height = this.canvas.height;
    }

    this.compositeCtx = this.compositeCanvas.getContext('2d');
  }

  /**
   * Render depth data to a canvas
   * @returns {HTMLCanvasElement} Canvas with depth visualization
   */
  renderDepthToCanvas() {
    if (!this.depthSensing || !this.depthSensing.rawDepthData) {
      return null;
    }

    const width = this.depthSensing.depthWidth;
    const height = this.depthSensing.depthHeight;

    if (!this._depthRenderCanvas) {
      this._depthRenderCanvas = document.createElement('canvas');
    }

    this._depthRenderCanvas.width = width;
    this._depthRenderCanvas.height = height;
    const ctx = this._depthRenderCanvas.getContext('2d');

    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const depthData = this.depthSensing.rawDepthData;
    const near = this.depthSensing.nearDepth;
    const far = this.depthSensing.farDepth;

    for (let i = 0; i < depthData.length; i++) {
      const depth = depthData[i];
      const normalized = Math.min(1, Math.max(0, (depth - near) / (far - near)));

      // Heatmap coloring
      const color = this.depthToColor(normalized);
      data[i * 4] = color.r;
      data[i * 4 + 1] = color.g;
      data[i * 4 + 2] = color.b;
      data[i * 4 + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
    return this._depthRenderCanvas;
  }

  /**
   * Convert normalized depth to RGB color (heatmap)
   */
  depthToColor(t) {
    let r, g, b;
    if (t < 0.25) {
      // Blue to Cyan
      r = 0;
      g = Math.floor(t * 4 * 255);
      b = 255;
    } else if (t < 0.5) {
      // Cyan to Green
      r = 0;
      g = 255;
      b = Math.floor((1 - (t - 0.25) * 4) * 255);
    } else if (t < 0.75) {
      // Green to Yellow
      r = Math.floor((t - 0.5) * 4 * 255);
      g = 255;
      b = 0;
    } else {
      // Yellow to Red
      r = 255;
      g = Math.floor((1 - (t - 0.75) * 4) * 255);
      b = 0;
    }
    return { r, g, b };
  }

  /**
   * Composite main canvas with depth map
   */
  compositeFrame() {
    if (!this.compositeCtx || !this.canvas) return;

    const ctx = this.compositeCtx;
    const mainCanvas = this.canvas;

    if (this.depthCompositeMode === 'side-by-side') {
      // Left: main view, Right: depth
      ctx.drawImage(mainCanvas, 0, 0);

      const depthCanvas = this.renderDepthToCanvas();
      if (depthCanvas) {
        ctx.drawImage(depthCanvas, mainCanvas.width, 0, mainCanvas.width, mainCanvas.height);
      } else {
        // Fill with gray if no depth
        ctx.fillStyle = '#333';
        ctx.fillRect(mainCanvas.width, 0, mainCanvas.width, mainCanvas.height);
        ctx.fillStyle = '#666';
        ctx.font = '20px sans-serif';
        ctx.fillText('No Depth Data', mainCanvas.width + 20, mainCanvas.height / 2);
      }

    } else if (this.depthCompositeMode === 'overlay') {
      // Draw main view
      ctx.drawImage(mainCanvas, 0, 0);

      // Overlay depth with opacity
      const depthCanvas = this.renderDepthToCanvas();
      if (depthCanvas) {
        ctx.globalAlpha = this.depthOpacity;
        ctx.drawImage(depthCanvas, 0, 0, mainCanvas.width, mainCanvas.height);
        ctx.globalAlpha = 1;
      }

    } else if (this.depthCompositeMode === 'picture-in-picture') {
      // Draw main view
      ctx.drawImage(mainCanvas, 0, 0);

      // Draw depth in corner (25% size)
      const depthCanvas = this.renderDepthToCanvas();
      if (depthCanvas) {
        const pipWidth = mainCanvas.width * 0.25;
        const pipHeight = mainCanvas.height * 0.25;
        const pipX = mainCanvas.width - pipWidth - 10;
        const pipY = 10;

        // Border
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(pipX - 2, pipY - 2, pipWidth + 4, pipHeight + 4);

        ctx.drawImage(depthCanvas, pipX, pipY, pipWidth, pipHeight);
      }

    } else {
      // No compositing, just copy main canvas
      ctx.drawImage(mainCanvas, 0, 0);
    }
  }

  /**
   * Start composite animation loop
   */
  startCompositeLoop() {
    const loop = () => {
      if (!this.isRecording) return;
      this.compositeFrame();
      this.compositeAnimationId = requestAnimationFrame(loop);
    };
    loop();
  }

  /**
   * Stop composite animation loop
   */
  stopCompositeLoop() {
    if (this.compositeAnimationId) {
      cancelAnimationFrame(this.compositeAnimationId);
      this.compositeAnimationId = null;
    }
  }

  /**
   * Check if browser supports required APIs
   */
  static isSupported() {
    return !!(
      window.MediaRecorder &&
      HTMLCanvasElement.prototype.captureStream
    );
  }

  /**
   * Get supported MIME types for recording
   */
  static getSupportedMimeTypes() {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',  // Some browsers support this
    ];

    return types.filter(type => MediaRecorder.isTypeSupported(type));
  }

  /**
   * Load FFmpeg for transcoding to MP4/MKV
   */
  async loadFFmpeg() {
    if (this.ffmpegLoaded) return;

    try {
      // Dynamic import of ffmpeg.wasm
      const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js');
      const { fetchFile, toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');

      this.ffmpeg = new FFmpeg();

      // Load FFmpeg core
      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.4/dist/esm';
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      this.fetchFile = fetchFile;
      this.ffmpegLoaded = true;
      console.log('[VideoRecorder] FFmpeg loaded');
    } catch (e) {
      console.error('[VideoRecorder] Failed to load FFmpeg:', e);
      throw new Error('FFmpeg loading failed. MP4/MKV export requires FFmpeg.');
    }
  }

  /**
   * Start recording
   */
  async start() {
    if (this.isRecording) {
      console.warn('[VideoRecorder] Already recording');
      return;
    }

    if (!this.canvas) {
      throw new Error('No canvas set for recording');
    }

    // Determine which canvas to record
    let recordCanvas = this.canvas;

    if (this.depthCompositeMode !== 'none' && this.depthSensing) {
      // Create/update composite canvas
      this.createCompositeCanvas();
      recordCanvas = this.compositeCanvas;
    }

    // Create video stream from canvas
    const videoStream = recordCanvas.captureStream(this.frameRate);

    // Create combined stream
    let combinedStream;

    if (this.audioContext && this.audioSource) {
      // Create audio stream from audio node
      const audioDestination = this.audioContext.createMediaStreamDestination();
      this.audioSource.connect(audioDestination);

      // Combine video and audio tracks
      combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks()
      ]);
    } else {
      // Video only
      combinedStream = videoStream;
    }

    // Select best available MIME type
    const supportedTypes = VideoRecorder.getSupportedMimeTypes();
    if (supportedTypes.length === 0) {
      throw new Error('No supported video MIME types found');
    }
    const mimeType = supportedTypes[0];

    // Create MediaRecorder
    this.mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: this.videoBitsPerSecond,
      audioBitsPerSecond: this.audioBitsPerSecond
    });

    this.recordedChunks = [];

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onerror = (event) => {
      console.error('[VideoRecorder] Error:', event.error);
      if (this.onError) this.onError(event.error);
    };

    this.mediaRecorder.onstop = () => {
      this.handleRecordingStop();
    };

    // Start recording with 1 second chunks
    this.mediaRecorder.start(1000);
    this.isRecording = true;
    this.isPaused = false;
    this.startTime = Date.now();

    // Start composite loop if using depth
    if (this.depthCompositeMode !== 'none' && this.depthSensing) {
      this.startCompositeLoop();
    }

    console.log(`[VideoRecorder] Started recording (${mimeType})${this.depthCompositeMode !== 'none' ? ` with depth [${this.depthCompositeMode}]` : ''}`);
    if (this.onStart) this.onStart();

    // Start duration tracking
    this.updateDuration();
  }

  /**
   * Update recording duration
   */
  updateDuration() {
    if (!this.isRecording) return;

    this.duration = (Date.now() - this.startTime) / 1000;
    if (this.onProgress) {
      this.onProgress({
        duration: this.duration,
        chunks: this.recordedChunks.length,
        size: this.recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0)
      });
    }

    if (this.isRecording) {
      requestAnimationFrame(() => this.updateDuration());
    }
  }

  /**
   * Pause recording
   */
  pause() {
    if (!this.isRecording || this.isPaused) return;

    if (this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      this.isPaused = true;
      console.log('[VideoRecorder] Paused');
      if (this.onPause) this.onPause();
    }
  }

  /**
   * Resume recording
   */
  resume() {
    if (!this.isRecording || !this.isPaused) return;

    if (this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this.isPaused = false;
      console.log('[VideoRecorder] Resumed');
      if (this.onResume) this.onResume();
    }
  }

  /**
   * Stop recording and get the video blob
   * @returns {Promise<Blob>} The recorded video blob
   */
  async stop() {
    if (!this.isRecording) {
      console.warn('[VideoRecorder] Not recording');
      return null;
    }

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        const blob = await this.handleRecordingStop();
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }

  /**
   * Handle recording stop - process and optionally transcode
   */
  async handleRecordingStop() {
    this.isRecording = false;
    this.isPaused = false;

    // Stop composite loop
    this.stopCompositeLoop();

    // Create WebM blob from recorded chunks
    const webmBlob = new Blob(this.recordedChunks, { type: 'video/webm' });
    console.log(`[VideoRecorder] Recorded ${this.recordedChunks.length} chunks, ${(webmBlob.size / 1024 / 1024).toFixed(2)} MB`);

    let finalBlob = webmBlob;

    // Transcode to MP4/MKV if needed
    if (this.outputFormat === 'mp4' || this.outputFormat === 'mkv') {
      try {
        finalBlob = await this.transcode(webmBlob, this.outputFormat);
      } catch (e) {
        console.error('[VideoRecorder] Transcoding failed, returning WebM:', e);
        // Fall back to WebM
      }
    }

    if (this.onStop) this.onStop(finalBlob);
    return finalBlob;
  }

  /**
   * Transcode WebM to MP4 or MKV using FFmpeg
   * @param {Blob} webmBlob - Input WebM blob
   * @param {'mp4'|'mkv'} format - Output format
   * @returns {Promise<Blob>}
   */
  async transcode(webmBlob, format) {
    if (!this.ffmpegLoaded) {
      await this.loadFFmpeg();
    }

    const inputName = 'input.webm';
    const outputName = `output.${format}`;

    // Write input file
    await this.ffmpeg.writeFile(inputName, await this.fetchFile(webmBlob));

    // Transcode
    console.log(`[VideoRecorder] Transcoding to ${format.toUpperCase()}...`);

    const ffmpegArgs = format === 'mp4'
      ? ['-i', inputName, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', outputName]
      : ['-i', inputName, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', outputName];

    await this.ffmpeg.exec(ffmpegArgs);

    // Read output file
    const data = await this.ffmpeg.readFile(outputName);
    const mimeType = format === 'mp4' ? 'video/mp4' : 'video/x-matroska';
    const blob = new Blob([data.buffer], { type: mimeType });

    // Cleanup
    await this.ffmpeg.deleteFile(inputName);
    await this.ffmpeg.deleteFile(outputName);

    console.log(`[VideoRecorder] Transcoded to ${format.toUpperCase()}: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    return blob;
  }

  /**
   * Download the recorded video
   * @param {Blob} blob - Video blob to download
   * @param {string} filename - Filename without extension
   */
  download(blob, filename = 'recording') {
    const extension = this.getExtension(blob.type);
    const fullFilename = `${filename}.${extension}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fullFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Cleanup URL after download starts
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    console.log(`[VideoRecorder] Downloaded: ${fullFilename}`);
  }

  /**
   * Get file extension from MIME type
   */
  getExtension(mimeType) {
    if (mimeType.includes('mp4')) return 'mp4';
    if (mimeType.includes('matroska') || mimeType.includes('mkv')) return 'mkv';
    return 'webm';
  }

  /**
   * Get current recording state
   */
  getState() {
    return {
      isRecording: this.isRecording,
      isPaused: this.isPaused,
      duration: this.duration,
      chunks: this.recordedChunks.length,
      size: this.recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0),
      format: this.outputFormat
    };
  }

  /**
   * Take a screenshot of the current canvas
   * @param {string} format - 'png' or 'jpeg'
   * @param {number} quality - JPEG quality (0-1)
   * @returns {Promise<Blob>}
   */
  async screenshot(format = 'png', quality = 0.92) {
    if (!this.canvas) {
      throw new Error('No canvas set');
    }

    return new Promise((resolve) => {
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      this.canvas.toBlob(resolve, mimeType, quality);
    });
  }

  /**
   * Download screenshot
   * @param {string} filename - Filename without extension
   * @param {string} format - 'png' or 'jpeg'
   */
  async downloadScreenshot(filename = 'screenshot', format = 'png') {
    const blob = await this.screenshot(format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Simple audio recorder for capturing mic/processed audio only
 */
export class AudioRecorder {
  constructor(options = {}) {
    this.audioContext = options.audioContext || null;
    this.audioSource = options.audioSource || null;

    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];

    this.audioBitsPerSecond = options.audioBitsPerSecond || 128000;
    this.outputFormat = options.outputFormat || 'webm';  // 'webm', 'mp3', 'wav'

    this.ffmpeg = null;
    this.ffmpegLoaded = false;
  }

  /**
   * Start audio recording
   */
  async start() {
    if (this.isRecording) return;

    if (!this.audioContext || !this.audioSource) {
      throw new Error('No audio source set');
    }

    const destination = this.audioContext.createMediaStreamDestination();
    this.audioSource.connect(destination);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.mediaRecorder = new MediaRecorder(destination.stream, {
      mimeType,
      audioBitsPerSecond: this.audioBitsPerSecond
    });

    this.recordedChunks = [];

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.start(1000);
    this.isRecording = true;
    console.log('[AudioRecorder] Started');
  }

  /**
   * Stop recording and get audio blob
   */
  async stop() {
    if (!this.isRecording) return null;

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        this.isRecording = false;
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }

  /**
   * Download audio file
   */
  download(blob, filename = 'audio') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
