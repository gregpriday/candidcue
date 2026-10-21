import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

/**
 * Capture harness for the stage's session dock — design review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE_DIR` names a directory, so the
 * normal suite and CI skip every test here. Each test drives one state of the
 * dock through the seams a real take uses — Present from the Library, the
 * shim's `stt://event` and `align://snapshot` deliveries, a silent capture
 * track for the audio fault, the dock's own controls under a real pointer and
 * keyboard — and writes two PNGs: the whole window, for where the dock sits
 * against the script and the take-controls tab, and a crop around the dock and
 * whatever popover it has raised. A state is checked on screen BEFORE its files
 * are written, so a capture that did not reach its state fails instead of
 * saving a plausible wrong frame.
 *
 *   DESIGN_CAPTURE_DIR=/tmp/shots SPEAKING_GLASS_E2E_PORT=5321 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-stage-dock.spec.ts --project=chromium
 */

const CAPTURE_DIR = process.env.DESIGN_CAPTURE_DIR ?? '';

test.skip(CAPTURE_DIR === '', 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

/** The Elgato Prompter's own grid — the panel a prompter take is judged on. */
const PROMPTER = { width: 1024, height: 600 } as const;
/** A reading window on a desk monitor. */
const DESK = { width: 1280, height: 800 } as const;

const SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Quarterly update',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter, and why it matters for the people who ship it.\n\n' +
    '## Pricing\n\nWe moved every plan to annual billing by default. Monthly billing is still there for anyone who asks for it.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March. The team that built it will walk you through it next week.\n',
};

/** Longer than the dock's 4 s idle timer, with room for its 140 ms fade. */
const IDLE_MS = 4_700;

async function boot(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
}

/** Paper saved in Settings, before the app reads its overlay. */
async function seedPaper(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = 'speaking-glass.settings-overlay.v1';
    const overlay = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    const teleprompter = (overlay['teleprompter'] ?? {}) as Record<string, unknown>;
    overlay['teleprompter'] = { ...teleprompter, readerTheme: 'paper' };
    localStorage.setItem(key, JSON.stringify(overlay));
  });
}

async function presentPrompter(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page.getByRole('listbox').getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
}

/** Through the editor's "How to present" menu, by the row's name. */
async function presentFromMenu(page: Page, row: RegExp): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Quarterly update/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page.getByRole('menu', { name: 'How to present' }).getByRole('menuitem').filter({ hasText: row }).first().click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
}

async function presentInWindow(page: Page): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Quarterly update/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present in a window/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
}

async function transcriptionStarted(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('start_transcription')), {
      timeout: 15_000,
    })
    .toBe(true);
}

/**
 * Words arriving on the take's own transcription generation, then a lock.
 *
 * The partials keep coming unless told otherwise: the fake capture device
 * plays a steady tone, and a take that hears speech and transcribes none of it
 * is — correctly — reported as "Not hearing you" within seconds, which holds
 * the dock up and would make every healthy state a fault state.
 */
async function following(page: Page, { keepHearing = true } = {}): Promise<void> {
  await transcriptionStarted(page);
  await page.evaluate((keep) => {
    const generation =
      40 + window.__E2E__.calls.filter((call) => call.command === 'start_transcription').length;
    window.__E2E__.emit('stt://event', { kind: 'transport', generation, state: 'connected' });
    const hear = (): void => {
      window.__E2E__.emit('stt://event', {
        kind: 'partial',
        generation,
        itemId: `design-${Date.now()}`,
        text: 'thank you for joining me today here is what changed',
      });
    };
    hear();
    if (keep) window.setInterval(hear, 1_000);
  }, keepHearing);
  for (const [seq, token, atMs] of [
    [1, 4, 2_000],
    [2, 9, 4_200],
  ] as const) {
    const delivered = await page.evaluate(
      ([s, t, at]) =>
        window.__E2E__.emit('align://snapshot', {
          sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
          seq: s,
          state: 'following',
          decision: 'localConfirmed',
          confirmedToken: t,
          observedToken: t,
          rateTokensPerSecond: 2.4,
          evidenceAudioMs: at,
          atAudioMs: at,
          maxPredictionMs: 800,
          pauseOnsetMs: 400,
          leadFloorMs: 0,
          maxLeadTokens: 2,
          leadMarginTokens: 2.2,
          leadEaseMs: 450,
          leadHoldMs: 0,
          leadDecayMs: 1200,
          displayLimitToken: t + 6,
          confidence: 0.92,
          suggestionToken: null,
          scriptLenTokens: 60,
          observedAtom: t,
          confirmedAtom: t,
        }),
      [seq, token, atMs] as const,
    );
    expect(delivered).toBeGreaterThan(0);
  }
}

const trigger = (page: Page): Locator => page.locator('.stage-dock .dock-button.menu-trigger');
const endButton = (page: Page): Locator => page.locator('.stage-dock .dock-button.end');
const menu = (page: Page): Locator => page.locator('.stage-dock .menu-popover');
const confirm = (page: Page): Locator => page.locator('.stage-dock .confirm-popover');

/** Move the pointer over the script, clear of the dock, so the controls wake. */
async function wake(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width * 0.55, viewport.height * 0.4);
  await page.mouse.move(viewport.width * 0.6, viewport.height * 0.45, { steps: 4 });
  await expect(endButton(page)).toHaveAttribute('data-hidden', 'false');
}

/** Park the pointer over the script and let the idle timer run out. */
async function idle(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width * 0.7, viewport.height * 0.3);
  await page.waitForTimeout(IDLE_MS);
  await expect(endButton(page)).toHaveAttribute('data-hidden', 'true');
}

async function openMenuWithMouse(page: Page): Promise<void> {
  await wake(page);
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
}

async function openConfirm(page: Page): Promise<void> {
  await wake(page);
  await endButton(page).click();
  await expect(confirm(page)).toBeVisible();
}

/**
 * The whole window, and a crop around the dock plus anything it has raised.
 *
 * The dock's own box covers only its row — the popovers are absolutely placed
 * above it — so the crop is the union of every dock part on screen, padded.
 */
async function shot(page: Page, state: string): Promise<void> {
  // Past the popover's rise, the buttons' fade and any focus transition.
  await page.waitForTimeout(400);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(CAPTURE_DIR, `${state}--full.png`), caret: 'hide' });

  const viewport = page.viewportSize()!;
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('.stage-dock, .stage-dock .dock-popover, .stage-dock .dock-row')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, right: r.right, bottom: r.bottom };
    }),
  );
  expect(boxes.length, 'the dock must be on screen to crop it').toBeGreaterThan(0);
  const pad = 28;
  const x = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - pad));
  const y = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - pad));
  // At least 420 wide, so a resting dock is seen with some script beside it.
  const right = Math.min(viewport.width, Math.max(x + 420, Math.ceil(Math.max(...boxes.map((b) => b.right)) + pad)));
  const bottom = viewport.height;
  await page.screenshot({
    path: join(CAPTURE_DIR, `${state}--dock.png`),
    caret: 'hide',
    clip: { x, y, width: right - x, height: bottom - y },
  });
}

test.describe('prompter take, 1024x600', () => {
  test('p01 the take opens with the dock introduced', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await expect(endButton(page)).toHaveAttribute('data-hidden', 'false');
    await shot(page, 'p01-start');
  });

  test('p02 at rest, the controls faded', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await idle(page);
    await expect(trigger(page)).toHaveAttribute('data-hidden', 'true');
    await shot(page, 'p02-rest');
  });

  test('p03 the pointer moves and the controls come back', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await idle(page);
    await wake(page);
    await shot(page, 'p03-revealed');
  });

  test('p04 the pointer rests on the way out', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await wake(page);
    await endButton(page).hover();
    await shot(page, 'p04-hover-end');
  });

  test('p05 the menu, opened with the mouse', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await openMenuWithMouse(page);
    // The pointer stays on the trigger, as it would after the click.
    await shot(page, 'p05-menu-mouse');
  });

  test('p06 the menu, opened from the keyboard', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await wake(page);
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).locator('.menu-row.active')).toHaveCount(1);
    await shot(page, 'p06-menu-keyboard');
  });

  test('p07 following off, at rest', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await openMenuWithMouse(page);
    await menu(page).locator('[data-menu-row="follow"]').click();
    await expect(trigger(page)).toHaveClass(/flagged/);
    await page.mouse.move(700, 150, { steps: 3 });
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    // Off the trigger and away from the keyboard, so nothing holds the dock.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await idle(page);
    await expect(trigger(page)).toHaveAttribute('data-hidden', 'false');
    await shot(page, 'p07-follow-off-rest');
  });

  test('p08 following off, menu open', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await openMenuWithMouse(page);
    await menu(page).locator('[data-menu-row="follow"]').click();
    await expect(menu(page).locator('[data-menu-row="follow"]')).toHaveAttribute('aria-checked', 'false');
    await shot(page, 'p08-follow-off-menu');
  });

  test('p09 the end-take confirmation', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await openConfirm(page);
    await expect(confirm(page)).toContainText('End take?');
    await shot(page, 'p09-confirm');
  });

  test('p10 one Escape, the keyboard route out', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await page.locator('.stage-root').click({ position: { x: 600, y: 200 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.escape-hint')).toBeVisible();
    await shot(page, 'p10-escape-hint');
  });

  test('p15 a held Escape is one press, never two', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await page.locator('.stage-root').click({ position: { x: 600, y: 200 } });
    // A key resting on the keyboard: one press, then auto-repeat.
    await page.keyboard.down('Escape');
    for (let i = 0; i < 6; i += 1) {
      await page.waitForTimeout(60);
      await page.keyboard.down('Escape');
    }
    await page.keyboard.up('Escape');
    await expect(page.locator('.escape-hint')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();
    await shot(page, 'p15-held-escape');
  });

  test('p11 the appearance panel, the menu second level', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await openMenuWithMouse(page);
    await menu(page).locator('[data-menu-row="appearance"]').click();
    await expect(page.locator('.stage-dock .appearance-popover')).toBeVisible();
    await expect(endButton(page)).toBeDisabled();
    await shot(page, 'p11-appearance');
  });

  test('p12 an audio fault holds the dock up', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, PROMPTER);
    await presentPrompter(page);
    // Speech the recogniser never answers: the pill's "Not hearing you".
    await following(page, { keepHearing: false });
    await page.mouse.move(700, 180);
    await expect(page.locator('.stage-dock .voice-pill[data-reading="fault"]')).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(IDLE_MS);
    await expect(endButton(page)).toHaveAttribute('data-hidden', 'false');
    await shot(page, 'p12-fault');
  });
});

test.describe('prompter take, 1024x600 — dismissal', () => {
  test('p13 the menu dismissed under a resting pointer still lets the dock fade', async ({ page }) => {
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page);
    await openMenuWithMouse(page);
    // The pointer rests on a row while Escape takes the menu away under it.
    await menu(page).locator('[data-menu-row="follow"]').hover();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await idle(page);
    await shot(page, 'p13-after-menu-escape');
  });

  test('p14 a fault clearing under an open confirmation does not move it', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, PROMPTER);
    await presentPrompter(page);
    await following(page, { keepHearing: false });
    await page.mouse.move(700, 180);
    await expect(page.locator('.stage-dock .voice-pill[data-reading="fault"]')).toBeVisible({ timeout: 25_000 });
    await endButton(page).click();
    await expect(confirm(page)).toBeVisible();
    const cancel = page.locator('.stage-dock .confirm-cancel');
    await cancel.hover();
    const before = await cancel.boundingBox();
    // Words come back: the fault clears and its name leaves the readout.
    await page.evaluate(() => {
      const generation =
        40 + window.__E2E__.calls.filter((call) => call.command === 'start_transcription').length;
      window.__E2E__.emit('stt://event', {
        kind: 'partial',
        generation,
        itemId: `design-recover-${Date.now()}`,
        text: 'and why it matters for the people who ship it',
      });
    });
    await expect(page.locator('.stage-dock .voice-pill[data-reading="fault"]')).toHaveCount(0, { timeout: 10_000 });
    const after = await cancel.boundingBox();
    expect(after!.x, 'Cancel must stay where the pointer is').toBeCloseTo(before!.x, 0);
    await shot(page, 'p14-confirm-through-recovery');
  });
});

test.describe('reading window, dark, 1280x800', () => {
  test('r01 revealed', async ({ page }) => {
    await boot(page, DESK);
    await presentInWindow(page);
    await following(page);
    await wake(page);
    await shot(page, 'r01-revealed');
  });

  test('r02 menu open', async ({ page }) => {
    await boot(page, DESK);
    await presentInWindow(page);
    await following(page);
    await openMenuWithMouse(page);
    await expect(menu(page)).toContainText('Switch to teleprompter');
    await shot(page, 'r02-menu');
  });

  test('r03 a practice, finishing', async ({ page }) => {
    await boot(page, DESK);
    await presentFromMenu(page, /Practi/);
    await following(page);
    await openConfirm(page);
    await expect(confirm(page)).toContainText('Finish');
    await shot(page, 'r03-practice-confirm');
  });
});

test.describe('reading window, paper, 1280x800', () => {
  test('q01 revealed', async ({ page }) => {
    await seedPaper(page);
    await boot(page, DESK);
    await presentInWindow(page);
    await following(page);
    await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
    await wake(page);
    await shot(page, 'q01-revealed');
  });

  test('q02 menu open', async ({ page }) => {
    await seedPaper(page);
    await boot(page, DESK);
    await presentInWindow(page);
    await following(page);
    await openMenuWithMouse(page);
    await shot(page, 'q02-menu');
  });

  test('q03 the end-take confirmation', async ({ page }) => {
    await seedPaper(page);
    await boot(page, DESK);
    await presentInWindow(page);
    await following(page);
    await openConfirm(page);
    await shot(page, 'q03-confirm');
  });

  test('q04 following off, at rest', async ({ page }) => {
    await seedPaper(page);
    await boot(page, DESK);
    await presentInWindow(page);
    await following(page);
    await openMenuWithMouse(page);
    await menu(page).locator('[data-menu-row="follow"]').click();
    await page.mouse.move(700, 150, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await idle(page);
    await expect(trigger(page)).toHaveAttribute('data-hidden', 'false');
    await shot(page, 'q04-follow-off-rest');
  });
});

test.describe('standalone stage window, 1024x600', () => {
  test('s01 menu open', async ({ page }) => {
    await page.setViewportSize(PROMPTER);
    await page.goto('/stage.html?preview=1');
    await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
    await openMenuWithMouse(page);
    await shot(page, 's01-standalone-menu');
  });

  test('s02 a blank still answers the pointer', async ({ page }) => {
    await page.setViewportSize(PROMPTER);
    await page.goto('/stage.html?preview=1');
    await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
    await page.locator('.stage-root').click({ position: { x: 600, y: 200 } });
    await page.keyboard.press('b');
    await expect(page.locator('.script-holder.blanked')).toHaveCount(1);
    await wake(page);
    await shot(page, 's02-blank-revealed');
  });
});
