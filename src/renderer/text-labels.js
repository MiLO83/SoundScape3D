// 3D Text Labels - Displays text at world positions
// Used for showing speech transcripts at triangulated source locations

import * as THREE from 'three';

/**
 * Renders text labels in 3D space using canvas textures
 */
export class TextLabels {
  constructor(scene) {
    this.scene = scene;
    this.labels = new Map();  // id -> { sprite, text, position, lastUpdate }

    // Text styling
    this.fontSize = 48;
    this.fontFamily = 'Arial, sans-serif';
    this.textColor = '#ffffff';
    this.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    this.padding = 16;
    this.maxWidth = 400;
    this.borderRadius = 8;

    // Label behavior
    this.fadeTime = 5000;  // ms before label starts fading
    this.fadeOutTime = 2000;  // ms to fully fade out
    this.billboarding = true;  // Always face camera

    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupOldLabels(), 1000);
  }

  /**
   * Create or update a text label
   * @param {string|number} id - Label identifier
   * @param {string} text - Text to display
   * @param {Object} position - World position {x, y, z}
   * @param {Object} options - Style overrides
   */
  setLabel(id, text, position, options = {}) {
    // Get or create label
    let label = this.labels.get(id);

    if (!label) {
      label = this.createLabel(id);
      this.labels.set(id, label);
    }

    // Update text if changed
    if (label.text !== text) {
      this.updateLabelTexture(label, text, options);
      label.text = text;
    }

    // Update position
    label.sprite.position.set(position.x, position.y + 0.3, position.z);  // Offset above source
    label.position = { ...position };
    label.lastUpdate = Date.now();
    label.opacity = 1;
  }

  /**
   * Create a new label sprite
   */
  createLabel(id) {
    // Create canvas for texture
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1, 0.25, 1);  // Will be updated based on text size
    sprite.renderOrder = 1000;  // Render on top

    this.scene.add(sprite);

    return {
      id,
      sprite,
      canvas,
      texture,
      material,
      text: '',
      position: { x: 0, y: 0, z: 0 },
      lastUpdate: Date.now(),
      opacity: 1
    };
  }

  /**
   * Update label texture with new text
   */
  updateLabelTexture(label, text, options = {}) {
    const canvas = label.canvas;
    const ctx = canvas.getContext('2d');

    const fontSize = options.fontSize || this.fontSize;
    const fontFamily = options.fontFamily || this.fontFamily;
    const textColor = options.textColor || this.textColor;
    const bgColor = options.backgroundColor || this.backgroundColor;
    const padding = options.padding || this.padding;

    // Set font for measuring
    ctx.font = `bold ${fontSize}px ${fontFamily}`;

    // Word wrap text
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > this.maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    // Calculate dimensions
    const lineHeight = fontSize * 1.2;
    const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
    const textHeight = lines.length * lineHeight;

    const canvasWidth = textWidth + padding * 2;
    const canvasHeight = textHeight + padding * 2;

    // Resize canvas if needed
    canvas.width = Math.min(1024, Math.ceil(canvasWidth));
    canvas.height = Math.min(512, Math.ceil(canvasHeight));

    // Clear and draw background
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Rounded rectangle background
    ctx.fillStyle = bgColor;
    this.roundRect(ctx, 0, 0, canvas.width, canvas.height, this.borderRadius);
    ctx.fill();

    // Draw text
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const startY = padding + lineHeight / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], canvas.width / 2, startY + i * lineHeight);
    }

    // Update texture
    label.texture.needsUpdate = true;

    // Update sprite scale based on canvas size
    const scale = 0.003;  // World units per pixel
    label.sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  }

  /**
   * Draw rounded rectangle
   */
  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  /**
   * Remove a label
   * @param {string|number} id
   */
  removeLabel(id) {
    const label = this.labels.get(id);
    if (label) {
      this.scene.remove(label.sprite);
      label.texture.dispose();
      label.material.dispose();
      this.labels.delete(id);
    }
  }

  /**
   * Update labels (call each frame for fading and billboarding)
   * @param {THREE.Camera} camera
   */
  update(camera) {
    const now = Date.now();

    for (const [id, label] of this.labels) {
      // Billboarding - face camera
      if (this.billboarding && camera) {
        label.sprite.quaternion.copy(camera.quaternion);
      }

      // Fade out old labels
      const age = now - label.lastUpdate;
      if (age > this.fadeTime) {
        const fadeProgress = Math.min(1, (age - this.fadeTime) / this.fadeOutTime);
        label.opacity = 1 - fadeProgress;
        label.material.opacity = label.opacity;

        if (label.opacity <= 0) {
          this.removeLabel(id);
        }
      }
    }
  }

  /**
   * Cleanup old labels
   */
  cleanupOldLabels() {
    const now = Date.now();
    const maxAge = this.fadeTime + this.fadeOutTime + 1000;

    for (const [id, label] of this.labels) {
      if (now - label.lastUpdate > maxAge) {
        this.removeLabel(id);
      }
    }
  }

  /**
   * Get all active labels
   */
  getLabels() {
    return this.labels;
  }

  /**
   * Set fade timing
   * @param {number} fadeTime - ms before fading starts
   * @param {number} fadeOutTime - ms to fade out
   */
  setFadeTiming(fadeTime, fadeOutTime) {
    this.fadeTime = fadeTime;
    this.fadeOutTime = fadeOutTime;
  }

  /**
   * Cleanup
   */
  dispose() {
    clearInterval(this.cleanupInterval);

    for (const id of this.labels.keys()) {
      this.removeLabel(id);
    }
  }
}
