/**
 * Composition tests: two or more coaching lanes wired together the way an
 * integrator has to wire them.
 *
 * Every lane in this subsystem has its own suite and every one of them passed
 * while the seams between them were broken — a token id in a span field, a
 * hardware alert with no producer, an alert that could be shown exactly once
 * per take. Per-lane tests cannot see any of that, because each lane is
 * individually correct. These tests use **producer-shaped data**: the
 * candidates come out of the real generators, not out of a fixture that happens
 * to use consistent id namespaces on both sides of a comparison.
 */
import { describe, expect, it } from 'vitest';

import type { AudioFrameFeatures, CoachCandidate } from '../../../../src/shared/contracts/coaching';
import {
  CoachCandidateRegistry,
  CoachTipPolicy,
  type CoachPolicyContext,
} from '../../../../src/shared/coaching/coach';
import {
  MicrophoneCandidateSource,
  MicrophoneHealthMonitor,
} from '../../../../src/shared/coaching/audio';
import { FillerTracker } from '../../../../src/shared/coaching/disfluency';
import { SpeechClock as VadSpeechClock } from '../../../../src/shared/coaching/audio/vad';
import { SpeechClock as PaceSpeechClock } from '../../../../src/shared/coaching/pace/speech-clock';
import { PaceAnalyzer } from '../../../../src/shared/coaching/pace/pace-analyzer';
import type { CoachClockContext } from '../../../../src/shared/coaching/pace/speech-clock';
import type { SpokenSegment, SpokenWord } from '../../../../src/shared/coaching/pace/token-timing';

const FRAME_MS = 20;

function frame(audioTimeMs: number, speaking: boolean, overrides: Partial<AudioFrameFeatures> = {}): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: speaking ? -20 : -70,
    peakDbfs: speaking ? -10 : -60,
    clippingRatio: 0,
    noiseFloorDbfs: -70,
    estimatedSnrDb: speaking ? 25 : 0,
    speechProbability: speaking ? 0.9 : 0.02,
    voicedProbability: speaking ? 0.85 : 0,
    f0Hz: speaking ? 140 : null,
    f0Confidence: speaking ? 0.9 : 0,
    spectralFlux: 0,
    zeroCrossingRate: 0.05,
    processorDropout: false,
    ...overrides,
  };
}

function policyContext(overrides: Partial<CoachPolicyContext> = {}): CoachPolicyContext {
  return {
    audioTimeMs: 0,
    mode: 'coach',
    trackingEpoch: 1,
    takePassId: 'take-1',
    deliveryStyle: 'natural',
    liveTipFrequency: 'normal',
    coachingEnabled: true,
    liveTipsEnabled: true,
    positiveReinforcementEnabled: false,
    state: {
      alignmentConfidence: 0.9,
      commandActive: false,
      retakeState: 'none',
      reacquiring: false,
      microphoneHealthy: true,
    },
    safeMoment: true,
    activeScriptSpanId: null,
    ...overrides,
  };
}

/** Four strict "um"s in one final item, inside authored span `span-7`. */
function repeatedFillerCandidate(): CoachCandidate {
  const tracker = new FillerTracker({
    take: { takePassId: 'take-1', trackingEpoch: 1 },
    precisionEnabled: false,
  });
  tracker.observeFinalTranscript(
    {
      itemId: 'item-1',
      commitSequence: 1,
      audioStartMs: 0,
      audioEndMs: 8_000,
      text: 'um we um launch um the update um today',
    },
    { spanId: 'span-7', scriptAnchorTokenId: 'tok-42', text: 'we launch the update today' },
  );
  const found = tracker.candidates(9_000).find((c) => c.type === 'repeated_filler');
  expect(found, 'the disfluency lane must produce this candidate').toBeDefined();
  return found as CoachCandidate;
}

/* ---------------------------------------------------------------------------
 * Finding 1 — span ids and token ids are different namespaces
 * ------------------------------------------------------------------------- */

describe('disfluency lane → coach lane: span scope', () => {
  it('puts the authored span in the span field and the token in the token field', () => {
    const candidate = repeatedFillerCandidate();
    // The whole defect in one assertion: this used to be `'tok-42'`.
    expect(candidate.scriptSpanId).toBe('span-7');
    expect(candidate.scriptAnchorTokenId).toBe('tok-42');
  });

  it('§19.4: the `<!-- cc:coach off -->` opt-out actually rejects the candidate', () => {
    const candidate = repeatedFillerCandidate();
    const registry = new CoachCandidateRegistry();
    const admitted = registry.admit(candidate, 1, 'take-1', 9_000, {
      coachingDisabledSpanIds: new Set(['span-7']),
    });
    expect(admitted).toEqual({ ok: false, reason: 'coaching_disabled_span' });

    // …and a *different* span's opt-out does not, which is what proves the
    // rejection came from the comparison rather than from a blanket refusal.
    const other = new CoachCandidateRegistry();
    expect(
      other.admit(candidate, 1, 'take-1', 9_000, {
        coachingDisabledSpanIds: new Set(['span-3']),
      }),
    ).toEqual({ ok: true });
  });

  it('§26.5: a filler tip survives ticks while the presenter is on its span', () => {
    const candidate = repeatedFillerCandidate();
    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [{ candidate, source: 'local', filler: candidate.detailCode }],
      policyContext({ audioTimeMs: 9_000, activeScriptSpanId: 'span-7' }),
    );
    expect(outcome.displayed).toBe(true);

    // 100 ms later — the tick that used to cancel it, `minimumDisplayMs: 2500`
    // notwithstanding, because a token id can never equal a span id.
    policy.tick(policyContext({ audioTimeMs: 9_100, activeScriptSpanId: 'span-7' }));
    expect(policy.getActiveTip()).not.toBeNull();

    // Leaving the span still cancels it: the rule works, it was the comparison
    // that did not.
    policy.tick(policyContext({ audioTimeMs: 9_200, activeScriptSpanId: 'span-8' }));
    expect(policy.getActiveTip()).toBeNull();
  });
});

describe('fidelity lane → coach lane: a critical alert is not span-scoped', () => {
  const criticalCandidate: CoachCandidate = {
    evidenceId: 'fidelity:critical_number_mismatch:span-7:3:11000',
    type: 'critical_number_mismatch',
    localConfidence: 0.85,
    stamp: {
      audioStartMs: 11_000,
      audioEndMs: 12_000,
      commitSequence: 4,
      trackingEpoch: 1,
      takePassId: 'take-1',
    },
    scriptSpanId: 'span-7',
    scriptAnchorTokenId: null,
    contributingEventIds: [],
    detailCode: 'number_substituted',
    spokenFragment: 'fifty',
    authoredFragment: 'fifteen percent',
    finalEvidence: true,
  };

  /**
   * `fidelity/comparator.ts` requires `MIN_FINAL_TOKENS_AFTER` final tokens
   * past the window before it will emit anything, so by the time a priority-90
   * alert exists the presenter has demonstrably moved on — often across a span
   * boundary. Cancelling it for that reason meant the loudest alert on the rail
   * lived exactly one tick.
   */
  it('survives the presenter having already moved to the next span', () => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [{ candidate: criticalCandidate, source: 'local', authoredTerm: criticalCandidate.authoredFragment }],
      policyContext({ audioTimeMs: 13_000, activeScriptSpanId: 'span-8' }),
    );
    expect(outcome.displayed).toBe(true);

    policy.tick(policyContext({ audioTimeMs: 13_100, activeScriptSpanId: 'span-8' }));
    expect(policy.getActiveTip()?.code).toBe('CRITICAL_NUMBER');
    // Still up two seconds later, and three spans on.
    policy.tick(policyContext({ audioTimeMs: 15_000, activeScriptSpanId: 'span-11' }));
    expect(policy.getActiveTip()?.code).toBe('CRITICAL_NUMBER');
  });

  it('still retires on its own maximumDisplayMs', () => {
    const policy = new CoachTipPolicy();
    policy.propose(
      [{ candidate: criticalCandidate, source: 'local' }],
      policyContext({ audioTimeMs: 13_000, activeScriptSpanId: 'span-8' }),
    );
    // CRITICAL_NUMBER's window is 5 s. Exempting it from *scope* cancellation
    // must not turn it into a permanent alert.
    policy.tick(policyContext({ audioTimeMs: 18_100, activeScriptSpanId: 'span-8' }));
    expect(policy.getActiveTip()).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Findings 2 and 4 — the system band has a producer, and it can repeat
 * ------------------------------------------------------------------------- */

describe('audio lane → coach lane: microphone alerts', () => {
  /** Drives the health monitor with clipping frames until it goes sustained. */
  function clippingRun(source: MicrophoneCandidateSource, startMs: number, frames: number) {
    const monitor = new MicrophoneHealthMonitor();
    const out: CoachCandidate[] = [];
    for (let i = 0; i < frames; i += 1) {
      const at = startMs + i * FRAME_MS;
      const state = monitor.process(frame(at, true, { peakDbfs: -0.1, clippingRatio: 0.05 }), true);
      out.push(...source.update(state, { audioTimeMs: at, trackingEpoch: 1, takePassId: 'take-1' }));
    }
    return out;
  }

  it('§12.7.1: a single clipped frame raises nothing', () => {
    const monitor = new MicrophoneHealthMonitor();
    const source = new MicrophoneCandidateSource();
    // A second of clean audio so the monitor is past `learning`…
    for (let at = 0; at < 1_200; at += FRAME_MS) {
      monitor.process(frame(at, true), true);
    }
    const state = monitor.process(frame(1_200, true, { peakDbfs: -0.1, clippingRatio: 0.05 }), true);
    expect(state.status).not.toBe('clipping');
    expect(
      source.update(state, { audioTimeMs: 1_200, trackingEpoch: 1, takePassId: 'take-1' }),
    ).toEqual([]);
  });

  it('§12.7.1: a sustained clipping run produces exactly one candidate', () => {
    const source = new MicrophoneCandidateSource();
    const produced = clippingRun(source, 0, 500);
    const clipping = produced.filter((c) => c.type === 'system_mic_clipping');
    // One per episode, not one per frame: 500 frames, one candidate.
    expect(clipping).toHaveLength(1);
    expect(clipping[0]?.finalEvidence).toBe(true);
    // A hardware fault is not scoped to a sentence.
    expect(clipping[0]?.scriptSpanId).toBeNull();
  });

  it('reaches the rail as MIC_CLIPPING at the top priority band', () => {
    const source = new MicrophoneCandidateSource();
    const candidate = clippingRun(source, 0, 500).find((c) => c.type === 'system_mic_clipping');
    expect(candidate).toBeDefined();

    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [{ candidate: candidate as CoachCandidate, source: 'local' }],
      policyContext({ audioTimeMs: 10_000 }),
    );
    expect(outcome.displayed).toBe(true);
    expect(policy.getActiveTip()?.code).toBe('MIC_CLIPPING');
    expect(policy.getActiveTip()?.priority).toBeGreaterThanOrEqual(100);
  });

  /**
   * §25.1's fifteen-second cooldown only means something if the alert can be
   * raised twice. It could not: `MIC_CLIPPING` has no second wording, and §26.3
   * turned that into "once per take" — so clipping recurring five minutes into
   * a take showed nothing at all.
   */
  it('§25.1: clipping that recurs later in the take is shown again', () => {
    const source = new MicrophoneCandidateSource();
    const policy = new CoachTipPolicy();

    const first = clippingRun(source, 0, 500).find((c) => c.type === 'system_mic_clipping');
    expect(policy.propose([{ candidate: first as CoachCandidate, source: 'local' }], policyContext({ audioTimeMs: 10_000 })).displayed).toBe(true);

    // The alert retires at `maximumDisplayMs` (30 s) and the audio goes clean.
    policy.tick(policyContext({ audioTimeMs: 50_000 }));
    expect(policy.getActiveTip()).toBeNull();

    // Five minutes later, a *new* clipping episode — new evidence id.
    const second = clippingRun(source, 300_000, 500).find((c) => c.type === 'system_mic_clipping');
    expect(second).toBeDefined();
    expect(second?.evidenceId).not.toBe(first?.evidenceId);

    const outcome = policy.propose(
      [{ candidate: second as CoachCandidate, source: 'local' }],
      policyContext({ audioTimeMs: 310_000 }),
    );
    expect(outcome.rejected).toEqual([]);
    expect(outcome.displayed).toBe(true);
    expect(policy.getActiveTip()?.code).toBe('MIC_CLIPPING');
  });

  it('§25.1: device loss reaches the rail as MIC_DISCONNECTED', () => {
    const monitor = new MicrophoneHealthMonitor();
    const source = new MicrophoneCandidateSource();
    monitor.setDisconnected(true);
    const state = monitor.process(frame(5_000, false), false);
    expect(state.status).toBe('disconnected');

    const produced = source.update(state, {
      audioTimeMs: 5_000,
      trackingEpoch: 1,
      takePassId: 'take-1',
    });
    expect(produced.map((c) => c.type)).toEqual(['system_mic_disconnected']);

    const policy = new CoachTipPolicy();
    policy.propose(
      [{ candidate: produced[0] as CoachCandidate, source: 'local' }],
      policyContext({ audioTimeMs: 5_000 }),
    );
    expect(policy.getActiveTip()?.code).toBe('MIC_DISCONNECTED');
  });

  it('§6.2: minimal mode still admits the microphone alerts', () => {
    const source = new MicrophoneCandidateSource();
    const candidate = clippingRun(source, 0, 500).find((c) => c.type === 'system_mic_clipping');
    const policy = new CoachTipPolicy();
    policy.propose(
      [{ candidate: candidate as CoachCandidate, source: 'local' }],
      policyContext({ audioTimeMs: 10_000, mode: 'minimal' }),
    );
    expect(policy.getActiveTip()?.code).toBe('MIC_CLIPPING');
  });
});

/* ---------------------------------------------------------------------------
 * Finding 6 — the evidence-invalidation channel, end to end
 * ------------------------------------------------------------------------- */

describe('disfluency demotion → registry → policy cancellation', () => {
  it('§26.5: a tip comes down when the event under it is revised away', () => {
    const candidate = repeatedFillerCandidate();
    expect(candidate.contributingEventIds.length).toBeGreaterThan(0);

    const registry = new CoachCandidateRegistry();
    expect(registry.admit(candidate, 1, 'take-1', 9_000)).toEqual({ ok: true });

    const policy = new CoachTipPolicy();
    policy.propose(
      [{ candidate, source: 'local', filler: candidate.detailCode }],
      policyContext({ audioTimeMs: 9_000, activeScriptSpanId: 'span-7' }),
    );
    expect(policy.getActiveTip()).not.toBeNull();

    // A precision transcript revises one of the "um"s away. The integrator's
    // loop, verbatim from `FillerTracker.drainRevisedEventIds`'s doc comment:
    const demotedEventId = candidate.contributingEventIds[0] as string;
    const affected = registry.invalidateByContributingEvent(demotedEventId, 'revised_away');
    expect(affected).toEqual([candidate.evidenceId]);
    for (const evidenceId of affected) {
      policy.cancel('evidence_revised', { evidenceId });
    }

    expect(policy.getActiveTip()).toBeNull();
    expect(registry.invalidatedIds().has(candidate.evidenceId)).toBe(true);
    // §23.1 consumes the same set, so a Luna answer citing it is now rejected.
    expect(registry.active(1, 'take-1')).toEqual([]);
  });

  it('leaves a tip resting on different evidence alone', () => {
    const candidate = repeatedFillerCandidate();
    const registry = new CoachCandidateRegistry();
    registry.admit(candidate, 1, 'take-1', 9_000);
    const policy = new CoachTipPolicy();
    policy.propose(
      [{ candidate, source: 'local', filler: candidate.detailCode }],
      policyContext({ audioTimeMs: 9_000, activeScriptSpanId: 'span-7' }),
    );

    expect(registry.invalidateByContributingEvent('fil_not_a_real_event', 'revised_away')).toEqual([]);
    policy.cancel('evidence_revised', { evidenceId: 'fil_not_a_real_event' });
    expect(policy.getActiveTip()).not.toBeNull();
  });

  it('the tracker reports every demotion path through one drain', () => {
    const tracker = new FillerTracker({
      take: { takePassId: 'take-1', trackingEpoch: 1 },
      precisionEnabled: false,
    });
    const created = tracker.observeFinalTranscript(
      {
        itemId: 'item-1',
        commitSequence: 1,
        audioStartMs: 0,
        audioEndMs: 4_000,
        text: 'um we launch today',
      },
      { spanId: 'span-7', scriptAnchorTokenId: 'tok-42', text: 'we launch today' },
    );
    expect(created.length).toBeGreaterThan(0);
    // Nothing has been revised yet.
    expect(tracker.drainRevisedEventIds()).toEqual([]);

    const eventId = created[0]?.eventId as string;
    expect(tracker.applyLunaVerdict(eventId, 'rejected')).toBe(true);
    expect(tracker.drainRevisedEventIds()).toEqual([eventId]);
    // Drained, not accumulated.
    expect(tracker.drainRevisedEventIds()).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * Finding 7 — fluent speech must not starve the pace tile
 * ------------------------------------------------------------------------- */

describe('audio lane → pace lane: a gapless monologue', () => {
  function words(n: number): SpokenWord[] {
    return Array.from({ length: n }, (_, i) => ({
      text: 'delivery',
      excluded: false,
      confirmedFiller: false,
      repetition: false,
      ...(i === n - 1 ? { endsSentence: true } : {}),
    }));
  }

  /**
   * Thirty seconds of unbroken speech with a final commit every five seconds.
   * The VAD never closes a run — there is no ≥250 ms gap to close it on — so
   * with closed intervals as the only evidence source the §14.4 floor was never
   * reached and the tile read `learning` / `wpm: null` the whole way through.
   * The best speakers got the least telemetry.
   */
  it('shows a number rather than starving to `learning`', () => {
    const vad = new VadSpeechClock({ takePassId: 'take-1' });
    const clock = new PaceSpeechClock();
    clock.start(0);
    const analyzer = new PaceAnalyzer({ style: 'natural' });
    const context = (nowMs: number): CoachClockContext => ({
      audioTimeMs: nowMs,
      trackingEpoch: 1,
      takePassId: 'take-1',
      commitSequence: null,
    });

    let nextCommitAt = 5_000;
    let commit = 0;
    for (let t = 0; t < 30_000; t += FRAME_MS) {
      const f = frame(t, true);
      clock.noteFrame(f);
      const closed = vad.process(f);
      if (closed !== null) clock.noteSpeechInterval(closed.interval);
      if (t >= nextCommitAt) {
        const segment: SpokenSegment = {
          segmentId: `seg-${commit}`,
          words: words(12),
          audioStartMs: nextCommitAt - 5_000,
          audioEndMs: nextCommitAt,
          final: true,
          commitSequence: commit,
          takePassId: 'take-1',
          confidence: 0.9,
        };
        analyzer.ingestSegment(segment, clock, context(t));
        commit += 1;
        nextCommitAt += 5_000;
      }
    }

    // Closed-interval accounting is untouched — the VAD really has closed
    // nothing — and the provisional evidence sits beside it.
    const snapshot = clock.snapshot();
    expect(snapshot.voicedMs).toBe(0);
    expect(snapshot.openVoicedMs).toBeGreaterThan(25_000);

    const result = analyzer.update(clock, { context: context(29_980) });
    expect(result.display.state).not.toBe('learning');
    expect(result.display.wpm).not.toBeNull();
    // ~12 words per 5 s = ~144 wpm. A wild number would mean the evidence is
    // being counted twice or in the wrong units.
    expect(result.display.wpm as number).toBeGreaterThan(100);
    expect(result.display.wpm as number).toBeLessThan(200);
  });

  it('does not double-count when the run finally closes', () => {
    const vad = new VadSpeechClock({ takePassId: 'take-1' });
    const clock = new PaceSpeechClock();
    clock.start(0);
    // 10 s of speech, then enough silence for the VAD to close the run.
    for (let t = 0; t < 10_000; t += FRAME_MS) {
      const f = frame(t, true);
      clock.noteFrame(f);
      const closed = vad.process(f);
      if (closed !== null) clock.noteSpeechInterval(closed.interval);
    }
    const beforeClose = clock.voicedMsIn(0, 10_000);
    expect(beforeClose).toBeGreaterThan(9_000);

    for (let t = 10_000; t < 12_000; t += FRAME_MS) {
      const f = frame(t, false);
      clock.noteFrame(f);
      const closed = vad.process(f);
      if (closed !== null) clock.noteSpeechInterval(closed.interval);
    }
    // The closed interval replaces the provisional evidence; it does not add
    // to it. Anything near 20 000 would be the double count.
    expect(clock.snapshot().openVoicedMs).toBe(0);
    expect(clock.voicedMsIn(0, 12_000)).toBeLessThan(beforeClose * 1.25);
    expect(clock.voicedMsIn(0, 12_000)).toBeGreaterThan(beforeClose * 0.75);
  });
});

/* ---------------------------------------------------------------------------
 * Finding 12 — the configured trigger count is the count that fires
 * ------------------------------------------------------------------------- */

describe('disfluency lane → coach lane: the repeated-filler threshold', () => {
  const AUTHORED = 'we launch the update today for every customer';
  /**
   * `count` "um"s scattered through one final item. The carrier words differ
   * so the repetition detector does not claim the phrase as a false start,
   * which would consume the fillers before they were counted.
   */
  function trackerWith(count: number) {
    const tracker = new FillerTracker({
      take: { takePassId: 'take-1', trackingEpoch: 1 },
      precisionEnabled: false,
    });
    const carriers = ['we launch', 'the update', 'today for', 'every customer'];
    const text = carriers
      .slice(0, count)
      .map((carrier) => `um ${carrier}`)
      .join(' ');
    tracker.observeFinalTranscript(
      { itemId: 'item-1', commitSequence: 1, audioStartMs: 0, audioEndMs: 8_000, text },
      { spanId: 'span-7', scriptAnchorTokenId: 'tok-42', text: AUTHORED },
    );
    return tracker;
  }

  /**
   * `sameStrictFillerCount` is 3, and at exactly three the candidate scored
   * 0.55 against `REPEATED_FILLER`'s 0.60 floor — so the policy rejected it
   * every time and the knob quietly meant "four". A configured count must be
   * the count the presenter actually experiences.
   */
  it('the third "um" produces a candidate the policy accepts', () => {
    const candidates = trackerWith(3).candidates(9_000);
    const repeated = candidates.find((c) => c.type === 'repeated_filler');
    expect(repeated, 'three "um"s must reach the configured trigger').toBeDefined();

    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [{ candidate: repeated as CoachCandidate, source: 'local', filler: (repeated as CoachCandidate).detailCode }],
      policyContext({ audioTimeMs: 9_000, activeScriptSpanId: 'span-7' }),
    );
    expect(outcome.rejected).toEqual([]);
    expect(outcome.displayed).toBe(true);
    expect(policy.getActiveTip()?.code).toBe('REPEATED_FILLER');
  });

  it('the second "um" still produces nothing', () => {
    const candidates = trackerWith(2).candidates(9_000);
    expect(candidates.find((c) => c.type === 'repeated_filler')).toBeUndefined();
  });
});
