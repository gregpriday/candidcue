import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

/**
 * Capture harness for the reading window's "Read from there" offer — design
 * review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE_DIR` names a directory, so the
 * normal suite and CI skip every test here. Each test presents a script in a
 * reading window, delivers the refusal a real take would (`holdOffScreen` with
 * a `suggestionToken`) over the shim's `align://snapshot`, and writes one PNG.
 * The offer is checked on screen, with the words it should carry, BEFORE the
 * file is written, so a capture that did not reach its state fails instead of
 * saving a plausible wrong frame.
 *
 *   DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5313 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-capture-suggestion.spec.ts --project=chromium
 */

const CAPTURE_DIR = process.env.DESIGN_CAPTURE_DIR ?? '';

test.skip(CAPTURE_DIR === '', 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

const SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999991',
  title: 'Cape Morrow',
  source: [
    '# Arrival',
    '',
    'For eleven years the light at Cape Morrow was kept by a woman named Ada Vance, who arrived with two suitcases and no plan to stay.',
    '',
    'The first winter nearly finished her, and the storms came in off the water three and four days at a stretch.',
    '',
    'She learned the lamp before she learned the town, and the town took a long time to learn her back.',
    '',
    '# The log',
    '',
    'She kept a log, as every keeper did, but hers was unusual. Alongside the wind she wrote down one small thing she noticed each day.',
    '',
    'A heron on the breakwater. Frost on the inside of the glass. A boy who rowed out every Sunday and never said why.',
    '',
    'When the light was finally automated the log went to the county archive, where people still ask for it more than anything else.',
    '',
  ].join('\n'),
};

const LONG_HEADING =
  'What the keepers of the northern lights wrote down when nobody was asking them to';

const LONG_SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999992',
  title: 'Northern lights',
  source: [
    '# Opening',
    '',
    'There were never many of them, and by the end there were only a handful left on the whole coast.',
    '',
    'Most of what they did was routine, and most of the routine was written down somewhere.',
    '',
    'The rest of it went home with them, and some of it is still going round the harbour bars.',
    '',
    `# ${LONG_HEADING}`,
    '',
    'Notwithstanding everything the inspectors expected of a well-kept station, the logs that survive are mostly about weather, birds and the people who came to visit.',
    '',
  ].join('\n'),
};

const BARE_SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999993',
  title: 'Toast',
  source: [
    'Thank you all for coming tonight, and thank you to the people who made the room look like this.',
    '',
    'I have known the two of them for a long time now, and I have never once seen them agree on a restaurant.',
    '',
    'They do agree on the important things, though, and the most important of those is each other.',
    '',
    'So please raise a glass with me, to the two people who finally found a table they could share.',
    '',
  ].join('\n'),
};

interface Size {
  width: number;
  height: number;
}

const DESK: Size = { width: 1100, height: 640 };

async function boot(
  page: Page,
  options: { size?: Size; paper?: boolean; seeds?: ShimScriptSeed[] } = {},
): Promise<void> {
  const size = options.size ?? DESK;
  await page.setViewportSize(size);
  if (options.paper) {
    await page.addInitScript(() => {
      const key = 'candidcue.settings-overlay.v1';
      const overlay = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      const teleprompter = (overlay['teleprompter'] ?? {}) as Record<string, unknown>;
      overlay['teleprompter'] = { ...teleprompter, readerTheme: 'paper' };
      localStorage.setItem(key, JSON.stringify(overlay));
    });
  }
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: options.seeds ?? [SCRIPT],
    presentationMode: 'reader',
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
}

async function presentInWindow(page: Page, title: RegExp): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present in a window/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
  await expect(page.locator('.script-layer span.w[data-t]').first()).toBeVisible();
}

/** Deliver one aligner snapshot over the control path the take listens on. */
async function snapshot(page: Page, fields: Record<string, unknown>): Promise<void> {
  await page.evaluate((fields) => {
    const at = performance.now();
    window.__E2E__.emit('align://snapshot', {
      sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
      seq: window.__E2E__.nextAlignmentSeq(),
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: 0,
      observedToken: 0,
      rateTokensPerSecond: 0,
      evidenceAudioMs: at,
      atAudioMs: at,
      maxPredictionMs: 1400,
      pauseOnsetMs: 2400,
      leadFloorMs: 0,
      maxLeadTokens: 3.2,
      leadMarginTokens: 1,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: 400,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 400,
      observedAtom: 0,
      confirmedAtom: 0,
      ...fields,
    });
  }, fields);
}

/** A refusal: the engine matched `token` but would not move the document there. */
async function refuse(page: Page, token: number, at = 2): Promise<void> {
  await snapshot(page, {
    state: 'holding',
    decision: 'holdOffScreen',
    confirmedToken: at,
    observedToken: at,
    suggestionToken: token,
    confidence: 0.6,
  });
}

async function tokenOf(page: Page, word: string): Promise<number> {
  const t = await page
    .locator('.script-layer span.w[data-t]')
    .filter({ hasText: new RegExp(`^${word}$`) })
    .first()
    .getAttribute('data-t');
  return Number(t);
}

/** Following, a few words in: the document has settled at the opening. */
async function readingOpening(page: Page): Promise<void> {
  // The pointer off the stage, so no state is captured under a hover it did
  // not ask for (it is left wherever the presentation menu was).
  await page.mouse.move(2, 2);
  await snapshot(page, { confirmedToken: 4, observedToken: 4 });
  await page.waitForTimeout(600);
}

/**
 * A refusal that persists, renewed the way a real take renews it, until the
 * hold ladder has said so in the corner — the steady state the offer lives in.
 */
async function holdClimbs(page: Page, token: number): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1000);
    await refuse(page, token);
  }
  await expect(page.locator('.hold-status')).toBeVisible();
}

function chip(page: Page): Locator {
  return page.locator('[data-suggestion-chip]');
}

async function shot(page: Page, name: string): Promise<void> {
  // Past any entrance and the follower's ease, and the caret blink.
  await page.waitForTimeout(500);
  await expect(chip(page)).toBeVisible();
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(CAPTURE_DIR, `${name}.png`), caret: 'hide' });
}

/** The offer alone, cropped with a margin, for a close read of its type. */
async function closeUp(page: Page, name: string): Promise<void> {
  const box = await chip(page).boundingBox();
  expect(box).toBeTruthy();
  const pad = 24;
  const view = page.viewportSize()!;
  const x = Math.max(0, box!.x - pad);
  const y = Math.max(0, box!.y - pad);
  await page.screenshot({
    path: join(CAPTURE_DIR, `${name}.png`),
    caret: 'hide',
    clip: {
      x,
      y,
      width: Math.min(view.width - x, box!.width + 2 * pad),
      height: Math.min(view.height - y, box!.height + 2 * pad),
    },
  });
}

test.describe.configure({ timeout: 60_000 });

test('01 below, dark, desk window', async ({ page }) => {
  await boot(page);
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toContainText('The log');
  await expect(chip(page)).toContainText('When the light was finally automated');
  await shot(page, '01-below--dark');
  await closeUp(page, '01z-below--dark--close');
});

test('02 below, paper, desk window', async ({ page }) => {
  await boot(page, { paper: true });
  await presentInWindow(page, /Cape Morrow/);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toContainText('When the light was finally automated');
  await shot(page, '02-below--paper');
  await closeUp(page, '02z-below--paper--close');
});

test('03 above, dark — the reader has run ahead of a match behind them', async ({ page }) => {
  await boot(page);
  await presentInWindow(page, /Cape Morrow/);
  const late = await tokenOf(page, 'automated');
  await snapshot(page, { confirmedToken: late, observedToken: late });
  await page.waitForTimeout(1200);
  const early = await tokenOf(page, 'eleven');
  await refuse(page, early, late);
  await expect(chip(page)).toHaveAttribute('data-direction', 'above');
  await expect(chip(page)).toContainText('Arrival');
  await shot(page, '03-above--dark');
});

test('04 pointer over Read from there, dark', async ({ page }) => {
  await boot(page);
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toBeVisible();
  await chip(page).getByRole('button', { name: 'Read from there' }).hover();
  await page.waitForTimeout(250);
  await closeUp(page, '04-hover-read--dark--close');
});

test('05 keyboard focus on Read from there, paper', async ({ page }) => {
  await boot(page, { paper: true });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toBeVisible();
  // Keyboard modality first, so the focus that follows draws its ring.
  await page.keyboard.press('Shift');
  await chip(page).getByRole('button', { name: 'Read from there' }).focus();
  await expect(chip(page).getByRole('button', { name: 'Read from there' })).toBeFocused();
  await page.waitForTimeout(250);
  await closeUp(page, '05-focus-read--paper--close');
});

test('06 small window, dark — the offer, the hold message and the dock together', async ({
  page,
}) => {
  await boot(page, { size: { width: 580, height: 360 } });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toBeVisible();
  await holdClimbs(page, await tokenOf(page, 'automated'));
  await shot(page, '06-small--dark');
});

test('06b small window, dark — the folded offer, opened by the reader', async ({ page }) => {
  await boot(page, { size: { width: 580, height: 360 } });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  const pill = chip(page).getByRole('button', { name: /down/ });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(chip(page).getByRole('button', { name: 'Read from there' })).toBeFocused();
  await shot(page, '06b-small-opened--dark');
});

test('12 desk window, dark — folded once nothing has renewed it', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page);
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page).getByRole('button', { name: 'Read from there' })).toBeVisible();
  await expect(chip(page).getByRole('button', { name: /Show possible match/ })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, '12-folded--dark');
});

test('13 short, wide window, paper — the offer in the dock\'s row', async ({ page }) => {
  await boot(page, { size: { width: 1100, height: 420 }, paper: true });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page).getByRole('button', { name: 'Read from there' })).toBeVisible();
  await expect(chip(page)).toContainText('When the light was finally automated');
  await shot(page, '13-short-wide--paper');
});

test('14 short, wide window, dark — beside the dock at its widest', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, { size: { width: 1100, height: 420 } });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  const target = await tokenOf(page, 'automated');
  await refuse(page, target);
  await expect(chip(page).getByRole('button', { name: 'Read from there' })).toBeVisible();
  // Renewed, as a take that keeps refusing does, until the readout carries
  // its fault label; then the pointer on the dock, so both its buttons show.
  const fault = page.locator('.dock-row').getByText('Not hearing you');
  for (let i = 0; i < 20 && !(await fault.isVisible()); i++) {
    await page.waitForTimeout(1000);
    await refuse(page, target);
  }
  await expect(fault).toBeVisible();
  await page.locator('.dock-row').hover();
  await expect(chip(page).getByRole('button', { name: 'Read from there' })).toBeVisible();
  await shot(page, '14-short-wide-fault--dark');
});

test('11 desk window, dark, once the hold message has come up beside the offer', async ({
  page,
}) => {
  await boot(page);
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toBeVisible();
  await holdClimbs(page, await tokenOf(page, 'automated'));
  await shot(page, '11-held--dark');
});

test('07 long section title and a long first sentence, dark', async ({ page }) => {
  await boot(page, { seeds: [LONG_SCRIPT] });
  await presentInWindow(page, /Northern lights/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'inspectors'));
  await expect(chip(page)).toContainText('Notwithstanding');
  await shot(page, '07-long--dark');
  await closeUp(page, '07z-long--dark--close');
});

test('08 no heading above the match, paper', async ({ page }) => {
  await boot(page, { paper: true, seeds: [BARE_SCRIPT] });
  await presentInWindow(page, /Toast/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'raise'));
  await expect(chip(page)).toContainText('So please raise a glass');
  await shot(page, '08-no-section--paper');
});

test('09 large window, dark', async ({ page }) => {
  await boot(page, { size: { width: 1440, height: 900 } });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'automated'));
  await expect(chip(page)).toContainText('When the light was finally automated');
  await shot(page, '09-large--dark');
});

test('10 the match is on the glass already, paper', async ({ page }) => {
  await boot(page, { paper: true });
  await presentInWindow(page, /Cape Morrow/);
  await readingOpening(page);
  await refuse(page, await tokenOf(page, 'winter'), 4);
  await expect(chip(page)).toBeVisible();
  await shot(page, '10-visible--paper');
});
