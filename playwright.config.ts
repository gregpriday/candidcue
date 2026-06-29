import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the app-level (Electron launch) smoke suite.
 *
 * This is a SEPARATE runner from Vitest: `tests/e2e/**` is excluded from
 * vitest.config.ts, and Vitest's worker model fights Playwright's Electron
 * driver. Run via `npm run test:e2e` (which builds the app first).
 *
 * Workers are forced to 1 — the suite launches the real Electron app against an
 * isolated userData dir, and concurrent launches would collide on the shared DB.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results/e2e',
  use: {
    trace: 'retain-on-failure',
  },
});
