/**
 * The fixed-pace transport, in a browser, against real layout.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CANNOT BE A COMPONENT TEST
 * ---------------------------------------------------------------------------
 * Auto-scroll derives its pixel rate from the rendered line map — how far apart
 * two measured baselines are, and how many words sit between them. In jsdom
 * every rect is zero, so the map never validates, and §62 correctly refuses to
 * move the document at all. The node test beside it (`autoscroll-transport`)
 * drives the motion engine against a synthetic layout and proves the seam; this
 * is the only layer that proves the whole chain — key press, session state,
 * bridge, measured geometry, engine, painted transform.
 *
 * What it asserts is what a presenter would claim: the script rolls when the
 * key is pressed, stops when it is pressed again, and does neither on its own.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

/*
 * Long enough to have somewhere to scroll to. A script that fits on the glass
 * has `maxScroll === 0`, and the transport would correctly refuse to move it —
 * which would make this test pass for the wrong reason.
 */
const PARAGRAPH =
  'Revenue grew steadily through the quarter and churn came down in every segment we measure. ' +
  'The onboarding rewrite landed in February and the numbers moved the week after it shipped. ' +
  'Support volume fell, activation rose, and the team has been able to work ahead of the queue.';

const SCRIPT = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Auto-scroll walkthrough',
  source:
    '# Opening\n\nThank you for joining me today.\n\n' +
    Array.from({ length: 8 }, (_, i) => `## Section ${i + 1}\n\n${PARAGRAPH}\n`).join('\n'),
};

async function present(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  // The map is built from measured rects on a later frame than the first paint;
  // the transport has no pace until it exists.
  await expect(page.locator('.script-layer')).toBeVisible();
}

/**
 * How far down the script the document is painted, in pixels.
 *
 * SIGNED, deliberately. The plane translates negatively as the reader advances,
 * so scrolling forward is a growing positive number here — and a regression that
 * moved the text the wrong way would produce a NEGATIVE one rather than passing
 * an absolute-value test that cannot tell the two apart.
 */
async function scrollPx(page: Page): Promise<number> {
  return page.locator('.scroll-plane').evaluate((el) => {
    const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
    return match?.[1] === undefined ? 0 : -Number(match[1]);
  });
}

/**
 * Pixels per second the document is actually travelling, sampled over a window.
 *
 * Two positions and a clock, because "it ended up further down" is equally true
 * of a steady roll and of a single jump — and the difference between those is
 * the whole claim this feature makes.
 */
async function measuredPace(page: Page, overMs = 2000): Promise<number> {
  const startedAt = Date.now();
  const from = await scrollPx(page);
  await page.waitForTimeout(overMs);
  const to = await scrollPx(page);
  return ((to - from) * 1000) / (Date.now() - startedAt);
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
    promptMode: 'voice',
  });
});

test('the script does not roll until it is asked to', async ({ page }) => {
  /*
   * The negative case first, and it is not a formality: the transport shares
   * the fallback path with the alignment corrections, and a bug that left it
   * running by default would move a presenter's script under them with no
   * recogniser behind it.
   */
  const errors = watchPageErrors(page);
  await present(page);

  const before = await scrollPx(page);
  await page.waitForTimeout(2500);
  expect(await scrollPx(page)).toBeCloseTo(before, 0);

  errors.expectClean();
});

test('A rolls the script at a fixed pace, and A again stops it', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  const atRest = await scrollPx(page);
  await page.keyboard.press('a');

  // It has to actually travel, not twitch.
  await expect
    .poll(() => scrollPx(page), { timeout: 15_000, intervals: [250] })
    .toBeGreaterThan(atRest + 20);

  /*
   * And it has to KEEP travelling, at a steady rate.
   *
   * A single displacement of any size satisfies the poll above, so on its own
   * that assertion cannot tell a roll from one jump. Two consecutive windows
   * with a consistent slope can.
   */
  const first = await measuredPace(page);
  const second = await measuredPace(page);
  expect(first).toBeGreaterThan(3);
  expect(second).toBeGreaterThan(3);
  expect(Math.abs(second - first)).toBeLessThan(first * 0.5);

  await page.keyboard.press('a');
  /*
   * Stopping is a coast, not a handbrake: the plant decelerates under its own
   * jerk limits, so the document keeps moving for a moment after the key. Let
   * that finish before sampling, or this measures the deceleration rather than
   * the stop.
   */
  await page.waitForTimeout(1500);
  const stopped = await scrollPx(page);
  await page.waitForTimeout(2500);
  expect(await scrollPx(page)).toBeCloseTo(stopped, 0);

  errors.expectClean();
});

test('pausing the take stops the script, and resuming picks it back up', async ({ page }) => {
  /*
   * THE CASE THAT NEEDS A BROWSER.
   *
   * A voice take stops itself when paused — the driver stops, no snapshots
   * arrive, and the engine holds. A fixed-pace transport has no such feedback:
   * it rolls because a pace says so. The `freeze` directive that would tell the
   * stage otherwise stands down at stage generation 0, which is every
   * single-window take — so a pause that did not gate the transport would leave
   * the script rolling on under a paused session, on camera.
   */
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('a');
  const start = await scrollPx(page);
  await expect
    .poll(() => scrollPx(page), { timeout: 15_000, intervals: [250] })
    .toBeGreaterThan(start + 20);

  await page.keyboard.press(' ');
  await page.waitForTimeout(1500); // let the plant coast to rest
  const paused = await scrollPx(page);
  await page.waitForTimeout(2500);
  expect(await scrollPx(page)).toBeCloseTo(paused, 0);

  // Resuming does not need the transport re-armed: the operator asked for it
  // once, and a pause is not a retraction.
  await page.keyboard.press(' ');
  await expect
    .poll(() => scrollPx(page), { timeout: 15_000, intervals: [250] })
    .toBeGreaterThan(paused + 20);

  errors.expectClean();
});

test('a manual step during a roll moves once and carries on at the same pace', async ({ page }) => {
  /*
   * A manual step suspends automatic motion for a grace interval — the engine
   * zeroes forward velocity and feed-forward for 2.5 seconds so a correction is
   * not immediately fought. A transport that went on advancing its goal through
   * that grace would bank two and a half seconds of travel behind the operator's
   * back, and the script would sit still and then chase: the opposite of what
   * pressing an arrow key looks like it should do, and worse the faster the pace.
   */
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('a');
  await page.waitForTimeout(1500);
  const before = await measuredPace(page);

  await page.keyboard.press('ArrowDown');
  // Sample across the far side of the grace interval. A banked backlog shows up
  // here as a burst well above the set pace.
  await page.waitForTimeout(3000);
  const after = await measuredPace(page);

  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before * 2);

  errors.expectClean();
});

test('the pace keys change the speed while it runs', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('a');
  // Let the starting ramp finish before measuring the baseline, or the "before"
  // sample is a plant accelerating rather than a pace.
  await page.waitForTimeout(1500);
  const slow = await measuredPace(page);

  // Wind it to the top of the range.
  for (let i = 0; i < 20; i++) await page.keyboard.press(']');
  await page.waitForTimeout(1500);
  const fast = await measuredPace(page);

  /*
   * The claim is that the KEYS CHANGED THE PACE, so the assertion has to compare
   * two paces. A floor on the second one alone would pass with every bracket
   * press ignored, because the default pace clears any floor worth setting.
   *
   * The range is 60–260 wpm and the default is 130, so winding to the top is a
   * factor of two. Asserting 1.4 leaves room for the ramp and for whatever the
   * measurement windows straddle, and still fails outright if the keys do
   * nothing.
   */
  expect(slow).toBeGreaterThan(3);
  expect(fast).toBeGreaterThan(slow * 1.4);

  errors.expectClean();
});
