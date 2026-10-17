import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

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

/** Every token the aligner was asked to move to, in order. */
function moves(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    window.__E2E__.calls
      .filter((call) => call.command === 'set_alignment_position')
      .map((call) => (call.args as { token: number }).token),
  );
}

/** How far down the script the document is painted, in pixels. */
function scrollPx(page: Page): Promise<number> {
  return page.locator('.scroll-plane').evaluate((el) => {
    const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
    return match?.[1] === undefined ? 0 : -Number(match[1]);
  });
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

interface ScrollSample {
  atMs: number;
  y: number;
}

/**
 * Record where the document is painted, every frame, until `stopRecording`.
 * Started BEFORE the key, so a pull-back that lands while the press is still
 * coming back is in the trace — a final-position check alone would miss it.
 */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ROLL__: ScrollSample[]; __ROLL_ON__: boolean };
    w.__ROLL__ = [];
    w.__ROLL_ON__ = true;
    const tick = () => {
      if (!w.__ROLL_ON__) return;
      const el = document.querySelector('.scroll-plane') as HTMLElement | null;
      const m = el ? /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform) : null;
      w.__ROLL__.push({ atMs: performance.now(), y: m?.[1] === undefined ? 0 : -Number(m[1]) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function stopRecording(page: Page): Promise<ScrollSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __ROLL__: ScrollSample[]; __ROLL_ON__: boolean };
    w.__ROLL_ON__ = false;
    return w.__ROLL__;
  });
}

/**
 * Press `key`, then watch long enough for the engine's answer and the manual
 * grace after it, and return what the document did.
 */
async function pressAndWatch(
  page: Page,
  key: string,
): Promise<{ fromPx: number; landedPx: number; trace: ScrollSample[] }> {
  const fromPx = await scrollPx(page);
  await startRecording(page);
  await page.keyboard.press(key);
  await page.waitForTimeout(3000);
  const trace = await stopRecording(page);
  const landing = trace.find((s) => Math.abs(s.y - fromPx) > 1);
  expect(landing, `${key} never moved the document`).toBeDefined();
  return { fromPx, landedPx: landing!.y, trace };
}

/** Furthest the document came back towards where it started, after landing. */
function worstPullBack(trace: ScrollSample[], fromPx: number, landedPx: number): number {
  const direction = Math.sign(landedPx - fromPx);
  const after = trace.slice(trace.findIndex((s) => s.y === landedPx));
  return Math.max(0, ...after.map((s) => direction * (landedPx - s.y)));
}

test('Page Down: the document stays where the key put it, and so does the aligner', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);
  const pitch = await linePitchPx(page);
  // The opening puts the first word on the reading line, so this is where the
  // reading line is on the glass.
  const readingLinePx = await wordTopPx(page, 0);

  const { fromPx, landedPx, trace } = await pressAndWatch(page, 'PageDown');
  // Most of a screen, as the key promises.
  expect(landedPx - fromPx).toBeGreaterThan(0.6 * 720);
  // The bug: about 400 px back, to one sentence on. At most the echo settles the
  // reading line onto the start of the line it is already on.
  expect(worstPullBack(trace, fromPx, landedPx)).toBeLessThan(pitch);

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
  const readingLinePx = await wordTopPx(page, 0);

  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect.poll(() => moves(page)).toHaveLength(1);
  await page.waitForTimeout(500);

  const { fromPx, landedPx, trace } = await pressAndWatch(page, 'PageUp');
  expect(fromPx - landedPx).toBeGreaterThan(0.6 * 720);
  expect(worstPullBack(trace, fromPx, landedPx)).toBeLessThan(pitch);

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
  const readingLinePx = await wordTopPx(page, 0);

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
  const readingLinePx = await wordTopPx(page, 0);

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

  const { fromPx, landedPx, trace } = await pressAndWatch(page, 'PageDown');
  expect(landedPx - fromPx).toBeGreaterThan(0.6 * 720);
  expect(worstPullBack(trace, fromPx, landedPx)).toBeLessThan(1);
  expect(Math.abs(trace.at(-1)!.y - landedPx)).toBeLessThan(1);

  const moved = await moves(page);
  expect(moved).toHaveLength(1);
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
  const errors = watchPageErrors(page);
  await present(page);

  let previous = -1;
  for (let press = 0; press < 40; press += 1) {
    const now = await scrollPx(page);
    if (now === previous) break;
    previous = now;
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(600);
  const settled = await moves(page);
  expect(settled.length).toBeGreaterThan(0);

  await page.keyboard.press('PageDown');
  await page.waitForTimeout(600);
  expect(await moves(page)).toEqual(settled);
  errors.expectClean();
});
