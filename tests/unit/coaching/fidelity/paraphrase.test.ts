/**
 * §25.5 `material_meaning_change`, and the deadlock it used to sit in.
 *
 * The comparator refuses to decide materiality (correctly — §25.5 reserves it
 * for Luna) and the observer refuses any Luna code the local candidate types do
 * not permit (correctly — §23.1). Composed, the candidate type, the tip code,
 * the catalog entry and the `MATERIAL_DIFFERENCE_CONFIRMED` reason were all
 * unreachable. These tests pin the resolution: the local layer may *ask*, and
 * only Luna's answer can show anything.
 */
import { describe, expect, it } from 'vitest';
import {
  DIVERGENCE_HIGH,
  observeParaphrase,
  type FidelitySpanObservation,
} from '../../../../src/shared/coaching/fidelity';
import {
  CoachTipPolicy,
  permittedCodesFor,
  type CoachPolicyContext,
} from '../../../../src/shared/coaching/coach';
import type { CoachCandidate } from '../../../../src/shared/contracts/coaching';

function observation(authored: string, spoken: string, final = true): FidelitySpanObservation {
  return {
    spanId: 'span-7',
    authored: authored.split(' ').map((surface, index) => ({ tokenIndex: index, surface })),
    spoken: spoken.split(' ').map((surface, index) => ({
      transcriptIndex: index,
      surface,
      audioStartMs: 1_000 + index * 200,
      audioEndMs: 1_200 + index * 200,
      final,
      commitSequence: 3,
    })),
    alignment: [],
    trackingEpoch: 1,
    takePassId: 'take-1',
  };
}

function policyContext(overrides: Partial<CoachPolicyContext> = {}): CoachPolicyContext {
  return {
    audioTimeMs: 5_000,
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
    activeScriptSpanId: 'span-7',
    ...overrides,
  };
}

const AUTHORED = 'revenue grew fifteen percent across the northern territories last quarter';

describe('the paraphrase question (§25.5)', () => {
  it('says nothing when the span was delivered as written', () => {
    const result = observeParaphrase(observation(AUTHORED, AUTHORED));
    expect(result.candidate).toBeNull();
    // The reason proves it looked and found a match, rather than never looking.
    expect(result.reason).toBe('below_divergence_floor');
    expect(result.divergence).toBe(0);
  });

  it('asks when the span was substantially reworded', () => {
    const result = observeParaphrase(
      observation(AUTHORED, 'revenue climbed sharply through the whole northern region last quarter'),
    );
    expect(result.reason).toBe('candidate');
    expect(result.candidate?.type).toBe('material_meaning_change');
    // The claim is lexical: a bounded, honest confidence, nowhere near the
    // other critical codes' 0.7.
    expect(result.candidate?.localConfidence).toBeLessThan(0.7);
    expect(result.candidate?.scriptSpanId).toBe('span-7');
    expect(result.candidate?.finalEvidence).toBe(true);
  });

  it('says nothing about a short span', () => {
    expect(observeParaphrase(observation('we ship today', 'we launch now')).reason).toBe(
      'span_too_short',
    );
  });

  it('says nothing when the divergence looks like a misalignment', () => {
    const result = observeParaphrase(
      observation(AUTHORED, 'entirely different sentence about unrelated subject matter entirely'),
    );
    expect(result.reason).toBe('above_divergence_ceiling');
    expect(result.divergence as number).toBeGreaterThan(DIVERGENCE_HIGH);
  });

  it('§25.5: says nothing about a provisional tail', () => {
    const result = observeParaphrase(
      observation(
        AUTHORED,
        'revenue climbed sharply through the whole northern region last quarter',
        false,
      ),
    );
    expect(result.reason).toBe('provisional_evidence');
    expect(result.candidate).toBeNull();
  });

  it('§19.4: respects the authored opt-out', () => {
    expect(
      observeParaphrase({
        ...observation(AUTHORED, 'revenue climbed sharply through the whole northern region last quarter'),
        coachingDisabled: true,
      }).reason,
    ).toBe('coaching_disabled');
  });
});

describe('MATERIAL_MEANING_CHANGE is reachable, and only through Luna', () => {
  function candidate(): CoachCandidate {
    const result = observeParaphrase(
      observation(AUTHORED, 'revenue climbed sharply through the whole northern region last quarter'),
    );
    expect(result.candidate).not.toBeNull();
    return result.candidate as CoachCandidate;
  }

  it('§23.1: the candidate now permits the code the observer used to reject', () => {
    expect(permittedCodesFor(['material_meaning_change'])).toContain('MATERIAL_MEANING_CHANGE');
  });

  it('§20.1: a local proposal can never show it, however confident', () => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [{ candidate: { ...candidate(), localConfidence: 1 }, source: 'local' }],
      policyContext(),
    );
    expect(outcome.displayed).toBe(false);
    expect(outcome.rejected[0]?.reason).toBe('requires_semantic_validation');
    expect(policy.getActiveTip()).toBeNull();
  });

  it('a Luna-validated proposal does show it', () => {
    const policy = new CoachTipPolicy();
    const outcome = policy.propose(
      [
        {
          candidate: candidate(),
          source: 'luna_validated',
          lunaConfidence: 0.9,
          authoredTerm: 'fifteen percent',
        },
      ],
      policyContext(),
    );
    expect(outcome.rejected).toEqual([]);
    expect(outcome.displayed).toBe(true);
    expect(policy.getActiveTip()?.code).toBe('MATERIAL_MEANING_CHANGE');
    // §25.5: the quoted text is authored script text supplied locally.
    expect(policy.getActiveTip()?.interpolations).toEqual({ term: 'fifteen percent' });
  });
});
