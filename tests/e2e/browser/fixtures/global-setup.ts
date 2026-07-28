import { chromium, expect, type Browser } from '@playwright/test';
import { installTauriShim } from './tauri-shim';

/**
 * Warm the Vite dev server's dependency optimizer before any spec runs.
 *
 * A DEV-SERVER-ONLY hazard, and one that made this suite unreliable on a cold
 * checkout. Vite pre-bundles dependencies lazily, as the browser asks for them.
 * The Markdown compiler's chain (`unified`, `remark-parse`, `remark-gfm`,
 * `mdast-util-to-string`) is reached only through a dynamic import inside the
 * compile Web Worker — so it is discovered mid-test, the first time a script is
 * opened. Vite then logs
 *
 *     ✨ new dependencies optimized: unified, remark-parse, remark-gfm, …
 *     ✨ optimized dependencies changed. reloading
 *
 * and forces a FULL PAGE RELOAD. Anything the spec had built up in memory —
 * an unsaved editor buffer, a conflict state, a live session — is gone, and the
 * test fails on an assertion that has nothing to do with the bug it protects.
 * `rm -rf node_modules/.vite && pnpm test:e2e` reproduced it every time.
 *
 * So: drive one script through a real compile here, absorb the reload, and hand
 * the specs a server that is done discovering dependencies. Roughly free once
 * the cache is warm.
 *
 * Not a substitute for a fix in `vite.config.ts` (`optimizeDeps.include` would
 * pre-bundle the worker's chain at server start) — but that file is outside
 * this layer, and this keeps the suite honest either way.
 */

const BASE_URL = `http://localhost:${process.env.CANDIDCUE_E2E_PORT ?? '1420'}`;
const WARMUP_SCRIPT = {
  id: '00000000-0000-4000-8000-000000000000',
  title: 'Dependency warm-up',
  source: '# Warm up\n\nA sentence with **emphasis**, a [link](https://example.com) and a list:\n\n- one\n- two\n',
};

/** The dev server may be started by `webServer` in parallel with this hook. */
async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE_URL}/control.html`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Dev server never became reachable');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Drive one script through a real compile. Throws if it never finishes. */
async function compileOnce(browser: Browser): Promise<void> {
  const page = await browser.newPage({ baseURL: BASE_URL });
  try {
    await installTauriShim(page, { welcomed: true, seedScripts: [WARMUP_SCRIPT] });
    await page.goto('/control.html');
    /*
     * Through the EDITOR, not through Present.
     *
     * Present opens a real take now — a session record, microphone transport
     * and fullscreen presentation — which is a great deal of machinery to run
     * for a warm-up. The editor reaches the same worker import and stops there.
     */
    await page
      .getByRole('list', { name: 'Scripts' })
      .getByRole('button', { name: /Dependency warm-up/ })
      .first()
      .click();
    // The worker's own result line: it appears only once the compile chain has
    // loaded and returned, which is the thing being waited for.
    await expect(page.getByText('Ready to present.')).toBeVisible({ timeout: 30_000 });
    // Let any optimizer-triggered reload land and settle before we leave.
    await page.goto('/control.html');
    await page.waitForLoadState('networkidle');
  } finally {
    await page.close();
  }
}

export default async function warmDependencyOptimizer(): Promise<void> {
  await waitForServer();

  const browser = await chromium.launch();
  try {
    /*
     * Up to three attempts: the very reload this hook exists to absorb can
     * interrupt the warm-up itself. Each retry starts from a strictly warmer
     * server, so this terminates rather than spinning.
     */
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await compileOnce(browser);
        return;
      } catch (error) {
        // Never fail the run from here. The warm-up is a flake guard, not a
        // gate — if it cannot complete, the specs are no worse off than before
        // it existed, and their own failures will say more than this one would.
        if (attempt === 3) {
          console.warn(
            `[e2e] dependency warm-up did not complete; cold-cache reload flakiness may return.\n${String(error)}`,
          );
        }
      }
    }
  } finally {
    await browser.close();
  }
}
