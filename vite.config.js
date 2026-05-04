import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    https: true  // Required for WebXR and microphone access
  },
  build: {
    target: 'esnext',
    outDir: 'dist'
  }
});
