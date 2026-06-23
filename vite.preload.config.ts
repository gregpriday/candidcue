import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Preload scripts run in an isolated context with access to Electron's
// contextBridge but no application secrets. Two preloads: control + stage.
export default defineConfig({
  resolve: {
    alias: { '@shared': r('./src/shared') },
  },
  build: {
    lib: {
      entry: {
        control: r('./src/preload/control.ts'),
        stage: r('./src/preload/stage.ts'),
      },
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron', /^node:/],
      output: { entryFileNames: '[name].js' },
    },
    emptyOutDir: false,
  },
});
