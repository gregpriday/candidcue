/**
 * Strict-schema and domain rejection matrix (companion §39, Appendix C.3/C.4).
 * Driven by the realistic + adversarial fixtures in tests/fixtures/luna.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { LocalCandidate } from '../../../src/shared/semantic/types';
import {
  validateLandmarkPreparation,
  validateLandmarkRetrieval,
  validateSemanticAssist,
} from '../../../src/shared/semantic/validate';

function loadFixture(name: string): {
  _request: Record<string, never> & Record<string, unknown>;
  cases: Array<{ name: string; expect: string; response: unknown }>;
} {
  const url = new URL(`../../fixtures/luna/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

function candidate(overrides: Partial<LocalCandidate> & { id: string }): LocalCandidate {
  return {
    relationHint: 'continuity',
    distance: 'current',
    text: 'The simplest approach is to begin with customers who already know and trust you.',
    sectionId: 'section_launch',
    startTokenIndex: 100,
    endTokenIndex: 130,
    localLogScore: -1.2,
    localScoreBand: 'moderate',
    supportKinds: ['lexical_anchor'],
    sectionTransitionAllowed: true,
    ...overrides,
  };
}

const CANDIDATES: LocalCandidate[] = [
  candidate({ id: 'cand_a', relationHint: 'continuity', distance: 'near_forward' }),
  candidate({ id: 'cand_b', relationHint: 'retake', distance: 'previous_sentence' }),
  candidate({
    id: 'cand_distant',
    relationHint: 'forward',
    distance: 'next_section',
    sectionId: 'section_closing',
    // The section graph already rejected this transition (§51 step 6).
    sectionTransitionAllowed: false,
  }),
];

describe('validateSemanticAssist — rejection matrix', () => {
  const fixture = loadFixture('classification-responses');
  const expectation = {
    requestId: 'assist_184',
    semanticEpoch: 7,
    transcriptRevision: 993,
    candidateSetHash: '7c32a1f0',
    candidates: CANDIDATES,
  };

  it('covers realistic and adversarial responses', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const testCase of fixture.cases) {
    it(`${testCase.name} → ${testCase.expect}`, () => {
      const result = validateSemanticAssist(testCase.response, expectation);
      if (testCase.expect === 'ok') {
        expect(result.ok, JSON.stringify(result)).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe(testCase.expect);
      }
    });
  }

  it('never accepts a model-supplied token index as a position', () => {
    const withIndex = {
      schemaVersion: 1,
      requestId: 'assist_184',
      semanticEpoch: 7,
      transcriptRevision: 993,
      candidateSetHash: '7c32a1f0',
      relation: 'near_exact',
      selectedCandidateId: 'cand_a',
      selectedCandidateConfidence: 0.9,
      transcriptCoverage: 0.9,
      candidateCoverage: 0.9,
      shouldInfluenceTracking: true,
      criticalMismatch: 'none',
      coachTipCode: 'none',
      confidence: 0.9,
      tokenIndex: 999,
    };
    const result = validateSemanticAssist(withIndex, expectation);
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer identity fields', () => {
    const result = validateSemanticAssist(
      {
        schemaVersion: 1,
        requestId: 'assist_184',
        semanticEpoch: 7.5,
        transcriptRevision: 993,
        candidateSetHash: '7c32a1f0',
        relation: 'adlib',
        selectedCandidateId: null,
        selectedCandidateConfidence: 0,
        transcriptCoverage: 0,
        candidateCoverage: 0,
        shouldInfluenceTracking: false,
        criticalMismatch: 'none',
        coachTipCode: 'none',
        confidence: 0.5,
      },
      expectation,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('semantic_epoch_out_of_schema');
  });
});

describe('validateLandmarkRetrieval — rejection matrix', () => {
  const fixture = loadFixture('retrieval-responses');
  const expectation = {
    requestId: 'recover_12',
    semanticEpoch: 7,
    transcriptRevision: 993,
    landmarkSetHash: 'a91b0c2d',
    offeredLandmarkIds: ['lm_p1', 'lm_p2', 'lm_p3'],
  };

  for (const testCase of fixture.cases) {
    it(`${testCase.name} → ${testCase.expect}`, () => {
      const result = validateLandmarkRetrieval(testCase.response, expectation);
      if (testCase.expect === 'ok') {
        expect(result.ok, JSON.stringify(result)).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe(testCase.expect);
      }
    });
  }
});

describe('validateLandmarkPreparation', () => {
  const expectation = {
    requestId: 'prep_1',
    scriptCompileHash: 'sc_1',
    sectionId: 'section_launch',
    offeredSpanIds: ['span_1', 'span_2'],
  };

  const annotation = (spanId: string) => ({
    spanId,
    proposition: 'Begin with customers who already trust the product.',
    topicLabels: ['launch', 'audience'],
    criticalTerms: [{ kind: 'name', canonical: 'CandidCue' }],
    conversationalAliases: ['start with people who trust you'],
    exactness: 'balanced',
  });

  it('drops invented and duplicated span IDs but keeps the rest (§39.3)', () => {
    const result = validateLandmarkPreparation(
      {
        schemaVersion: 1,
        requestId: 'prep_1',
        scriptCompileHash: 'sc_1',
        sectionId: 'section_launch',
        annotations: [
          annotation('span_1'),
          annotation('span_invented'),
          annotation('span_1'),
          annotation('span_2'),
        ],
      },
      expectation,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.annotations.map((a) => a.spanId)).toEqual(['span_1', 'span_2']);
    }
  });

  it('rejects a result for another script or section', () => {
    const wrongScript = validateLandmarkPreparation(
      {
        schemaVersion: 1,
        requestId: 'prep_1',
        scriptCompileHash: 'other',
        sectionId: 'section_launch',
        annotations: [],
      },
      expectation,
    );
    expect(wrongScript.ok).toBe(false);
    if (!wrongScript.ok) expect(wrongScript.reason).toBe('script_compile_hash_mismatch');
  });

  it('drops an annotation with an out-of-schema critical term kind', () => {
    const result = validateLandmarkPreparation(
      {
        schemaVersion: 1,
        requestId: 'prep_1',
        scriptCompileHash: 'sc_1',
        sectionId: 'section_launch',
        annotations: [
          { ...annotation('span_1'), criticalTerms: [{ kind: 'vibe', canonical: 'x' }] },
          annotation('span_2'),
        ],
      },
      expectation,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.annotations.map((a) => a.spanId)).toEqual(['span_2']);
  });
});
