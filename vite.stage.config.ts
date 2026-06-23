import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Teleprompter StageWindow renderer.
export default defineConfig({
  root: r('./src/renderer/stage'),
  base: './',
  plugins: [react()],
  resolve: { alias: { '@shared': r('./src/shared') } },
  server: { fs: { allow: [repoRoot] } },
  // Isolated dep-optimizer cache — see vite.control.config.ts. Without this the
  // two renderer dev servers race on node_modules/.vite/deps and trigger
  // recurring "504 (Outdated Optimize Dep)" errors for react/react-dom.
  cacheDir: r('./node_modules/.vite/stage'),
  build: { outDir: r('./.vite/renderer/stage'), emptyOutDir: true },
});
