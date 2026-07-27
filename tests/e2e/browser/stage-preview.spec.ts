import { test, expect } from '@playwright/test';

/**
 * The stage window, driven directly via /stage.html?preview=1.
 *
 * BOUNDARY (read the report): this exercises the stage RENDERER through the
 * stage's own event protocol on a local bus (src/stage/preview.ts). It does NOT
 * exercise the control->stage channel — cross-window Tauri events do not fire
 * between two browser pages, and the Rust IPC relay that carries them is not
 * reachable here.
 *
 * Real behaviour asserted:
 *   - the compiled script renders on the glass (heading + narration);
 *   - a reserved band is folded into the scroll plane's bottom padding (§7.1);
 *   - the reading band is live: the script drifts upward as semantic motion
 *     frames advance (not a static frame);
 *   - blanking hides the script instantly without unmounting (§16.6).
 */

test('the preview renders the script, reserves the bottom band, and drives the reading band', async ({ page }, testInfo) => {
  await page.goto('/stage.html?preview=1');

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  // The compiled document is on the glass.
  await expect(root.getByText('A calm start')).toBeVisible();
  await expect(root.getByText('Welcome back to the channel.')).toBeVisible();

  // §7.1: the reserved band at the foot of the stage is folded into the scroll
  // plane's bottom padding, so the script never scrolls into it. The band
  // outlived the coaching rail that used to fill it — the transcript bar and
  // the voice pill sit there now, and the script must still clear them.
  const scrollPlane = page.locator('.scroll-plane');
  const paddingBottom = await scrollPlane.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(paddingBottom).toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('stage-preview.png'), fullPage: false });

  /*
   * The stage SCROLLS — it does not merely highlight.
   *
   * This used to assert that the plane's `translateY` had moved 5 px inside
   * five seconds, and that is far too weak a claim to stand for "the reading
   * band is live". A frame loop that re-anchored the motion plant once per
   * displayed frame left the document crawling at about 1 px/s while the
   * reading position advanced at 35: it cleared the 5 px inside four seconds,
   * passed this test, and then spent the rest of the take with the presenter's
   * words a thousand pixels below the fold. Movement is not following.
   *
   * So the claim is now the one a presenter would make: THE WORD BEING SPOKEN
   * ARRIVES AT THE READING BAND. The preview reads about three tokens a second,
   * so a stage that follows brings token 30 to the band in roughly ten seconds;
   * one that only highlights would need six minutes.
   */
  const word30 = page.locator('[data-t="30"]');
  // Token 30 is the first word of the third block, so it OPENS a rendered line
  // — which is what makes it a fair probe: the §8 motion path puts every line
  // START at `R`, and a mid-line word would legitimately sit a whole line pitch
  // above that. Pinned so an edit to the preview script cannot quietly turn
  // this into a mid-line probe and loosen the assertion by a line.
  await expect(word30).toHaveText('Reading');

  const { bandCentrePx, linePitchPx } = await page.evaluate(() => ({
    // The preview's own `readingBandCenterPercent` (src/stage/preview.ts).
    bandCentrePx: window.innerHeight * 0.38,
    linePitchPx: parseFloat(getComputedStyle(document.querySelector('.column')!).lineHeight),
  }));

  /**
   * Where the 30th spoken word sits relative to the reading band, positive
   * below. Every sample is kept, so the assertion afterwards can speak about
   * the whole approach rather than one racy re-read.
   */
  const approach: number[] = [];
  const bandError = async (): Promise<number> => {
    const error = Math.round(
      (await word30.evaluate((el) => el.getBoundingClientRect().top)) - bandCentrePx,
    );
    approach.push(error);
    return error;
  };

  // Arrival, measured from the top of the word's box against the band's centre.
  // `R` is where the BASELINE goes, so a line sitting exactly on the reading
  // line reads as roughly −0.8 of a line pitch here; landing anywhere under
  // +40 means the word has come up out of the lower half of the screen.
  await expect.poll(bandError, { timeout: 25_000, intervals: [250] }).toBeLessThan(40);

  /*
   * And it arrived by FOLLOWING, not by flying past. The stage's fade treatment
   * makes a display that LEADS the reader worse than one that trails, so the
   * far side is the one worth pinning: nothing on the way in may put the word
   * more than a couple of line pitches above the band.
   *
   * Measured arrival is about −0.6 of a line pitch, and a single missed 250 ms
   * poll across a line handoff can add one more, so 2.5 is the honest floor —
   * tight enough that an unfollowed jump to the top of the document (which puts
   * this word a whole screen high) still fails.
   */
  expect(
    Math.min(...approach),
    `band error over the approach: ${approach.join(', ')}`,
  ).toBeGreaterThan(-2.5 * linePitchPx);

  // Blank (§16.6): the script hides instantly, without unmounting.
  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(1);
  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(0);
});

/**
 * The same claim, on the layout almost every take actually runs.
 *
 * The test above drives the CALIBRATED path: the harness discovers a rig,
 * resolves it, and hands the stage a full `optics` block. A rig only becomes
 * calibrated when somebody stands at the glass with a ruler, so until that
 * happens every take in the app lays out on the other branch — flat
 * `fontSizePx`/`lineHeight`/`columnWidthPercent`, no optics at all.
 *
 * That branch had no end-to-end coverage of whether the document FOLLOWS. Its
 * geometry is pinned to literals in jsdom (`script-layer-uncalibrated-parity`),
 * but jsdom has no layout engine and cannot answer the only question that
 * matters here: does the word being spoken arrive at the reading band. Half the
 * product was covered by a test that looked like it covered all of it.
 */
test('the uncalibrated stage follows too', async ({ page }) => {
  await page.goto('/stage.html?preview=1&calibrated=0');

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');
  await expect(root.getByText('A calm start')).toBeVisible();

  const word30 = page.locator('[data-t="30"]');
  await expect(word30).toHaveText('Reading');

  const { bandCentrePx, linePitchPx } = await page.evaluate(() => ({
    // `uncalibratedPreviewSettings()`'s own `readingBandCenterPercent`, which is
    // `DEFAULT_STAGE_APPEARANCE`'s — the number a fresh profile prompts at.
    bandCentrePx: window.innerHeight * 0.38,
    linePitchPx: parseFloat(getComputedStyle(document.querySelector('.column')!).lineHeight),
  }));

  const approach: number[] = [];
  const bandError = async (): Promise<number> => {
    const error = Math.round(
      (await word30.evaluate((el) => el.getBoundingClientRect().top)) - bandCentrePx,
    );
    approach.push(error);
    return error;
  };

  // Arrival, and arrival by following — the same two bounds as the calibrated
  // case, and for the same reason: a display that LEADS the reader is worse
  // than one that trails, so the far side is the one worth pinning.
  await expect.poll(bandError, { timeout: 25_000, intervals: [250] }).toBeLessThan(40);
  expect(
    Math.min(...approach),
    `band error over the approach: ${approach.join(', ')}`,
  ).toBeGreaterThan(-2.5 * linePitchPx);
});

/**
 * The exit affordance is clickable, not just painted.
 *
 * This assertion is here rather than in jsdom because it needs real hit-testing.
 * The button lives inside `.stage-safe-plane`, which is `pointer-events: none`
 * so a stray click over the hold chip or the voice pill falls through to the
 * root and reports focus instead of being swallowed by decoration. A button
 * inheriting that rule paints perfectly and does nothing — and jsdom cannot see
 * it, because `getComputedStyle` there reports `pointer-events: auto` without
 * inheriting the parent's `none`, so the obvious unit assertion passes either
 * way (checked: removing the fix leaves the jsdom suite green).
 *
 * Playwright's actionability check is the real thing: it hit-tests the point it
 * is about to click and fails if some other element would receive the event.
 */
test('the exit affordance is clickable, not just painted', async ({ page }) => {
  await page.goto('/stage.html?preview=1');
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  // It stays out of the way until somebody reaches for the mouse — a take is
  // exactly when nobody does.
  await expect(page.locator('.stage-exit')).toHaveCount(0);

  await root.hover();
  const exit = page.locator('.stage-exit');
  await expect(exit).toBeVisible();

  // The assertion. A `pointer-events: none` button fails this with "element
  // intercepts pointer events" rather than clicking; it does not pass slowly.
  await exit.click({ timeout: 5_000 });
});

/*
 * ---------------------------------------------------------------------------
 * REMOVED: "the rail does not reflow when the delivery score changes (§7.1)"
 * ---------------------------------------------------------------------------
 * It measured the coaching rail — `.coach-rail`, its `[data-zone]` tracks and
 * the `--score-col` that held the tip still while the number grew — with real
 * `getBoundingClientRect()` readings, because jsdom has no layout engine and a
 * content-sized track would satisfy every markup assertion and still shove the
 * tip sideways.
 *
 * Live coaching was deleted with the OpenAI provider (9db32ac). There is no
 * rail, no score, no `setDeliveryScore` on the preview driver, and no
 * `--score-col`: the test could not be repaired, only re-pointed at something
 * it was never about. It has been failing on every run since, which is worse
 * than absent — a suite with a permanent red in it stops being read.
 *
 * If a rail comes back, this is the assertion to bring back with it: three
 * measured boxes across `—`, `84` and `100`, proving the zone around the number
 * is identical in every state while the ink inside it is not.
 */
