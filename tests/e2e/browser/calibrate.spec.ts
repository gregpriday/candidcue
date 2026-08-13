import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openPreferences } from './fixtures/preferences';

/**
 * The calibration wizard's promise that leaving costs you nothing, SHIM-BACKED.
 *
 * The wizard asks "Leave without saving?" and says the measurements "have not
 * been applied to this display yet". That used to be false of exactly one
 * field: a preset card and the orientation toggles wrote `teleprompter.mirrorX/
 * mirrorY` — the axes a real take renders from — the instant they were touched,
 * and Discard reverted nothing. Somebody who tried a rig and backed out had
 * silently changed how every future take rendered, and found out mid-shoot.
 *
 * The specs below cover that claim in both directions: a mirror tried out in
 * here must not escape the wizard, and a mirror set OUTSIDE it must not be
 * quietly cancelled by a rig that never asked about orientation.
 *
 * This is a browser test rather than a component one on purpose. The bug is not
 * in Calibrate's markup; it is in which store gets written and when. A jsdom
 * render would have to substitute the settings store, the router guard and the
 * confirm dialog — the three things whose real behaviour is the whole claim —
 * and would pass against mocks no matter what the route did. Here the real
 * store, the real guard and the real Settings screen all run, and only the Rust
 * boundary is simulated.
 *
 * The assertions land on the Settings switches rather than on the `update_
 * settings` payload because only `mirrorX` reaches Rust (`stageBehavior.
 * horizontalMirror`); `mirrorY` lives in the local overlay. Reading the two
 * switches covers both axes the same way and is what the operator actually sees.
 */

const SCRIPT = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Quarterly note',
  source: '# Quarterly note\n\nThanks for joining.\n',
};

/** Steps are headed by their question, not by their id. */
const ORIENTATION_STEP = 'Does it read the right way round?';
const LAST_STEP = 'How hot should the type burn?';

/** Settings → Stage display, the section that owns the mirror switches and Calibrate. */
async function openStageDisplay(page: Page): Promise<void> {
  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Stage display', exact: true })
    .click();
}

/** A `role="switch"` by its label, on either screen. */
function toggle(page: Page, label: string) {
  return page.getByRole('switch', { name: label });
}

/**
 * A preset card by its name alone.
 *
 * Not `getByRole('button', { name })`: a card's accessible name folds in its
 * description, so "Elgato Prompter" also matches "Elgato Prompter XL".
 */
function presetCard(page: Page, name: string) {
  return page.locator('.preset-card', {
    has: page.locator('.preset-name', { hasText: new RegExp(`^${name}$`) }),
  });
}

/**
 * Open the wizard, then clear the IPC log once it has finished hydrating.
 *
 * Waits for a preset card rather than the page heading: the heading paints at
 * once, while `hydrate()` is async and deliberately withholds the cards until
 * the display list has arrived. Resetting on the heading alone would let
 * hydration's own calls land in a log the test then reads as the operator's.
 */
async function enterWizard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Calibrate…' }).click();
  await expect(page.getByRole('heading', { name: 'Calibrate this display' })).toBeVisible();
  await expect(presetCard(page, 'Elgato Prompter')).toBeVisible();
  await page.evaluate(() => window.__E2E__.reset());
}

/**
 * Walk the wizard to a named step by pressing Skip, which advances without
 * recording an answer.
 *
 * Each press waits for the heading to actually change before the next one.
 * `isVisible()` is an instantaneous read, so a loop that only polled it could
 * click Skip against the step it had already left.
 */
async function skipTo(page: Page, heading: string): Promise<void> {
  const target = page.getByRole('heading', { name: heading });
  for (let i = 0; i < 12; i += 1) {
    if (await target.isVisible()) return;
    const before = await currentStep(page);
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect
      .poll(() => currentStep(page), { message: `Skip did not advance past "${before}"` })
      .not.toBe(before);
  }
  throw new Error(`never reached the "${heading}" step`);
}

/** The heading of the step currently on screen. */
async function currentStep(page: Page): Promise<string> {
  return (await page.locator('.step-title').first().textContent())?.trim() ?? '';
}

/**
 * Walk to the last step and press Apply, failing loudly if it never appears.
 *
 * Explicitly clicks "Apply this rig" rather than whatever the footer offers:
 * the ghost button becomes "Finish without this" on the last step, which is a
 * second route into `finish()`, and a test that took it by accident would not
 * be testing what it says it is.
 */
async function applyRig(page: Page): Promise<void> {
  await skipTo(page, LAST_STEP);
  const apply = page.getByRole('button', { name: 'Apply this rig' });
  await expect(apply).toBeEnabled();
  await apply.click();
}

/** The mirror axes on the newest `settings` directive the stage was sent. */
async function previewMirror(page: Page): Promise<{ mirrorX: boolean; mirrorY: boolean }> {
  return await page.evaluate(() => {
    const sent = window.__E2E__.directivesOfKind('settings');
    const last = sent[sent.length - 1];
    const settings = (last?.payload?.['settings'] ?? {}) as Record<string, unknown>;
    return {
      mirrorX: settings['mirrorX'] === true,
      mirrorY: settings['mirrorY'] === true,
    };
  });
}

/**
 * Every settings patch that actually reached Rust, in order.
 *
 * These are RUST-shaped, not UI-shaped: `teleprompter.mirrorX` arrives as
 * `stageBehavior.horizontalMirror`. `mirrorY` and the whole `optical` section
 * are overlay-backed (localStorage) and never appear here at all — which is
 * why the axes are also read off the Settings switches below, where both of
 * them are visible the same way.
 */
async function settingsWrites(page: Page): Promise<Array<Record<string, unknown>>> {
  return await page.evaluate(() =>
    window.__E2E__.calls
      .filter((c) => c.command === 'update_settings')
      .map((c) => (c.args as Record<string, Record<string, unknown>>)?.['patch'] ?? {}),
  );
}

/**
 * The writes that touch one section.
 *
 * Finishing the wizard now issues TWO writes, and both are the point: the rig
 * goes to Rust (`optical`) because a calibration measured with a tape measure
 * must survive a cleared browser store, and the mirror goes with it
 * (`stageBehavior`). Before that move the rig lived only in localStorage and
 * these tests could count total writes; counting them now would conflate "the
 * mirror was written once" with "how many sections finishing touches", and the
 * first is what they are about.
 */
async function writesTouching(page: Page, section: string): Promise<Array<Record<string, unknown>>> {
  return (await settingsWrites(page)).filter((patch) => patch[section] !== undefined);
}

test('a mirror tried out in the wizard reaches the glass but not the settings, and Discard drops it', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);

  // The starting truth: this display is not mirrored on either axis.
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'false');

  await enterWizard(page);

  // A preset that mirrors horizontally. The glass must turn around...
  await presetCard(page, 'Elgato Prompter').click();
  await expect.poll(() => previewMirror(page)).toEqual({ mirrorX: true, mirrorY: false });

  // ...and the orientation step's own toggle must reach it too.
  await skipTo(page, ORIENTATION_STEP);
  await toggle(page, 'Mirror vertically').click();
  await expect.poll(() => previewMirror(page)).toEqual({ mirrorX: true, mirrorY: true });

  /*
   * The whole point: the preview moved, and NOTHING was persisted to do it.
   * On the old code the preset click alone wrote `stageBehavior.
   * horizontalMirror` here, so this is the assertion that fails without the fix.
   */
  expect(await settingsWrites(page)).toEqual([]);

  // Back out, and take the Discard the wizard offers.
  await page.getByRole('button', { name: 'Stage display' }).first().click();
  await page.getByRole('button', { name: 'Discard' }).click();

  /*
   * The measurements are gone, as promised — including the mirror. Read off the
   * switches rather than the IPC log because `mirrorY` never goes near Rust:
   * this is the one assertion that covers the vertical axis too.
   */
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'false');
  expect(await settingsWrites(page)).toEqual([]);
});

/*
 * The same defect pointed the other way, and the reason `hydrate()` seeds the
 * working profile's flips from the mirroring already in force.
 *
 * `finish()` writes BOTH axes unconditionally — that is what keeps the rig's
 * record and `teleprompter.mirrorX/mirrorY` from drifting apart. Left alone,
 * that turns a skipped orientation step into a silent global change: a fresh
 * rig comes from `defaultOpticalProfile()` unflipped, orientation is the one
 * step `discoverProfile` can never answer, and so Apply would clear a mirror
 * the operator set in Settings and was never even shown in here. On main this
 * path wrote nothing at all, so it would have been a regression introduced by
 * the fix above.
 *
 * The horizontal axis is the one under test because it is the axis that
 * actually reaches Rust, so the write can be read two ways: off the Settings
 * switch the operator sees, and off the `update_settings` payload.
 */
test('Apply cannot clear a mirror set in Settings when the orientation step was skipped', async ({
  page,
}) => {
  // Ten steps skipped one at a time does not fit the default budget.
  test.slow();
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);

  // The operator mirrors this display from Settings, well before any wizard.
  await toggle(page, 'Horizontal mirror').click();
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'true');

  // Now calibrate a NEW rig: nothing stored for this panel, so the profile is
  // the all-defaults one and no orientation answer exists to inherit.
  await enterWizard(page);

  /*
   * Walk as far as the orientation step and read the glass there, WITHOUT
   * touching either toggle.
   *
   * The card is already drawn mirrored, which is the seed doing its job and is
   * also what makes the question honest: unseeded, the wizard would draw square
   * glass and ask whether it reads the right way round while a real take
   * rendered flipped. Asserted here rather than on arrival because
   * `enterWizard` clears the directive log once hydration settles, and the
   * working profile has to change for the effect to publish again — advancing
   * the step is the first thing that does so without editing the rig.
   */
  await skipTo(page, ORIENTATION_STEP);
  await expect.poll(() => previewMirror(page)).toEqual({ mirrorX: true, mirrorY: false });

  // Straight past it to the end, so orientation is never answered.
  await applyRig(page);
  /*
   * "Measure another rig…" is the sentinel for being back on Stage display once
   * a rig is applied. The primary button there is "Re-calibrate {rigName}…" and
   * so moves with the rig's name; this one does not, and only exists in the
   * applied state, which is exactly the state every assertion below is in.
   */
  await expect(page.getByRole('button', { name: 'Measure another rig…' })).toBeVisible();

  // The mirror survived a rig the operator calibrated around it.
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'true');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'false');

  /*
   * And it survived by being WRITTEN BACK, not by never being written: the log
   * was cleared at the end of hydration, so this is finish's own patch, and it
   * carries the mirror on. Asserting the switch alone would pass just as well
   * if the write had gone out as `false` and the store had somehow not caught
   * up yet.
   */
  const writes = await writesTouching(page, 'stageBehavior');
  expect(writes).toHaveLength(1);
  expect((writes[0]?.['stageBehavior'] as Record<string, unknown>)?.['horizontalMirror']).toBe(true);
  // And the rig itself reached Rust, which is why there are two writes now.
  expect(await writesTouching(page, 'optical')).toHaveLength(1);
});

/*
 * The re-entrancy guard, which exists because finishing is no longer a single
 * write. A second Apply landing mid-save would start a second sequence from the
 * same store revision, and the backend would reject the loser — losing the
 * mirror the same way the old per-axis writes did.
 */
test('a second Apply cannot start while the first is still saving', async ({ page }) => {
  test.slow();
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);
  await enterWizard(page);
  await presetCard(page, 'Elgato Prompter').click();

  // Hold the save open so the in-flight window is something the test can act in.
  await page.evaluate(() => window.__E2E__.setDelay('update_settings', 3000));
  await applyRig(page);

  // While it is in flight both completion buttons are out of reach, so there is
  // no way to ask for a second save.
  const apply = page.getByRole('button', { name: 'Apply this rig' });
  await expect(apply).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Finish without this' })).toBeDisabled();

  // The save completes and the wizard leaves on its own.
  await page.evaluate(() => window.__E2E__.setDelay('update_settings', null));
  await expect(page.getByRole('button', { name: 'Measure another rig…' })).toBeVisible();

  /*
   * Still exactly ONE finish, despite Apply having been pressed during a save:
   * one write per section, not two. Counted per section because finishing
   * writes the rig and the mirror in sequence — a second finish would show up
   * as a second write to each.
   */
  expect(await writesTouching(page, 'optical')).toHaveLength(1);
  expect(await writesTouching(page, 'stageBehavior')).toHaveLength(1);
});

test('finishing the wizard is what applies the mirror, both axes at once', async ({ page }) => {
  // Ten steps clicked through one at a time does not fit the default budget.
  test.slow();
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);
  await enterWizard(page);

  await presetCard(page, 'Elgato Prompter').click();
  await skipTo(page, ORIENTATION_STEP);
  await toggle(page, 'Mirror vertically').click();

  // Nothing is persisted right up to the moment Apply is pressed, so the write
  // below is caused by finishing and by nothing earlier in the walk.
  expect(await settingsWrites(page)).toEqual([]);
  await applyRig(page);

  // Finishing navigates back to Stage display on its own.
  await expect(page.getByRole('button', { name: 'Measure another rig…' })).toBeVisible();

  // Both axes are now in force, and the operator can see it on the switches.
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'true');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'true');

  /*
   * Exactly ONE mirror write reached Rust, and it turned the mirror on.
   *
   * The count is the real assertion. Two calls would mean the per-axis writes
   * were back: `patchSettings` reads the store revision when it is called, so a
   * pair fired before either lands both start from the same one and the backend
   * rejects the loser — which is how an axis used to disappear.
   *
   * Scoped to `stageBehavior` because finishing also writes the rig itself to
   * `optical` now (calibrations are Rust-owned; they used to live only in
   * localStorage). The two are sequential, so they cannot collide over a
   * revision, and each section is written once.
   *
   * The patch carries the whole mapped section (`patchSettings` sends the
   * merged section, not just the changed keys), so this reads the one field it
   * is about rather than pinning the section's entire shape.
   */
  const writes = await writesTouching(page, 'stageBehavior');
  expect(writes).toHaveLength(1);
  expect((writes[0]?.['stageBehavior'] as Record<string, unknown>)?.['horizontalMirror']).toBe(true);
  expect(await writesTouching(page, 'optical')).toHaveLength(1);
});

/*
 * Finishing writes twice — the rig to `optical`, then the mirror to
 * `stageBehavior` — so a failing `update_settings` fails the FIRST of the two
 * and the mirror write never runs at all. What must not happen either way is
 * the wizard claiming success it did not have.
 *
 * (The comment here used to say `optical` was overlay-backed and only the
 * mirror reached Rust. That was true before calibrated rigs moved into the
 * settings document, which is the change that made a measured viewing distance
 * survive a cleared browser store.)
 *
 * SCOPE OF THIS TEST, precisely. It proves the in-session outcome: a write was
 * attempted, the wizard neither announced success nor left, the switches read
 * unchanged afterwards, and the operator can try again. It does NOT prove
 * durability across a reload, and must not be read as if it did: `updateSettings`
 * writes the section into the localStorage overlay BEFORE calling Rust for the
 * sections that are still overlay-backed, and the store's rollback restores only
 * its in-memory snapshot.
 */
test('a mirror write that fails is reported, not silently half-applied', async ({
  page,
}) => {
  // As above, plus a failing round trip to wait out.
  test.slow();
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);
  await enterWizard(page);

  await presetCard(page, 'Elgato Prompter').click();

  // The write that puts a flip in force now fails. Shaped like a real AppError
  // for realism only — the store toasts one fixed line and rethrows without
  // reading the error, so the shape is not what makes this work.
  await page.evaluate(() =>
    window.__E2E__.setFail('update_settings', {
      code: 'STORAGE_ERROR',
      userMessage: 'The settings could not be written.',
    }),
  );

  await applyRig(page);

  /*
   * Wait for the write to have actually come back rejected before going on.
   *
   * The store toasts on the way down, so this is the first moment the round
   * trip is known to be over. Clearing the failure or reading the screen before
   * it would race the in-flight `finish()` — let the clear win and the save
   * quietly succeeds, which is a green test asserting nothing.
   */
  await expect(page.getByText('Could not save settings. Nothing was changed.')).toBeVisible();

  // The wizard stays put with the measurements on screen: no success, no exit.
  await expect(page.getByRole('heading', { name: 'Calibrate this display' })).toBeVisible();

  /*
   * One write was attempted and it was the rig — the first of the two — and
   * because it was rejected the mirror write never ran. Both halves are
   * asserted: a failure that let the sequence carry on would put a flip in
   * force for a rig the document does not have.
   */
  const writes = await settingsWrites(page);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.['optical']).toBeDefined();
  expect(await writesTouching(page, 'stageBehavior')).toHaveLength(0);

  // The guard released: a failed save must leave the wizard retryable, not
  // permanently disabled with the work stranded behind it.
  await expect(page.getByRole('button', { name: 'Apply this rig' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Finish without this' })).toBeEnabled();

  /*
   * And the switches read exactly as they did. Only the horizontal axis is
   * asserted: this test never turns vertical mirroring on, so a `false` there
   * would pass whether the code rolled back or did nothing at all.
   */
  await page.getByRole('button', { name: 'Stage display' }).first().click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'false');
});
