/**
 * Bounded semantic fusion (companion §40, §3.6).
 *
 * The load-bearing property: a semantic contribution never exceeds
 * `profile.alignment.semanticInfluenceMax` and can never flip a local decision
 * on its own unless the local margin was already inside that bound.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import {
  applyBoundedAdjustment,
  clampInfluence,
  fuseSemanticAssist,
  localTopMargin,
  semanticMagnitude,
  toTrackingAssistEvidence,
  topByLocalScore,
} from '../../../src/shared/semantic/fusion';
import type {
  AssistRelation,
  LocalCandidate,
  SemanticAssistResult,
} from '../../../src/shared/semantic/types';
import { mulberry32, pick } from '../helpers/rand';

const INFLUENCE_MAX = DEFAULT_SMOOTH_FOLLOW_PROFILE.alignment.semanticInfluenceMax;

function candidate(overrides: Partial<LocalCandidate> & { id: string }): LocalCandidate {
  return {
    relationHint: 'continuity',
    distance: 'near_forward',
    text: 'script text',
    sectionId: 'section_a',
    startTokenIndex: 10,
    endTokenIndex: 40,
    localLogScore: -1,
    localScoreBand: 'moderate',
    supportKinds: ['lexical_anchor'],
    sectionTransitionAllowed: true,
    ...overrides,
  };
}

function result(overrides: Partial<SemanticAssistResult> = {}): SemanticAssistResult {
  return {
    schemaVersion: 1,
    requestId: 'assist_1',
    semanticEpoch: 3,
    transcriptRevision: 40,
    candidateSetHash: 'h',
    relation: 'near_exact',
    selectedCandidateId: 'cand_a',
    selectedCandidateConfidence: 1,
    transcriptCoverage: 1,
    candidateCoverage: 1,
    shouldInfluenceTracking: true,
    criticalMismatch: 'none',
    coachTipCode: 'none',
    confidence: 1,
    ...overrides,
  };
}

const BASE = {
  influenceMax: INFLUENCE_MAX,
  finalEvidence: true,
  sessionId: 's1',
  sessionGeneration: 1,
  scriptCompileHash: 'sc',
  nowMs: 1_000,
};

describe('fuseSemanticAssist — preconditions', () => {
  const candidates = [candidate({ id: 'cand_a' })];

  it('produces bounded evidence for a supported, eligible candidate', () => {
    const message = fuseSemanticAssist({ ...BASE, result: result(), candidates });
    expect(message).not.toBeNull();
    expect(message?.evidence).toHaveLength(1);
    expect(message?.evidence[0]?.adjustment).toBeLessThanOrEqual(INFLUENCE_MAX);
    expect(message?.behaviorHint).toBe('advance');
    expect(message?.expiresAtMs).toBeGreaterThan(message?.issuedAtMs ?? 0);
  });

  it('emits no evidence from provisional-only speech (§3.6)', () => {
    const message = fuseSemanticAssist({
      ...BASE,
      finalEvidence: false,
      result: result(),
      candidates,
    });
    expect(message?.evidence).toEqual([]);
  });

  it('emits no evidence without minimum local support (§40.2)', () => {
    const message = fuseSemanticAssist({
      ...BASE,
      result: result(),
      candidates: [candidate({ id: 'cand_a', supportKinds: [] })],
    });
    expect(message?.evidence).toEqual([]);
  });

  it('emits no evidence when the section graph prohibits the candidate', () => {
    const message = fuseSemanticAssist({
      ...BASE,
      result: result(),
      candidates: [candidate({ id: 'cand_a', sectionTransitionAllowed: false })],
    });
    expect(message?.evidence).toEqual([]);
  });

  it('turns ad-lib into a hold hint, never advancement (§40.3)', () => {
    const message = fuseSemanticAssist({
      ...BASE,
      result: result({ relation: 'adlib', selectedCandidateId: null, shouldInfluenceTracking: false }),
      candidates,
    });
    expect(message?.behaviorHint).toBe('hold');
    expect(message?.evidence).toEqual([]);
  });

  it('gives unresolved no positive movement evidence', () => {
    const message = fuseSemanticAssist({
      ...BASE,
      result: result({
        relation: 'unresolved',
        selectedCandidateId: null,
        shouldInfluenceTracking: false,
      }),
      candidates,
    });
    expect(message?.behaviorHint).toBe('none');
    expect(message?.evidence).toEqual([]);
  });

  it('ranks relations per §40.3 without ever exceeding the cap', () => {
    const relations: AssistRelation[] = [
      'near_exact',
      'return_to_script',
      'paraphrase',
      'forward_skip',
      'restart',
    ];
    const magnitudes = relations.map((relation) =>
      semanticMagnitude(result({ relation }), INFLUENCE_MAX),
    );
    for (const magnitude of magnitudes) expect(magnitude).toBeLessThanOrEqual(INFLUENCE_MAX);
    expect(magnitudes[0]).toBeGreaterThan(magnitudes[3] ?? 0);
  });
});

describe('bounded influence — property tests', () => {
  it('never produces an adjustment outside ±influenceMax over 5000 random results', () => {
    const rand = mulberry32(20260724);
    const relations: AssistRelation[] = [
      'near_exact',
      'paraphrase',
      'adlib',
      'return_to_script',
      'restart',
      'self_correction',
      'forward_skip',
      'unresolved',
    ];
    for (let i = 0; i < 5000; i++) {
      const influenceMax = rand() * 0.9;
      const relation = pick(rand, relations);
      const message = fuseSemanticAssist({
        ...BASE,
        influenceMax,
        result: result({
          relation,
          selectedCandidateConfidence: rand(),
          transcriptCoverage: rand(),
          candidateCoverage: rand(),
          confidence: rand(),
          shouldInfluenceTracking: rand() > 0.2,
          selectedCandidateId: rand() > 0.1 ? 'cand_a' : null,
        }),
        candidates: [candidate({ id: 'cand_a', relationHint: 'continuity' })],
      });
      for (const evidence of message?.evidence ?? []) {
        expect(Math.abs(evidence.adjustment)).toBeLessThanOrEqual(influenceMax + 1e-12);
      }
    }
  });

  it('never flips the local ranking unless the local margin was ≤ influenceMax', () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 5000; i++) {
      const size = 2 + Math.floor(rand() * 4);
      const locals = Array.from({ length: size }, (_, index) => ({
        id: `cand_${index}`,
        localLogScore: -rand() * 6,
      }));
      const selected = locals[Math.floor(rand() * locals.length)];
      if (selected === undefined) continue;

      // Deliberately hostile: an evidence value far outside the contract.
      const evidence = [
        {
          candidateId: selected.id,
          adjustment: (rand() > 0.5 ? 1 : -1) * rand() * 50,
          relation: 'near_exact' as const,
          confidence: 1,
          influenceMax: INFLUENCE_MAX,
        },
      ];
      const combined = applyBoundedAdjustment(locals, evidence, INFLUENCE_MAX);
      const localWinner = topByLocalScore(locals);
      const combinedWinner = combined.reduce((best, current) =>
        current.combinedLogScore > best.combinedLogScore ? current : best,
      ).id;

      if (combinedWinner !== localWinner) {
        // A flip is only ever possible inside the bounded ambiguity band.
        expect(localTopMargin(locals)).toBeLessThanOrEqual(INFLUENCE_MAX + 1e-12);
      }
      for (const scored of combined) {
        expect(Math.abs(scored.combinedLogScore - scored.localLogScore)).toBeLessThanOrEqual(
          INFLUENCE_MAX + 1e-12,
        );
      }
    }
  });

  it('re-clamps hostile evidence on application', () => {
    const scored = applyBoundedAdjustment(
      [{ id: 'a', localLogScore: -5 }],
      [
        {
          candidateId: 'a',
          adjustment: 999,
          relation: 'near_exact',
          confidence: 1,
          influenceMax: INFLUENCE_MAX,
        },
      ],
      INFLUENCE_MAX,
    );
    expect(scored[0]?.combinedLogScore).toBeCloseTo(-5 + INFLUENCE_MAX, 12);
  });

  it('clampInfluence neutralizes non-finite values', () => {
    expect(clampInfluence(Number.NaN, 0.25)).toBe(0);
    expect(clampInfluence(Number.POSITIVE_INFINITY, 0.25)).toBe(0);
    expect(clampInfluence(-9, 0.25)).toBe(-0.25);
  });

  it('adjusts at most one candidate per result (single beneficiary)', () => {
    const message = fuseSemanticAssist({
      ...BASE,
      result: result(),
      candidates: [
        candidate({ id: 'cand_a' }),
        candidate({ id: 'cand_b' }),
        candidate({ id: 'cand_c' }),
      ],
    });
    expect(message?.evidence).toHaveLength(1);
    expect(message?.evidence[0]?.candidateId).toBe('cand_a');
  });
});

describe('tracking-worker binding (src/shared/tracking/semantic-assist.ts)', () => {
  const candidates = [candidate({ id: 'cand_a' }), candidate({ id: 'cand_b' })];

  it('emits the worker inbound shape with raw (unweighted) confidence', () => {
    const assist = result({ relation: 'paraphrase', candidateCoverage: 0.5, transcriptCoverage: 0.5 });
    const message = fuseSemanticAssist({ ...BASE, result: assist, candidates });
    expect(message).not.toBeNull();
    const evidence = toTrackingAssistEvidence({
      result: assist,
      message: message!,
      candidates,
      assistId: 'assist_1',
      requestRevision: 40,
      sourceItemIds: ['item_9'],
      receivedAtMs: 1_000,
    });
    expect(evidence.assistId).toBe('assist_1');
    expect(evidence.epoch).toBe(3);
    expect(evidence.sourceItemIds).toEqual(['item_9']);
    expect(evidence.opinions).toEqual([
      { candidateId: 'cand_a', relation: 'paraphrase', confidence: 0.5 },
    ]);
  });

  it('spreads an ad-lib opinion over every eligible candidate (hold branch)', () => {
    const assist = result({
      relation: 'adlib',
      selectedCandidateId: null,
      shouldInfluenceTracking: false,
      confidence: 0.8,
    });
    const message = fuseSemanticAssist({ ...BASE, result: assist, candidates });
    const evidence = toTrackingAssistEvidence({
      result: assist,
      message: message!,
      candidates,
      assistId: 'assist_2',
      requestRevision: 41,
      sourceItemIds: [],
      receivedAtMs: 1_000,
    });
    expect(evidence.opinions).toHaveLength(2);
    expect(evidence.opinions.every((o) => o.relation === 'adlib')).toBe(true);
  });

  it('emits no opinions when the result carries no usable evidence', () => {
    const assist = result({
      relation: 'unresolved',
      selectedCandidateId: null,
      shouldInfluenceTracking: false,
    });
    const message = fuseSemanticAssist({ ...BASE, result: assist, candidates });
    const evidence = toTrackingAssistEvidence({
      result: assist,
      message: message!,
      candidates,
      assistId: 'assist_3',
      requestRevision: 42,
      sourceItemIds: [],
      receivedAtMs: 1_000,
    });
    expect(evidence.opinions).toEqual([]);
  });
});
