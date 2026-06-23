import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * `node:sqlite` is a brand-new Node builtin that Vite's bundled
 * builtin-module list does not yet recognize, so Vite strips the `node:`
 * prefix and then fails to resolve bare `sqlite` from disk. This plugin marks
 * both forms as external (native) so the SQLite repository loads the real
 * module under Vitest's Node runner.
 */
const NODE_SQLITE_VIRTUAL = '\0virtual:node-sqlite';

const externalNodeSqlite: Plugin = {
  name: 'external-node-sqlite',
  enforce: 'pre',
  resolveId(source) {
    if (source === 'node:sqlite' || source === 'sqlite') {
      return NODE_SQLITE_VIRTUAL;
    }
    return null;
  },
  load(id) {
    if (id === NODE_SQLITE_VIRTUAL) {
      // Re-export the native module via createRequire so Vite never tries to
      // transform/resolve the (unrecognized) `node:sqlite` builtin itself.
      return [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        "const mod = require('node:sqlite');",
        'export const DatabaseSync = mod.DatabaseSync;',
        'export const StatementSync = mod.StatementSync;',
        'export default mod;',
      ].join('\n');
    }
    return null;
  },
};

export default defineConfig({
  // `react()` transforms JSX/TSX for renderer component tests; it is inert for
  // the node/`.ts` suites (which import no JSX). `externalNodeSqlite` keeps its
  // `enforce: 'pre'` precedence so `node:sqlite` resolution is unaffected.
  plugins: [react(), externalNodeSqlite],
  // Vitest's Node runner consults `ssr.external` to decide what to leave as a
  // native import. Keep `node:sqlite` (and its prefix-stripped form) external
  // so it is `require`d natively rather than transformed.
  ssr: {
    external: ['node:sqlite', 'sqlite'],
  },
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@main': r('./src/main'),
    },
  },
  test: {
    globals: true,
    // `node` stays the default so the experimental-sqlite + main/shared suites
    // run natively. Renderer component tests opt into a DOM by adding a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: 'node',
    server: { deps: { external: [/node:sqlite/] } },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', '.vite', 'tests/e2e/**', 'tests/provider-contract/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/renderer/**/entry.tsx'],
    },
  },
});
