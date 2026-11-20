import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { gotoSection, openPreferences } from './fixtures/preferences';

/**
 * Camera placement, lens position and safe-area insets, set from Settings ›
 * Prompter display (#489). SHIM-BACKED.
 *
 * Until this, only the Calibrate wizard could set any of the three. What is
 * asserted is the round trip each one makes through the settings document —
 * the `optical` section Rust's `update_settings` receives — and that an edit
 * to one leaves every other value a wizard stored exactly as it was; and that
 * the on-panel preview is available beside the controls and carries the marks
 * the stage draws (`StageSettings.rigMarks`). How the stage draws them is
 * `tests/dom/stage-talent-plane.test.ts`.
 */

const PANEL = 'dsp-e2e-prompter';
const RIG_NAME = 'Studio hood';
const RIG_KEY = `${encodeURIComponent(PANEL)}::${encodeURIComponent(RIG_NAME)}`;

/**
 * A rig the wizard saved, with something in every field an edit here could
 * disturb: a ruler scale, a measured distance, an override, uneven insets, a
 * lens off centre and the steps in the order they were answered.
 */
const WIZARD_RIG = {
  schemaVersion: 1,
  rigName: RIG_NAME,
  hardwareKind: 'generic',
  scale: { mmPerCssPx: 0.25, source: 'ruler' },
  viewingDistanceMm: 1500,
  safeArea: { top: 0.08, right: 0.03, bottom: 0.12, left: 0.05 },
  lens: { x: 0.4, y: 0.3 },
  lensPlacement: 'in-panel',
  flips: { horizontal: true, vertical: false },
  framing: 'close-up',
  bias: 0.6,
  overrides: { fontSizePx: 48 },
  intensity: 'strong',
  readingCue: 'wash',
  completedSteps: ['hardware', 'distance', 'safe-area', 'lens'],
};

async function seedWizardRig(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, profile, fp, name]) => {
      localStorage.setItem(
        'speaking-glass.settings-overlay.v1',
        JSON.stringify({ optical: { profiles: { [key]: profile }, activeRig: { [fp]: name } } }),
      );
    },
    [RIG_KEY, WIZARD_RIG, PANEL, RIG_NAME] as const,
  );
}

type OpticalPatch = {
  profiles?: Record<string, Record<string, unknown>>;
  activeRig?: Record<string, string>;
};

/** Every `optical` section written to `update_settings`, in order. */
async function opticalWrites(page: Page): Promise<OpticalPatch[]> {
  return await page.evaluate(() =>
    window.__E2E__.calls
      .filter((c) => c.command === 'update_settings')
      .map((c) => (c.args as { patch?: Record<string, unknown> }).patch?.['optical'])
      .filter((optical): optical is OpticalPatch => optical !== undefined && optical !== null),
  );
}

/** The rig the panel runs with, as last written. */
async function writtenRig(page: Page): Promise<Record<string, unknown> | null> {
  const last = (await opticalWrites(page)).at(-1);
  const name = last?.activeRig?.[PANEL];
  if (!last || name === undefined) return null;
  return last.profiles?.[`${encodeURIComponent(PANEL)}::${encodeURIComponent(name)}`] ?? null;
}

/** Every stage directive the preview sent, in order. */
async function settingsDirectives(page: Page): Promise<Array<Record<string, unknown>>> {
  return await page.evaluate(() =>
    window.__E2E__
      .directivesOfKind('settings')
      .map((d) => (d.payload as { settings: Record<string, unknown> }).settings),
  );
}

async function openPrompterDisplay(page: Page): Promise<void> {
  await openPreferences(page);
  await gotoSection(page, 'Prompter display and rigs');
}

test('a wizard rig opens showing its stored placement, lens and insets', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedWizardRig(page);
  await openPrompterDisplay(page);

  await expect(page.getByRole('combobox', { name: 'Where the camera is' })).toHaveValue('in-panel');
  await expect(page.getByRole('slider', { name: 'Lens across' })).toHaveValue('40');
  await expect(page.getByRole('slider', { name: 'Lens down' })).toHaveValue('30');
  await expect(page.getByRole('slider', { name: 'Inset from the top' })).toHaveValue('8');
  await expect(page.getByRole('slider', { name: 'Inset from the bottom' })).toHaveValue('12');
  await expect(page.getByRole('slider', { name: 'Inset from the left' })).toHaveValue('5');
  await expect(page.getByRole('slider', { name: 'Inset from the right' })).toHaveValue('3');
});

test('each value round-trips, and an edit leaves everything else the wizard stored', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await seedWizardRig(page);
  await openPrompterDisplay(page);

  const edits: Array<{ slider: string; value: string; expect: Record<string, unknown> }> = [
    { slider: 'Inset from the top', value: '10', expect: { safeArea: { ...WIZARD_RIG.safeArea, top: 0.1 } } },
    {
      slider: 'Inset from the bottom',
      value: '20',
      expect: { safeArea: { ...WIZARD_RIG.safeArea, top: 0.1, bottom: 0.2 } },
    },
    {
      slider: 'Inset from the left',
      value: '7',
      expect: { safeArea: { ...WIZARD_RIG.safeArea, top: 0.1, bottom: 0.2, left: 0.07 } },
    },
    {
      slider: 'Inset from the right',
      value: '0',
      expect: { safeArea: { top: 0.1, right: 0, bottom: 0.2, left: 0.07 } },
    },
    { slider: 'Lens across', value: '55', expect: { lens: { x: 0.55, y: 0.3 } } },
    { slider: 'Lens down', value: '62', expect: { lens: { x: 0.55, y: 0.62 } } },
  ];

  let expected: Record<string, unknown> = { ...WIZARD_RIG };
  for (const edit of edits) {
    await page.getByRole('slider', { name: edit.slider }).fill(edit.value);
    expected = { ...expected, ...edit.expect };
    // The whole rig, deep: distance, scale and its source, the override, the
    // flips, framing, bias, intensity, cue and the steps in answer order.
    await expect.poll(() => writtenRig(page), { message: edit.slider }).toEqual(expected);
  }

  // Placement keeps both coordinates, so a camera moved above the screen and
  // back behind the glass comes back to the lens it had.
  const placement = page.getByRole('combobox', { name: 'Where the camera is' });
  for (const value of ['above', 'below', 'none', 'in-panel'] as const) {
    await placement.selectOption(value);
    expected = { ...expected, lensPlacement: value };
    await expect.poll(() => writtenRig(page), { message: value }).toEqual(expected);
  }
});

test('Down is offered only for a camera behind the glass, and Across names what it moves', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await seedWizardRig(page);
  await openPrompterDisplay(page);

  const placement = page.getByRole('combobox', { name: 'Where the camera is' });
  await placement.selectOption('above');
  await expect(page.getByRole('slider', { name: 'Lens down' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Camera across' })).toHaveValue('40');

  await placement.selectOption('none');
  await expect(page.getByRole('slider', { name: 'Column centre' })).toHaveValue('40');

  // The insets do not depend on where the camera is.
  await expect(page.getByRole('slider', { name: 'Inset from the top' })).toHaveValue('8');
});

test('on a panel running automatically, the first change stores a rig for it', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await openPrompterDisplay(page);

  const before = await writtenRig(page);
  expect(before).toBeNull();

  await page.getByRole('slider', { name: 'Inset from the left' }).fill('6');
  await expect
    .poll(async () => (await writtenRig(page))?.['safeArea'])
    .toEqual({ top: 0, right: 0, bottom: 0, left: 0.06 });

  const writes = await opticalWrites(page);
  const last = writes.at(-1)!;
  // One rig, chosen for this panel — not a value parked somewhere else.
  expect(Object.keys(last.profiles ?? {})).toHaveLength(1);
  expect(last.activeRig?.[PANEL]).toBeTruthy();
});

test('the preview is beside the controls, marks the rig and follows each change', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await seedWizardRig(page);
  await openPrompterDisplay(page);

  await page.getByRole('button', { name: 'Show on teleprompter' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();

  // The opening document already carries the marks.
  const opened = await page.evaluate(() => {
    const call = window.__E2E__.calls.filter((c) => c.command === 'publish_stage_document').at(-1);
    return (call?.args as { documentEnvelope?: { stageSettings?: Record<string, unknown> } })
      ?.documentEnvelope?.stageSettings?.['rigMarks'];
  });
  expect(opened).toEqual({
    safeArea: WIZARD_RIG.safeArea,
    lens: WIZARD_RIG.lens,
    lensPlacement: 'in-panel',
  });

  await page.getByRole('slider', { name: 'Inset from the top' }).fill('15');
  await expect
    .poll(async () => (await settingsDirectives(page)).at(-1)?.['rigMarks'])
    .toEqual({
      safeArea: { ...WIZARD_RIG.safeArea, top: 0.15 },
      lens: WIZARD_RIG.lens,
      lensPlacement: 'in-panel',
    });

  await page.getByRole('combobox', { name: 'Where the camera is' }).selectOption('above');
  await expect
    .poll(async () => ((await settingsDirectives(page)).at(-1)?.['rigMarks'] as { lensPlacement?: string })?.lensPlacement)
    .toBe('above');

  // "Show test" would open a second stage window over the preview's.
  await expect(page.getByRole('button', { name: /^Show test/ })).toBeDisabled();
});

test('one preview between Prompter display and Teleprompter, closed by any other section', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true });
  await seedWizardRig(page);
  await openPrompterDisplay(page);

  await page.getByRole('button', { name: 'Show on teleprompter' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();

  const closes = () =>
    page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'close_stage').length);
  const closedBefore = await closes();

  // To Teleprompter: the same window, now without the marks.
  await gotoSection(page, 'Teleprompter');
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  await expect
    .poll(async () => {
      const last = (await settingsDirectives(page)).at(-1);
      return last !== undefined && !('rigMarks' in last);
    })
    .toBe(true);
  expect(await closes()).toBe(closedBefore);

  // And back: the marks return to the same window.
  await gotoSection(page, 'Prompter display and rigs');
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
  await expect
    .poll(async () => (await settingsDirectives(page)).at(-1)?.['rigMarks'])
    .toBeTruthy();
  expect(await closes()).toBe(closedBefore);

  // Anywhere else takes it down.
  await gotoSection(page, 'General');
  await expect.poll(closes).toBe(closedBefore + 1);
});

test('choosing another display closes the preview on the old one', async ({ page }) => {
  await installTauriShim(page, { welcomed: true });
  await seedWizardRig(page);
  await openPrompterDisplay(page);

  await page.getByRole('button', { name: 'Show on teleprompter' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();

  await page
    .locator('.monitor-tile', {
      has: page.locator('.monitor-name', { hasText: /^Built-in Display$/ }),
    })
    .click();
  await expect(page.getByRole('button', { name: 'Show on teleprompter' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'close_stage').length),
    )
    .toBeGreaterThan(0);
});
