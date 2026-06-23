import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Build config for the Electron main process. The main process is the trusted
// application core; it is bundled separately from the renderers.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@main': r('./src/main'),
    },
  },
  build: {
    outDir: r('./.vite/build'),
    target: 'node20',
    lib: {
      entry: r('./src/main/index.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      // Electron + Node built-ins and native-ish modules stay external.
      external: ['electron', 'node:sqlite', /^node:/, 'ws', 'openai'],
      output: { entryFileNames: 'main.js' },
    },
    emptyOutDir: false,
  },
});
