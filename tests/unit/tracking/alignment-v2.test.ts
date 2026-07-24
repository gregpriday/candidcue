/**
 * Multi-hypothesis beam, semantic-assist bounds, and the behavior projection
 * (companion §11–§16, §18–§23, §40, §52).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import {
  buildTails,
  mergeHypotheses,
  normalizeWeights,
  type AlignmentHypothesis,
} from '../../../src/shared/tracking/alignment-v2';
import { projectBehavior } from '../../../src/shared/tracking/behavior';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import {
  semanticAdjustment,
  isSemanticEvidenceCurrent,
  type SemanticAssistEvidence,
} from '../../../src/shared/tracking/semantic-assist';
import type { LedgerToken } from '../../../src/shared/tracking/types';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

const profile = DEFAULT_TRACKING_PROFILE;
const smooth = DEFAULT_SMOOTH_FOLLOW_PROFILE;

function engine(id = 'beam'): AlignmentEngine {
  return new AlignmentEngine(demoDocument(), {
    sessionId: id,
    sessionGeneration: 1,
    stageGeneration: 1,
  });
}

function speak(e: AlignmentEngine, s: TranscriptScripter, text: string): void {
  for (const event of s.speak({ text })) e.handleTranscriptEvent(event);
}

function token(normalized: string, content = true): LedgerToken {
  return {
    itemId: 'i',
    indexInItem: 0,
    surface: normalized,
    normalized,
    final: true,
    filler: false,
    content,
  };
}

function hypothesis(overrides: Partial<AlignmentHypothesis>): AlignmentHypothesis {
  return {
    id: 'h',
    lineageId: 'l',
    sectionId: 'h0',
    candidateId: 'continuity:0',
    scope: 'continuity',
    tokenPosition: 0,
    spokenUnitPosition: 0,
    velocityUnitsPerSecond: 0,
    mode: 'following',
    logScore: 0.5,
    weight: 0,
    lexicalScore: 0.5,
    phoneticScore: 0,
    sequenceScore: 1,
    semanticScore: 0,
    continuityPrior: 1,
    authority: 'ordinary',
    evidenceItemIds: [],
    matchedTokenIndexes: [],
    contentMatches: 3,
    rareAnchorMatches: 0,
    longestOrderedRun: 3,
    finalEvidence: true,
    lastStrongAnchorAtMs: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe('transcript tails (companion §15.2, A.2)', () => {
  it('produces short / medium / long meaningful-token tails', () => {
    const tokens: LedgerToken[] = [];
    for (let i = 0; i < 60; i++) tokens.push(token(`w${i}`));
    const tails = buildTails(tokens, profile);
    expect(tails).toHaveLength(3);
    expect(tails[0]?.length).toBe(profile.tailShortTokens);
    expect(tails[1]?.length).toBe(profile.tailMediumTokens);
    expect(tails[2]?.length).toBe(profile.tailLongTokens);
    // A longer tail always contains the shorter one — that containment is why
    // the beam scores *agreement* rather than summing tail scores.
    expect(tails[2]?.slice(-(tails[0]?.length ?? 0))).toEqual(tails[0]);
  });

  it('counts only meaningful tokens toward the tail length (§30.6)', () => {
    const tokens: LedgerToken[] = [];
    for (let i = 0; i < 12; i++) {
      tokens.push(token(`w${i}`));
      tokens.push(token('the', false));
    }
    const short = buildTails(tokens, profile)[0] ?? [];
    expect(short.filter((t) => t.content)).toHaveLength(profile.tailShortTokens);
    expect(short.length).toBeGreaterThan(profile.tailShortTokens);
  });

  it('deduplicates tails when the transcript is shorter than the windows', () => {
    const tails = buildTails([token('a'), token('b')], profile);
    expect(tails).toHaveLength(1);
  });
});

describe('beam maintenance (companion §16 steps 7–9)', () => {
  it('merges hypotheses describing the same position, keeping the best', () => {
    const merged = mergeHypotheses(
      [
        hypothesis({ id: 'a', tokenPosition: 40, logScore: 0.4 }),
        hypothesis({ id: 'b', tokenPosition: 42, logScore: 0.8 }),
        hypothesis({ id: 'c', tokenPosition: 90, logScore: 0.6 }),
      ],
      profile.beamMergeTokens,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe('b');
  });

  it('does not merge across a section boundary', () => {
    const merged = mergeHypotheses(
      [
        hypothesis({ id: 'a', tokenPosition: 61, sectionId: 'h0' }),
        hypothesis({ id: 'b', tokenPosition: 62, sectionId: 'h1' }),
      ],
      profile.beamMergeTokens,
    );
    expect(merged).toHaveLength(2);
  });

  it('normalizes weights into a probability distribution', () => {
    const beam = [
      hypothesis({ id: 'a', logScore: 0.9 }),
      hypothesis({ id: 'b', logScore: 0.6 }),
      hypothesis({ id: 'c', logScore: 0.3 }),
    ];
    normalizeWeights(beam, profile.hypothesisSoftmaxTemperature);
    const total = beam.reduce((sum, h) => sum + h.weight, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(beam[0]?.weight).toBeGreaterThan(beam[1]?.weight ?? 0);
    for (const h of beam) expect(Number.isFinite(h.weight)).toBe(true);
  });

  it('stays within the configured beam width during a real read', () => {
    const e = engine('width');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    speak(e, s, 'Today we are talking about building a teleprompter that actually listens.');
    expect(e.beam.current().length).toBeLessThanOrEqual(smooth.alignment.beamWidth);
    expect(e.beam.current().length).toBeGreaterThan(0);
  });

  it('always keeps a hold branch so speech alone cannot consume script (§16.2)', () => {
    const e = engine('hold-branch');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    expect(e.beam.current().some((h) => h.mode === 'holding')).toBe(true);
  });

  it('reports position variance in spoken units, not token indexes (§16.6)', () => {
    const e = engine('variance');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    const measurement = e.measurement;
    expect(measurement).toBeDefined();
    expect(Number.isFinite(measurement?.positionVariance ?? Number.NaN)).toBe(true);
    expect(measurement?.positionVariance).toBeGreaterThanOrEqual(0);
  });
});

describe('provisional-only evidence is inert for risky moves (§31.8 tightened, §15.3)', () => {
  /**
   * The previous version of this test inspected `committedTokenIndex` only.
   * The provisional branch never writes that field, so the assertion could not
   * fail whatever the provisional path did — it proved the branch was not
   * taken, not that the branch was safe. The interesting cursor is
   * `cursor.tokenIndex` (the provisional one), which is what
   * `TrackingSnapshot.tokenIndex` reports to the control Live screen.
   */
  it('never commits a retake, a large skip, or a section crossing', () => {
    const e = engine('provisional');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Hello everyone and welcome to the channel.');
    speak(e, s, 'Today we are talking about building a teleprompter that actually listens.');
    const committed = e.cursor.committedTokenIndex;
    const provisionalBefore = e.cursor.tokenIndex;
    const sectionBefore = e.sectionGraph.sectionIdAt(committed);
    const largeSkip = DEFAULT_TRACKING_PROFILE.largeForwardDistance;

    // A long provisional stream matching an earlier passage (a retake shape)
    // and a distant one (a jump shape) — neither may move anything.
    for (const text of [
      'Hello everyone and welcome to the channel today we are',
      'Now watch the kaleidoscope demo carefully because the colors shift',
      'Let us get started with the wrap up now remember to subscribe',
    ]) {
      for (const event of s.speak({ text })) {
        if (event.type === 'completed') break; // provisional only
        e.handleTranscriptEvent(event);
        expect(e.cursor.committedTokenIndex).toBe(committed);
        expect(e.sectionGraph.sectionIdAt(e.cursor.committedTokenIndex)).toBe(sectionBefore);

        // The provisional cursor is the one the provisional path actually
        // writes, so this is where a retake, a large skip or a section
        // crossing would show up.
        const provisional = e.cursor.tokenIndex;
        expect(provisional, 'provisional evidence must never move backward').toBeGreaterThanOrEqual(
          Math.min(committed, provisionalBefore),
        );
        expect(
          provisional - committed,
          'provisional evidence must never perform a large forward skip',
        ).toBeLessThanOrEqual(largeSkip);
        expect(
          e.sectionGraph.sectionIdAt(provisional),
          'provisional evidence must never cross a section boundary',
        ).toBe(sectionBefore);
      }
    }
    expect(e.decisionRecords().every((r) => r.behavior !== 'retake')).toBe(true);
  });
});

describe('repeated passages freeze rather than guess (companion §23, §31.13)', () => {
  it('a generic repeated refrain does not move the cursor', () => {
    const e = engine('refrain');
    const s = new TranscriptScripter(10_000, 1);
    speak(e, s, 'Now watch the kaleidoscope demo carefully because the colors shift like a metronome keeping perfect time.');
    const before = e.cursor.committedTokenIndex;
    const recordsBefore = e.decisionRecords().length;
    // "let's get started with the" appears in both Welcome and Closing.
    speak(e, s, "Let's get started with the");
    expect(e.cursor.committedTokenIndex).toBe(before);
    const behaviors = e.decisionRecords().slice(recordsBefore).map((r) => r.behavior);
    expect(behaviors).not.toContain('retake');
    expect(behaviors).not.toContain('large_skip');
  });
});

describe('semantic assist is bounded advisory evidence (companion §3.6, §40)', () => {
  const evidence = (
    overrides?: Partial<SemanticAssistEvidence>,
  ): SemanticAssistEvidence => ({
    assistId: 'assist-1',
    epoch: 0,
    requestRevision: 1,
    sourceItemIds: ['item-1-0'],
    receivedAtMs: 1000,
    opinions: [{ candidateId: 'continuity:40', relation: 'paraphrase', confidence: 1 }],
    ...overrides,
  });

  const input = (overrides?: Partial<Parameters<typeof semanticAdjustment>[1]>) => ({
    candidateId: 'continuity:40',
    distanceTokens: 10,
    largeForward: false,
    localScore: 0.6,
    finalEvidence: true,
    epoch: 0,
    nowMs: 1000,
    activeItemIds: new Set(['item-1-0']),
    ...overrides,
  });

  it('is clamped to a modest fraction of the local score (A.2, §40.1)', () => {
    const { delta } = semanticAdjustment(evidence(), input(), smooth);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(smooth.alignment.semanticInfluenceMax * 0.6 + 1e-9);
  });

  it('cannot rescue a candidate with no local support (§18.4, §40.1)', () => {
    const { delta } = semanticAdjustment(evidence(), input({ localScore: 0 }), smooth);
    expect(delta).toBe(0);
  });

  it('only touches candidates the local engine supplied (§40.2)', () => {
    const { delta } = semanticAdjustment(evidence(), input({ candidateId: 'ngram:900' }), smooth);
    expect(delta).toBe(0);
  });

  it('a restart opinion cannot boost a forward candidate (§40.3)', () => {
    const restart = evidence({
      opinions: [{ candidateId: 'continuity:40', relation: 'restart', confidence: 1 }],
    });
    expect(semanticAdjustment(restart, input({ distanceTokens: 10 }), smooth).delta).toBe(0);
    expect(semanticAdjustment(restart, input({ distanceTokens: -10 }), smooth).delta).not.toBe(0);
  });

  it('never supports a retake or a large skip from provisional context (§15.3)', () => {
    const restart = evidence({
      opinions: [{ candidateId: 'continuity:40', relation: 'restart', confidence: 1 }],
    });
    expect(
      semanticAdjustment(restart, input({ distanceTokens: -10, finalEvidence: false }), smooth)
        .delta,
    ).toBe(0);
    const skip = evidence({
      opinions: [{ candidateId: 'continuity:40', relation: 'forward_skip', confidence: 1 }],
    });
    expect(
      semanticAdjustment(skip, input({ largeForward: true, finalEvidence: false }), smooth).delta,
    ).toBe(0);
  });

  it('`adlib` and `unresolved` supply no positive movement evidence (§40.3)', () => {
    const unresolved = evidence({
      opinions: [{ candidateId: 'continuity:40', relation: 'unresolved', confidence: 1 }],
    });
    expect(semanticAdjustment(unresolved, input(), smooth).delta).toBe(0);
    const adlib = evidence({
      opinions: [{ candidateId: 'continuity:40', relation: 'adlib', confidence: 1 }],
    });
    expect(semanticAdjustment(adlib, input(), smooth).delta).toBeLessThan(0);
  });

  it('expires, and is rejected on a stale epoch or superseded items (§25.7, §40.4)', () => {
    const active = new Set(['item-1-0']);
    expect(isSemanticEvidenceCurrent(evidence(), 0, 1000, 4000, active)).toBe(true);
    expect(isSemanticEvidenceCurrent(evidence(), 1, 1000, 4000, active)).toBe(false);
    expect(isSemanticEvidenceCurrent(evidence(), 0, 99_000, 4000, active)).toBe(false);
    expect(isSemanticEvidenceCurrent(evidence(), 0, 1000, 4000, new Set(['other']))).toBe(false);
    expect(isSemanticEvidenceCurrent(undefined, 0, 1000, 4000, active)).toBe(false);
  });

  it('the engine drops assist carrying the wrong epoch', () => {
    const e = engine('assist-epoch');
    e.moveTo(40, 'command', 1000); // epoch → 1
    e.applySemanticAssist(evidence({ epoch: 0 }));
    // Nothing to assert beyond "did not throw and did not move"; the guard is
    // that a stale-epoch payload can never become score.
    expect(e.cursor.committedTokenIndex).toBe(40);
    expect(e.semanticEpoch).toBe(1);
  });
});

describe('behavior projection (companion §17, §52)', () => {
  const base = {
    state: 'following' as const,
    movement: 'advance' as const,
    acquired: true,
    provisional: false,
    correction: 'local' as const,
    activeTransition: 'none' as const,
    authority: 'ordinary' as const,
    msSinceConfident: 0,
    horizonMs: 750,
    offScript: false,
    retakeCommitted: false,
    confidence: 0.9,
    lockedThreshold: profile.lockedThreshold,
    softThreshold: profile.softThreshold,
  };

  it('maps an ordinary confident read to following/normal', () => {
    expect(projectBehavior(base)).toEqual({ state: 'following', behavior: 'normal' });
  });

  it('navigation is keyed off authority, not movement kind (§56.1)', () => {
    // `setCommandPending` also emits a 'command' movement; freezing for a
    // pending command is not navigation.
    expect(projectBehavior({ ...base, movement: 'command' }).behavior).not.toBe(
      'command_navigation',
    );
    expect(projectBehavior({ ...base, authority: 'command' }).behavior).toBe('command_navigation');
    expect(projectBehavior({ ...base, authority: 'manual' }).behavior).toBe('manual_navigation');
  });

  it('reports acquiring until the first lock (§17.1)', () => {
    expect(projectBehavior({ ...base, acquired: false }).state).toBe('acquiring');
    expect(projectBehavior({ ...base, acquired: false }).behavior).toBe('acquire');
  });

  it('coasts inside the horizon and holds once off-script (§17.3, §17.5)', () => {
    expect(projectBehavior({ ...base, msSinceConfident: 2000 }).state).toBe('coasting');
    expect(projectBehavior({ ...base, msSinceConfident: 2000, offScript: true }).state).toBe(
      'adlib_hold',
    );
  });

  it('maps v1 searching onto LOST_LOCAL, not a global hunt (Appendix E §31.14)', () => {
    const projection = projectBehavior({ ...base, state: 'searching', movement: 'hold' });
    expect(projection.state).toBe('lost_local');
    expect(projection.behavior).toBe('lost');
  });

  it('an off-script search is an ad-lib hold, not a loss of position (§19.1)', () => {
    const projection = projectBehavior({
      ...base,
      state: 'searching',
      movement: 'hold',
      offScript: true,
    });
    expect(projection.state).toBe('adlib_hold');
    expect(projection.behavior).toBe('adlib');
  });

  it('distinguishes a small skip from a large skip by rendered distance (§20, A.3)', () => {
    expect(projectBehavior({ ...base, movement: 'skip', correction: 'catch_up' }).behavior).toBe(
      'small_skip',
    );
    expect(projectBehavior({ ...base, movement: 'skip', correction: 'reanchor' }).behavior).toBe(
      'large_skip',
    );
  });

  it('an ordinary advance is never labelled a jump, however far it moved (§20.1)', () => {
    expect(projectBehavior({ ...base, correction: 'catch_up' }).behavior).toBe('normal');
    expect(projectBehavior({ ...base, correction: 'reanchor' }).behavior).toBe('normal');
  });

  it('reports paraphrase for positionally consistent but lexically thin evidence (§18.1)', () => {
    expect(projectBehavior({ ...base, confidence: 0.65 }).behavior).toBe('paraphrase');
  });

  it('an active directive outranks the ordinary state projection (§17.8–§17.9)', () => {
    expect(projectBehavior({ ...base, activeTransition: 'reanchor' }).state).toBe('reanchoring');
    expect(projectBehavior({ ...base, activeTransition: 'rewind' }).state).toBe('rewinding');
    expect(projectBehavior({ ...base, activeTransition: 'catch_up' }).state).toBe('catching_up');
  });

  it('preserves the v1 lifecycle states verbatim (§17.11)', () => {
    for (const [v1, v2] of [
      ['paused', 'paused'],
      ['reconnecting', 'reconnecting'],
      ['command_pending', 'command_pending'],
      ['retake_candidate', 'retake_pending'],
    ] as const) {
      expect(projectBehavior({ ...base, state: v1 }).state).toBe(v2);
    }
  });
});
