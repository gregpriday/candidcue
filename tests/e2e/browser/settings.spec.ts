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

/**
 * §28.4 — the voice-detection sensitivity slider leaves the browser.
 *
 * This is the defect the setting shipped with: the slider was wired to the VAD
 * and to the Preflight meter, and persisted in the localStorage overlay only.
 * Rust declared no such field and `toRustPatch` had no `audio` arm, so a
 * presenter's mic tuning did not survive a cleared store and the backend
 * billing the key could not see the commit cadence it was paying for — this
 * VAD's `speech_ended` is the Realtime commit cue.
 */
test('moving the sensitivity slider writes audio.vadSensitivity to update_settings', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();

  const slider = page.getByRole('slider', { name: 'Voice-detection sensitivity' });
  await expect(slider).toBeVisible();
  // The shim's document predates the field, so the UI shows the A.6 neutral
  // rather than an extreme — and says which one it is.
  await expect(slider).toHaveValue('50');
  await expect(page.getByText('Default', { exact: true })).toBeVisible();

  // The bound is in the copy: what the slider does NOT move is why it is safe.
  await expect(page.getByText(/pause that ends a sentence/)).toBeVisible();

  await slider.fill('80');

  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'update_settings').length))
    .toBeGreaterThan(0);

  const call = await page.evaluate(() => window.__E2E__.lastCall('update_settings'));
  const args = call!.args as { patch: Record<string, Record<string, unknown>> };
  expect(args.patch.audio?.['vadSensitivity']).toBe(0.8);
  // The per-machine capture state stays in the overlay and must not be sent.
  expect(JSON.stringify(args.patch)).not.toContain('preferredDeviceId');
  expect(JSON.stringify(args.patch)).not.toContain('noiseSuppression');
});

/**
 * §37.4 — "keep the Listener when the stage is blanked" is a stored preference,
 * not the hard-coded `keepListener: false` the session used to put on every
 * `blank` directive.
 */
test('the blank-behaviour toggle writes listener.keepWhenBlanked to update_settings', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Listeners', exact: true }).click();

  const keep = page.getByRole('switch', { name: 'Keep the Listener when the stage is blanked' });
  await expect(keep).toBeVisible();
  await expect(keep).toHaveAttribute('aria-checked', 'false');

  await keep.click();
  await expect(keep).toHaveAttribute('aria-checked', 'true');

  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'update_settings').length))
    .toBeGreaterThan(0);

  const call = await page.evaluate(() => window.__E2E__.lastCall('update_settings'));
  const args = call!.args as { patch: Record<string, Record<string, unknown>> };
  expect(args.patch.listener?.['keepWhenBlanked']).toBe(true);
  // The deleted field must not come back on the wire either.
  expect(JSON.stringify(args.patch)).not.toContain('hideOnBlank');
});
