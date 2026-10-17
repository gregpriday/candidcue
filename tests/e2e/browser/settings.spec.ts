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
 * tile names the panel the CandidCue window is on ("Currently display 2 ·
 * Teleprompter Display"), so a text match can find two.
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

/*
 * #300 — Diagnostic Take is a switch somebody can find, off until they turn it
 * on.
 *
 * Every take used to open with the engine's readout and a strip of raw
 * transcript on the glass, and no control wrote the setting behind it. The two
 * controls that say "diagnostics" elsewhere do not touch the stage, so this one
 * is named for the take, and it has to be found by searching for what it shows.
 */
function storedDiagnosticTake(page: import('@playwright/test').Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('candidcue.settings-overlay.v1');
    if (raw === null) return null;
    const overlay = JSON.parse(raw) as { teleprompter?: Record<string, unknown> };
    return overlay.teleprompter?.['diagnosticTake'] ?? null;
  });
}

test('Diagnostic Take is off on a fresh profile, and its switch turns it on and off', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Teleprompter');

  const diagnostic = page.getByRole('switch', { name: 'Diagnostic Take' });
  await expect(diagnostic).toHaveAttribute('aria-checked', 'false');
  // The same switch every other row uses, so it takes the control focus ring.
  await expect(diagnostic).toHaveAttribute('data-focus', 'control');

  await diagnostic.click();
  await expect(diagnostic).toHaveAttribute('aria-checked', 'true');
  // The overlay is the document for this field: no Rust write carries it.
  await expect.poll(() => storedDiagnosticTake(page)).toBe(true);

  // Read back on a fresh load, not just held by the screen that set it.
  await page.reload();
  await page.getByRole('button', { name: 'Teleprompter', exact: true }).click();
  await expect(diagnostic).toHaveAttribute('aria-checked', 'true');

  await diagnostic.click();
  await expect(diagnostic).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => storedDiagnosticTake(page)).toBe(false);
});

test('searching for what Diagnostic Take shows finds its row', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('transcript');
  await gotoSection(page, 'Teleprompter');

  const row = page.locator('.content .toggle-row', {
    has: page.getByRole('switch', { name: 'Diagnostic Take' }),
  });
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('data-settings-search-miss');
  // And the search really narrowed the section rather than matching everything.
  // `includeHidden`, so the row is found whether or not a miss is hidden.
  const highlight = page.locator('.content .toggle-row', {
    has: page.getByRole('switch', { name: 'Current phrase highlight', includeHidden: true }),
  });
  await expect(highlight).toHaveAttribute('data-settings-search-miss');
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
      'This mode was saved by an earlier version, and takes started in it do not follow ' +
        'your voice. Switch back to Follow voice to prompt normally; auto-scroll still ' +
        'rolls the script at a set pace from inside any take.',
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
  await expect(page.getByText(/saved by an earlier version/)).toHaveCount(0);
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
  // It says where the pace actually lives — Teleprompter, not "below" in General.
  await expect(
    page.getByText(
      'Every take opens listening. Auto-scroll can roll the script at a set pace from inside ' +
        'any take; set the pace with Auto-scroll pace in Settings › Teleprompter.',
      { exact: true },
    ),
  ).toBeVisible();
});

test('Following drops the dead Script fidelity control', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await page.goto('/control.html');
  await openSettingsSection(page, 'Following');

  // It set a field nothing reads, and promised tips from a removed feature.
  await expect(page.getByText('Script fidelity')).toHaveCount(0);
  // Motion profile states its one family rather than opening a dropdown of one.
  await expect(page.getByText('Standard motion (v1)')).toBeVisible();
  await expect(page.getByText('CandidCue has one motion profile')).toBeVisible();
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

  // Named rows rather than a count. A count taken before the section settles
  // measures how far the render got, not what the filter did: the rig rows
  // arrive only once `list_displays` answers, and a section counted before them
  // looks three rows long.
  const horizontal = page.locator('.content .toggle-row', { hasText: 'Horizontal mirror' });
  const vertical = page.locator('.content .toggle-row', { hasText: 'Vertical mirror' });
  const unrelated = [
    page.locator('.content .toggle-row', { hasText: 'Always on top' }),
    page.locator('.content .readout', { hasText: 'Body text' }),
    page.locator('.content .field', { has: page.getByLabel('Custom (metres)') }),
    page.locator('.content .field', { has: page.getByLabel('How you are framed') }),
  ];
  for (const row of [horizontal, vertical, ...unrelated]) await expect(row).toBeVisible();

  const search = page.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('mirror');

  await expect(horizontal).toBeVisible();
  await expect(vertical).toBeVisible();
  // Attached AND hidden: a row that is simply absent would pass `toBeHidden`
  // on its own.
  for (const row of unrelated) {
    await expect(row).toHaveAttribute('data-settings-search-miss', '');
    await expect(row).toBeHidden();
  }
  // The count is stated rather than left to be inferred from a short form, and
  // it is the count of what is on screen.
  await expectRowFilterNote(page, 2);

  // And "Show all" puts the section back rather than leaving the user to clear
  // a field they may not remember typing in.
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(search).toHaveValue('');
  await expect(page.locator('.content p.row-filter-note')).toHaveCount(0);
  await expect(
    page.locator('.content [data-settings-search-miss], .content [data-settings-search-hit]'),
  ).toHaveCount(0);
  for (const row of unrelated) await expect(row).toBeVisible();
});

/**
 * A row that renders after the search ran is filtered too.
 *
 * Searching first and then opening the section is the ordinary way to use the
 * search, and the rig rows in Prompter display and rigs render only once
 * `list_displays` answers — after the pass that marked the rows already there.
 * They used to stay visible, unmarked, under a note counting fewer rows.
 *
 * The reply is held until the section has been seen without them, so the order
 * is certain rather than likely. And a row already on screen changes too: the
 * mirror switch's description names the display once it resolves, which is
 * what makes it match `prompter` — a row whose TEXT arrives late, not the row.
 */
test('rows that render after the search ran are filtered too', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  await page.evaluate(() => window.__E2E__.setHeld('list_displays', true));
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('prompter');
  await gotoSection(page, 'Prompter display and rigs');

  const alwaysOnTop = page.locator('.content .toggle-row', { hasText: 'Always on top' });
  const horizontal = page.locator('.content .toggle-row', { hasText: 'Horizontal mirror' });
  const framing = page.locator('.content .field', { has: page.getByLabel('How you are framed') });
  // The section is open and the display list is not: only "Always on top"
  // says teleprompter yet, and the rig rows do not exist.
  await expect(alwaysOnTop).toBeVisible();
  await expect(horizontal).toHaveAttribute('data-settings-search-miss', '');
  await expect(framing).toHaveCount(0);
  await expectRowFilterNote(page, 1);

  await releaseHeld(page, 'list_displays');

  await expect(framing).toBeAttached();
  await expect(framing).toHaveAttribute('data-settings-search-miss', '');
  await expect(framing).toBeHidden();
  await expect(horizontal).toContainText('Teleprompter Display');
  await expect(horizontal).toBeVisible();
  // And the note counts what is actually left on screen.
  await expectRowFilterNote(page, 2);

  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(framing).toBeVisible();
});

/**
 * The same, for a row the Settings screen does not render itself.
 *
 * The Language dropdown belongs to the speech language picker, which asks for
 * its languages when it mounts and draws the row only once they arrive. Nothing
 * the Settings screen holds changes when they do, so a filter that re-ran on the
 * screen's own state — the section, the settings document, the display list —
 * never saw it: it stayed visible and unmarked under a note saying nothing in
 * the section matched.
 */
test('a row a child component renders after the search ran is filtered too', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  // Before the section opens: the picker asks as it mounts.
  await page.evaluate(() => window.__E2E__.setHeld('get_speech_language_options', true));
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('speech');
  await gotoSection(page, 'Speech');

  const language = page.locator('.content .field', {
    has: page.getByLabel('Language', { exact: true }),
  });
  await expect(page.getByText('Checking which languages are available')).toBeVisible();
  await expect(language).toHaveCount(0);

  await releaseHeld(page, 'get_speech_language_options');

  await expect(language).toBeAttached();
  await expect(language).toHaveAttribute('data-settings-search-miss', '');
  await expect(language).toBeHidden();
  await expectRowFilterNote(page, 0);

  // A row that arrived during the search comes back with the rest.
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(language).toBeVisible();
  await expect(
    page.locator('.content [data-settings-search-miss], .content [data-settings-search-hit]'),
  ).toHaveCount(0);
});

/**
 * A row inside another row is one setting, not two.
 *
 * Following's motion profile is a readout inside a `.field` of its own, and both
 * wrappers are rows to the filter. Counted separately, a search for it said two
 * settings matched while one was on screen — and marked separately, the inner
 * row could be hidden inside an outer row that matched.
 */
test('searching counts a row once when another row sits inside it', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  await gotoSection(page, 'Following');
  const readout = page.locator('.content .readout', { hasText: 'Motion profile' });
  await expect(readout).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search settings' }).fill('motion profile');

  await expect(readout).toBeVisible();
  const diagnostics = page.locator('.content .toggle-row', { hasText: 'Developer diagnostics' });
  await expect(diagnostics).toBeHidden();
  await expectRowFilterNote(page, 1);
});

/**
 * A row stops matching while it has focus, and stays until focus leaves.
 *
 * Follow feel matches "sluggish" only through Balanced's description, and the
 * arrow keys move focus AND the choice together. One press to Responsive swaps
 * the description, so the row no longer matches — and hiding it there would
 * hide the radio the keyboard is on, dropping focus to the page mid-gesture.
 * It is held, and judged again once focus goes somewhere else.
 */
test('a row that stops matching while it has focus stays until focus leaves', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await openPreferences(page);
  await gotoSection(page, 'Following');

  // `includeHidden`: a role query skips hidden elements, and the row is meant
  // to end up hidden.
  const feel = page.locator('.content .field', {
    has: page.getByRole('radiogroup', { name: 'Follow feel', includeHidden: true }),
  });
  const search = page.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('sluggish');
  await expect(feel).toBeVisible();
  await expectRowFilterNote(page, 1);

  await page.getByRole('radio', { name: 'Balanced' }).focus();
  await page.keyboard.press('ArrowRight');

  const responsive = page.getByRole('radio', { name: 'Responsive' });
  await expect(responsive).toHaveAttribute('aria-checked', 'true');
  // The description has changed, and the row no longer says "sluggish"…
  await expect(feel).toContainText('Livelier');
  // …and it is still on screen, with the keyboard still on it.
  await expect(feel).toBeVisible();
  await expect(feel).not.toHaveAttribute('data-settings-search-miss');
  await expect(responsive).toBeFocused();
  await expectRowFilterNote(page, 1);

  // Leaving the row lets the filter catch up.
  await search.focus();
  await expect(feel).toHaveAttribute('data-settings-search-miss', '');
  await expect(feel).toBeHidden();
  await expectRowFilterNote(page, 0);
});

/**
 * Let a command held by `setHeld` answer — once the screen has actually asked.
 *
 * Releasing first would lift the hold before the request it was there for, and
 * the reply would then answer at once.
 */
async function releaseHeld(page: Page, command: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((name) => window.__E2E__.calls.some((call) => call.command === name), command),
    )
    .toBe(true);
  await page.evaluate((name) => window.__E2E__.setHeld(name, false), command);
}

/**
 * The row filter's note against the rows it claims to count.
 *
 * Both are read in ONE pass, inside the page, and polled until they agree on
 * `expected`: a count captured once and compared with a note read later is two
 * snapshots of a section that may still be rendering. The whole number is
 * parsed, so "1 setting" cannot pass on a note that says "10 settings"; every
 * row wrapper the filter indexes is counted, `.readout` included; and a row
 * inside another row is counted with it, as the filter counts it. A missing
 * note reads as `null`, so it never agrees with a number.
 */
async function expectRowFilterNote(page: Page, expected: number): Promise<void> {
  await expect
    .poll(async () => {
      const { note, visible } = await page.evaluate(() => ({
        note: document.querySelector('.content p.row-filter-note')?.textContent ?? null,
        // Unmarked, and not inside another row.
        visible: document.querySelectorAll(
          '.content :is(.field, .toggle-row, .readout)' +
            ':not([data-settings-search-miss]):not(:is(.field, .toggle-row, .readout) *)',
        ).length,
      }));
      if (note === null) return { stated: null, visible };
      const text = note.replace(/\s+/g, ' ').trim();
      if (text.startsWith('No settings in this section matched.')) return { stated: 0, visible };
      const match = /^(\d+) settings? matched in this section\./.exec(text);
      // An unrecognised note comes back as itself, so a failure says what it read.
      return { stated: match ? Number(match[1]) : text, visible };
    })
    .toEqual({ stated: expected, visible: expected });
}
