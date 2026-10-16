import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { gotoSection, openPreferences } from './fixtures/preferences';

/**
 * Settings round-trip journey, SHIM-BACKED.
 *
 * Real behaviour asserted: flipping a UI toggle persists through the frontend's
 * settings adapter in the EXACT shape Rust's `update_settings` expects, with the
 * pre-edit revision — a real optimistic-concurrency write, not a mock
 * passthrough.
 *
 * Mirroring is per PANEL (#206). It used to be one global
 * `stageBehavior.horizontalMirror` for every display, so a take that fell back
 * to the laptop with the glass unplugged read backwards. The switches now
 * describe the display the section is about, and write that display's entry in
 * `optical.panelMirror` — and nothing to the retired global.
 */

/**
 * A display tile by the display's own name.
 *
 * Matched on `.monitor-name` exactly, not on the tile's text: the Automatic
 * tile says "Currently display 2 · Teleprompter Display", so a text match
 * finds two.
 */
function monitorTile(page: Page, name: string) {
  return page.locator('.monitor-tile', {
    has: page.locator('.monitor-name', { hasText: new RegExp(`^${name}$`) }),
  });
}

/** The `update_settings` patches that carried a panel's mirroring, in order. */
async function panelMirrorWrites(page: Page): Promise<Array<Record<string, unknown>>> {
  return await page.evaluate(() =>
    window.__E2E__.calls
      .filter((c) => c.command === 'update_settings')
      .map((c) => (c.args as { patch?: Record<string, Record<string, unknown>> }).patch ?? {})
      .filter((patch) => patch['optical']?.['panelMirror'] !== undefined)
      .map((patch) => patch['optical']!['panelMirror'] as Record<string, unknown>),
  );
}

test('toggling "Horizontal mirror" writes that display\'s entry, and only that one', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');

  // Into Settings, then the Stage display section — mirroring describes the
  // rig, not the type, so it lives with the panel it is a property of.
  await openPreferences(page);
  await page.getByRole('button', { name: 'Prompter display and rigs', exact: true }).click();

  const mirror = page.getByRole('switch', { name: 'Horizontal mirror' });
  await expect(mirror).toBeVisible();
  await expect(mirror).toHaveAttribute('aria-checked', 'false');

  // Nothing is pinned, so the section is about the external panel — the one
  // a prompter take is sent to.
  await mirror.click();
  await expect(mirror).toHaveAttribute('aria-checked', 'true');

  /*
   * Poll for the MIRROR write, not for any write: Settings can also issue an
   * `optical` migration write on mount, which would satisfy a bare count the
   * moment the section opens.
   */
  await expect
    .poll(async () => (await panelMirrorWrites(page)).at(-1))
    .toEqual({ 'dsp-e2e-prompter': { horizontal: true, vertical: false } });

  const call = await page.evaluate(() =>
    window.__E2E__.calls.filter((c) => c.command === 'update_settings').at(-1),
  );
  const args = call!.args as { expectedRevision: number; patch: Record<string, Record<string, unknown>> };
  // A real optimistic write carries the revision the UI was editing.
  expect(typeof args.expectedRevision).toBe('number');
  // Nothing to the retired global switch, and no UI-only flat key.
  expect(args.patch['stageBehavior']?.['horizontalMirror']).toBeUndefined();
  expect(JSON.stringify(args.patch)).not.toContain('mirrorX');

  /*
   * The other display keeps its own answer. Choosing the laptop shows ITS
   * mirroring — off — and choosing the glass again shows the glass's, which is
   * the whole point: one panel's glass is not every panel's.
   */
  await monitorTile(page, 'Built-in Display').click();
  await expect(mirror).toHaveAttribute('aria-checked', 'false');
  await monitorTile(page, 'Teleprompter Display').click();
  await expect(mirror).toHaveAttribute('aria-checked', 'true');
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

  await openPreferences(page);
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
   * honest limit when a local detector decided turn boundaries. The recogniser
   * decides its own turn boundaries, so this slider cannot gate a single byte — and a
   * user who believes it can will turn it up and be no better off.
   */
  await expect(page.getByText(/recogniser hears everything/)).toBeVisible();

  await slider.fill('80');

  /*
   * Poll for the SLIDER's write, not for any write.
   *
   * Settings also issues an `optical` migration write, and a bare count check
   * is satisfied by that one the moment the section opens — so this read
   * whichever write happened to be last and passed or failed on the order of
   * two unrelated things.
   */
  const audioWrite = () =>
    page.evaluate(() =>
      window.__E2E__.calls
        .filter(
          (c) =>
            c.command === 'update_settings' &&
            (c.args as { patch?: Record<string, unknown> }).patch?.['audio'] !== undefined,
        )
        .at(-1),
    );
  await expect.poll(async () => (await audioWrite()) !== undefined).toBe(true);

  const call = await audioWrite();
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

  await openPreferences(page);
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

  await openPreferences(page);
  await page.getByRole('button', { name: 'Audio', exact: true }).click();

  await expect(page.getByLabel('Input device')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow and choose microphone' })).toHaveCount(0);
});


/* ---------------------------------------------------------------------------
 * #124 — controls that configure nothing, or are silently overridden.
 *
 * The four teleprompter geometry sliders were live, draggable, and inert under
 * a calibrated rig: `resolveStageGeometry` decides size, line height, column and
 * band from a measured distance, and `buildStageSettings` writes its answer over
 * these same flat fields. The screen explained the override in a paragraph
 * underneath and left the controls working, which is the defect — an accurate
 * explanation beside a control that lies is still a control that lies.
 * ------------------------------------------------------------------------- */

/**
 * Seed a stored, applied rig for the panel Settings resolves to.
 *
 * `optical` is one of the sections that lives in the localStorage overlay
 * rather than in the Rust document (settings.ts `opticalFromOverlay`), so this
 * needs no change to the shared shim. The fingerprint is the shim's own
 * non-primary display, which is what `chooseStageDisplay` picks with nothing
 * pinned.
 */
async function seedAppliedRig(
  page: import('@playwright/test').Page,
  options: { scale?: boolean } = {},
): Promise<void> {
  const fingerprint = 'dsp-e2e-prompter';
  const rigName = 'Desk hood';
  await page.addInitScript(
    ([fp, name, withScale]) => {
      const profile = {
        schemaVersion: 1,
        rigName: name,
        hardwareKind: 'generic',
        scale: withScale ? { mmPerCssPx: 0.25, source: 'ruler' } : null,
        viewingDistanceMm: 1200,
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        lens: { x: 0.5, y: 0.38 },
        lensPlacement: 'in-panel',
        flips: { horizontal: false, vertical: false },
        framing: 'head-and-shoulders',
        bias: 0.4,
        overrides: {},
        intensity: 'standard',
        readingCue: 'ticks',
        // Every step the wizard records a token for. With no scale this is the
        // state that used to read "8 of 8 steps" — finished, unmeasured.
        completedSteps: [
          'hardware',
          'safe-area',
          'orientation',
          'lens',
          'distance',
          'text-size',
          'line-width',
          'brightness',
        ],
      };
      const key = `${encodeURIComponent(fp)}::${encodeURIComponent(name)}`;
      localStorage.setItem(
        'candidcue.settings-overlay.v1',
        JSON.stringify({ optical: { profiles: { [key]: profile }, activeRig: { [fp]: name } } }),
      );
    },
    [fingerprint, rigName, options.scale ?? false] as const,
  );
}

async function openSettingsSection(
  page: import('@playwright/test').Page,
  section: string,
): Promise<void> {
  await openPreferences(page);
  await page.getByRole('button', { name: section, exact: true }).click();
}

test('a calibrated rig disables the four sliders it owns and names itself', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedAppliedRig(page, { scale: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Teleprompter');

  // All four are the rig's, so none of them accepts a drag.
  for (const label of [
    'Default font size',
    'Line height',
    'Text column width',
    'Reading band position',
  ]) {
    await expect(page.getByRole('slider', { name: label })).toBeDisabled();
  }

  // And EACH says whose value it is showing, by name — not "a calibrated rig",
  // and not one shared paragraph underneath. Counted rather than `.first()`:
  // three of the four could lose the attribution and a first-match assertion
  // would never notice.
  await expect(page.getByText(/Controlled by Desk hood calibration/)).toHaveCount(4);

  // With a route to the thing that owns it.
  await expect(page.getByRole('button', { name: 'Open Desk hood calibration' })).toBeVisible();
});

test('a reading window owns the same four fields, with no rig measured at all', async ({ page }) => {
  // The near-miss in this fix: gating on the applied prompter rig alone.
  // `stageSettingsFromSettings` branches on presentation mode FIRST, and
  // `readerOpticalProfile` synthesises a profile when nothing is stored — so a
  // reading window overrides these four whether or not anybody has calibrated.
  // No rig is seeded here on purpose; that is the case the obvious gate missed.
  await installTauriShim(page, { welcomed: true, presentationMode: 'reader' });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Teleprompter');

  for (const label of [
    'Default font size',
    'Line height',
    'Text column width',
    'Reading band position',
  ]) {
    await expect(page.getByRole('slider', { name: label })).toBeDisabled();
  }
  // And it names the reading window rather than a rig it does not have.
  await expect(page.getByText(/Controlled by the reading window/)).toHaveCount(4);
});

test('auto-scroll pace stays live under a rig, because a rig does not own pace', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedAppliedRig(page, { scale: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Teleprompter');

  // The disable must be scoped to the geometry the resolver actually decides.
  // Disabling this one too would be the same defect with the sign flipped.
  await expect(page.getByRole('slider', { name: 'Auto-scroll pace' })).toBeEnabled();
});

test('with no rig applied the sliders are live and show what the default is', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Teleprompter');

  const fontSize = page.getByRole('slider', { name: 'Default font size' });
  await expect(fontSize).toBeEnabled();
  // A fresh install sits on every default, and each one now says so rather
  // than leaving the number unexplained.
  //
  // `exact: true` matters more than it looks: Playwright's default string
  // matching is a case-insensitive SUBSTRING, so a loose 'Default · 130 wpm'
  // also matches the reset button's 'Reset to default · 130 wpm' — which is
  // how the first version of this test passed while the pace was showing
  // "Set by you" against a default it disagreed with.
  await expect(page.getByText('Default · 64 px', { exact: true })).toBeVisible();
  await expect(page.getByText('Default · 1.32', { exact: true })).toBeVisible();

  // The shim's document carries 140 wpm, which is NOT the default — so the
  // pace must report itself as chosen rather than defaulted, and name the
  // number a reset would restore.
  await expect(page.getByRole('slider', { name: 'Auto-scroll pace' })).toHaveValue('140');
  await expect(page.getByRole('button', { name: 'Reset to default · 130 wpm' })).toBeVisible();
});

test('a changed slider offers its way back to the default', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Teleprompter');

  const fontSize = page.getByRole('slider', { name: 'Default font size' });
  await fontSize.fill('92');

  // It now reports itself as chosen rather than defaulted, and offers the
  // reset the screen never had.
  await expect(page.getByText('Set by you').first()).toBeVisible();
  const reset = page.getByRole('button', { name: 'Reset to default · 64 px' });
  await expect(reset).toBeVisible();

  await reset.click();
  await expect(fontSize).toHaveValue('64');
  await expect(page.getByText('Default · 64 px')).toBeVisible();

  /*
   * And the reset PERSISTS — to the overlay, which is where this field lives.
   *
   * This used to assert `lastCall('update_settings') !== null`, described as
   * "a real write, not a local rollback". That assertion was vacuous: the stage
   * font size has no Rust mapping in `toRustPatch`, so `updateSettings` finds
   * an empty patch and never reaches IPC at all. What the check was actually
   * seeing was the unrelated `optical` migration write that Settings issues on
   * mount — so it passed while proving nothing about the reset, and would have
   * gone on passing if the reset had persisted nothing.
   *
   * The overlay IS the document for this field, so that is what to read.
   */
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('candidcue.settings-overlay.v1');
        if (raw === null) return null;
        const overlay = JSON.parse(raw) as { teleprompter?: Record<string, unknown> };
        return overlay.teleprompter?.['fontSizePx'] ?? null;
      }),
    )
    .toBe(64);
});

test('a rig with every step answered but no measured scale does not read as done', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedAppliedRig(page, { scale: false });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Prompter display and rigs');

  // This used to render "8 of 8 steps" — finished, with the one measurement
  // every angular result is multiplied by never taken.
  await expect(page.getByText('Scale not measured · 8 of 9 calibration checks')).toBeVisible();
  await expect(page.getByText(/of 8 steps/)).toHaveCount(0);
});

test('the prominent calibrate action re-measures the applied rig instead of starting a new one', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedAppliedRig(page, { scale: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Prompter display and rigs');

  // It names the rig it will change. Pressing the most prominent button on the
  // panel used to mint "Desk hood 2" and leave the applied rig untouched.
  await expect(page.getByRole('button', { name: 'Re-calibrate Desk hood…' })).toBeVisible();
  // Measuring a second arrangement stays reachable — one panel legitimately
  // holds several rigs, so this must not simply replace the old behaviour.
  await expect(page.getByRole('button', { name: 'Measure another rig…' })).toBeVisible();

  // The LABEL is not the fix; where the button goes is. Rewiring this back to
  // calibrate() would restore the original defect with the copy still correct,
  // so the wizard's own rig name is what gets asserted. It lives on the second
  // step — the first is the optional preset shortcut.
  await page.getByRole('button', { name: 'Re-calibrate Desk hood…' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Rig name')).toHaveValue('Desk hood');
});

test('measuring another rig opens the wizard on a new name, not the applied one', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedAppliedRig(page, { scale: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Prompter display and rigs');

  // The other half of the same rule: the store keys on (panel, name), so this
  // path must NOT reuse "Desk hood" — that would silently replace the
  // measurements of an arrangement somebody believes is saved.
  await page.getByRole('button', { name: 'Measure another rig…' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Rig name')).not.toHaveValue('Desk hood');
});

test('a session mode stored by an older build is admitted, not papered over', async ({ page }) => {
  // `fromRustDocument` still accepts a persisted 'manual', and startTake passes
  // it straight into the session — so a readout hardcoded to "Follow voice"
  // would be the same defect one layer along, and removing the Select would
  // have taken away the only way back.
  await installTauriShim(page, { welcomed: true, promptMode: 'manual' });
  await page.goto('/control.html');
  await openSettingsSection(page, 'General');

  await expect(page.getByText('Manual', { exact: true })).toBeVisible();
  // The way back is named in the readout's own vocabulary, in the sentence and
  // on the button alike: "Switch to voice follow" leading to a value that reads
  // "Follow voice" is two names for one mode.
  await expect(
    page.getByText(
      'This setting was stored by an earlier version and takes no longer open in it. ' +
        'Switch back to Follow voice to prompt normally; auto-scroll still rolls the ' +
        'script at a set pace from inside any take.',
      { exact: true },
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Switch to Follow voice', exact: true }).click();
  // The store changes before the save is awaited, so the readout alone would
  // pass on a way back that never reached the backend.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__E2E__.calls.some(
          (c) =>
            c.command === 'update_settings' &&
            (c.args as { patch?: { stageBehavior?: { promptMode?: unknown } } }).patch
              ?.stageBehavior?.promptMode === 'voice',
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByText('Follow voice', { exact: true })).toBeVisible();
  await expect(page.getByText(/takes no longer open in it/)).toHaveCount(0);
});

test('Session mode states its one value instead of offering two dead options', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'General');

  await expect(page.getByText('Session mode', { exact: true })).toBeVisible();
  await expect(page.getByText('Follow voice', { exact: true })).toBeVisible();
  // The dropdown is gone, and with it the two permanently disabled rows.
  await expect(page.getByLabel('Default session mode')).toHaveCount(0);
  await expect(page.getByText(/not available in this release/)).toHaveCount(0);
});

test('Following drops the dead Script fidelity control', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Following');

  // It set a field nothing reads, and promised tips from a removed feature.
  await expect(page.getByText('Script fidelity')).toHaveCount(0);
  // Motion profile states its one family rather than opening a dropdown of one.
  await expect(page.getByText('Standard motion (v1)')).toBeVisible();
  await expect(page.getByText('The only motion profile in this release')).toBeVisible();
  // What genuinely reaches resolveFollowProfile stays. Matched exactly: the
  // motion-profile description mentions follow feel too, and a loose match
  // would pass on the sentence about the control rather than the control.
  await expect(page.getByText('Follow feel', { exact: true })).toBeVisible();
});

/**
 * §14.2 — the search narrows the ROWS, not only the section list.
 *
 * The section index alone answers "which section holds the microphone". It does
 * not answer "which of these fourteen controls is the one", which is the
 * question somebody has once they are looking at a section — and that half is
 * what makes a settings search worth having on a screen this long.
 */
test('searching settings hides the rows that do not match, and says how many did', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  await gotoSection(page, 'Prompter display and rigs');

  // Wait for the section to render before counting — the window shows
  // "Loading settings…" until `get_settings` answers.
  await expect(page.getByRole('switch', { name: 'Horizontal mirror' })).toBeVisible();
  // And for the rig rows, which arrive only once `list_displays` answers.
  // Counted before them, the section looks three rows long and two late rows
  // can make a correct filter fail `toBeLessThan(rowsBefore)`.
  await expect(page.getByLabel('How you are framed')).toBeVisible();
  const rows = page.locator('.content .field, .content .toggle-row');
  const rowsBefore = await rows.count();
  expect(rowsBefore).toBeGreaterThan(1);

  await page.getByRole('searchbox', { name: 'Search settings' }).fill('mirror');

  // The count is stated rather than left to be inferred from a short form.
  // The toast region is also `role="status"`, so this names the note itself.
  await expect(page.locator('p[role="status"]')).toContainText('matched in this section');

  const visible = page.locator(
    '.content .field:not([data-settings-search-miss]), .content .toggle-row:not([data-settings-search-miss])',
  );
  const visibleCount = await visible.count();
  expect(visibleCount).toBeGreaterThan(0);
  expect(visibleCount).toBeLessThan(rowsBefore);
  await expect(visible.first()).toContainText(/mirror/i);

  // And "Show all" puts the section back rather than leaving the user to clear
  // a field they may not remember typing in.
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page.locator('.content [data-settings-search-miss]')).toHaveCount(0);
});

/**
 * A row that renders after the search ran is filtered too.
 *
 * Searching first and then opening the section is the ordinary way to use the
 * search, and the rig rows in Prompter display and rigs render only once
 * `list_displays` answers — after the pass that marked the rows already there.
 * They used to stay visible, unmarked, under a note counting fewer rows.
 */
test('rows that render after the search ran are filtered too', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('prompter');
  await gotoSection(page, 'Prompter display and rigs');

  const framing = page.locator('.content .field', { has: page.getByLabel('How you are framed') });
  await expect(framing).toBeAttached();
  await expect(framing).toHaveAttribute('data-settings-search-miss');

  // And the note counts what is actually left on screen.
  const visible = page.locator(
    '.content .field:not([data-settings-search-miss]), .content .toggle-row:not([data-settings-search-miss])',
  );
  const visibleCount = await visible.count();
  expect(visibleCount).toBeGreaterThan(0);
  await expect(page.locator('p[role="status"]')).toContainText(`${visibleCount} setting`);
});
