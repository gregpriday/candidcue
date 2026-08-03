import { test, expect } from '@playwright/test';

/**
 * THE CLAIM THE WHOLE PRODUCT RESTS ON: it follows along.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN THERE IS ALREADY A BENCHMARK
 * ---------------------------------------------------------------------------
 * `cc-bench` replays real captured transcripts through the alignment
 * engine and scores the result — and every number it produces is measured
 * against `Snapshot::display_at`, which is RUST's model of where the display
 * would be. Nothing in it renders a pixel. So the suite could report
 * `live.within5 = 95%` while the Svelte stage sat perfectly still, and did:
 * "the aligner followed nine words, the summary said so, and the glass never
 * moved" is a real session, and neither the benchmark nor any unit test could
 * have caught it. The engine and the renderer were verified separately and the
 * failure lived exactly between them.
 *
 * This closes that gap with the only assertion a presenter would recognise:
 * take speech that a real person really said, put it through the real engine,
 * and check that the words they are saying arrive under their eye on the real
 * glass.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Real: the speech (a captured Tier-B run — TTS audio streamed at real time
 * through a live recogniser, with its errors intact), the
 * alignment engine, the atom-to-token projection the app publishes, the Svelte
 * stage, its motion controller, its layout, and the browser's own compositor.
 *
 * Not real: the Tauri event bridge between Rust and the stage window, which
 * cannot be exercised from a browser. The snapshots are delivered on the stage's
 * local bus instead, in the same shape and on the same schedule.
 *
 * Real time is the measurement, not a convenience — see `startFixtureReplay`.
 * A twenty-second claim costs twenty seconds.
 */

/** Regenerate with: cd crates && cargo run --release -p cc-bench -- \
 *  export-run starter__exact__gemini --seconds 22 \
 *  --out ../tests/fixtures/follow/starter-gemini-22s.json */
const FIXTURE = '/tests/fixtures/follow/starter-gemini-22s.json';

interface Fixture {
  totalMs: number;
  tokens: Array<{ surface: string; para: number }>;
  gold: Array<{ atMs: number; token: number }>;
}

test('the stage follows a real recorded reading', async ({ page }) => {
  test.setTimeout(90_000);

  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(String(e)));

  await page.goto(`/stage.html?preview=1&replay=${encodeURIComponent(FIXTURE)}`);

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live', { timeout: 20_000 });

  const fixture = (await page.evaluate(
    () => (window as unknown as Record<string, { fixture: Fixture }>)['__followReplay']!.fixture,
  )) as Fixture;
  expect(fixture.gold.length).toBeGreaterThan(50);

  const { bandCentrePx, linePitchPx } = await page.evaluate(() => ({
    // `uncalibratedPreviewSettings()`'s own reading band, which is
    // `DEFAULT_STAGE_APPEARANCE`'s — what a fresh profile prompts at.
    bandCentrePx: window.innerHeight * 0.38,
    linePitchPx: parseFloat(getComputedStyle(document.querySelector('.column')!).lineHeight),
  }));

  /**
   * Where the word the reader is actually saying sits, relative to the band.
   *
   * Positive is below the band (the display is behind the reader), negative is
   * above it (the display has run ahead). Null when that word is not in the
   * DOM — the stage windows its render, and a token far off-screen genuinely
   * has no box.
   */
  async function bandErrorNow(): Promise<{ atMs: number; token: number; errorPx: number } | null> {
    return page.evaluate(
      ({ centre }) => {
        const handle = (
          window as unknown as Record<string, { fixture: Fixture; startedAtMs: number }>
        )['__followReplay'];
        if (!handle) return null;
        const atMs = performance.now() - handle.startedAtMs;
        let best = handle.fixture.gold[0]!;
        for (const g of handle.fixture.gold) {
          if (g.atMs <= atMs) best = g;
          else break;
        }
        const el = document.querySelector(`[data-t="${Math.floor(best.token)}"]`);
        if (!el) return { atMs, token: best.token, errorPx: Number.NaN };
        return { atMs, token: best.token, errorPx: el.getBoundingClientRect().top - centre };
      },
      { centre: bandCentrePx },
    );
  }

  /*
   * Sampling starts after the engine has had a chance to lock. Tier B measures
   * `live.first_lock_p50` at about 2.3 s on this corpus, and the display then
   * has to travel to that position — so anything before ~6 s is measuring the
   * approach, which the benchmark already covers and which is not what this
   * test is about.
   */
  const samples: Array<{ atMs: number; token: number; errorPx: number }> = [];
  const deadlineMs = Math.min(fixture.totalMs, 21_000);
  for (;;) {
    const sample = await bandErrorNow();
    if (sample === null) break;
    if (sample.atMs > deadlineMs) break;
    if (sample.atMs > 6_000 && Number.isFinite(sample.errorPx)) samples.push(sample);
    await page.waitForTimeout(400);
  }

  expect(failures, `page errors during replay: ${failures.join(' | ')}`).toEqual([]);
  expect(samples.length, 'no usable samples were taken').toBeGreaterThan(15);

  const report = samples
    .map((s) => `${Math.round(s.atMs)}ms t${s.token.toFixed(1)} ${Math.round(s.errorPx)}px`)
    .join(', ');

  /*
   * THE CLAIM, part one: the spoken word sits ON the reading band.
   *
   * The band's centre is measured against the top of the word's box, and `R` is
   * where the BASELINE goes — so a line resting exactly on the reading line
   * reads as roughly −0.8 of a line pitch here, not zero. The window below is
   * that reference plus about a line either way, which is the sawtooth a line
   * handoff produces and nothing more.
   */
  const errors = samples.map((s) => s.errorPx).sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)]!;
  expect(median, `band error median over the read: ${report}`).toBeLessThan(0.4 * linePitchPx);
  expect(median, `band error median over the read: ${report}`).toBeGreaterThan(-2 * linePitchPx);

  /*
   * THE CLAIM, part two — and this is the one that catches the failure that
   * started all of this: the error DOES NOT TREND.
   *
   * A stage that has stopped applying its snapshots still passes every
   * position-based bound for the first second or two, because it is still in
   * roughly the right place. What gives it away is that the reader keeps going
   * and it does not: the gap opens steadily, one line at a time, for as long as
   * the passage lasts. Comparing where the error starts against where it ends
   * is what tells "following, with the ordinary wobble" apart from "frozen, and
   * being left behind" — and a frozen display over this fifteen-second window
   * would be some thirty-five tokens, several lines, adrift by the end.
   */
  const third = Math.floor(samples.length / 3);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const early = mean(samples.slice(0, third).map((s) => s.errorPx));
  const late = mean(samples.slice(-third).map((s) => s.errorPx));
  expect(
    Math.abs(late - early),
    `the display drifted ${Math.round(late - early)}px away from the reader over the read: ${report}`,
  ).toBeLessThan(1.5 * linePitchPx);

  /*
   * And it never gets lost at any single moment. Loose, because one relocation
   * legitimately travels — this bounds catastrophe, not comfort.
   */
  const worst = Math.max(...errors.map(Math.abs));
  expect(worst, `worst band error over the read: ${report}`).toBeLessThan(4 * linePitchPx);
});
