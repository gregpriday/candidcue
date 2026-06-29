import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Preload scripts run in an isolated context with access to Electron's
// contextBridge but no application secrets. Two preloads: control + stage.
//
// The windows run with sandbox:true, so a preload cannot require a sibling
// chunk — only `electron` and a few built-ins are available. Each preload must
// therefore be a self-contained bundle (no shared chunk). Forge already
// guarantees this by declaring each entry as its own build pass (forge.config.ts
// build[]), which overrides lib.entry to a single file. When this config runs
// standalone (npm run build:app), PRELOAD_ENTRY=control|stage builds one entry
// per pass; building both entries in a single pass makes Rollup extract the
// shared @shared/contracts module into a sibling chunk, which the sandboxed
// preload cannot resolve — it crashes before exposing window.candidcue /
// window.candidcueStage.
const preloadEntry = process.env.PRELOAD_ENTRY as 'control' | 'stage' | undefined;
const entry = preloadEntry
  ? { [preloadEntry]: r(`./src/preload/${preloadEntry}.ts`) }
  : { control: r('./src/preload/control.ts'), stage: r('./src/preload/stage.ts') };

export default defineConfig({
  resolve: {
    alias: { '@shared': r('./src/shared') },
  },
  build: {
    lib: {
      entry,
      formats: ['cjs'],
    },
    rollupOptions: {
      external: ['electron', /^node:/],
      output: { entryFileNames: '[name].js' },
    },
    emptyOutDir: false,
  },
});
