import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';

/**
 * Capture harness for the in-session appearance panel — design review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE=1` and `DESIGN_CAPTURE_DIR` names a
 * directory outside the repo, so the normal suite and CI skip every test here.
 * Each test presents a real take through the Library's Present button, raises
 * the panel from the stage's own dock, drives it to one state, and writes the
 * whole window and a crop of the panel. A state is checked on screen BEFORE its
 * file is written, so a capture that did not reach its state fails instead of
 * saving a plausible picture of the wrong panel.
 *
 *   DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5311 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-appearance-sheet.spec.ts
 *
 * The prompter states are taken at 1024x600, the Elgato Prompter's own grid,
 * because that is the panel the sheet's height budget was measured against.
 * Which branch of the sheet a prompter take gets is decided by the panel it
 * lands on, so the display list is replaced per state: an unidentifiable 1080p
 * panel (flat Settings values, live sliders), the Elgato (the automatic
 * profile), and the Elgato with a calibrated rig chosen for it.
 */

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'] ?? '';

test.skip(!CAPTURE || OUT === '', 'design capture harness — set DESIGN_CAPTURE=1 and DESIGN_CAPTURE_DIR');
test.describe.configure({ mode: 'serial' });
// Retina, as the panel is actually seen: 11px readouts at 1x are too soft to
// judge weight and contrast from.
test.use({ deviceScaleFactor: 2 });

const PROMPTER = { width: 1024, height: 600 };
const READING = { width: 1240, height: 820 };
const SMALLEST_READING = { width: 580, height: 360 };

const SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Product launch walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Over the next ten minutes I want to show you what changed in the product this quarter, and why it matters for the people who use it every day.\n\n' +
    '## What we heard\n\nYou told us the setup took too long. The first take of the morning should start in under a minute, and for most of you it took closer to five.\n\n' +
    '## What we built\n\nSo we rebuilt the first run from the ground up. It finds your camera, sizes the text for where you stand, and gets out of the way.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March. The team that built it will walk you through it next week.\n',
};

const BUILTIN = {
  id: 'display-0',
  name: 'Built-in Retina Display',
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 3024, height: 1964 },
  scaleFactor: 2,
  logicalSize: { width: 1512, height: 982 },
  primary: true,
  fingerprint: 'dsp-e2e-builtin',
  topologyHash: 'top-e2e',
};

/** The 9-inch Elgato at its native mode, which discovery identifies by its grid. */
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

/** A panel CandidCue cannot size: no model match and no EDID millimetres. */
const UNKNOWN_PANEL = {
  id: 'display-1',
  name: 'HDMI Capture Monitor',
  physicalPosition: { x: 3024, y: 0 },
  physicalSize: { width: 1920, height: 1080 },
  scaleFactor: 1,
  logicalSize: { width: 1920, height: 1080 },
  primary: false,
  fingerprint: 'dsp-e2e-prompter',
  topologyHash: 'top-e2e',
};

const ELGATO_MM_PER_PX = (228.6 * 1024) / Math.hypot(1024, 600) / 1024;

const CALIBRATED_RIG = {
  profiles: {
    [`${encodeURIComponent('dsp-e2e-prompter')}::${encodeURIComponent('Desk hood')}`]: {
      schemaVersion: 1,
      rigName: 'Desk hood',
      hardwareKind: 'elgato-prompter',
      scale: { mmPerCssPx: ELGATO_MM_PER_PX, source: 'model', diagonalMm: 228.6 },
      viewingDistanceMm: 900,
      safeArea: { top: 0.02, right: 0.03, bottom: 0.02, left: 0.03 },
      lens: { x: 0.5, y: 0.36 },
      lensPlacement: 'in-panel',
      flips: { horizontal: false, vertical: false },
      framing: 'head-and-shoulders',
      bias: 0.4,
      overrides: {},
      intensity: 'standard',
      readingCue: 'ticks',
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
    },
  },
  activeRig: { 'dsp-e2e-prompter': 'Desk hood' },
  panelMirror: { 'dsp-e2e-prompter': { horizontal: false, vertical: false } },
};

interface Fixture {
  mode: 'prompter' | 'reader';
  size: { width: number; height: number };
  /** Replaces the shim's display list; `[]` is a machine with nothing to name. */
  displays?: unknown[];
  /** Seeded into the settings overlay before boot. */
  overlay?: Record<string, unknown>;
}

/** Runs after the Tauri shim, so it wraps the shim's `invoke` rather than replacing it. */
function stubs(config: { displays: unknown[] | null; overlay: Record<string, unknown> | null }): void {
  if (config.overlay) {
    localStorage.setItem('candidcue.settings-overlay.v1', JSON.stringify(config.overlay));
  }
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__;
  const invoke = internals.invoke.bind(internals);
  internals.invoke = (command: string, args?: unknown) => {
    if (command === 'list_displays' && config.displays) {
      return invoke(command, args).then(() => config.displays);
    }
    return invoke(command, args);
  };
}

async function present(page: Page, fixture: Fixture): Promise<void> {
  await page.setViewportSize(fixture.size);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    presentationMode: fixture.mode,
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
  await page.addInitScript(stubs, {
    displays: fixture.displays ?? null,
    overlay: fixture.overlay ?? null,
  });
  await page.goto('/control.html');
  await page.getByRole('listbox').getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
}

function sheet(page: Page): Locator {
  return page.locator('.stage-dock .appearance-popover [role="dialog"]');
}

async function openMenu(page: Page): Promise<void> {
  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.menu-trigger').click();
  await expect(page.locator('.stage-dock [data-menu-row="appearance"]')).toBeVisible();
}

async function openSheet(page: Page, heading: 'Reading appearance' | 'Prompter appearance'): Promise<Locator> {
  await openMenu(page);
  await page.locator('.stage-dock [data-menu-row="appearance"]').click();
  const panel = sheet(page);
  await expect(panel.getByRole('heading', { name: heading })).toBeVisible();
  // Off the panel, so no control is captured in its hover state just because
  // the menu row it replaced was under the pointer.
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width * 0.8, viewport.height * 0.12);
  return panel;
}

/** Wait out the pop-in, the stage's re-wrap after a change, and the caret blink. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(500);
}

function outPath(name: string): string {
  mkdirSync(OUT, { recursive: true });
  return join(OUT, `${name}.png`);
}

async function shotWindow(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: outPath(`${name}--window`), caret: 'hide' });
}

/**
 * Press a slider's thumb and drag it a little, leaving the button DOWN — the
 * panel's see-through-while-held state only exists while a pointer holds it.
 * The caller releases with `page.mouse.up()` after its capture.
 */
async function holdSlider(page: Page, slider: Locator, dx: number): Promise<void> {
  const box = await slider.boundingBox();
  if (!box) throw new Error('the slider has no box');
  const [min, max, value] = await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    return [Number(input.min), Number(input.max), Number(input.value)];
  });
  const x = box.x + 8 + ((value - min) / (max - min)) * (box.width - 16);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 6 });
  await expect(sheet(page)).toHaveAttribute('data-peeking', '');
}

/** The panel with a margin of the stage around it, clamped to the viewport. */
async function shotSheet(page: Page, name: string): Promise<void> {
  await settle(page);
  const box = await sheet(page).boundingBox();
  if (!box) throw new Error(`${name}: the panel has no box — refusing to write`);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('no viewport');
  const pad = 24;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const right = Math.min(viewport.width, box.x + box.width + pad);
  const bottom = Math.min(viewport.height, box.y + box.height + pad + 56);
  await page.screenshot({
    path: outPath(`${name}--sheet`),
    caret: 'hide',
    clip: { x, y, width: right - x, height: bottom - y },
  });
}

/* ------------------------------------------------------------- reading window */

test('reader: just opened, dark', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  const panel = await openSheet(page, 'Reading appearance');
  await expect(panel.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
  await shotWindow(page, 'reader-open');
  await shotSheet(page, 'reader-open');
});

test('reader: the dock menu that raises it', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  await openMenu(page);
  await expect(page.locator('.stage-dock [data-menu-row="appearance"]')).toHaveText('Reading appearance…');
  await shotWindow(page, 'reader-menu');
});

test('reader: adjusted — bigger, wider, looser, wash', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  const panel = await openSheet(page, 'Reading appearance');
  const larger = panel.getByRole('button', { name: 'Larger text' });
  await larger.click();
  await larger.click();
  await larger.click();
  await panel.getByRole('radiogroup', { name: 'Line width' }).getByRole('radio', { name: 'Wider' }).click();
  await panel.getByLabel('Line spacing').fill('1.7');
  await panel.getByRole('radiogroup', { name: 'Reading cue' }).getByRole('radio', { name: 'Wash' }).click();
  await expect(
    panel.getByRole('radiogroup', { name: 'Line width' }).getByRole('radio', { name: 'Wider' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(panel).toContainText('1.70');
  await shotWindow(page, 'reader-adjusted');
  await shotSheet(page, 'reader-adjusted');
});

test('reader: paper', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  const panel = await openSheet(page, 'Reading appearance');
  await panel.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Paper' }).click();
  await expect(panel).toHaveAttribute('data-theme', 'workspace');
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
  await shotWindow(page, 'reader-paper');
  await shotSheet(page, 'reader-paper');
});

test('reader: opened from the keyboard', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  await page.locator('.stage-root').hover();
  const trigger = page.locator('.stage-dock .dock-button.menu-trigger');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.stage-dock [data-menu-row="appearance"]')).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = sheet(page);
  await expect(panel.getByRole('heading', { name: 'Reading appearance' })).toBeVisible();
  await expect
    .poll(() => panel.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== el))
    .toBe(true);
  await shotSheet(page, 'reader-keyboard');
});

test('reader: text size held mid-drag', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  const panel = await openSheet(page, 'Reading appearance');
  await holdSlider(page, panel.getByLabel('Text size'), 24);
  await shotWindow(page, 'reader-held');
  await page.mouse.up();
  await expect(panel).not.toHaveAttribute('data-peeking', '');
});

test('reader: smallest reading window', async ({ page }) => {
  await present(page, { mode: 'reader', size: SMALLEST_READING });
  const panel = await openSheet(page, 'Reading appearance');
  await expect(panel.getByRole('button', { name: 'Done' })).toBeInViewport();
  await shotWindow(page, 'reader-smallest');
});

test('reader: Done, and what it says', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING });
  const panel = await openSheet(page, 'Reading appearance');
  await panel.getByRole('button', { name: 'Larger text' }).click();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText('Reading appearance saved')).toBeVisible();
  await shotWindow(page, 'reader-after-done');
});

/*
 * A reading window with no display to compose against: no reader preference
 * reaches the glass, so the window gets the flat controls — the prompter's
 * branch, in a window nobody aligns to a lens.
 */
test('reader: no display to measure', async ({ page }) => {
  await present(page, { mode: 'reader', size: READING, displays: [] });
  await openMenu(page);
  await page.locator('.stage-dock [data-menu-row="appearance"]').click();
  const panel = sheet(page);
  await expect(panel.getByRole('heading')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
  await shotWindow(page, 'reader-no-display');
  await shotSheet(page, 'reader-no-display');
});

/* -------------------------------------------------------------------- prompter */

test('prompter: flat settings, just opened', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  await expect(panel.getByLabel('Reading line')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
  await shotWindow(page, 'prompter-open');
  await shotSheet(page, 'prompter-open');
});

test('prompter: the dock menu that raises it', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  await openMenu(page);
  await expect(page.locator('.stage-dock [data-menu-row="appearance"]')).toHaveText('Prompter appearance…');
  await shotWindow(page, 'prompter-menu');
});

test('prompter: adjusted — reading line up, narrower, looser', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  await panel.getByLabel('Reading line').fill('30');
  await panel.getByLabel('Text width').fill('62');
  await panel.getByLabel('Line spacing').fill('1.5');
  await panel.getByRole('radiogroup', { name: 'Intensity' }).getByRole('radio', { name: 'Strong' }).click();
  await expect(panel).toContainText('30%');
  await expect(panel).toContainText('1.50');
  await shotWindow(page, 'prompter-adjusted');
  await shotSheet(page, 'prompter-adjusted');
});

test('prompter: reading line held mid-drag', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  await holdSlider(page, panel.getByLabel('Reading line'), -30);
  await shotWindow(page, 'prompter-held');
  await page.mouse.up();
  await expect(panel).not.toHaveAttribute('data-peeking', '');
});

test('prompter: the eye held — the whole stage', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  const eye = panel.getByRole('button', { name: 'Hold to see the whole stage' });
  const box = await eye.boundingBox();
  if (!box) throw new Error('the eye has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(panel).toHaveAttribute('data-revealing', '');
  await shotWindow(page, 'prompter-eye-held');
  await page.mouse.up();
  await expect(panel).not.toHaveAttribute('data-revealing', '');
});

/*
 * A click on the stage while the panel is up: it must neither close nor
 * reach the stage, and the panel's edge answers it. Taken straight away,
 * without the usual settle, because the answer lasts about half a second.
 */
test('prompter: a click away', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  await panel.getByRole('button', { name: 'Larger text' }).click();
  await page.mouse.click(760, 140);
  await expect(page.locator('.stage-dock .appearance-popover')).toHaveAttribute('data-attention', '');
  await page.waitForTimeout(80);
  await page.screenshot({ path: outPath('prompter-click-away--window'), caret: 'hide' });
  await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
});

test('prompter: at the largest size', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  const size = panel.getByLabel('Text size');
  const max = await size.getAttribute('max');
  if (!max) throw new Error('the size slider has no max');
  await size.fill(max);
  await expect(panel.getByRole('button', { name: 'Larger text' })).toBeDisabled();
  await shotWindow(page, 'prompter-max-size');
  await shotSheet(page, 'prompter-max-size');
});

test('prompter: Done, and what it says', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, UNKNOWN_PANEL] });
  const panel = await openSheet(page, 'Prompter appearance');
  await panel.getByRole('button', { name: 'Larger text' }).click();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText('Prompter appearance saved')).toBeVisible();
  await shotWindow(page, 'prompter-after-done');
});

test('prompter: sized automatically for the Elgato', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, ELGATO] });
  const panel = await openSheet(page, 'Prompter appearance');
  await expect(panel).toContainText('Automatic');
  await expect(panel.getByLabel('Size balance')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
  await shotWindow(page, 'prompter-automatic');
  await shotSheet(page, 'prompter-automatic');
});

test('prompter: automatic, balanced toward larger text', async ({ page }) => {
  await present(page, { mode: 'prompter', size: PROMPTER, displays: [BUILTIN, ELGATO] });
  const panel = await openSheet(page, 'Prompter appearance');
  const opened = await panel.locator('dd').first().textContent();
  await panel.getByLabel('Size balance').fill('85');
  await expect(panel.locator('dd').first()).not.toHaveText(opened ?? '');
  await shotWindow(page, 'prompter-automatic-adjusted');
  await shotSheet(page, 'prompter-automatic-adjusted');
});

test('prompter: a calibrated rig', async ({ page }) => {
  await present(page, {
    mode: 'prompter',
    size: PROMPTER,
    displays: [BUILTIN, ELGATO],
    overlay: { optical: CALIBRATED_RIG },
  });
  const panel = await openSheet(page, 'Prompter appearance');
  await expect(panel).toContainText('Calibrated');
  await expect(panel.getByRole('button', { name: 'Close' })).toBeVisible();
  await shotWindow(page, 'prompter-calibrated');
  await shotSheet(page, 'prompter-calibrated');
});
