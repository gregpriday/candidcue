/**
 * Screenshots of the calibration wizard in every state that carries design
 * weight, for design review. Opt-in: it skips unless DESIGN_CAPTURE_DIR names
 * a directory to write into, so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots SPEAKING_GLASS_E2E_PORT=5314 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-rig-calibration.spec.ts
 *
 * The wizard is reached the way calibrate.spec.ts reaches it: load the
 * Settings window, open Prompter display and rigs, press Calibrate. Panels the
 * stock shim does not describe — an Elgato it can identify, an iPad, a machine
 * with one display — are answered by wrapping the shim's `list_displays` from
 * a second init script, so the shim itself stays as every other spec sees it.
 *
 * Each capture is checked for the thing it is meant to show before it is
 * written, and throws rather than writing a plausible picture of the wrong
 * state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openPreferences } from './fixtures/preferences';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

const SCRIPT = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Quarterly note',
  source: '# Quarterly note\n\nThanks for joining.\n',
};

const VIEWPORTS = [
  { width: 880, height: 660 },
  { width: 720, height: 480 },
];

const BUILTIN = {
  id: 'display-0',
  name: 'Built-in Display',
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 3024, height: 1964 },
  scaleFactor: 2,
  logicalSize: { width: 1512, height: 982 },
  primary: true,
  fingerprint: 'dsp-e2e-builtin',
  topologyHash: 'top-e2e',
};

/** The 9-inch Elgato at its native mode, which discovery identifies by model. */
const ELGATO = {
  id: 'display-1',
  name: 'Elgato Prompter',
  physicalPosition: { x: 3024, y: 0 },
  physicalSize: { width: 1024, height: 600 },
  scaleFactor: 1,
  logicalSize: { width: 1024, height: 600 },
  primary: false,
  fingerprint: 'dsp-e2e-prompter',
  topologyHash: 'top-e2e',
};

/** A 12.9-inch iPad Pro over Sidecar. */
const IPAD = {
  id: 'display-1',
  name: 'iPad Pro',
  physicalPosition: { x: 3024, y: 0 },
  physicalSize: { width: 2732, height: 2048 },
  scaleFactor: 2,
  logicalSize: { width: 1366, height: 1024 },
  primary: false,
  fingerprint: 'dsp-e2e-prompter',
  topologyHash: 'top-e2e',
};

interface Open {
  /** Replace the shim's display list. */
  displays?: unknown[];
  /**
   * Refuse the wizard's own enumeration. Settings has to list the panels first
   * or it offers no Calibrate button at all, so the failure starts after it.
   */
  failListDisplays?: boolean;
  /** Hold the wizard's own display enumeration open, to show its loading state. */
  holdHydration?: boolean;
}

async function openWizard(page: Page, viewport: { width: number; height: number }, opts: Open = {}) {
  await page.setViewportSize(viewport);
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  if (opts.displays) {
    await page.addInitScript((displays) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke.bind(internals);
      internals.invoke = (command: string, args?: unknown) =>
        command === 'list_displays' ? Promise.resolve(displays) : original(command, args);
    }, opts.displays);
  }
  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();
  const calibrate = page.getByRole('button', { name: 'Calibrate…' });
  await expect(calibrate).toBeEnabled();
  if (opts.holdHydration) {
    await page.evaluate(() => window.__E2E__.setDelay('list_displays', 120_000));
  }
  if (opts.failListDisplays) {
    await page.evaluate(() =>
      window.__E2E__.setFail('list_displays', {
        code: 'HARDWARE_ERROR',
        userMessage: 'Could not enumerate displays.',
      }),
    );
  }
  await calibrate.click();
  await expect(page.getByRole('heading', { name: 'Calibrate this display' })).toBeVisible();
  if (!opts.holdHydration && !opts.failListDisplays) {
    await expect(page.locator('.preset-name').first()).toBeVisible();
  }
}

async function currentStep(page: Page): Promise<string> {
  return (await page.locator('.step-title').first().textContent())?.trim() ?? '';
}

async function skipTo(page: Page, heading: string): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    if ((await currentStep(page)) === heading) return;
    const before = await currentStep(page);
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect.poll(() => currentStep(page)).not.toBe(before);
  }
  throw new Error(`never reached the "${heading}" step`);
}

/** Wait for the prompter state to settle so the toolbar light is not mid-change. */
async function stageSettled(page: Page): Promise<void> {
  await expect(page.getByText(/Showing on the prompter|No prompt window/).first()).toBeVisible();
}

async function shoot(page: Page, name: string, viewport: { width: number; height: number }) {
  // Park the pointer on the toolbar's empty middle so no hover state is
  // captured, then let transitions (a toast's entrance, a dialog's fade) finish.
  await page.mouse.move(Math.round(viewport.width * 0.62), 22);
  await page.waitForTimeout(350);
  const file = path.join(OUT!, `${name}--${viewport.width}x${viewport.height}.png`);
  await page.screenshot({ path: file });
  if (!fs.existsSync(file) || fs.statSync(file).size < 5000) {
    throw new Error(`capture ${file} was not written`);
  }
}

const STEP = {
  preset: 'Start from a preset?',
  hardware: 'Which prompter is this?',
  scale: 'How big is the picture, really?',
  safeArea: 'What can you actually see?',
  orientation: 'Does it read the right way round?',
  lens: 'Where is the lens?',
  distance: 'How far away do you stand?',
  textSize: 'How large should the text be?',
  lineWidth: 'How wide should a line run?',
  brightness: 'How hot should the type burn?',
};

test.describe('design capture: rig calibration', () => {
  test.skip(!OUT, 'DESIGN_CAPTURE_DIR is not set');
  test.beforeAll(() => {
    if (OUT) fs.mkdirSync(OUT, { recursive: true });
  });

  for (const vp of VIEWPORTS) {
    test(`loading ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { holdHydration: true });
      await expect(page.getByText(/Loading|Reading what/).first()).toBeVisible();
      await shoot(page, '01-loading', vp);
    });

    test(`presets ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      expect(await currentStep(page)).toBe(STEP.preset);
      await shoot(page, '02-presets', vp);
    });

    test(`hardware unidentified ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await skipTo(page, STEP.hardware);
      await expect(page.getByText(/could not recognise this panel/)).toBeVisible();
      await shoot(page, '03-hardware-unidentified', vp);
    });

    test(`hardware identified ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, ELGATO] });
      await stageSettled(page);
      await skipTo(page, STEP.hardware);
      await expect(page.getByLabel('Hardware')).toHaveValue('elgato-prompter');
      await shoot(page, '04-hardware-identified', vp);
    });

    test(`scale unidentified ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await skipTo(page, STEP.scale);
      await shoot(page, '05-scale-unidentified', vp);
    });

    test(`scale identified ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, ELGATO] });
      await stageSettled(page);
      await skipTo(page, STEP.scale);
      await shoot(page, '06-scale-identified', vp);
    });

    test(`scale validation ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await skipTo(page, STEP.scale);
      const field = page.getByLabel(/length of the bar/i);
      if (!(await field.isVisible())) {
        // A redesign may tuck the ruler behind a choice; open it if so.
        await page.getByRole('radio', { name: /ruler/i }).first().click();
      }
      // Five millimetres for a 600px bar: a panel well under an inch across.
      await field.fill('5');
      await field.press('Enter');
      await expect(page.getByText(/inches across the diagonal|Check the units/).first()).toBeVisible();
      await shoot(page, '07-scale-validation', vp);
    });

    test(`safe area ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await skipTo(page, STEP.safeArea);
      await shoot(page, '08-safe-area', vp);
    });

    test(`orientation ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await page.locator('.preset-card', { hasText: 'Elgato Prompter' }).first().click();
      await skipTo(page, STEP.orientation);
      await expect(page.getByRole('switch', { name: 'Mirror horizontally' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await shoot(page, '09-orientation', vp);
    });

    test(`lens ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await skipTo(page, STEP.lens);
      await shoot(page, '10-lens', vp);
    });

    test(`distance warning ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, ELGATO] });
      await stageSettled(page);
      await page.locator('.preset-card', { hasText: 'Elgato Prompter' }).first().click();
      await skipTo(page, STEP.distance);
      await page.getByRole('button', { name: '2.5 m', exact: true }).click();
      await expect(page.getByText(/rated for comfortable reading/)).toBeVisible();
      await shoot(page, '11-distance-warning', vp);
    });

    test(`text size ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, ELGATO] });
      await stageSettled(page);
      await skipTo(page, STEP.textSize);
      await shoot(page, '12-text-size', vp);
    });

    test(`line width ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, ELGATO] });
      await stageSettled(page);
      await skipTo(page, STEP.lineWidth);
      await shoot(page, '13-line-width', vp);
    });

    test(`final apply ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, ELGATO] });
      await stageSettled(page);
      // Answer a few on the way so the progress shows a mix of done and skipped.
      await page.locator('.preset-card', { hasText: 'Elgato Prompter' }).first().click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await skipTo(page, STEP.distance);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await skipTo(page, STEP.brightness);
      await expect(page.getByRole('button', { name: 'Apply this rig' })).toBeVisible();
      await shoot(page, '14-final-apply', vp);
    });

    test(`stage unavailable ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN] });
      await expect(page.getByText(/second display/i).first()).toBeVisible();
      await shoot(page, '15-stage-unavailable', vp);
    });

    test(`displays unreadable ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { failListDisplays: true });
      await expect(page.getByText(/connected displays/i).first()).toBeVisible();
      await shoot(page, '16-displays-unreadable', vp);
    });

    test(`sidecar checklist ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp, { displays: [BUILTIN, IPAD] });
      await stageSettled(page);
      await skipTo(page, STEP.hardware);
      const checklist = page.locator('section[aria-label="Sidecar checklist"]');
      await expect(checklist).toBeVisible();
      await checklist.scrollIntoViewIfNeeded();
      await shoot(page, '17-sidecar-checklist', vp);
      // The end of the list, wherever the hint sits inside it.
      await checklist.locator('li').last().scrollIntoViewIfNeeded();
      await shoot(page, '18-sidecar-checklist-end', vp);
    });

    test(`discard confirmation ${vp.width}`, async ({ page }) => {
      await openWizard(page, vp);
      await stageSettled(page);
      await page.locator('.preset-card', { hasText: 'Elgato Prompter' }).first().click();
      await page.getByRole('button', { name: 'Prompter display and rigs' }).first().click();
      await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
      await shoot(page, '19-discard-confirm', vp);
    });
  }
});
