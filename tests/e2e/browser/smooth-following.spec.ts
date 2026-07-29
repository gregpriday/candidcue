import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

/**
 * IS THE SCROLL SMOOTH? — the presenter's word, made into a number.
 *
 * "Once it's moving, it should not stop... any bit of jerkiness is an absolute
 * killer." This drives the stage with a feed shaped like the real one and reads
 * the painted transform every animation frame, so the complaint has a
 * measurement: frames standing still while the presenter is talking, and the
 * spread between the slowest and fastest moments of an even read.
 *
 * The feed is faithful in the one way that matters. `rateTokensPerSecond` is
 * NOT the reader's pace — the aligner scales it by `prediction_gain` (0.33 at
 * ordinary speed) and publishes ZERO on every Final, because upstream that
 * number bounds a PREDICTION rather than describing a speed. A harness that
 * sent the true pace would hand the stage the very thing it has to work out for
 * itself, and would have passed against the bug this file exists to hold shut.
 *
 * WHAT IT MEASURES TODAY, and it is not good: at 150 wpm about a quarter of
 * frames are standing still, the tenth-percentile velocity is zero and the
 * ninetieth is ~110 px/s. The presenter reads that as surge-and-crawl, and they
 * are right. The cause is upstream and understood — `rateTokensPerSecond` is a
 * PREDICTION BOUND, not a pace (the aligner scales it by `prediction_gain` and
 * publishes zero on every Final), and the stage hands it to its controller as a
 * feed-forward VELOCITY — but the fix is not landed, because the first attempt
 * measured better on a synthetic feed and no better on this one.
 *
 * So the thresholds below are deliberately generous: they are a REGRESSION
 * floor, not a standard. What they hold shut is the direction of travel —
 * the document must not run backward, and it must cover the ground the reader
 * covers. Tighten them as the motion improves; the numbers to beat are in the
 * log line this test prints.
 */

const PARAGRAPH =
  'Revenue grew steadily through the quarter and churn came down in every segment we measure. ' +
  'The onboarding rewrite landed in February and the numbers moved the week after it shipped. ' +
  'Support volume fell, activation rose, and the team has been able to work ahead of the queue. ';

const SCRIPT = {
  id: '77777777-0000-4000-8000-000000000001',
  title: 'Smoothness',
  source:
    'Good morning, and welcome to this short teleprompter test.\n\n' +
    Array.from({ length: 6 }, () => PARAGRAPH).join('\n\n'),
};

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: { available: true, loaded: true, model: 'streaming-zipformer-en-20M-int8' },
    promptMode: 'voice',
  });
});

test('the script does not stop and start while the presenter reads', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 700 });
  await page.goto('/control.html');
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);

  const report = await page.evaluate(async () => {
    const WPM = 150;
    const TOKENS_PER_SEC = WPM / 60;
    const RUN_MS = 24_000;
    const PARTIAL_MS = 1000;
    /** The recogniser is always a little behind the mouth. */
    const LAG_TOKENS = 1.2;

    const samples: Array<{ t: number; y: number }> = [];
    const plane = document.querySelector('.scroll-plane') as HTMLElement;
    const read = () => {
      const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(plane.style.transform);
      return m?.[1] === undefined ? 0 : -Number(m[1]);
    };

    const started = performance.now();
    let stopped = false;
    const tick = () => {
      samples.push({ t: performance.now() - started, y: read() });
      if (!stopped) requestAnimationFrame(tick);
    };
    tick();

    const generation = window.__E2E__.lastSession?.sessionGeneration ?? 0;
    let seq = 0;
    let lastEvidence = { token: 0, atMs: 0 };
    const emit = (elapsedMs: number) => {
      const spoken = (elapsedMs / 1000) * TOKENS_PER_SEC;
      const confirmed = Math.max(0, spoken - LAG_TOKENS);
      // Utterances close every few partials, as the VAD sees sentence ends.
      const isFinal = seq % 4 === 3;
      /*
       * A REPEATED partial: the live captures show identical text arriving
       * 1.1s apart, so every third snapshot here carries no new evidence. A
       * harness without them lets a pace estimate that mistakes "no news" for
       * "no words" pass.
       */
      const repeated = seq % 3 === 1;
      const evidence = repeated ? lastEvidence : { token: confirmed, atMs: elapsedMs };
      lastEvidence = evidence;
      window.__E2E__.emit('align://snapshot', {
        sessionGeneration: generation,
        seq: ++seq,
        state: 'following',
        decision: 'localConfirmed',
        confirmedToken: evidence.token,
        observedToken: evidence.token,
        /*
         * What the aligner ACTUALLY publishes, not the reader's pace:
         * `prediction_gain` scales it to 0.33 at ordinary speed, and a Final
         * publishes zero because prediction stops at an utterance boundary.
         * The stage used to feed this straight to the controller as a
         * velocity, which is the whole surge-and-crawl.
         */
        rateTokensPerSecond: isFinal ? 0 : TOKENS_PER_SEC * 0.33,
        // Evidence is stamped when the words were SAID; the snapshot arrives
        // later. Collapsing the two hides endpoint delay from the estimator.
        evidenceAudioMs: evidence.atMs,
        atAudioMs: elapsedMs,
        maxPredictionMs: 1800,
        pauseOnsetMs: 1800,
        leadFloorMs: 0,
        maxLeadTokens: 1.25,
        leadMarginTokens: 2.2,
        leadEaseMs: 450,
        leadHoldMs: 0,
        leadDecayMs: 1200,
        displayLimitToken: confirmed + 40,
        confidence: 0.95,
        suggestionToken: null,
        scriptLenTokens: 400,
        observedAtom: confirmed,
        confirmedAtom: confirmed,
      });
    };

    await new Promise<void>((resolve) => {
      const step = () => {
        const elapsed = performance.now() - started;
        if (elapsed >= RUN_MS) {
          stopped = true;
          resolve();
          return;
        }
        emit(elapsed);
        // Real partials do not arrive on a metronome.
        window.setTimeout(step, PARTIAL_MS + (seq % 3) * 140);
      };
      step();
    });

    // ---- metrics ----
    const windowed = samples.filter((s) => s.t > 2000);
    const vels: number[] = [];
    for (let i = 1; i < windowed.length; i++) {
      const a = windowed[i - 1]!;
      const b = windowed[i]!;
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0) continue;
      vels.push((b.y - a.y) / dt);
    }
    const sorted = [...vels].sort((x, y) => x - y);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const accels: number[] = [];
    for (let i = 1; i < vels.length; i++) accels.push(Math.abs(vels[i]! - vels[i - 1]!));
    const accelSorted = [...accels].sort((x, y) => x - y);
    const stalled = vels.filter((v) => Math.abs(v) < 3).length;
    const backward = vels.filter((v) => v < -3).length;

    // Where the stalls are, in seconds into the run.
    const stallAt: number[] = [];
    {
      let runStart = -1;
      for (let i = 0; i < vels.length; i++) {
        const slow = Math.abs(vels[i]!) < 3;
        if (slow && runStart < 0) runStart = i;
        if ((!slow || i === vels.length - 1) && runStart >= 0) {
          if (i - runStart > 8) stallAt.push(Math.round((windowed[runStart]?.t ?? 0) / 100) / 10);
          runStart = -1;
        }
      }
    }

    // Longest run of consecutive stalled frames.
    let longest = 0;
    let run = 0;
    for (const v of vels) {
      run = Math.abs(v) < 3 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }

    return {
      stallAt,
      frames: windowed.length,
      travelPx: Math.round((windowed[windowed.length - 1]?.y ?? 0) - (windowed[0]?.y ?? 0)),
      velMedian: Math.round(pct(0.5)),
      velP10: Math.round(pct(0.1)),
      velP90: Math.round(pct(0.9)),
      stalledPct: Math.round((stalled / Math.max(1, vels.length)) * 100),
      longestStallFrames: longest,
      backwardFrames: backward,
      accelP95: Math.round(accelSorted[Math.floor(accelSorted.length * 0.95)] ?? 0),
      accelMax: Math.round(accelSorted[accelSorted.length - 1] ?? 0),
    };
  });

  console.log('smoothness', JSON.stringify(report));

  // A regression floor, not a standard — see the header. Measured today: ~25%.
  expect(report.stalledPct, 'frames standing still during a steady read').toBeLessThan(40);
  // It covers the ground the reader covers: 24s at 150 wpm over this script.
  expect(report.travelPx, 'ground covered').toBeGreaterThan(600);
  // And it does not run backward under them. Measured today: single digits, all
  // of them the prediction's lead decaying rather than the document rewinding.
  expect(report.backwardFrames).toBeLessThan(20);
});
