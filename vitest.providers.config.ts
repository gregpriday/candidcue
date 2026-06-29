import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Provider contract suite (spec §24.1.3). These tests hit real provider
 * endpoints, so the main `vitest.config.ts` lists `tests/provider-contract/**`
 * in its `exclude` — which is applied at file-discovery time and therefore wins
 * over any CLI path argument, leaving `npm run test:providers` with zero files
 * (issue #11).
 *
 * This config reuses everything the base sets up — the `externalNodeSqlite`
 * plugin, `ssr.external`, resolve aliases, globals and the node environment —
 * but narrows discovery to the provider-contract directory and drops the
 * provider-contract entry from `exclude` so the suite is actually collected.
 * The contract tests themselves stay safe in keyless CI: each file guards with
 * `describe.skipIf(!OPENAI_API_KEY)`, so a missing key skips every test and the
 * runner exits 0.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/provider-contract/**/*.test.ts',
      'tests/provider-contract/**/*.test.tsx',
    ],
    exclude: ['node_modules', '.vite'],
    // Contract tests make real provider round-trips (e.g. prepareProject builds
    // a full interview plan), which routinely exceed Vitest's 5s default. Give
    // live-key runs generous headroom; keyless runs skip instantly regardless.
    testTimeout: 30_000,
  },
});
