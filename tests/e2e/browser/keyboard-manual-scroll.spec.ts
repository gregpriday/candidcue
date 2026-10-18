import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import {
  moves,
  scrollPx,
  startRecording,
  stopRecording,
  type ScrollSample,
} from './fixtures/take-motion';

/*
 * #282 — THE ARROW AND PAGE KEYS DURING A TAKE.
 *
 * Page Down scrolled the glass most of a screen, then told control only "one
 * step forward". Control spent that as exactly one sentence from wherever the
 * aligner was, Rust answered with a manual anchor there, and the document
 * lurched back to it a moment later: 186 → 762 → 359 px, and the aligner on
 * token 12, the same place a single ⌥→ goes. The arrow keys shared the path
 * with a smaller error.
 *
 * The keys now report where they put the document, the way the wheel does.
 * The claims below are the presenter's: the document stays where the key put
 * it, and the place the aligner is moved to is the line on the reading line.
 *
 * This runs the production single-window path end to end: real keys, the real
 * store and driver, the embedded stage, and the shim answering each move with a
 * manual anchor the way Rust does. What it cannot show is a real take — a live
 * recogniser carrying on from the new place — which only the app on a real rig
 * proves.
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

/** The issue's script: twelve paragraphs, each six twelve-word sentences. */
const SCRIPT = {
  id: '28228228-2822-4282-8282-282282282282',
  title: 'Keyboard navigation',
  source:
    '# Keys\n\n' +
    Array.from({ length: 12 }, (_, p) =>
      Array.from({ length: 6 }, (_, s) => sentence(p * 6 + s)).join(' '),
    ).join('\n\n') +
    '\n',
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
  await expect(page.locator('.scroll-plane')).toBeVisible();
  expect(await moves(page)).toEqual([]);
  // The opening placement has finished: every later movement is a key's.
  await expect
    .poll(async () => {
      const from = await scrollPx(page);
      await page.waitForTimeout(300);
      return (await scrollPx(page)) - from;
    })
    .toBe(0);
}

/** Where a word sits on the glass, as the top of its box in the viewport. */
function wordTopPx(page: Page, token: number): Promise<number> {
  return page
    .locator(`.script-layer [data-t="${token}"]`)
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
}

/** One rendered line's height, read off the words themselves. */
function linePitchPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tops = [...document.querySelectorAll<HTMLElement>('.script-layer [data-t]')]
      .slice(0, 80)
      .map((el) => Math.round(el.getBoundingClientRect().top));
    const rows = [...new Set(tops)].sort((a, b) => a - b);
    let pitch = Number.POSITIVE_INFINITY;
    for (let i = 1; i < rows.length; i += 1) pitch = Math.min(pitch, rows[i]! - rows[i - 1]!);
    return pitch;
  });
}

/**
 * Press `key`, then watch long enough for the engine's answer and the manual
 * grace after it, and return what the document did.
 */
async function pressAndWatch(
  page: Page,
  key: string,
): Promise<{ fromPx: number; landedPx: number; afterLanding: ScrollSample[] }> {
  const fromPx = await scrollPx(page);
  await startRecording(page);
  await page.keyboard.press(key);
  await page.waitForTimeout(3000);
  const trace = await stopRecording(page);
  /*
   * The first frame the key moved, which is the hand's own landing: the report
   * that could pull it back is not sent until the keys have been quiet for
   * 200 ms, a dozen frames later.
   */
  const landing = trace.findIndex((s) => Math.abs(s.y - fromPx) > 1);
  expect(landing, `${key} never moved the document`).toBeGreaterThanOrEqual(0);
  return { fromPx, landedPx: trace[landing]!.y, afterLanding: trace.slice(landing) };
}

/** Furthest the document came back towards where it started, after landing. */
function worstPullBack(afterLanding: ScrollSample[], fromPx: number, landedPx: number): number {
  const direction = Math.sign(landedPx - fromPx);
  return Math.max(0, ...afterLanding.map((s) => direction * (landedPx - s.y)));
}

/**
 * The opening's placement of the first word, as a stand-in for the reading line.
 *
 * Not the reading line's own coordinate, which the DOM does not expose: the
 * opening centres the first line on the reading mark, and a manual anchor lands
 * its line by the same mark, so in uniform prose the tops of the two lines'
 * first words agree to well inside half a line. That is the tolerance used.
 */
function openingWordTopPx(page: Page): Promise<number> {
  return wordTopPx(page, 0);
}

test('Page Down: the document stays where the key put it, and so does the aligner', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);
  const pitch = await linePitchPx(page);
  const readingLinePx = await openingWordTopPx(page);

  const { fromPx, landedPx, afterLanding } = await pressAndWatch(page, 'PageDown');
  // Most of a screen, as the key promises.
  expect(landedPx - fromPx).toBeGreaterThan(0.6 * 720);
  // The bug: about 400 px back, to one sentence on. At most the echo settles the
  // reading line onto the start of the line it is already on.
  expect(worstPullBack(afterLanding, fromPx, landedPx)).toBeLessThan(pitch);

  const moved = await moves(page);
  expect(moved).toHaveLength(1);
  const target = moved[0]!;
  // Not "one sentence on": the second sentence starts at token 12.
  expect(target).toBeGreaterThan(24);
  await expect(page.locator('.diagnostics')).toContainText(`token: ${target.toFixed(1)}`);
  // ...and the word the aligner was moved to is the one on the reading line.
  expect(Math.abs((await wordTopPx(page, target)) - readingLinePx)).toBeLessThan(pitch / 2);
  errors.expectClean();
});

test('Page Up comes back the same way', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);
  const pitch = await linePitchPx(page);
  const readingLinePx = await openingWordTopPx(page);

  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect.poll(() => moves(page)).toHaveLength(1);
  await page.waitForTimeout(500);

  const { fromPx, landedPx, afterLanding } = await pressAndWatch(page, 'PageUp');
  expect(fromPx - landedPx).toBeGreaterThan(0.6 * 720);
  expect(worstPullBack(afterLanding, fromPx, landedPx)).toBeLessThan(pitch);

  const moved = await moves(page);
  expect(moved).toHaveLength(2);
  expect(moved[1]!).toBeLessThan(moved[0]!);
  expect(Math.abs((await wordTopPx(page, moved[1]!)) - readingLinePx)).toBeLessThan(pitch / 2);
  errors.expectClean();
});

test('the arrow keys put the aligner on the line they scrolled to', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);
  const pitch = await linePitchPx(page);
  const readingLinePx = await openingWordTopPx(page);

  // Three lines in one breath: one gesture, one move.
  await startRecording(page);
  const fromPx = await scrollPx(page);
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(3000);
  const trace = await stopRecording(page);

  const moved = await moves(page);
  expect(moved).toHaveLength(1);
  const target = moved[0]!;
  // Three lines down is three lines down, whatever the sentences do.
  const landedPx = await scrollPx(page);
  expect(landedPx - fromPx).toBeGreaterThan(2.5 * pitch);
  expect(Math.min(...trace.map((s) => s.y))).toBeGreaterThan(fromPx - 1);
  expect(Math.abs((await wordTopPx(page, target)) - readingLinePx)).toBeLessThan(pitch / 2);
  errors.expectClean();
});

test('following off: the key lands exactly, and the aligner goes with it', async ({ page }) => {
  // With following off the engine's answer to the hand's own move is recognised
  // and spent as nothing, so the document does not even settle onto the line.
  const errors = watchPageErrors(page);
  await present(page);
  const pitch = await linePitchPx(page);
  const readingLinePx = await openingWordTopPx(page);

  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.menu-trigger').click();
  await page.locator('.stage-dock [data-menu-row="follow"]').click();
  await expect(page.locator('.stage-dock .dock-button.menu-trigger')).toHaveAttribute(
    'aria-label',
    'Take menu — voice following is off',
  );
  await page.keyboard.press('Escape');
  // Closing the menu hands focus back to its trigger, and a key aimed at the
  // dock's own chrome is not addressed to the script. Put focus down on the
  // script the way a presenter would, by clicking it.
  await page.mouse.click(640, 200);

  const { fromPx, landedPx, afterLanding } = await pressAndWatch(page, 'PageDown');
  expect(landedPx - fromPx).toBeGreaterThan(0.6 * 720);
  expect(worstPullBack(afterLanding, fromPx, landedPx)).toBeLessThan(1);
  expect(Math.abs(afterLanding.at(-1)!.y - landedPx)).toBeLessThan(1);

  const moved = await moves(page);
  expect(moved).toHaveLength(1);
  // The engine's answer DID reach the stage — this is the echo being recognised,
  // not an answer that never arrived leaving the document alone.
  await expect(page.locator('.diagnostics')).toContainText(`token: ${moved[0]!.toFixed(1)}`);
  expect(Math.abs((await wordTopPx(page, moved[0]!)) - readingLinePx)).toBeLessThan(pitch);
  errors.expectClean();
});

test('Page Down at the foot of the script moves nothing and re-anchors nothing', async ({
  page,
}) => {
  /*
   * The document is as far down as it goes, so the last lines the presenter is
   * reading sit below the reading line. Re-anchoring there would drag the
   * aligner back up to a place nobody went.
   */
  /*
   * The walk to the foot does not fit the default budget. This script takes 32
   * presses to reach it at 1280x720, and each press is waited out for 700 ms,
   * so the waiting alone is 22.4 s of the 30. It ran in 26-27 s on CI and timed
   * out on a slower runner; the loop's own ceiling, 40 presses, is 28 s of
   * waiting before anything else is counted.
   */
  test.slow();
  const errors = watchPageErrors(page);
  await present(page);

  /*
   * Page down until a press changes neither the glass nor the aligner. Each
   * press is waited out past its report and the answer to it, so "nothing
   * changed" is about that press and not about one still in flight.
   */
  let atFoot = false;
  for (let press = 0; press < 40 && !atFoot; press += 1) {
    const fromPx = await scrollPx(page);
    const before = (await moves(page)).length;
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(700);
    atFoot = (await scrollPx(page)) === fromPx && (await moves(page)).length === before;
  }
  expect(atFoot, 'Page Down never stopped moving the script').toBe(true);
  // ...and it stopped because the script ran out, not because the key did: the
  // last word is on the glass.
  const lastWordBottomPx = await page.evaluate(() => {
    const words = document.querySelectorAll<HTMLElement>('.script-layer [data-t]');
    return words[words.length - 1]!.getBoundingClientRect().bottom;
  });
  expect(lastWordBottomPx).toBeLessThan(720);
  expect((await moves(page)).length).toBeGreaterThan(0);
  errors.expectClean();
});

test('during a roll: Page Down lands, and the roll carries on from there', async ({ page }) => {
  /*
   * Auto-scroll switches following off, so the key meets the transport, and
   * both of the ways that goes wrong are motion: the transport's goal is still
   * where the document WAS and drags it back over the key, or the engine's
   * answer takes the document from the transport and the roll stops dead.
   */
  const errors = watchPageErrors(page);
  await present(page);
  const opening = await scrollPx(page);

  await page.keyboard.press('a');
  await expect
    .poll(() => scrollPx(page), { timeout: 15_000, intervals: [50] })
    .toBeGreaterThan(opening + 2);

  /*
   * Measured from where the document was before the key, not from the first
   * recorded frame: the key can land before the recorder's first frame does,
   * and a jump that happens between "before" and the first sample is not a
   * step between two samples.
   */
  const fromPx = await scrollPx(page);
  await startRecording(page);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(4000);
  const trace = await stopRecording(page);

  const moved = await moves(page);
  expect(moved).toHaveLength(1);
  await expect(page.locator('.diagnostics')).toContainText(`token: ${moved[0]!.toFixed(1)}`);

  // The key landed most of a screen on, at once: within a few frames, where the
  // roll itself covers a couple of pixels a frame...
  const landed = trace.find((s) => s.y - fromPx > 0.6 * 720);
  expect(landed, 'Page Down never moved the document').toBeDefined();
  expect(landed!.atMs - trace[0]!.atMs).toBeLessThan(150);
  // ...nothing pulled the document back over it afterwards...
  const steps = trace.slice(1).map((s, i) => s.y - trace[i]!.y);
  expect(Math.min(...steps)).toBeGreaterThan(-1);
  // ...and the roll is still rolling in the last second of the window.
  const end = trace.at(-1)!;
  const secondBefore = trace.find((s) => s.atMs >= end.atMs - 1000)!;
  expect(end.y).toBeGreaterThan(secondBefore.y);
  errors.expectClean();
});
