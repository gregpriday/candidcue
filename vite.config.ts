import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Three HTML entry points built from one Vite config. Tauri window URLs
// reference them directly:
//   dev:  http://localhost:1420/control.html, /stage.html, /identify.html
//   prod: the same files inside dist/ (frontendDist "../dist")
// identify.html backs the short-lived numbered overlays that answer "which
// physical panel is display 2?" (spec §52.4).
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // macOS ships WKWebView; Windows ships WebView2 (Chromium).
    target: ['es2022', 'safari16', 'chrome110'],
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        control: fileURLToPath(new URL('./control.html', import.meta.url)),
        stage: fileURLToPath(new URL('./stage.html', import.meta.url)),
        identify: fileURLToPath(new URL('./identify.html', import.meta.url)),
      },
    },
  },
});
