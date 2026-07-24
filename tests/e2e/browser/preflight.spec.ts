import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

/**
 * Preflight readiness journey, SHIM-BACKED, focused on a DEGRADED path.
 *
 * Real behaviour asserted:
 *   - when display enumeration REJECTS, the Stage row does not sit forever at
 *     "Opening…": it reports an actionable error (role="alert") and offers a
 *     retry ("Check displays again"), and the section status becomes
 *     "Stage display unavailable";
 *   - the retry actually recovers — once enumeration succeeds, the detected
 *     displays appear and the error clears. This is the exact "a check that
 *     starts must finish" guarantee in preflight-load.ts.
 */

const SCRIPT = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Investor update',
  source: '# Investor update\n\nThanks for joining this quarter.\n',
};

test('a rejecting display enumeration leaves an actionable error and a working retry', async ({ page }, testInfo) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], failListDisplays: true });
  await page.goto('/control.html');

  // Enter Preflight from the library row.
  await page.getByRole('list', { name: 'Scripts' }).getByRole('button', { name: 'Present', exact: true }).first().click();

  // Stage display section surfaces a real error and a retry — not a stuck row.
  await expect(page.getByText('could not list the connected displays')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check displays again' })).toBeVisible();
  await expect(page.getByText('Stage display unavailable')).toBeVisible();
  // Explicitly NOT stuck in the "checking" state.
  await expect(page.getByText('Opening…')).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath('preflight-degraded-display.png'), fullPage: true });

  // Recover: enumeration now succeeds, the operator retries.
  await page.evaluate(() => window.__E2E__.setFail('list_displays', null));
  await page.getByRole('button', { name: 'Check displays again' }).click();

  // The detected displays render and the error is gone.
  await expect(page.getByText('Teleprompter Display')).toBeVisible();
  await expect(page.getByText('could not list the connected displays')).toHaveCount(0);
});
