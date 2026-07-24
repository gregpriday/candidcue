/**
 * §16.5 / §26.5 through the integrator: a filler is counted, and then the
 * count corrects downward *and takes its tip with it*.
 *
 * `FillerTracker.drainRevisedEventIds` documents the exact wiring this proves,
 * and had no caller: the tile's number corrected while the tip built on that
 * very "um" stayed on the presenter's glass. The demotion drain is the only
 * reason these assertions can hold.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness, authoredSpan, prose } from './harness';
import type { PrecisionTranscriptResult } from '../../../../src/shared/coaching/disfluency/types';

describe('coaching integration — disfluency', () => {
  it('counts a confirmed strict filler on the rail', () => {
    const harness = new TakeHarness();
    harness.say(prose(12), 4_000);
    harness.say('so um we should start with the second section', 4_000);
    harness.orchestrator.tick();

    const rail = harness.latest();
    expect(rail).not.toBeNull();
    expect(rail?.fillers.confirmedCount).toBeGreaterThan(0);
    // §25.3: only a strict form from the fixed lexicon may be quoted back.
    expect(rail?.fillers.dominantForm).toBe('um');
    // §27.4: the same event is a ribbon tick, drawn at its own audio interval.
    const ticks = rail?.ribbonEvents.filter((event) => event.type === 'confirmed_filler') ?? [];
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('corrects the count downward when a precision transcript revises the event away', () => {
    const harness = new TakeHarness();
    harness.say(prose(12), 4_000);
    const spoken = harness.say('so um we should start with the second section', 4_000);
    harness.orchestrator.tick();

    const before = harness.latest();
    expect(before?.fillers.confirmedCount).toBeGreaterThan(0);
    const counted = before?.fillers.confirmedCount as number;

    // §16.3.4: a verbatim pass over the same audio that does not contain the
    // form. The result is mapped back onto the interval it describes.
    const precision: PrecisionTranscriptResult = {
      chunkId: 'chunk-1',
      audioStartMs: spoken.startMs,
      audioEndMs: spoken.endMs,
      takePassId: harness.orchestrator.hostState().takePassId,
      trackingEpoch: harness.orchestrator.hostState().trackingEpoch,
      commitSequence: spoken.item.commitSequence,
      text: 'so we should start with the second section',
    };
    harness.orchestrator.notePrecisionResult(precision, authoredSpan(null));
    harness.silence(400);
    harness.orchestrator.tick();

    const after = harness.latest();
    expect(after?.fillers.confirmedCount).toBe(counted - 1);
    // §10.4 / §2.4: the tick is replaced in place rather than appearing twice,
    // and a rejected detection is not drawn at all.
    const ticks = after?.ribbonEvents.filter((event) => event.type === 'confirmed_filler') ?? [];
    expect(ticks.length).toBe(0);
  });

  it('cancels the tip built on an "um" when that "um" is revised away (§26.5)', () => {
    const harness = new TakeHarness();
    // §16.7: never a tip for one isolated filler. Three inside twenty seconds
    // is the `filler_cluster` pattern.
    const first = harness.say('um we should start here', 2_000);
    harness.say('um the next part matters', 2_000);
    harness.say('um and then we finish', 2_000);

    const shown = harness.latest();
    expect(shown?.activeTip).not.toBeNull();
    expect(shown?.activeTip?.code).toBe('USE_SILENT_PAUSE');
    expect(shown?.fillers.confirmedCount).toBe(3);

    // The demotion channel: the tracker stops believing one contributing
    // event, the registry invalidates the candidate that aggregated it, and the
    // policy cancels the tip resting on it. Break any of the three and the
    // count below still corrects while the tip stays on the glass — which is
    // precisely the failure §26.5 describes.
    harness.orchestrator.notePrecisionResult(
      {
        chunkId: 'chunk-1',
        audioStartMs: first.startMs,
        audioEndMs: first.endMs,
        takePassId: harness.orchestrator.hostState().takePassId,
        trackingEpoch: harness.orchestrator.hostState().trackingEpoch,
        commitSequence: first.item.commitSequence,
        text: 'we should start here',
      },
      authoredSpan(null),
    );
    harness.settle(400);

    const corrected = harness.latest();
    expect(corrected?.fillers.confirmedCount).toBe(2);
    expect(corrected?.activeTip).toBeNull();
  });

  it('keeps the filler count across a tracking-epoch change while dropping the coaching state (§5.4, §20.5)', () => {
    const harness = new TakeHarness();
    // §16.7's `filler_cluster` pattern: three inside twenty seconds.
    harness.say('um we should start here', 2_000);
    harness.say('um the next part matters', 2_000);
    harness.say('um and then we finish', 2_000);

    const before = harness.latest();
    expect(before?.fillers.confirmedCount).toBe(3);
    expect(before?.activeTip?.code).toBe('USE_SILENT_PAUSE');
    expect(harness.orchestrator.telemetry().activeCandidates.length).toBeGreaterThan(0);

    // "Go to the conclusion." The presenter's position was re-established
    // inside the same take pass — they did not start a new take.
    harness.orchestrator.setHostState({ trackingEpoch: 1 });

    // Everything the epoch bump is *supposed* to invalidate is gone, before a
    // single further aggregation pass runs.
    const lanes = harness.orchestrator.laneBundle();
    expect(lanes.policy.getActiveTip()).toBeNull();
    expect(harness.orchestrator.telemetry().activeCandidates).toEqual([]);

    // …and the presenter's cumulative total is untouched, on the lane and on
    // the glass. Routing this through `setTake` put both at zero.
    expect(lanes.fillers.events().filter((event) => event.confidence === 'confirmed')).toHaveLength(
      3,
    );
    harness.settle(400);
    expect(harness.latest()?.fillers.confirmedCount).toBe(3);
  });

  it('zeroes the count on a new take pass, which an epoch change is not (§11.3)', () => {
    const harness = new TakeHarness();
    harness.say('um we should start here', 2_000);
    harness.say('um the next part matters', 2_000);
    expect(harness.latest()?.fillers.confirmedCount).toBe(2);

    // A genuinely new performance. Nothing crosses the boundary.
    harness.orchestrator.beginTakePass(2, harness.audioMs);
    harness.settle(400);
    harness.orchestrator.tick();
    expect(harness.latest()?.fillers.confirmedCount).toBe(0);
  });

  it('feeds the VAD watermark every frame, so a filler outside speech is not confirmed', () => {
    const harness = new TakeHarness();
    // Speak, then a long silence the VAD scans and reports as silent, then a
    // commit whose interval lands *in* that silence — the shape of a
    // hallucinated "um" in an endpoint tail.
    harness.speak(4_000);
    harness.silence(4_000);
    const startMs = harness.audioMs - 2_000;
    harness.orchestrator.noteFinalTranscript(
      {
        itemId: 'ghost',
        commitSequence: 9,
        audioStartMs: startMs,
        audioEndMs: startMs + 300,
        text: 'um',
      },
      authoredSpan(null),
    );
    harness.silence(400);
    harness.orchestrator.tick();

    // Without `noteVadObservedThrough` on every frame the watermark would sit at
    // the end of the last *closed run*, `hasCredibleTiming` would take its
    // permissive branch, and this would confirm and then flicker back down.
    expect(harness.latest()?.fillers.confirmedCount).toBe(0);
  });
});
