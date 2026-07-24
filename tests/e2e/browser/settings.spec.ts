import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

/**
 * Settings round-trip journey, SHIM-BACKED.
 *
 * Real behaviour asserted: flipping a UI toggle persists through the frontend's
 * settings adapter in the EXACT shape Rust's `update_settings` expects. The UI
 * exposes a flat `teleprompter.mirrorX`; Rust's document calls it
 * `stageBehavior.horizontalMirror`. This proves the adapter (settings.ts
 * toRustPatch) maps it correctly and sends the pre-edit revision — i.e. a real
 * optimistic-concurrency write, not a mock passthrough.
 */

test('toggling "Horizontal mirror" writes stageBehavior.horizontalMirror to update_settings', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');

  // Into Settings, then the Teleprompter section.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Teleprompter', exact: true }).click();

  const mirror = page.getByRole('switch', { name: 'Horizontal mirror by default' });
  await expect(mirror).toBeVisible();
  await expect(mirror).toHaveAttribute('aria-checked', 'false');

  await mirror.click();
  await expect(mirror).toHaveAttribute('aria-checked', 'true');

  // The write reached the backend in the Rust document shape.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'update_settings').length))
    .toBeGreaterThan(0);

  const call = await page.evaluate(() => window.__E2E__.lastCall('update_settings'));
  const args = call!.args as { expectedRevision: number; patch: Record<string, Record<string, unknown>> };
  expect(args.patch.stageBehavior?.['horizontalMirror']).toBe(true);
  // A real optimistic write carries the revision the UI was editing (get_settings -> 3).
  expect(typeof args.expectedRevision).toBe('number');
  // It must NOT leak the UI-only flat key.
  expect(JSON.stringify(args.patch)).not.toContain('mirrorX');
});
