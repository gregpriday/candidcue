import { test, expect } from '@playwright/test';

/**
 * The stage window, driven directly via /stage.html?preview=1.
 *
 * BOUNDARY (read the report): this exercises the stage RENDERER through the
 * stage's own event protocol on a local bus (src/stage/preview.ts). It does NOT
 * exercise the control->stage channel — cross-window Tauri events do not fire
 * between two browser pages, and the Rust IPC relay that carries them is not
 * reachable here. The rail CONTENT is real (the preview publishes `coach_rail`
 * snapshots at the producer's §12.2 rate) but it is the preview's own, not a
 * live session's.
 *
 * Real behaviour asserted:
 *   - the compiled script renders on the glass (heading + narration);
 *   - a reserved band is folded into the scroll plane's bottom padding (§7.1);
 *   - the reading band is live: the script drifts upward as semantic motion
 *     frames advance (not a static frame);
 *   - blanking hides the script instantly without unmounting (§16.6);
 *   - §7.1 as *measured geometry*: the rail's zones and the script's box do not
 *     move when the delivery score changes state or width.
 */

function translateY(transform: string): number {
  // matrix(a,b,c,d,tx,ty) or translate3d(...) -> read the vertical component.
  const m = transform.match(/matrix\([^)]*,\s*([-\d.]+)\)/);
  if (m) return parseFloat(m[1]!);
  return 0;
}

test('the preview renders the script, reserves the rail band, and drives the reading band', async ({ page }, testInfo) => {
  await page.goto('/stage.html?preview=1');

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  // The compiled document is on the glass.
  await expect(root.getByText('A calm start')).toBeVisible();
  await expect(root.getByText('Welcome back to the channel.')).toBeVisible();

  // §7.1: the rail's reserved band is folded into the scroll plane's bottom
  // padding, so the script never scrolls under the rail.
  const scrollPlane = page.locator('.scroll-plane');
  const paddingBottom = await scrollPlane.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(paddingBottom).toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('stage-preview.png'), fullPage: false });

  // The reading band is LIVE: semantic frames advance, so the script drifts up
  // (translateY grows more negative) rather than sitting on a static frame.
  const first = translateY(await scrollPlane.evaluate((el) => getComputedStyle(el).transform));
  await expect
    .poll(async () => translateY(await scrollPlane.evaluate((el) => getComputedStyle(el).transform)), {
      timeout: 5000,
    })
    .toBeLessThan(first - 5);

  // Blank (§16.6): the script hides instantly, without unmounting.
  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(1);
  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(0);
});

type Score = Record<string, unknown> | null;

/**
 * Drive the preview's rail. `startPreviewDriver` parks the same object the
 * keyboard shortcuts use on `window` under `?preview=1`; its absence is a
 * broken harness, not a passing test, so this throws inside the page rather
 * than quietly doing nothing.
 */
async function setPreviewScore(
  page: import('@playwright/test').Page,
  score: Score,
): Promise<void> {
  await page.evaluate((value: Score) => {
    const driver = (
      window as unknown as {
        __stagePreview?: { setDeliveryScore(next: Score): void };
      }
    ).__stagePreview;
    if (!driver) throw new Error('preview driver is not on window — is ?preview=1 set?');
    driver.setDeliveryScore(value);
  }, score);
}

/** A measured box, rounded to a hundredth of a pixel so it compares as text. */
type Box = { x: number; y: number; width: number; height: number };

const boxOf = async (page: import('@playwright/test').Page, selector: string): Promise<Box> =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const round = (n: number) => Math.round(n * 100) / 100;
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  });

/**
 * §7.1 in a browser that actually lays boxes out.
 *
 * The unit suite proves this by byte-comparing the rendered markup and reading
 * the stylesheet, and it is explicit about its own limit: jsdom has no layout
 * engine, so nothing there measures a real box. A content-sized grid track
 * would satisfy every one of those assertions and still shove the tip sideways
 * the moment `LISTENING…` became `84`. This is the assertion that cannot be
 * satisfied that way — three real `getBoundingClientRect()` readings, taken
 * from the same live page as the score moves through the states a take puts it
 * in.
 */
test('the rail does not reflow when the delivery score changes (§7.1, measured)', async ({ page }) => {
  await page.goto('/stage.html?preview=1');

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  // The preview publishes real coach_rail snapshots, so the band is populated.
  await expect(page.locator('.coach-rail')).toHaveCount(1);
  await expect(page.locator('[data-zone="score"]')).toHaveCount(1);
  const scoreValue = page.locator('[data-field="score-value"]');

  // Freeze the reading band so the score is the only thing changing. The rail
  // publishes on its own timer and keeps running.
  await root.press('f');

  async function measureAt(
    score: Record<string, unknown> | null,
    expected: string,
  ): Promise<Record<string, string>> {
    await setPreviewScore(page, score);
    // Wait for the state to be on the glass before measuring it — the rail
    // rate-caps the number at 2–5 Hz (§11.3), so the DOM lags the payload.
    await expect(scoreValue).toHaveText(expected);
    return {
      // The zone next to the score: what a growing score column would push.
      tip: JSON.stringify(await boxOf(page, '[data-zone="tip"]')),
      // The score's own fixed track (`--score-col`), in real pixels.
      score: JSON.stringify(await boxOf(page, '[data-zone="score"]')),
      pace: JSON.stringify(await boxOf(page, '[data-zone="pace"]')),
      // The reserved band itself, and the script's box above it.
      rail: JSON.stringify(await boxOf(page, '.coach-rail')),
      script: JSON.stringify(await boxOf(page, '.script-layer')),
      // §7.1's other half: the hole the script leaves for the band.
      inset: await page
        .locator('.scroll-plane')
        .evaluate((el) => getComputedStyle(el).paddingBottom),
    };
  }

  // §11.3 warm-up: an em dash and "Listening…", the narrowest thing the zone
  // ever holds and the widest label it ever holds.
  const warming = await measureAt({ tier: 'warming_up', displayScore: null }, '—');
  // A real two-digit score.
  const scored = await measureAt({ tier: 'usable', displayScore: 84 }, '84');
  // Three digits — the width change §7.1 has to absorb inside the score's own
  // box.
  const perfect = await measureAt({ tier: 'confident', displayScore: 100 }, '100');
  // And a trend caret arriving beside the number.
  const rising = await measureAt(
    { tier: 'confident', displayScore: 100, trend: 'rising' },
    '100',
  );

  expect(scored).toEqual(warming);
  expect(perfect).toEqual(warming);
  expect(rising).toEqual(warming);

  // The measurements are of real boxes, not of empty ones: a zero-width tip
  // zone would compare equal to itself all day.
  const tip = JSON.parse(warming['tip']!) as Box;
  expect(tip.width).toBeGreaterThan(100);
  expect(tip.height).toBeGreaterThan(0);

  // Where the guarantee actually lives. The `min-width: 3ch` on the number is a
  // hint, not the mechanism: measured in the stage's own font, three tabular
  // digits come out about half a pixel wider than `3ch` (37.55 px for `—` and
  // `84`, 38.06 px for `100`) — something no markup or stylesheet assertion can
  // see. What holds §7.1 is the fixed `--score-col` track around it, which is
  // why the zone box above is identical in every state while the ink inside it
  // is not.
  const widths: number[] = [];
  for (const value of ['—', '84', '100']) {
    await setPreviewScore(
      page,
      value === '—'
        ? { tier: 'warming_up', displayScore: null }
        : { tier: 'usable', displayScore: Number(value) },
    );
    await expect(scoreValue).toHaveText(value);
    widths.push((await boxOf(page, '[data-field="score-value"]')).width);
  }
  const scoreZone = JSON.parse(warming['score']!) as Box;
  expect(Math.max(...widths)).toBeLessThan(scoreZone.width);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
});
