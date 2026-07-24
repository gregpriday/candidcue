/**
 * Failure modes that survive normal operation and only bite mid-take.
 *
 * Everything here was demonstrated against the previous implementation before
 * being fixed; each test names the specific way the engine used to break.
 */
import { describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { DocumentIndex } from '../../../src/shared/tracking/document-index';
import { generateCandidates } from '../../../src/shared/tracking/candidates';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import { SemanticFilter } from '../../../src/shared/tracking/semantic-filter';
import { SectionGraph } from '../../../src/shared/tracking/section-graph';
import { SemanticFrameEmitter } from '../../../src/shared/tracking/motion-frame';
import {
  DEFAULT_TRACKING_PROFILE,
  resolveSmoothFollowProfile,
} from '../../../src/shared/tracking/profile';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

function engine(id: string): AlignmentEngine {
  return new AlignmentEngine(demoDocument(), {
    sessionId: id,
    sessionGeneration: 1,
    stageGeneration: 1,
    layoutGeneration: 1,
  });
}

function speak(e: AlignmentEngine, s: TranscriptScripter, text: string): void {
  for (const event of s.speak({ text })) e.handleTranscriptEvent(event);
}

/* ------------------------------------------------------------------------- */

describe('COMMAND_PENDING is a bounded freeze (§33.4.4, §33.11)', () => {
  /**
   * `handleTranscriptEvent` returns `{}` for every event while pending and
   * `command_pending` is an identity state for the filter, so nothing
   * integrates. Nothing in the pipeline timed the freeze out: the Luna branch
   * awaited an `ipcInvoke` with no timeout and never cleared the flag, so a
   * hung handler froze the teleprompter for the rest of the take.
   */
  it('releases itself once the timeout lapses and follows again', () => {
    const e = engine('freeze');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    const acquired = e.cursor.committedTokenIndex;
    expect(acquired).toBeGreaterThan(0);

    e.setCommandPending(true, s.clockMs);
    // Nothing moves while pending — that part is by design.
    speak(e, s, 'Today we are talking about building a teleprompter that actually listens.');
    expect(e.cursor.committedTokenIndex).toBe(acquired);

    // …but the freeze must not outlive its budget, even though nobody ever
    // called setCommandPending(false).
    const past = s.clockMs + DEFAULT_TRACKING_PROFILE.commandPendingTimeoutMs + 1;
    e.tick(past);
    s.advance(DEFAULT_TRACKING_PROFILE.commandPendingTimeoutMs + 2_000);
    speak(e, s, "Let's get started with the basics right away.");
    expect(e.cursor.committedTokenIndex).toBeGreaterThan(acquired);
  });

  it('expires on transcript alone when no animation tick ever arrives', () => {
    const e = engine('freeze-no-tick');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    const acquired = e.cursor.committedTokenIndex;
    e.setCommandPending(true, s.clockMs);
    s.advance(DEFAULT_TRACKING_PROFILE.commandPendingTimeoutMs + 2_000);
    speak(e, s, 'Today we are talking about building a teleprompter that actually listens.');
    speak(e, s, "Let's get started with the basics right away.");
    expect(e.cursor.committedTokenIndex).toBeGreaterThan(acquired);
  });
});

describe('command speech does not contaminate the pace estimate (§24.4)', () => {
  /**
   * `lastPaceSpan` was reset only by `moveTo`. After a long non-navigating
   * command the next span measured script units covered against a duration
   * that included the command utterance — a rate that clears the 0.4 floor,
   * so it was accepted, and halves blended pace. `PaceSampleRejection` already
   * declared a `'command_speech'` member that nothing in src/ ever emitted.
   */
  it('flags the first span after a command as command_speech', () => {
    const e = engine('pace-command');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    speak(e, s, 'Today we are talking about building a teleprompter that actually listens.');
    expect(e.paceRejection).toBeUndefined(); // clean reading so far

    e.setCommandPending(true, s.clockMs);
    s.advance(6_000);
    e.setCommandPending(false, s.clockMs);

    speak(e, s, "Let's get started with the basics right away.");
    expect(e.paceRejection).toBe('command_speech');
  });

  it('the same flag fires when the command channel masks items directly', () => {
    const e = engine('pace-mask');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    speak(e, s, 'Today we are talking about building a teleprompter that actually listens.');
    e.maskItems(['item-1-2']);
    s.advance(6_000);
    speak(e, s, "Let's get started with the basics right away.");
    expect(e.paceRejection).toBe('command_speech');
  });

  it('a contaminated span does not become the pace estimate', () => {
    const contaminated = engine('pace-dirty');
    const clean = engine('pace-clean');
    const s1 = new TranscriptScripter(10_000, 1);
    const s2 = new TranscriptScripter(10_000, 1);
    const turns = [
      'Hello everyone and welcome to the channel.',
      'Today we are talking about building a teleprompter that actually listens.',
      "Let's get started with the basics right away.",
      'The first principle is that the prompter follows you instead of forcing you to follow it.',
      'When you pause the prompter pauses.',
    ];
    turns.slice(0, 2).forEach((t) => {
      speak(contaminated, s1, t);
      speak(clean, s2, t);
    });
    contaminated.setCommandPending(true, s1.clockMs);
    s1.advance(6_000);
    contaminated.setCommandPending(false, s1.clockMs);
    turns.slice(2).forEach((t) => {
      speak(contaminated, s1, t);
      speak(clean, s2, t);
    });

    const dirty = contaminated.paceEstimator.estimate(s1.clockMs).blendedUnitsPerSecond;
    const baseline = clean.paceEstimator.estimate(s2.clockMs).blendedUnitsPerSecond;
    expect(baseline).toBeGreaterThan(0);
    // Without the rejection the six-second detour halved the estimate.
    expect(dirty).toBeGreaterThan(baseline * 0.7);
  });
});

describe('the innovation clamp is not lifted for a whole time window (§24.2, B.3)', () => {
  /**
   * REANCHORING/REWINDING returned an infinite clamp because "the transition
   * already authorized the discontinuity". But those states are derived from
   * `directives.activeType(now)`, and a directive lives `transitionTtlMs`
   * (1.5 s) — so for a second and a half after every command, every manual
   * move and every ordinary retake, unrelated ordinary *and provisional*
   * measurements fused unclamped.
   */
  const smooth = resolveSmoothFollowProfile();

  function fuse(state: 'following' | 'reanchoring', authorized: boolean): number {
    const filter = new SemanticFilter(DEFAULT_TRACKING_PROFILE, smooth);
    filter.resetTo(100, 0, 1, state);
    filter.setState(state);
    filter.observe({
      positionUnits: 400,
      confidence: 0.4,
      margin: 0.1,
      beamVariance: 0,
      finalEvidence: authorized,
      ...(authorized ? { authorizedDiscontinuity: true } : {}),
      atMs: 100,
    });
    return filter.estimate().positionUnits;
  }

  it('an unauthorized observation stays clamped in reanchoring', () => {
    const clamp = DEFAULT_TRACKING_PROFILE.filterInnovationClampUnits;
    const following = fuse('following', false);
    const reanchoring = fuse('reanchoring', false);
    // Previously: following 100.59, reanchoring 117.22 for the identical
    // observation. The residual difference now is process noise (`Q` is larger
    // while reanchoring), not an unclamped fusion.
    expect(reanchoring).toBeLessThanOrEqual(100 + clamp);
    expect(Math.abs(reanchoring - following)).toBeLessThan(1);
  });

  it('only the observation that IS the authorized destination fuses unclamped', () => {
    expect(fuse('reanchoring', true)).toBeGreaterThan(fuse('reanchoring', false));
  });

  /**
   * …and the lift may not depend on the state, because the state can never be
   * right when it matters. `applyDecision` feeds the committed retake to the
   * filter (`observeCommittedPosition`) *before* `emit` mints the directive
   * that REANCHORING/REWINDING are projected from, so the one observation
   * carrying `authorizedDiscontinuity` always arrived while the filter was
   * still FOLLOWING. The lift whose doc comment described exactly this case
   * could therefore never fire, and the measurement was clamped like any
   * other.
   */
  it('the authorized destination fuses from FOLLOWING too — the state is never right in time', () => {
    const clamp = DEFAULT_TRACKING_PROFILE.filterInnovationClampUnits;
    const filter = new SemanticFilter(DEFAULT_TRACKING_PROFILE, smooth);
    filter.resetTo(100, 0, 1, 'following');
    filter.observe({
      positionUnits: 40, // a committed retake, 60 units back
      confidence: 0.95,
      margin: 1,
      // The beam is bimodal at exactly this moment, so `measurementVariance`
      // used to distrust the measurement most when it was most authoritative
      // (measured Kalman gain ≈ 0.036). An authorized destination is not
      // weighed at all now, so beam variance cannot hold it back either.
      beamVariance: 900,
      finalEvidence: true,
      authorizedDiscontinuity: true,
      atMs: 100,
    });
    expect(filter.estimate().positionUnits).toBeCloseTo(40, 6);
    // The trajectory belonged to the superseded take; it does not survive.
    expect(filter.estimate().velocityUnitsPerSecond).toBe(0);
    // Sanity: without the authorization the same observation stays clamped.
    const ordinary = new SemanticFilter(DEFAULT_TRACKING_PROFILE, smooth);
    ordinary.resetTo(100, 0, 1, 'following');
    ordinary.observe({
      positionUnits: 40,
      confidence: 0.95,
      margin: 1,
      beamVariance: 900,
      finalEvidence: true,
      atMs: 100,
    });
    expect(ordinary.estimate().positionUnits).toBeGreaterThan(100 - clamp - 1e-9);
  });

  /**
   * End to end: the quantity that actually reaches the stage is the frame, and
   * before the fix it carried `committedUnit 17.5` against `estimatedUnit ≈
   * 45.8` after a committed retake — a 28-unit gap, roughly three rendered
   * lines. It closed only if the presenter kept talking through the
   * directive's 1.5 s TTL; one who pauses after "let me take that again" was
   * left with the trajectory pointing at the abandoned position.
   */
  it('a committed retake leaves the trajectory at the retake destination', () => {
    const engine = new AlignmentEngine(demoDocument(), {
      sessionId: 'retake-anchor',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);
    for (const text of [
      'Hello everyone and welcome to the channel.',
      'Today we are talking about building a teleprompter that actually listens.',
      "Let's get started with the basics right away.",
      'The first principle is that the prompter follows you instead of forcing you to follow it.',
    ]) {
      for (const event of scripter.speak({ text })) engine.handleTranscriptEvent(event);
    }
    const deep = engine.cursor.committedTokenIndex;

    // The presenter restarts from the very top.
    for (const event of scripter.speak({
      text: 'Hello everyone and welcome to the channel today we are talking about building a teleprompter.',
    })) {
      engine.handleTranscriptEvent(event);
    }
    const committed = engine.cursor.committedTokenIndex;
    expect(committed).toBeLessThan(deep); // the retake really committed

    const gap = Math.abs(
      engine.filter.estimate().positionUnits - engine.units.unitAt(committed),
    );
    expect(gap).toBeLessThan(1);
  });
});

describe('the filter cannot latch a non-finite position (§24.2.1)', () => {
  /**
   * DEFENSIVE, and honestly so: this test passes without the fix.
   *
   * `observe` assigned `anchorUnits = this.position` *before*
   * `applyConstraints`, and `applyConstraints` restores a non-finite position
   * *from* `anchorUnits` — so a non-finite position would have made the
   * fallback the very value it exists to replace, permanently. No live path
   * reaches that state today (`observe` already runs the incoming measurement
   * through `finite()`, and the velocity/acceleration clamps keep `integrate`
   * bounded), so the ordering fix removes a latent latch rather than a
   * reproducible bug. The test pins the invariant so a future caller that
   * bypasses the sanitizer is caught here instead of mid-take.
   */
  it('a NaN measurement leaves the estimate finite and the anchor usable', () => {
    const filter = new SemanticFilter(DEFAULT_TRACKING_PROFILE, resolveSmoothFollowProfile());
    filter.resetTo(50, 0, 1, 'following');
    filter.observe({
      positionUnits: Number.NaN,
      confidence: 0.9,
      margin: 0.5,
      beamVariance: 0,
      finalEvidence: true,
      atMs: 100,
    });
    expect(Number.isFinite(filter.estimate().positionUnits)).toBe(true);
    expect(Number.isFinite(filter.committedAnchorUnits)).toBe(true);

    // …and the filter still tracks afterwards rather than being dead.
    filter.observe({
      positionUnits: 56,
      confidence: 0.9,
      margin: 0.5,
      beamVariance: 0,
      finalEvidence: true,
      atMs: 200,
    });
    expect(filter.estimate().positionUnits).toBeGreaterThan(50);
  });
});

describe('every frame number is finite (§26.1)', () => {
  /**
   * `emit` sanitized six fields and passed the rest through. A NaN
   * `layoutGeneration` is the dangerous one: the engine's latch is
   * `generation === this.layoutGeneration`, which is never true for NaN, so it
   * stuck permanently — and every stale-frame comparison on the stage silently
   * became false.
   */
  it('a non-finite layout generation is rejected at the engine boundary', () => {
    const e = engine('layout-nan');
    e.setLayoutGeneration(Number.NaN, 1_000);
    const frame = e.tick(1_100).frame ?? e.setLayoutGeneration(2, 1_200).frame;
    expect(frame).toBeDefined();
    expect(Number.isFinite(frame?.layoutGeneration ?? Number.NaN)).toBe(true);
  });

  it('the emitter sanitizes identity fields and the transition payload', () => {
    const emitter = new SemanticFrameEmitter(DEFAULT_TRACKING_PROFILE, resolveSmoothFollowProfile());
    const frame = emitter.emit({
      sessionId: 's',
      sessionGeneration: Number.NaN,
      scriptCompileHash: 'h',
      layoutGeneration: Number.NaN,
      epoch: Number.NaN,
      sessionTimeMs: Number.NaN,
      estimatedUnit: 1,
      committedUnit: 1,
      velocityUnitsPerSecond: 0,
      accelerationUnitsPerSecond2: 0,
      positionVariance: 0,
      confidence: 0.5,
      sectionId: 'h0',
      tokenIndex: 0,
      sentenceId: 's0',
      blockId: 'b0',
      state: 'following',
      behavior: 'normal',
      finalEvidence: true,
      transition: {
        id: 'td-1',
        type: 'reanchor',
        authority: 'ordinary',
        fromUnit: Number.NaN,
        toUnit: Number.POSITIVE_INFINITY,
        destinationTokenIndex: Number.NaN,
        issuedAtMs: Number.NaN,
        expiresAtMs: Number.NaN,
        semanticEpoch: Number.NaN,
        reason: 'large_forward_skip',
      },
      motionProfileId: 'm',
    });
    for (const value of [
      frame.sessionGeneration,
      frame.layoutGeneration,
      frame.epoch,
      frame.sessionTimeMs,
      frame.transition?.fromUnit,
      frame.transition?.toUnit,
      frame.transition?.destinationTokenIndex,
      frame.transition?.issuedAtMs,
      frame.transition?.expiresAtMs,
      frame.transition?.semanticEpoch,
    ]) {
      expect(Number.isFinite(value ?? Number.NaN)).toBe(true);
    }
  });
});

describe('bounded buffers (§30.3, §33.4)', () => {
  it('the ledger anomaly log is capped', () => {
    const ledger = new TranscriptLedger();
    ledger.setSessionGeneration(5);
    for (let i = 0; i < 5_000; i++) {
      ledger.apply({
        type: 'completed',
        sessionGeneration: 1, // stale generation → one anomaly per event
        itemId: `stale-${i}`,
        text: 'hello',
        receivedAtMs: 1_000 + i,
      });
    }
    expect(ledger.recordedAnomalies().length).toBeLessThanOrEqual(200);
  });

  it('masked item ids do not grow monotonically for the whole session', () => {
    // §33.4: every spurious wake adds ids to `maskedItemIds`, which was never
    // pruned — not even once the ledger had dropped the item past its 180 s
    // horizon. The set is consulted on every alignment pass.
    const e = engine('mask-growth');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    for (let i = 0; i < 500; i++) e.maskItems([`ghost-${i}`]);
    // None of those ids exists in the ledger, so none of them survives. Before
    // the fix the set held all 500 for the rest of the session.
    expect(e.maskedItemCount).toBeLessThan(64);
    e.releaseItems([]);
    expect(e.maskedItemCount).toBe(0);
  });
});

describe('session time never runs backwards (§26.1)', () => {
  /**
   * `tick` guarded only against earlier *ticks*; `lastEventAtMs` was never
   * updated by `handleTranscriptEvent`, so a tick timestamped before the last
   * transcript event emitted a frame whose `sessionTimeMs` went backwards.
   */
  it('a tick older than the last transcript event emits nothing', () => {
    const e = engine('monotone-time');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    const before = s.clockMs;
    expect(e.tick(before - 5_000).frame).toBeUndefined();
    const frame = e.tick(before + 100).frame;
    expect(frame?.sessionTimeMs ?? 0).toBeGreaterThanOrEqual(before);
  });
});

describe('§31.14 global reacquisition genuinely widens the search', () => {
  /**
   * `CandidateInput.globalSearch` was set by the engine and never read, so
   * SEARCHING searched exactly the space FOLLOWING searched.
   */
  it('globalSearch produces a materially different candidate set', () => {
    const document = demoDocument();
    const index = new DocumentIndex(document, {
      rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight,
    });
    const tail = [
      { itemId: 'i', indexInItem: 0, surface: 'kaleidoscope', normalized: 'kaleidoscope', final: true, filler: false, content: true },
      { itemId: 'i', indexInItem: 1, surface: 'metronome', normalized: 'metronome', final: true, filler: false, content: true },
    ];
    const base = { committedTokenIndex: 10, transcriptTail: tail, checkpoints: [] };
    const local = generateCandidates(index, { ...base, globalSearch: false }, DEFAULT_TRACKING_PROFILE);
    const global = generateCandidates(index, { ...base, globalSearch: true }, DEFAULT_TRACKING_PROFILE);

    const span = (windows: typeof local): number =>
      windows.reduce((sum, w) => sum + (w.endTokenIndex - w.startTokenIndex + 1), 0);
    expect(span(global)).toBeGreaterThan(span(local));
  });
});

describe('SectionGraph does not alias a mutable array (§13)', () => {
  it('mutating DocumentIndex.sections afterwards cannot reorder the gate', () => {
    const document = demoDocument();
    const index = new DocumentIndex(document, {
      rareWeight: DEFAULT_TRACKING_PROFILE.rareWeight,
    });
    const graph = new SectionGraph(index, DEFAULT_TRACKING_PROFILE);
    const nextBefore = graph.nextSectionId('h0');
    expect(nextBefore).toBe('h1');
    index.sections.splice(1, 1); // something else drops a section from the list
    expect(graph.nextSectionId('h0')).toBe(nextBefore);
  });
});

describe('evidence finality follows the tail, not the triggering event (§30.7)', () => {
  /**
   * `handleTranscriptEvent` passed `update.final` — the finality of whichever
   * event happened to arrive — into the alignment pass. Transcription
   * providers complete items out of order, so a late completion for an *older*
   * item marked the whole pass final while the tail's newest tokens were still
   * provisional deltas. Everything gated on finality then fired on
   * majority-provisional evidence: retake commits, large-skip commits, the low
   * final measurement noise, and `authorizedDiscontinuity`, which now
   * re-anchors the semantic filter outright.
   *
   * `tail.final` — the ledger's own newest-contributing-item status — existed
   * for exactly this and had zero consumers.
   */
  it('a late completion for an older item does not finalize a provisional tail', () => {
    const e = engine('ooo-finality');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');

    // Item A opens and streams; its completion is held back by the provider.
    const itemA = s.speak({
      text: 'Today we are talking about building a teleprompter that actually listens.',
    });
    for (const event of itemA) {
      if (event.type !== 'completed') e.handleTranscriptEvent(event);
    }
    // Item B opens behind it and is still streaming deltas.
    const itemB = s.speak({ text: "Let's get started with the basics" });
    for (const event of itemB) {
      if (event.type !== 'completed') e.handleTranscriptEvent(event);
    }
    expect(e.measurement?.finalEvidence).toBe(false);

    // A's completion finally lands, out of order. It finalizes *A*, but the
    // newest tokens in the tail are still B's provisional deltas, so this
    // alignment pass is not running on final evidence.
    const completionA = itemA.find((event) => event.type === 'completed');
    expect(completionA).toBeDefined();
    if (completionA === undefined) return;
    e.handleTranscriptEvent({ ...completionA, receivedAtMs: s.clockMs });

    expect(e.measurement?.finalEvidence).toBe(false);
  });
});

describe('§16.5 challenger hysteresis is real machinery, not a comment', () => {
  /**
   * `AlignmentMeasurement.challengerPersistence` was computed on every update
   * and consumed by nothing in `src/`; `retakePersistenceTokens` and
   * `retakePersistenceMs` in the smooth-follow profile were likewise read by
   * nothing. Commit-flap protection rested entirely on thresholds and softmax.
   * The counter was wrong too, which is why it mattered that nobody read it:
   * it re-added the *whole* 30-token rolling tail on every final event, so it
   * over-counted the same speech five to ten times over.
   */
  const say = (e: AlignmentEngine, s: TranscriptScripter, text: string): void => {
    for (const event of s.speak({ text })) e.handleTranscriptEvent(event);
  };
  const turns = [
    'Hello everyone and welcome to the channel.',
    'Today we are talking about building a teleprompter that actually listens.',
    "Let's get started with the basics right away.",
    'The first principle is that the prompter follows you instead of forcing you to follow it.',
    'When you pause the prompter pauses.',
  ];

  it('counts each transcript item once, not once per rolling-tail appearance', () => {
    const e = engine('challenger-count');
    const s = new TranscriptScripter(10_000, 1);
    let spokenMeaningful = 0;
    for (const text of turns) {
      say(e, s, text);
      // A generous upper bound on meaningful tokens: every word counts, even
      // the stopwords the ledger does not.
      spokenMeaningful += text.split(/\s+/).filter((w) => w.length > 0).length;
      // The counter can only ever describe speech that actually happened.
      expect(e.measurement?.challengerPersistence.finalTokens ?? 0).toBeLessThanOrEqual(
        spokenMeaningful,
      );
    }
  });

  it('a retake waits for the challenger to persist (`retakePersistence*`)', () => {
    const document = demoDocument();
    const session = {
      sessionId: 'challenger-gate',
      sessionGeneration: 1,
      stageGeneration: 1,
      layoutGeneration: 1,
    };
    const run = (smooth?: { alignment?: Record<string, number> }): AlignmentEngine => {
      const e = new AlignmentEngine(document, session, undefined, smooth as never);
      const s = new TranscriptScripter(10_000, 1);
      for (const text of turns) say(e, s, text);
      s.advance(1_200);
      // The previous sentence restarts — an ordinary retake.
      say(
        e,
        s,
        'The first principle is that the prompter follows you instead of forcing you to follow it',
      );
      return e;
    };

    const ordinary = run();
    const ordinaryRetakes = ordinary
      .decisionRecords()
      .filter((record) => record.behavior === 'retake').length;
    expect(ordinaryRetakes).toBeGreaterThan(0);

    // With a persistence requirement no single utterance can satisfy, the same
    // speech must not commit the backward move. If the profile fields were
    // still unread this would be identical to the run above.
    const gated = run({
      alignment: {
        retakePersistenceTokens: Number.MAX_SAFE_INTEGER,
        retakePersistenceMs: Number.MAX_SAFE_INTEGER,
      },
    });
    const gatedRetakes = gated.decisionRecords().filter((r) => r.behavior === 'retake').length;
    expect(gatedRetakes).toBe(0);
  });
});
