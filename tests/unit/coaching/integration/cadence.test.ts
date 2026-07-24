/**
 * §12.4 / §18.5 through the integrator: pauses derived from VAD gaps, and the
 * two gates that decide what they mean.
 *
 * The orchestrator is the module that derives pauses from gaps between speech
 * runs, so it is the module that owes `PauseEvent.unmeasured` — the audio
 * lane's hard rule is that a dropout is not a pause, and the gap between two
 * runs is exactly where a buffer underrun shows up.
 *
 * `CadenceAnalyzer.setAlignmentConfidence` defaults **shut** by design, so a
 * choppy-delivery claim is only reachable when someone tells the lane the
 * alignment is trustworthy. These tests prove both directions.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness } from './harness';
import type { PauseLocation } from '../../../../src/shared/coaching/prosody/cadence-analyzer';

/** The tracking engine's answer to "where did that silence sit?" (§18.2). */
const midClause = (): { location: PauseLocation } => ({ location: 'between_words' });

function choppyHarness(alignmentConfidence: number): TakeHarness {
  const harness = new TakeHarness({ host: { alignmentConfidence, pauseLocation: midClause } });
  // Four short runs separated by three 400 ms silences: three mid-clause
  // interruptions inside the twenty-second window.
  for (let index = 0; index < 3; index += 1) {
    harness.speak(1_000);
    harness.silence(400);
  }
  harness.speak(1_000);
  harness.settle(400);
  return harness;
}

describe('coaching integration — cadence', () => {
  it('raises the choppy pattern when the alignment is trusted', () => {
    const harness = choppyHarness(0.9);
    expect(harness.latest()?.activeTip?.code).toBe('KEEP_SENTENCE_FLOWING');
  });

  it('stays silent on identical audio when the alignment is not trusted (§18.5)', () => {
    // Same frames, same pauses, same locator — only the confidence differs, and
    // it sits below the lane's 0.7 gate. `setAlignmentConfidence` is the only
    // thing that can open it, so this pair proves the call is actually made.
    const harness = choppyHarness(0.5);
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
  });

  it('never claims a mid-clause pause without a locator from the tracking engine', () => {
    const harness = new TakeHarness({ host: { alignmentConfidence: 0.95 } });
    for (let index = 0; index < 3; index += 1) {
      harness.speak(1_000);
      harness.silence(400);
    }
    harness.speak(1_000);
    // Long enough for the publication cadence to land after the last run
    // closes: nothing changed state here, so §12.2's 200 ms tick is the only
    // thing that will publish it.
    harness.settle(800);
    // §18.5 is about *mid-clause* interruptions. Where a silence sits relative
    // to the authored text is an alignment fact; with no `pauseLocation` the
    // orchestrator declines to guess, rather than calling every gap
    // `uncertain` and manufacturing a finding out of sentence boundaries.
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
    // The pauses are still *drawn* — the ribbon is a record, not a verdict.
    const pauses = harness.latest()?.ribbonEvents.filter((event) => event.type === 'pause') ?? [];
    expect(pauses.length).toBe(3);
  });

  it('does not draw a dropout as a pause, and does not count it as choppy', () => {
    const clean = new TakeHarness({ host: { alignmentConfidence: 0.9, pauseLocation: midClause } });
    const lossy = new TakeHarness({ host: { alignmentConfidence: 0.9, pauseLocation: midClause } });

    for (const [harness, dropout] of [
      [clean, false],
      [lossy, true],
    ] as const) {
      for (let index = 0; index < 3; index += 1) {
        harness.speak(1_000);
        // The identical 600 ms silence in both takes. In the lossy one the
        // worklet lost 200 ms of it, so part of the gap was never measured —
        // the run still closes (a dropout does not advance the VAD's close
        // timer, but the surrounding real silence does), and the difference is
        // therefore entirely in what the gap *means*.
        harness.silence(200);
        harness.silence(200, dropout ? { processorDropout: true } : {});
        harness.silence(200);
      }
      harness.speak(1_000);
      harness.settle(400);
    }

    const cleanPauses = clean.latest()?.ribbonEvents.filter((event) => event.type === 'pause');
    const lossyPauses = lossy.latest()?.ribbonEvents.filter((event) => event.type === 'pause');
    expect(cleanPauses?.length).toBe(3);
    // §12.4: a dropout is not a pause. Not a smaller pause — not one at all.
    expect(lossyPauses?.length).toBe(0);

    // …and the same distinction reaches the cadence lane, so a buffer underrun
    // never tells a presenter their phrasing is broken.
    expect(clean.latest()?.activeTip?.code).toBe('KEEP_SENTENCE_FLOWING');
    expect(lossy.published.every((state) => state.activeTip === null)).toBe(true);
  });
});
