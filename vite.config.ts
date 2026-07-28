import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const devPort = Number(process.env['CANDIDCUE_E2E_PORT'] ?? 1420);

/**
 * Absolute path to `decode-named-character-reference`'s non-DOM build.
 *
 * The package selects between two builds with export conditions: `browser`
 * resolves to `index.dom.js`, which runs `document.createElement('i')` at
 * module top level, while `worker`/`default` resolve to `index.js`, a pure
 * lookup table. It reaches us through remark-parse → micromark.
 *
 * In dev, Vite pre-bundles dependencies once for the client under the
 * `browser` condition, and the compiler Web Worker imports that same optimized
 * bundle — so it evaluated `document.createElement` in a context with no
 * `document` and threw `ReferenceError: document is not defined` on import.
 * The user-visible symptom was total: compiling a script failed, so no script
 * could be opened at all under `pnpm tauri dev`. Production was unaffected
 * (Rollup resolves `index.js` for the worker build), which is why the packaged
 * bundle looked clean while the everyday path was broken.
 *
 * pnpm does not hoist transitive dependencies, so the plain package path does
 * not exist and the versioned `.pnpm` path would break on any upgrade. These
 * candidates cover pnpm's version-independent hidden store and a hoisted
 * (npm/yarn) layout. Resolution failure throws rather than skipping the alias:
 * a silently missing alias would restore the crash invisibly.
 */
function resolveDecodeNamedCharacterReference(): string {
  const candidates = [
    './node_modules/.pnpm/node_modules/decode-named-character-reference/index.js',
    './node_modules/decode-named-character-reference/index.js',
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(
    'vite.config.ts: could not locate decode-named-character-reference/index.js. ' +
      'Without this alias the compiler worker throws "document is not defined" in dev ' +
      'and no script can be opened. Tried:\n  ' +
      candidates.join('\n  '),
  );
}

// Three HTML entry points built from one Vite config. Tauri window URLs
// reference them directly:
//   dev:  http://localhost:1420/control.html, /stage.html, /identify.html
//   prod: the same files inside dist/ (frontendDist "../dist")
// identify.html backs the short-lived numbered overlays that answer "which
// physical panel is display 2?" (spec §52.4).
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  resolve: {
    // The lookup-table build is correct in every context this app runs in
    // (window, worker, packaged, dev), so it is pinned everywhere rather than
    // patching dev alone. See the resolver above for the full reasoning.
    alias: [
      {
        find: /^decode-named-character-reference$/,
        replacement: resolveDecodeNamedCharacterReference(),
      },
    ],
  },
  server: {
    port: devPort,
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
