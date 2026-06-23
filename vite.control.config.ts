import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Operator ControlWindow renderer. Rooted at its own folder so Forge's Vite
// plugin emits a clean .vite/renderer/control/index.html.
export default defineConfig({
  root: r('./src/renderer/control'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': r('./src/shared') } },
  server: { fs: { allow: [repoRoot] } },
  // Absolute outDir so the bundle lands at the project's .vite/renderer/control
  // (where Forge packages from) rather than under the renderer root folder.
  build: { outDir: r('./.vite/renderer/control'), emptyOutDir: true },
});
