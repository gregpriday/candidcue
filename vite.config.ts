import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Two HTML entry points (control.html, stage.html) built from one Vite config.
// Tauri window URLs reference them directly:
//   dev:  http://localhost:1420/control.html and /stage.html
//   prod: control.html / stage.html inside dist/ (frontendDist "../dist")
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
      },
    },
  },
});
