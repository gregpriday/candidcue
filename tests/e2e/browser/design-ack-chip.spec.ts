import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';

/**
 * Capture harness for the stage's command acknowledgement — design review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE_DIR` names a directory, so the
 * normal suite and CI skip every test here. Each test presents a take the way a
 * presenter does (single window, from the Library), presses the key a presenter
 * presses mid-take, and photographs whatever the glass shows in answer. The
 * acknowledgement is found by its WORDS, wherever it is drawn, and checked
 * visible and fully faded in both before and after the screenshot — so a frame
 * taken while it was arriving, leaving or absent fails instead of being saved.
 *
 *   DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5323 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-ack-chip.spec.ts --project=chromium
 */

const CAPTURE_DIR = process.env.DESIGN_CAPTURE_DIR ?? '';

test.skip(CAPTURE_DIR === '', 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

const PROMPTER = { name: 'prompter-1024', width: 1024, height: 600 } as const;
const PROMPTER_HD = { name: 'prompter-1920', width: 1920, height: 1080 } as const;
const WINDOW = { name: 'window-1440', width: 1440, height: 900 } as const;

type Size = { name: string; width: number; height: number };

const LONG_SECTION = 'Quarterly results for the enterprise customer segment, renewals included';

const SCRIPT: ShimScriptSeed = {
  id: '99999999-9999-4999-8999-999999999999',
  title: 'Quarterly update',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter, and why it matters for the people who ship it. ' +
    'We will cover pricing first, then what the team is shipping next, and then the numbers.\n\n' +
    '## Pricing\n\nWe moved every plan to annual billing by default. Monthly billing is still there for anyone who asks for it, ' +
    'and nobody on a monthly plan today will be moved without being asked first.\n\n' +
    `## ${LONG_SECTION}\n\nRenewals came in ahead of plan for the third quarter running. Expansion revenue carried most of it.\n\n` +
    '## What is next\n\nWe ship the new onboarding in March. The team that built it will walk you through it next week.\n',
};

async function boot(page: Page, size: Size, presentationMode: 'prompter' | 'reader' = 'prompter'): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    presentationMode,
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
  await onElgatoPanel(page);
}

/**
 * Present onto an Elgato panel the size of the viewport, the way a real rig does.
 *
 * The shim names no landed display, so every take it presents is composed
 * against the flat 64px fallback with no optical profile — and every
 * presenter-facing label falls to its 18px "nothing is known" size. That is not
 * what the glass shows on the panels this app is judged on, and a review of a
 * label's size against it would be a review of the wrong size. So the shim's
 * answers are extended, here and only here: the display list gains the panel,
 * and a prompter Present reports landing on it, which is what `startTake`
 * composes the automatic profile from.
 */
async function onElgatoPanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    const xl = window.innerWidth >= 1920;
    const panel = {
      id: 'display-elgato',
      name: xl ? 'Elgato Prompter XL' : 'Elgato Prompter',
      physicalPosition: { x: 4944, y: 0 },
      physicalSize: xl ? { width: 1920, height: 1080 } : { width: 1024, height: 600 },
      scaleFactor: 1,
      logicalSize: xl ? { width: 1920, height: 1080 } : { width: 1024, height: 600 },
      primary: false,
      fingerprint: 'dsp-e2e-elgato',
      topologyHash: 'top-e2e',
    };
    internals.invoke = async (command, args) => {
      const answer = await invoke(command, args);
      if (command === 'list_displays' && Array.isArray(answer)) return [...answer, panel];
      if (command === 'set_control_presenting') {
        const state = answer as { presenting?: boolean; mode?: string };
        if (state.presenting === true && state.mode !== 'reader') {
          return { ...state, displayFingerprint: panel.fingerprint };
        }
      }
      return answer;
    };
  });
}

/** Paper saved in Settings, before the app reads its overlay. */
async function seedPaper(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = 'candidcue.settings-overlay.v1';
    const overlay = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    const teleprompter = (overlay['teleprompter'] ?? {}) as Record<string, unknown>;
    overlay['teleprompter'] = { ...teleprompter, readerTheme: 'paper' };
    localStorage.setItem(key, JSON.stringify(overlay));
  });
}

async function present(page: Page, region: RegExp | string = 'Teleprompter'): Promise<void> {
  await page.goto('/control.html');
  await page.getByRole('listbox').getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: region })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
  await expect
    .poll(
      () => page.locator('.script-layer').evaluate((el) => getComputedStyle(el).visibility !== 'hidden'),
      { timeout: 10_000, intervals: [80] },
    )
    .toBe(true);
}

async function transcriptionStarted(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('start_transcription')), {
      timeout: 15_000,
    })
    .toBe(true);
}

/** Words arriving on the take's own transcription generation. */
async function hear(page: Page, text: string): Promise<void> {
  await page.evaluate((spoken) => {
    const generation =
      40 + window.__E2E__.calls.filter((call) => call.command === 'start_transcription').length;
    window.__E2E__.emit('stt://event', { kind: 'transport', generation, state: 'connected' });
    window.__E2E__.emit('stt://event', {
      kind: 'partial',
      generation,
      itemId: `design-${Date.now()}`,
      text: spoken,
    });
  }, text);
}

/** A take that is following a voice, so the glass looks the way it does mid-take. */
async function following(page: Page): Promise<void> {
  await transcriptionStarted(page);
  await hear(page, 'thank you for joining me today here is what changed');
  for (const [seq, token] of [
    [1, 4],
    [2, 9],
  ] as const) {
    await page.evaluate(
      ({ seq, token }) =>
        window.__E2E__.emit('align://snapshot', {
          sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
          seq,
          state: 'following',
          decision: 'localConfirmed',
          confirmedToken: token,
          observedToken: token,
          rateTokensPerSecond: 2.4,
          evidenceAudioMs: 2_000 * seq,
          atAudioMs: 2_000 * seq,
          maxPredictionMs: 800,
          pauseOnsetMs: 400,
          leadFloorMs: 0,
          maxLeadTokens: 2,
          leadMarginTokens: 2.2,
          leadEaseMs: 450,
          leadHoldMs: 0,
          leadDecayMs: 1200,
          displayLimitToken: token + 6,
          confidence: 0.92,
          suggestionToken: null,
          scriptLenTokens: 80,
          observedAtom: token,
          confirmedAtom: token,
        }),
      { seq, token },
    );
  }
}

/**
 * Let the session dock fall back to its resting readout, as it does mid-take —
 * still speaking meanwhile, so the wait does not turn into a "not hearing you"
 * hold that no real take in progress would show.
 */
async function dockAtRest(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
  for (let i = 0; i < 6; i++) {
    await hear(page, `thank you for joining me today here is what changed ${i}`);
    await page.waitForTimeout(750);
  }
}

/**
 * Whatever on the page is acknowledging `label` — the stage's chip, or anything
 * else that has taken that job — once it is fully in.
 */
async function acknowledgement(page: Page, label: string | RegExp): Promise<Locator> {
  const found = page.locator('.ack, .toast').filter({ hasText: label }).last();
  await expect(found, `nothing on the glass says ${String(label)}`).toBeVisible({ timeout: 4_000 });
  await expect
    .poll(() => found.evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 2_000, intervals: [16] })
    .toBe(1);
  return found;
}

async function shot(page: Page, state: string, size: Size, ack: Locator): Promise<void> {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const path = join(CAPTURE_DIR, `${state}--${size.name}.png`);
  await page.screenshot({ path, caret: 'hide' });
  // Still fully in AFTER the frame was taken, or the frame may show it leaving.
  const after = await ack.evaluate((el) => {
    const style = getComputedStyle(el);
    return style.visibility === 'visible' ? Number(style.opacity) : 0;
  });
  if (after < 0.99) throw new Error(`${state}: the acknowledgement had started to leave when the frame was taken`);
}

for (const size of [PROMPTER, PROMPTER_HD]) {
  test(`section jump — ${size.name}`, async ({ page }) => {
    await boot(page, size);
    await present(page);
    await following(page);
    await dockAtRest(page);
    await page.keyboard.press('Alt+ArrowDown');
    await shot(page, '01-section-jump', size, await acknowledgement(page, 'Pricing'));
  });
}

test(`section jump with the dock up — ${PROMPTER.name}`, async ({ page }) => {
  await boot(page, PROMPTER);
  await present(page);
  await following(page);
  await page.mouse.move(PROMPTER.width / 2, PROMPTER.height / 2);
  await page.mouse.move(PROMPTER.width / 2 + 10, PROMPTER.height / 2 + 10);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.stage-dock .dock-button.end')).toBeVisible();
  await shot(page, '02-dock-up', PROMPTER, await acknowledgement(page, 'Pricing'));
});

test(`a long section title — ${PROMPTER.name}`, async ({ page }) => {
  await boot(page, PROMPTER);
  await present(page);
  await following(page);
  await dockAtRest(page);
  await page.keyboard.press('Alt+ArrowDown');
  await acknowledgement(page, 'Pricing');
  await page.keyboard.press('Alt+ArrowDown');
  await shot(page, '03-long-title', PROMPTER, await acknowledgement(page, LONG_SECTION));
});

test(`pace pressed three times — ${PROMPTER.name}`, async ({ page }) => {
  await boot(page, PROMPTER);
  await present(page);
  await following(page);
  await dockAtRest(page);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(']');
    await page.waitForTimeout(220);
  }
  await shot(page, '04-pace-repeat', PROMPTER, await acknowledgement(page, /\d+\s+wpm/));
});

test(`auto-scroll on — ${PROMPTER.name}`, async ({ page }) => {
  await boot(page, PROMPTER);
  await present(page);
  await following(page);
  await dockAtRest(page);
  await page.keyboard.press('a');
  await shot(page, '05-auto-scroll-on', PROMPTER, await acknowledgement(page, /Auto-scroll\s+(on|\d+)/));
});

test(`mirror turned on — ${PROMPTER.name}`, async ({ page }) => {
  await boot(page, PROMPTER);
  await present(page);
  await following(page);
  await dockAtRest(page);
  // The chord's modifier is the page's own primary one, whatever it reports.
  const mac = (await page.locator('html').getAttribute('data-platform')) === 'macos';
  await page.keyboard.press(mac ? 'Meta+Shift+M' : 'Control+Shift+M');
  await expect(page.locator('.stage-talent-plane')).toHaveAttribute('data-mirror-x', 'true');
  await shot(page, '06-mirrored', PROMPTER, await acknowledgement(page, /mirrored/i));
});

test(`reading window, dark — ${WINDOW.name}`, async ({ page }) => {
  await boot(page, WINDOW, 'reader');
  await present(page, /^Reading: /);
  await following(page);
  await dockAtRest(page);
  await page.keyboard.press('Alt+ArrowDown');
  await shot(page, '07-reader-dark', WINDOW, await acknowledgement(page, 'Pricing'));
});

test(`reading window, paper — ${WINDOW.name}`, async ({ page }) => {
  await seedPaper(page);
  await boot(page, WINDOW, 'reader');
  await present(page, /^Reading: /);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
  await following(page);
  await dockAtRest(page);
  await page.keyboard.press('Alt+ArrowDown');
  await shot(page, '08-reader-paper', WINDOW, await acknowledgement(page, 'Pricing'));
});

/*
 * The separate stage window, through its own preview driver: the one path that
 * reaches the chip through the `ack` directive itself. Its acknowledgement is
 * short-lived, so a frame that missed it is retried rather than saved.
 */
test(`stage window preview — ${PROMPTER_HD.name}`, async ({ page }) => {
  await page.setViewportSize({ width: PROMPTER_HD.width, height: PROMPTER_HD.height });
  await page.goto('/stage.html?preview=1');
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
  await page.waitForTimeout(1_500);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.keyboard.press('a');
    try {
      await shot(page, '09-stage-window', PROMPTER_HD, await acknowledgement(page, 'Chapter 1'));
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(2_500);
    }
  }
  throw lastError;
});
