import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

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

/** Settings → Stage display, the section that owns the mirror switches and Calibrate. */
async function openStageDisplay(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
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

/** Walk the wizard to a named step by pressing Skip, which advances without recording. */
async function skipTo(page: Page, heading: string): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    if (await page.getByRole('heading', { name: heading }).isVisible()) return;
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
  }
  throw new Error(`never reached the "${heading}" step`);
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

test('a mirror tried out in the wizard reaches the glass but not the settings, and Discard drops it', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);

  // The starting truth: this display is not mirrored on either axis.
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('button', { name: 'Calibrate…' }).click();
  await expect(page.getByRole('heading', { name: 'Calibrate this display' })).toBeVisible();

  // Hydration has settled; from here every recorded call belongs to the wizard.
  await page.evaluate(() => window.__E2E__.reset());

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

test('finishing the wizard is what applies the mirror, both axes at once', async ({ page }) => {
  // Ten steps clicked through one at a time does not fit the default budget.
  test.slow();
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);
  await page.getByRole('button', { name: 'Calibrate…' }).click();
  await expect(page.getByRole('heading', { name: 'Calibrate this display' })).toBeVisible();
  await page.evaluate(() => window.__E2E__.reset());

  await presetCard(page, 'Elgato Prompter').click();
  await skipTo(page, ORIENTATION_STEP);
  await toggle(page, 'Mirror vertically').click();

  // Run out the wizard and apply the rig.
  for (let i = 0; i < 12; i += 1) {
    const apply = page.getByRole('button', { name: 'Apply this rig' });
    if (await apply.isVisible()) {
      await apply.click();
      break;
    }
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
  }

  // Finishing navigates back to Stage display on its own.
  await expect(page.getByRole('button', { name: 'Calibrate…' })).toBeVisible();

  // Both axes are now in force, and the operator can see it on the switches.
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'true');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'true');

  /*
   * Exactly ONE write reached Rust, and it turned the mirror on.
   *
   * The count is the real assertion. Two calls would mean the per-axis writes
   * were back: `patchSettings` reads the store revision when it is called, so a
   * pair fired before either lands both start from the same one and the backend
   * rejects the loser — which is how an axis used to disappear.
   *
   * The patch carries the whole mapped section (`patchSettings` sends the
   * merged section, not just the changed keys), so this reads the one field it
   * is about rather than pinning the section's entire shape.
   */
  const writes = await settingsWrites(page);
  expect(writes).toHaveLength(1);
  expect((writes[0]?.['stageBehavior'] as Record<string, unknown>)?.['horizontalMirror']).toBe(true);
});

/*
 * Only the mirror write reaches Rust — `optical` is overlay-backed — so failing
 * `update_settings` fails precisely the step that puts a flip in force. What
 * must not happen is the wizard claiming success, or the display's mirroring
 * moving anyway.
 */
test('a mirror write that fails leaves the display mirrored exactly as it was', async ({
  page,
}) => {
  // As above, plus a failing round trip to wait out.
  test.slow();
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openStageDisplay(page);
  await page.getByRole('button', { name: 'Calibrate…' }).click();
  await expect(page.getByRole('heading', { name: 'Calibrate this display' })).toBeVisible();
  await page.evaluate(() => window.__E2E__.reset());

  await presetCard(page, 'Elgato Prompter').click();

  // The write that puts a flip in force now fails. Shaped like a real AppError:
  // the store's `catch` describes it, and a bare string has no `userMessage`.
  await page.evaluate(() =>
    window.__E2E__.setFail('update_settings', {
      code: 'STORAGE_ERROR',
      userMessage: 'The settings could not be written.',
    }),
  );

  for (let i = 0; i < 12; i += 1) {
    const apply = page.getByRole('button', { name: 'Apply this rig' });
    if (await apply.isVisible()) {
      await apply.click();
      break;
    }
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
  }

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
  expect(await settingsWrites(page)).toHaveLength(1);

  await page.getByRole('button', { name: 'Stage display' }).first().click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(toggle(page, 'Horizontal mirror')).toHaveAttribute('aria-checked', 'false');
  await expect(toggle(page, 'Vertical mirror')).toHaveAttribute('aria-checked', 'false');
});
