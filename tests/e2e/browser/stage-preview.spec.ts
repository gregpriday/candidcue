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
  /*
   * ...and it is GONE, not merely classed.
   *
   * Blanking hides an ancestor with `visibility: hidden`, and visibility is the
   * one inherited property a descendant can countermand. Anything inside the
   * stage that writes an explicit `visibility: visible` on itself — the opening
   * gate is the live example — punches the script straight back through a
   * blanked stage while control goes on reporting it as blanked. The class is
   * not the claim; the glass is.
   */
  const scriptVisibility = () =>
    page.locator('.script-layer').evaluate((el) => getComputedStyle(el).visibility);
  await expect.poll(scriptVisibility).toBe('hidden');

  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(0);
  await expect.poll(scriptVisibility).toBe('visible');
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
 * The dock is clickable, not just painted.
 *
 * This assertion is here rather than in jsdom because it needs real
 * hit-testing. The dock lives in the operator plane, which is
 * `pointer-events: none` so a stray click over a readout falls through to the
 * root and reports focus instead of being swallowed by decoration. A button
 * inheriting that rule paints perfectly and does nothing — and jsdom cannot see
 * it, because `getComputedStyle` there reports `pointer-events: auto` without
 * inheriting the parent's `none`, so the obvious unit assertion passes either
 * way (checked: removing the fix leaves the jsdom suite green).
 *
 * Playwright's actionability check is the real thing: it hit-tests the point it
 * is about to click and fails if some other element would receive the event —
 * which additionally covers the hidden buttons, since they keep their place in
 * the layout and would otherwise sit invisibly over the audio readout.
 */
test('the session dock is clickable, not just painted', async ({ page }) => {
  await page.goto('/stage.html?preview=1');
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  // It introduces itself and then gets out of the way — a take is exactly when
  // nobody touches the mouse.
  const end = page.locator('.stage-dock .dock-button.end');
  await expect(end).toHaveAttribute('data-hidden', 'true', { timeout: 10_000 });

  await root.hover();
  await expect(end).toHaveAttribute('data-hidden', 'false');

  // The assertion. A `pointer-events: none` button fails this with "element
  // intercepts pointer events" rather than clicking; it does not pass slowly.
  await end.click({ timeout: 5_000 });

  // And one click asks rather than acts.
  await expect(page.locator('.stage-dock .confirm-end')).toBeVisible();
});

/**
 * A hidden dock button cannot be clicked through.
 *
 * The other half of the rule above, and the half jsdom structurally cannot see:
 * it reports `pointer-events` as the initial `auto` without inheriting an
 * ancestor's `none`, so the obvious unit assertion passes with the rule deleted.
 *
 * The failure it guards is specific. The buttons keep their place in the layout
 * while invisible — otherwise the audio readout would jump sideways every time
 * the mouse moved — so an invisible button that still took a click would be a
 * live "end session" target sitting in the corner where a pointer is most
 * likely to be resting when the idle timer expires.
 */
test('a hidden dock button cannot be clicked through', async ({ page }) => {
  await page.goto('/stage.html?preview=1');
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  const end = page.locator('.stage-dock .dock-button.end');
  await expect(end).toHaveAttribute('data-hidden', 'true', { timeout: 10_000 });

  // It is still laid out — that is the point of hiding it this way...
  const box = await end.boundingBox();
  expect(box, 'the hidden button must keep its place in the row').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);

  // ...and the browser's own hit test says nothing there answers a click. This
  // fails if `pointer-events: none` is dropped, which is the regression.
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el === null || el.closest('.dock-button') === null;
  }, [box!.x + box!.width / 2, box!.y + box!.height / 2] as const);
  expect(hit, 'a hidden button must not be the element under the pointer').toBe(true);
});

/**
 * The reading cue's band, measured — the one claim jsdom cannot make.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAS TO BE HERE
 * ---------------------------------------------------------------------------
 * The mark is fixed and the document advances a line pitch per line, so the mark
 * travels one pitch relative to the line being read and only the PHASE is
 * tunable. The phase puts it on the middle of the capitals at line entry; the
 * band covers where the line goes from there, which is one pitch UPWARD.
 *
 * That band's defining property is where its lower edge lands: on the tick's
 * apex, expressed as `bottom: 50%` inside a tick that is itself
 * `translateY(-50%)` on the band centre. Every part of that is layout, and the
 * jsdom suite (`tests/dom/script-layer-reading-cue.test.ts`) can only read the
 * inline heights back — it would pass with `bottom: 50%` changed to `top: 50%`,
 * with the parent transform removed, or with the rules growing downward, all of
 * which put the band over the line the presenter has already read.
 *
 * `?calibrated=0` on purpose: the flat branch fixes the pitch at 64 x 1.32 and a
 * 78% column, so there is a real gutter for the band and a pitch this test can
 * predict. A calibrated rig whose resolved column fills the safe width has no
 * gutter, and the band is deliberately absent there.
 */
test('the reading cue marks one line pitch above the mark, in both styles', async ({ page }) => {
  await page.goto('/stage.html?preview=1&calibrated=0');

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');
  await expect(page.locator('.cue.ticks')).toHaveCount(1);

  const linePitchPx = await page
    .locator('.column')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
  expect(linePitchPx, 'the flat branch renders 64px at 1.32').toBeCloseTo(64 * 1.32, 1);

  // Both sides, because a band on one tick and not the other reads as breakage.
  const ticks = page.locator('.cue.ticks .tick');
  await expect(ticks).toHaveCount(2);
  await expect(page.locator('.cue.ticks .travel')).toHaveCount(2);

  const apexes: number[] = [];
  for (let i = 0; i < 2; i++) {
    const tick = ticks.nth(i);
    const tickBox = (await tick.boundingBox())!;
    const bandBox = (await tick.locator('.travel').boundingBox())!;
    const apex = tickBox.y + tickBox.height / 2;
    apexes.push(apex);

    // ONE PITCH, measured — not "about a line".
    expect(bandBox.height, `band ${i} height`).toBeCloseTo(linePitchPx, 0);
    // ...ending ON the apex. This is the assertion the whole change rests on.
    expect(bandBox.y + bandBox.height, `band ${i} lower edge`).toBeCloseTo(apex, 0);
    // ...and reaching UP from it, never down. Stated separately so a band of the
    // right height hung the wrong way fails on its own line.
    expect(bandBox.y, `band ${i} upper edge`).toBeCloseTo(apex - linePitchPx, 0);
  }

  /*
   * The wash is the same band, lit rather than ruled. Its element carries the
   * plateau edges as percentages of its own height (they follow from the skirt
   * ratio rather than from chosen stops), so the plateau is measured from the
   * real box and the real custom properties.
   */
  await root.press('r');
  const wash = page.locator('.cue.wash .wash-band');
  await expect(wash).toHaveCount(1);

  const plateau = await wash.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const read = (name: string): number =>
      Number.parseFloat(getComputedStyle(el).getPropertyValue(name));
    return {
      top: box.top + box.height * (read('--plateau-top') / 100),
      bottom: box.top + box.height * (read('--plateau-bottom') / 100),
    };
  });

  expect(plateau.bottom - plateau.top, 'lit plateau height').toBeCloseTo(linePitchPx, 0);
  // The mark has not moved, so the plateau ends where the hairline did.
  expect(plateau.bottom, 'lit plateau lower edge').toBeCloseTo(apexes[0]!, 0);
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
