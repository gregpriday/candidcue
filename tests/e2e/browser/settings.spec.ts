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

  // Into Settings, then the Stage display section — mirroring describes the
  // rig, not the type, so it lives with the panel it is a property of.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Stage display', exact: true }).click();

  const mirror = page.getByRole('switch', { name: 'Horizontal mirror' });
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
 * and to the level meter beside it, and persisted in the localStorage overlay only.
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

  /*
   * The bound is in the copy: what the slider does NOT move is why it is safe
   * to offer. It used to be "the pause that ends a sentence", which was the
   * honest limit when a local detector decided turn boundaries. xAI
   * endpoints server-side, so this slider cannot gate a single byte — and a
   * user who believes it can will turn it up and be no better off.
   */
  await expect(page.getByText(/recogniser hears everything/)).toBeVisible();

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
 * §28.1 — the input picker is a picker.
 *
 * It used to be DISABLED AND BLANK on a fresh install, because "follow system
 * default" defaults to on and that toggle lived in another section three
 * controls further down the page. The screen's answer to "which microphone is
 * this using, and how do I change it?" was an empty dead dropdown — so someone
 * with a good microphone plugged in presented through their headset instead,
 * with nothing on screen to explain it or to fix it.
 *
 * Following the system default is now the first ROW of that picker, and it
 * names the device it resolves to.
 */
test('the input picker offers the system default and every input, and remembers what is chosen', async ({ page }) => {
  // The suite grants the microphone and runs fake devices (playwright.config.ts),
  // so the permission is already in hand — the state a packaged build is in
  // every launch after the first, since macOS grants per application.
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();

  const picker = page.getByLabel('Input device');
  await expect(picker).toBeVisible();

  // The bug: this used to be disabled and blank, because "follow system
  // default" is the shipped default and its toggle lived in another section.
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue('__system_default__');

  const options = picker.locator('option');
  // The system-default row names what it currently resolves to — the one
  // option whose meaning is otherwise invisible.
  await expect(options.first()).toHaveText(/^System default — .+/);
  expect(await options.count()).toBeGreaterThan(1);

  const chosen = await options.nth(1).textContent();
  const chosenId = await options.nth(1).getAttribute('value');
  await picker.selectOption({ index: 1 });
  await expect(picker).toHaveValue(chosenId!);

  // Remembered as a device id AND a label: the id alone does not survive a
  // re-salt, so the label is what identifies this microphone next launch.
  const overlay = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('candidcue.settings-overlay.v1') ?? '{}'),
  );
  expect(overlay.audio).toMatchObject({
    followSystemDefault: false,
    preferredDeviceId: chosenId,
    preferredDeviceLabel: chosen,
  });
  // Per-machine capture state stays local; a device id has no business in the
  // Rust document.
  const settingsCalls = await page.evaluate(() =>
    window.__E2E__.calls.filter((c) => c.command === 'update_settings'),
  );
  expect(JSON.stringify(settingsCalls)).not.toContain('preferredDeviceId');
});

/**
 * §28.1 — a grant this machine has already made is not asked for again.
 *
 * The regression this pins is platform-specific and invisible in dev: the only
 * webview CandidCue ships in does not implement
 * `navigator.permissions.query({ name: 'microphone' })`, so the permission
 * watcher reports 'unsupported' on EVERY launch and the screen kept showing
 * "Allow and choose microphone" forever. `audio.microphoneGranted` is the
 * record of the grant, and for a while nothing read it — the predicate that
 * decides this had a full unit-test suite and no production call site at all.
 *
 * Chromium implements the Permissions API and this suite grants the microphone
 * globally (see playwright.config.ts), so the platform hole has to be recreated
 * deliberately: the stub below makes `permissions.query` reject exactly as
 * WKWebView's absence of it does, which `queryMicrophonePermission` maps to
 * 'unsupported'. Without that stub Chromium answers 'granted' and this test
 * passes whether or not the remembered flag is ever read — which is how the
 * first version of it was useless.
 */
test('a microphone grant remembered on this machine is not asked for again', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.addInitScript(() => {
    localStorage.setItem(
      'candidcue.settings-overlay.v1',
      JSON.stringify({ audio: { microphoneGranted: true } }),
    );
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (descriptor: PermissionDescriptor) =>
      descriptor.name === ('microphone' as PermissionName)
        ? Promise.reject(new TypeError("'microphone' is not a valid permission name"))
        : query(descriptor);
  });
  await page.goto('/control.html');

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();

  await expect(page.getByLabel('Input device')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow and choose microphone' })).toHaveCount(0);
});

