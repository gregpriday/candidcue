import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-driven end-to-end layer (spec §55.8 alternative).
 *
 * This is NOT the packaged-app WebDriver suite — `tauri-driver` is Linux/Windows
 * only and macOS ships WKWebView, for which Apple provides no WebDriver. Instead
 * this drives the REAL Svelte frontend (control / stage / identify entries)
 * against the Vite dev server, exercising real routes, stores, components, and
 * DOM as complete user journeys.
 *
 * The `invoke` boundary is backed two ways (see tests/e2e/browser/fixtures):
 *   - an injected Tauri shim (`installTauriShim`) so the app takes the SAME code
 *     path it takes in production and every command response is owned per-test;
 *   - the app's own mock backend (plain browser, no shim) for pure
 *     navigation/render smoke — those specs are LABELLED "[mock-backed]".
 *
 * Runs as a THIRD command (`pnpm test:e2e`), separate from `pnpm test`
 * (node vitest) and `pnpm test:dom` (jsdom vitest). It never runs inside either
 * vitest project.
 */
export default defineConfig({
  testDir: './tests/e2e/browser',
  testMatch: '**/*.spec.ts',
  /*
   * Vite discovers the compile worker's dependency chain lazily and then forces
   * a full page reload ("optimized dependencies changed. reloading"), which
   * wiped app state mid-test on any cold `node_modules/.vite`. The warm-up
   * absorbs that reload before the first spec runs.
   */
  globalSetup: './tests/e2e/browser/fixtures/global-setup.ts',
  // Journeys mutate shared dev-server state (localStorage per context is
  // isolated, but keeping it serial makes screenshots and failures legible).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['list']],
  /*
   * Artifacts go somewhere the Vite dev server does NOT watch, and that is the
   * whole reason for this path.
   *
   * This used to be `./tests/e2e/browser/.artifacts`. Playwright writes trace
   * resources and screenshots there WHILE a test is running, Vite's watcher saw
   * every write, and the dev server issued a full page reload to the page under
   * test for each one:
   *
   *     [vite] (client) page reload tests/e2e/browser/.artifacts/
   *         .playwright-artifacts-0/traces/resources/75a8c5fa….html
   *
   * The suite was reloading the app out from under itself, in proportion to how
   * much it traced — a flake generator that gets worse with every spec added.
   * Vite's watcher ignores `**\/node_modules/**` unconditionally, so this is the
   * one location a Playwright-only config change can reach; nothing here needs
   * a `vite.config.ts` edit. (A `server.watch.ignored` entry there would be the
   * tidier home for the rule if that file is ever open anyway.)
   *
   * Screenshots therefore land in `node_modules/.cache/candidcue-e2e/<test>/`.
   */
  outputDir: './node_modules/.cache/candidcue-e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: 'http://localhost:1420',
    // A blank frame is a failed launch, not a pass — capture on failure so a
    // "launched but never rendered" regression is visible in the report.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Grant fake media so Preflight's getUserMedia probe resolves rather than
    // hanging on a permission prompt. It never asserts real audio.
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
    permissions: ['microphone'],
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420/control.html',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
