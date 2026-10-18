import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { openScript } from './fixtures/library';
import { moves, scrollPx } from './fixtures/take-motion';

/*
 * FINDING YOUR PLACE AGAIN, AND KNOWING WHEN YOU ARE DONE, IN A READING WINDOW.
 *
 * The engine refuses to move the document to a match it found off the glass
 * and names the refused place in `suggestionToken`. These drive the real
 * surface with synthetic snapshots: the place is offered — never taken — the
 * offer moves the aligner exactly once when accepted, and goes away when
 * ignored or when the reader moves the document themselves. They also check
 * that the end of the script says so, that the window is named for the script
 * it shows, that Home and End reach the two ends and re-seed the aligner
 * there, and that none of it reaches a teleprompter take.
 */

/** A refusal: the engine matched `token` but would not move the document there. */
function refusal(token: number): Record<string, unknown> {
  return {
    state: 'holding',
    decision: 'holdOffScreen',
    confirmedToken: 2,
    observedToken: 2,
    suggestionToken: token,
    confidence: 0.6,
  };
}

/** Wait until the document has stopped moving: two equal reads 250 ms apart. */
async function settled(page: Page): Promise<void> {
  let last = Number.NaN;
  await expect
    .poll(async () => {
      const now = await scrollPx(page);
      const still = Math.abs(now - last) < 0.5;
      last = now;
      return still;
    }, { intervals: [250] })
    .toBe(true);
}

/** True when the token's word is painted inside the stage's visible box. */
async function onGlass(page: Page, token: number): Promise<boolean> {
  return page.evaluate((token) => {
    const word = document.querySelector(`.script-layer span.w[data-t="${token}"]`);
    const stage = document.querySelector('.stage-root');
    if (!word || !stage) return false;
    const w = word.getBoundingClientRect();
    const r = stage.getBoundingClientRect();
    return w.bottom > r.top && w.top < r.bottom;
  }, token);
}

const SCRIPT = {
  id: '88888888-8888-4888-8888-888888888888',
  title: 'Recovery walkthrough',
  source: [
    '# Arrival',
    '',
    'For eleven years the light at Cape Morrow was kept by a woman named Ada Vance, who arrived with two suitcases and no plan to stay.',
    '',
    'The first winter nearly finished her, and the storms came in off the water three and four days at a stretch.',
    '',
    '# The log',
    '',
    'She kept a log, as every keeper did, but hers was unusual. Alongside the wind she wrote down one small thing she noticed each day.',
    '',
    'When the light was finally automated the log went to the county archive, where people still ask for it more than anything else.',
    '',
  ].join('\n'),
};

async function presentInWindow(page: Page): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Recovery walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present in a window/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
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

/** The first token of the sentence that starts "When the light". */
async function tokenOf(page: Page, word: string): Promise<number> {
  const t = await page
    .locator('.script-layer span.w[data-t]')
    .filter({ hasText: new RegExp(`^${word}$`) })
    .first()
    .getAttribute('data-t');
  return Number(t);
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    presentationMode: 'reader',
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
  await page.setViewportSize({ width: 1100, height: 420 });
});

test('offers a refused off-screen match, and reads from it only when asked', async ({ page }) => {
  const errors = watchPageErrors(page);
  await presentInWindow(page);
  await expect(page.getByRole('region', { name: 'Reading: Recovery walkthrough' })).toBeVisible();

  const target = await tokenOf(page, 'automated');
  const sentenceStart = await tokenOf(page, 'When');
  await snapshot(page, { confirmedToken: 2, observedToken: 2 });
  await settled(page);
  // The premise: the refused place really is off the glass.
  expect(await onGlass(page, target)).toBe(false);
  const before = await moves(page);
  const paintedBefore = await scrollPx(page);

  await snapshot(page, refusal(target));
  const chip = page.getByRole('group', { name: 'Possible match' });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/just below|\d+ paragraphs? down/);
  await expect(chip).toContainText('The log');
  await expect(chip).toContainText('When the light was finally automated');
  // The button says where from, and a screen reader hears the offer once.
  await expect(chip.getByRole('button', { name: 'Read from there' })).toHaveAccessibleDescription(
    /The log.*When the light was finally automated/,
  );
  await expect(page.locator('.stage-announcer')).toHaveText(
    /Possible match (just below|\d+ paragraphs? down), in The log: When the light was finally automated/,
  );
  // Offered, not taken: nothing asked the aligner to move, and the document
  // did not go there — a hold eases by a pixel or two, a relocation by screens.
  await page.waitForTimeout(300);
  expect(await moves(page)).toEqual(before);
  expect(Math.abs((await scrollPx(page)) - paintedBefore)).toBeLessThan(15);
  expect(await onGlass(page, target)).toBe(false);

  await chip.getByRole('button', { name: 'Read from there' }).focus();
  await page.keyboard.press('Enter');
  await expect(chip).toHaveCount(0);
  // The keyboard is handed to the reading window, not dropped on the page.
  await expect(page.getByRole('region', { name: 'Reading: Recovery walkthrough' })).toBeFocused();
  await expect.poll(() => moves(page)).toEqual([...before, sentenceStart]);
  // A second press has nothing left to press.
  expect(await moves(page)).toEqual([...before, sentenceStart]);

  errors.expectClean();
});

test('lets an off-screen match be ignored, and does not offer the same place again', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await presentInWindow(page);
  const target = await tokenOf(page, 'automated');
  const hold = refusal(target);
  await snapshot(page, hold);
  const chip = page.getByRole('group', { name: 'Possible match' });
  await expect(chip).toBeVisible();
  await chip.getByRole('button', { name: 'Ignore' }).click();
  await expect(chip).toHaveCount(0);
  await snapshot(page, hold);
  await page.waitForTimeout(300);
  await expect(chip).toHaveCount(0);
  // Found again: the next refusal may be offered afresh.
  await snapshot(page, { confirmedToken: 4, observedToken: 4 });
  await snapshot(page, hold);
  await expect(chip).toBeVisible();
  errors.expectClean();
});

test('says where the script ends, and Home and End reach both ends', async ({ page }) => {
  const errors = watchPageErrors(page);
  await presentInWindow(page);
  const scrollY = () =>
    page.locator('.scroll-plane').evaluate((el) => {
      const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
      return m?.[1] === undefined ? 0 : -Number(m[1]);
    });

  const lastSentence = await tokenOf(page, 'When');
  await page.locator('.stage-root').click({ position: { x: 20, y: 200 } });
  const beforeEnd = (await moves(page)).length;
  await page.keyboard.press('End');
  await expect.poll(scrollY).toBeGreaterThan(100);
  await expect(page.locator('.end-of-script-label')).toBeInViewport();
  await expect(page.locator('.end-of-script-label')).toHaveText('End of script');
  // A key is a move: the aligner was re-seeded in the last sentence, once.
  await expect.poll(async () => (await moves(page)).length).toBe(beforeEnd + 1);
  expect((await moves(page)).at(-1)).toBeGreaterThanOrEqual(lastSentence);
  // A second End is absorbed: the document is already there.
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  expect((await moves(page)).length).toBe(beforeEnd + 1);

  await page.keyboard.press('Home');
  await expect.poll(scrollY).toBeLessThan(5);
  // The opening is a heading, so the reading line is on no spoken line — and
  // the move still takes the aligner back to the first word.
  await expect.poll(async () => (await moves(page)).length).toBe(beforeEnd + 2);
  expect((await moves(page)).at(-1)).toBe(0);
  // Once the echo has come back and the follower has settled, the opening is
  // still what is on the glass: the heading and the first spoken words.
  await settled(page);
  expect(await onGlass(page, 0)).toBe(true);
  await expect(page.locator('.script-layer').getByText('Arrival', { exact: true })).toBeInViewport();
  errors.expectClean();
});

test('a teleprompter take keeps its name and shows no end marker', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto('/control.html');
  await openScript(page, /Recovery walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present full screen/ })
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
  await expect(page.locator('.script-layer span.w[data-t]').first()).toBeVisible();
  // At the foot of the script, where a reading window would say so.
  await page.locator('.stage-root').click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  await expect(page.locator('.end-of-script')).toHaveCount(0);
  // A refusal is not offered at the glass: there is no pointer to take it.
  await snapshot(page, refusal(await tokenOf(page, 'eleven')));
  await page.waitForTimeout(300);
  await expect(page.getByRole('group', { name: 'Possible match' })).toHaveCount(0);
  await expect(page.locator('.stage-announcer')).toHaveCount(0);
  errors.expectClean();
});

test('a hand move withdraws the offer, and a blanked stage keeps its place', async ({ page }) => {
  const errors = watchPageErrors(page);
  await presentInWindow(page);
  const target = await tokenOf(page, 'automated');
  await snapshot(page, refusal(target));
  const chip = page.getByRole('group', { name: 'Possible match' });
  await expect(chip).toBeVisible();
  await page.locator('.stage-root').click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('ArrowDown');
  await expect(chip).toHaveCount(0);
  // Withdrawn stays withdrawn: a blank and unblank re-runs the stage's state
  // without a new refusal, and must not bring the old offer back.
  await page.keyboard.press('b');
  await page.keyboard.press('b');
  await expect(page.locator('.script-layer')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(chip).toHaveCount(0);

  // Blanking with the offer's button focused hands the keyboard to the window.
  // From the menu: a plain B belongs to the focused button, not the app.
  await snapshot(page, refusal(await tokenOf(page, 'county')));
  await expect(chip).toBeVisible();
  await chip.getByRole('button', { name: 'Ignore' }).focus();
  await page.evaluate(() =>
    window.__E2E__.emit('menu://command', { id: 'session.blank-stage' }),
  );
  await expect(page.locator('.script-layer')).toBeHidden();
  await expect(chip).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Reading: Recovery walkthrough' })).toBeFocused();
  await page.keyboard.press('b');
  await expect(page.locator('.script-layer')).toBeVisible();
  await page.locator('.stage-root').click({ position: { x: 20, y: 200 } });
  await page.keyboard.press('ArrowDown');

  // Blank, then the two keys that travel furthest: nothing moves behind it.
  await page.keyboard.press('b');
  await expect(page.locator('.script-layer')).toBeHidden();
  // The arrow's own report lands when its gesture settles; wait it out.
  await page.waitForTimeout(400);
  await settled(page);
  const painted = await scrollPx(page);
  const before = await moves(page);
  await page.keyboard.press('End');
  await page.waitForTimeout(400);
  expect(await scrollPx(page)).toBe(painted);
  expect(await moves(page)).toEqual(before);
  // A refusal while blanked is not drawn over the blank.
  await snapshot(page, refusal(target));
  await expect(chip).toHaveCount(0);
  errors.expectClean();
});

test('the offer fits a small reading window without covering the controls or the line', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 580, height: 360 });
  await presentInWindow(page);
  const target = await tokenOf(page, 'automated');
  await snapshot(page, refusal(target));
  const chip = page.getByRole('group', { name: 'Possible match' });
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  const stage = await page.locator('.stage-root').boundingBox();
  const dock = await page.locator('.dock-row').boundingBox();
  expect(box && stage && dock).toBeTruthy();
  // Inside the window on every side.
  expect(box!.x).toBeGreaterThanOrEqual(stage!.x);
  expect(box!.y).toBeGreaterThanOrEqual(stage!.y);
  expect(box!.x + box!.width).toBeLessThanOrEqual(stage!.x + stage!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(stage!.y + stage!.height);
  // Too short a window for the card: it waits in the dock's row, beside the
  // dock rather than over it, and the script is left alone.
  const overlaps =
    box!.x < dock!.x + dock!.width &&
    dock!.x < box!.x + box!.width &&
    box!.y < dock!.y + dock!.height &&
    dock!.y < box!.y + box!.height;
  expect(overlaps).toBe(false);
  expect(box!.y).toBeGreaterThanOrEqual(dock!.y - 1);
  const hold = page.locator('.hold-status');
  if (await hold.isVisible()) {
    const h = (await hold.boundingBox())!;
    expect(box!.y).toBeGreaterThanOrEqual(h.y + h.height);
  }
  errors.expectClean();
});


test('pausing a reading take holds the text still, without calling it Following off', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await presentInWindow(page);
  await settled(page);
  /*
   * A snapshot that predicts: the reader is moving at a steady pace, so the
   * follower plays that pace out between snapshots. This is the motion a
   * paused take used to go on playing under a label that said "Paused".
   */
  const predicting = {
    confirmedToken: 4,
    observedToken: 4,
    rateTokensPerSecond: 8,
    maxPredictionMs: 6000,
  };
  await snapshot(page, predicting);
  const a = await scrollPx(page);
  await page.waitForTimeout(700);
  const b = await scrollPx(page);
  // The premise: without a pause the document is moving.
  expect(b - a).toBeGreaterThan(8);

  await page.locator('.stage-root').click({ position: { x: 20, y: 200 } });
  await page.keyboard.press(' ');
  await expect(page.getByRole('region', { name: 'Reading: Recovery walkthrough' })).toBeVisible();
  /*
   * Brakes, then holds. Measured from 300 ms after the key, over two seconds:
   * held, it travels nothing; left to play the prediction out it creeps on by
   * several pixels over the same window (measured: ~6-7 px).
   */
  await page.waitForTimeout(300);
  const c = await scrollPx(page);
  await page.waitForTimeout(2000);
  const d = await scrollPx(page);
  expect(Math.abs(d - c)).toBeLessThan(2);
  // Paused is not Following off: the follow switch's chip stays away.
  await expect(page.getByText('Following off')).toHaveCount(0);
  errors.expectClean();
});
