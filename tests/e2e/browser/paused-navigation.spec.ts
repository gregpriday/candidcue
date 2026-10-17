import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { moves, scrollPx, startRecording, stopRecording } from './fixtures/take-motion';

/*
 * #275 — SENTENCE STEPS WHILE THE TAKE IS NOT FOLLOWING.
 *
 * Pausing (Space) and switching following off both stop the alignment driver
 * prompting, and the driver used to drop every snapshot while it was not —
 * including the `manualAnchor` Rust publishes in answer to a sentence step. So
 * ⌥→ moved the engine and nothing else: the glass stayed where it was, the next
 * press was measured from the same stale place (three presses, one target), and
 * the take ended where following had been paused. With following off the stage
 * also parked the move itself, because it treated every re-anchor as automatic.
 *
 * This runs the production single-window path end to end: real keys, the real
 * store and driver, the embedded stage, and the shim answering each move the way
 * Rust does. Voice following is not shimmed, so the voice side is represented by
 * snapshots injected by hand.
 */

const WORDS = [
  'river', 'lantern', 'harbour', 'meadow', 'copper', 'signal', 'orchard', 'canvas',
  'summit', 'thistle', 'beacon', 'quarry', 'velvet', 'compass', 'ember', 'falcon',
  'granite', 'hollow', 'island', 'juniper', 'kestrel', 'ledger', 'marble', 'nectar',
];

/** Twelve distinct words, so every sentence is a long, unambiguous line. */
function sentence(seed: number): string {
  const words = Array.from({ length: 12 }, (_, i) => WORDS[(seed * 5 + i) % WORDS.length]!);
  const first = words[0]!;
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(' ')}.`;
}

function paragraph(seed: number): string {
  return Array.from({ length: 4 }, (_, i) => sentence(seed * 4 + i)).join(' ');
}

const SCRIPT = {
  id: '27527527-5275-4275-8275-275275275275',
  title: 'Paused navigation',
  source:
    `# Opening\n\n${paragraph(0)}\n\n${paragraph(1)}\n\n` +
    `## Middle\n\n${paragraph(2)}\n\n${paragraph(3)}\n\n` +
    `## Close\n\n${paragraph(4)}\n`,
};

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
    // The `.diagnostics` readout's `token:` line is how these specs read where
    // the stage says it is, and it is drawn only in Diagnostic Take (#300).
    diagnosticTake: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
});

async function present(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/);
  // The glass has been placed and painted, so a later position is a move.
  await expect(page.locator('.scroll-plane')).toBeVisible();
  // A take from the top issues no opening anchor: the first move is a step.
  expect(await moves(page)).toEqual([]);
}

/**
 * One ⌥→, waited out the way a presenter waits: the move is asked for, the
 * engine's answer reaches the stage, and the glass has gone further down than
 * it was. Returns the token the step aimed at.
 */
async function stepForward(page: Page): Promise<number> {
  const before = await moves(page);
  const fromPx = await scrollPx(page);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => moves(page)).toHaveLength(before.length + 1);
  const target = (await moves(page)).at(-1)!;
  await expect(page.locator('.diagnostics')).toContainText(`token: ${target.toFixed(1)}`);
  await expect.poll(() => scrollPx(page), { timeout: 5_000 }).toBeGreaterThan(fromPx + 1);
  return target;
}

/** Three steps, each one sentence further than the last. */
async function expectThreeAdvancingSteps(page: Page): Promise<void> {
  const targets = [await stepForward(page), await stepForward(page), await stepForward(page)];
  expect(targets[0]).toBeGreaterThan(0);
  expect(targets[1]).toBeGreaterThan(targets[0]!);
  expect(targets[2]).toBeGreaterThan(targets[1]!);
}

/** A snapshot the voice would produce: a confident place far down the script. */
async function injectVoice(page: Page, token: number): Promise<void> {
  await page.evaluate((at) => {
    const generation = window.__E2E__.lastSession?.sessionGeneration ?? 0;
    window.__E2E__.emit('align://snapshot', {
      sessionGeneration: generation,
      // Far ahead of the shim's own counter: were it let through, every later
      // manual answer would read as stale and be dropped, and the steps below
      // would fail loudly rather than pass by luck.
      seq: 10_000,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: at,
      observedToken: at,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 800,
      pauseOnsetMs: 400,
      leadFloorMs: 0,
      maxLeadTokens: 2,
      leadMarginTokens: 2.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: at,
      confidence: 0.95,
      suggestionToken: null,
      scriptLenTokens: 240,
      observedAtom: at,
      confirmedAtom: at,
    });
  }, token);
}

test('following: each sentence step lands one sentence further on the glass', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);
  await expectThreeAdvancingSteps(page);
  errors.expectClean();
});

test('paused with Space: the voice holds, and sentence steps still land', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press(' ');
  // Pausing stops automatic motion, and that is still true: a confident place
  // from the voice reaches nothing while the take is paused.
  const restingPx = await scrollPx(page);
  await injectVoice(page, 200);
  await page.waitForTimeout(500);
  await expect(page.locator('.diagnostics')).not.toContainText('token: 200.0');
  expect(Math.abs((await scrollPx(page)) - restingPx)).toBeLessThan(2);

  await expectThreeAdvancingSteps(page);
  errors.expectClean();
});

test('following off: sentence steps still land on the glass', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.menu-trigger').click();
  await page.locator('.stage-dock [data-menu-row="follow"]').click();
  await expect(
    page.locator('.stage-dock .dock-button.menu-trigger'),
  ).toHaveAttribute('aria-label', 'Take menu — voice following is off');
  await page.keyboard.press('Escape');

  await expectThreeAdvancingSteps(page);
  errors.expectClean();
});

test('during a roll: a sentence step lands, and the roll carries on from there', async ({
  page,
}) => {
  /*
   * Starting auto-scroll switches following off, so a step during a roll is
   * one of these moves too — and it meets the transport. Two ways for that to
   * go wrong, both visible as motion: the transport's goal is still where the
   * document WAS, so it drags the script back over the step; or the step's
   * snapshot takes the document from the transport and the roll stops dead.
   */
  const errors = watchPageErrors(page);
  await present(page);
  // The opening placement has finished: the roll is measured from rest.
  await expect
    .poll(async () => {
      const from = await scrollPx(page);
      await page.waitForTimeout(300);
      return (await scrollPx(page)) - from;
    })
    .toBe(0);
  const opening = await scrollPx(page);

  await page.keyboard.press('a');
  // Rolling, by its own motion — and pressed straight away, while the roll is
  // still a sentence short of the step's target (sentence two, twelve words on).
  await expect
    .poll(() => scrollPx(page), { timeout: 15_000, intervals: [50] })
    .toBeGreaterThan(opening + 2);

  await startRecording(page);
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForTimeout(4000);
  const trace = await stopRecording(page);
  expect(await moves(page)).toHaveLength(1);
  const target = (await moves(page))[0]!;
  await expect(page.locator('.diagnostics')).toContainText(`token: ${target.toFixed(1)}`);

  const steps = trace.slice(1).map((s, i) => s.y - trace[i]!.y);
  // The step was spent as a jump, not parked behind the roll...
  expect(Math.max(...steps)).toBeGreaterThan(15);
  // ...nothing pulled the document back over it afterwards...
  expect(Math.min(...steps)).toBeGreaterThan(-1);
  // ...and the roll is still rolling in the last second of the window.
  const end = trace.at(-1)!;
  const secondBefore = trace.find((s) => s.atMs >= end.atMs - 1000)!;
  expect(end.y).toBeGreaterThan(secondBefore.y);
  errors.expectClean();
});

test('a take paused and stepped on ends where the steps left it', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press(' ');
  // Into the second paragraph: well past anywhere following ever reached.
  let last = 0;
  for (let press = 0; press < 5; press += 1) last = await stepForward(page);
  expect(last).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Take complete' })).toBeVisible();

  const ended = await page.evaluate(
    () =>
      window.__E2E__.calls.find((call) => call.command === 'end_session')?.args as
        | { summary: { endTokenIndex?: number } | null }
        | undefined,
  );
  expect(ended?.summary?.endTokenIndex).toBe(last);
  errors.expectClean();
});
