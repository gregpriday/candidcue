import { defineConfig, devices } from '@playwright/test';

const e2ePort = process.env['CANDIDCUE_E2E_PORT'] ?? '1420';

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
    baseURL: `http://localhost:${e2ePort}`,
    // A blank frame is a failed launch, not a pass — capture on failure so a
    // "launched but never rendered" regression is visible in the report.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /*
         * Chromium-only, and that is why they live here rather than in the
         * shared `use` block. WebKit rejects `permissions: ['microphone']`
         * outright ("Unknown permission"), so a shared grant made the WebKit
         * project unable to open a page at all.
         */
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
        permissions: ['microphone'],
      },
      /*
       * Chromium runs it by default — a fake device, no prompt, and it still
       * proves the rates agree and both taps stay alive. WebKit adds the engine
       * that actually exhibits the silence, and is opt-in for the reason below.
       */
    },
    /*
     * WebKit, for the audio graph only.
     *
     * The app ships in a Tauri window, which on macOS is WKWebView — WebKit,
     * not Chromium. That distinction is not academic here: the defect this spec
     * covers is two `MediaStreamAudioSourceNode`s on one `MediaStream` from
     * contexts at different sample rates, and it is WEBKIT that lets one of
     * them fall silent. Chromium reports the mismatch and keeps both taps
     * alive, so a Chromium-only run can prove the rates agree and cannot prove
     * the thing that actually broke on the presenter's rig.
     *
     * Scoped to the one spec rather than the whole suite: everything else here
     * asserts DOM, layout and motion, which are the same in both engines and
     * already slow enough once.
     */
    /*
     * OPT-IN, because it uses the REAL microphone.
     *
     * Playwright's WebKit has no fake capture device, so `getUserMedia` opens
     * the actual input and macOS prompts for permission — every run, in front
     * of whoever is at the machine. That is intolerable in a default suite and
     * is exactly why this is behind a flag rather than simply enabled.
     *
     * It is the run that matters most, though: it exercises WKWebView's engine
     * on real hardware, which is the only place the sample-rate mismatch this
     * spec covers actually silences a tap.
     *
     *     CANDIDCUE_E2E_WEBKIT=1 pnpm test:e2e
     */
    ...(process.env['CANDIDCUE_E2E_WEBKIT'] === '1'
      ? [
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
            testMatch: '**/one-microphone-two-taps.spec.ts',
          },
        ]
      : []),
  ],
  webServer: {
    /*
     * `pnpm dev --port N`, NOT `pnpm dev -- --port N`: the extra separator
     * reaches Vite as a literal `--` argument and the port after it is dropped,
     * so `CANDIDCUE_E2E_PORT` was silently ignored and every run tried to bind
     * 1420. With a dev server already on that port — which is the normal state
     * when the suite runs from a worktree — the server failed to start and the
     * whole suite failed on connection-refused instead.
     */
    command: `pnpm dev --port ${e2ePort}`,
    url: `http://localhost:${e2ePort}/control.html`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
