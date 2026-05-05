// Source Markers - AR visualization of detected sound sources
// Displays 3D markers at estimated sound source positions

import * as THREE from 'three';

export class SourceMarkers {
  constructor(scene) {
    this.scene = scene;
    this.markers = new Map();  // sourceId -> { mesh, ring, label }

    // Marker geometry (shared)
    this.sphereGeometry = new THREE.SphereGeometry(0.05, 16, 16);
    this.ringGeometry = new THREE.RingGeometry(0.08, 0.12, 32);

    // Pulse animation state
    this.time = 0;
  }

  /**
   * Update markers to match detected sources
   * @param {Map<number, {position, confidence, color, lastSeen}>} sources
   */
  update(sources) {
    this.time += 0.016;  // ~60fps

    // Remove markers for sources no longer present
    for (const [id, marker] of this.markers) {
      if (!sources.has(id)) {
        this.removeMarker(id);
      }
    }

    // Update or create markers for current sources
    for (const [id, source] of sources) {
      if (this.markers.has(id)) {
        this.updateMarker(id, source);
      } else {
        this.createMarker(id, source);
      }
    }
  }

  createMarker(id, source) {
    const color = new THREE.Color(source.color);

    // Main sphere - always on top, no depth testing
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false
    });
    const sphere = new THREE.Mesh(this.sphereGeometry, sphereMaterial);
    sphere.renderOrder = 999;

    // Pulsing ring - always on top
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });
    const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;  // Face up
    ring.renderOrder = 998;

    // Direction line (pointing to source from origin) - always on top
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0)
    ]);
    const lineMaterial = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.3,
      depthTest: false,
      depthWrite: false
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.renderOrder = 997;

    // Group for all marker elements - render on top of everything
    const group = new THREE.Group();
    group.add(sphere);
    group.add(ring);
    group.renderOrder = 999;

    // Position marker
    group.position.set(source.position.x, source.position.y, source.position.z);

    // Add to scene
    this.scene.add(group);
    this.scene.add(line);

    this.markers.set(id, {
      group,
      sphere,
      ring,
      line,
      sphereMaterial,
      ringMaterial,
      lineMaterial
    });

    console.log(`[SourceMarkers] Created marker ${id} at`, source.position);
  }

  updateMarker(id, source) {
    const marker = this.markers.get(id);
    if (!marker) return;

    // Smoothly move marker to new position
    const pos = marker.group.position;
    pos.x += (source.position.x - pos.x) * 0.3;
    pos.y += (source.position.y - pos.y) * 0.3;
    pos.z += (source.position.z - pos.z) * 0.3;

    // Update color
    const color = new THREE.Color(source.color);
    marker.sphereMaterial.color = color;
    marker.ringMaterial.color = color;
    marker.lineMaterial.color = color;

    // Update opacity based on confidence
    marker.sphereMaterial.opacity = 0.4 + source.confidence * 0.6;
    marker.ringMaterial.opacity = 0.3 + source.confidence * 0.4;

    // Pulse animation
    const pulse = Math.sin(this.time * 3 + id) * 0.5 + 0.5;
    marker.ring.scale.set(1 + pulse * 0.3, 1 + pulse * 0.3, 1);
    marker.ringMaterial.opacity = (0.3 + source.confidence * 0.4) * (1 - pulse * 0.5);

    // Update direction line
    const linePositions = marker.line.geometry.attributes.position;
    if (linePositions) {
      linePositions.setXYZ(1, pos.x, pos.y, pos.z);
      linePositions.needsUpdate = true;
    }
  }

  removeMarker(id) {
    const marker = this.markers.get(id);
    if (!marker) return;

    // Remove from scene
    this.scene.remove(marker.group);
    this.scene.remove(marker.line);

    // Dispose geometries and materials
    marker.sphereMaterial.dispose();
    marker.ringMaterial.dispose();
    marker.lineMaterial.dispose();
    marker.line.geometry.dispose();

    this.markers.delete(id);
    console.log(`[SourceMarkers] Removed marker ${id}`);
  }

  dispose() {
    for (const id of this.markers.keys()) {
      this.removeMarker(id);
    }
    this.sphereGeometry.dispose();
    this.ringGeometry.dispose();
  }
}
