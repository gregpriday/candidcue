/**
 * Candidate-bounded context construction and the landmark index
 * (companion §37, §41, §42.3, §57.2).
 */
import { describe, expect, it } from 'vitest';

import { candidateSetHash, landmarkSetHash, stableHash } from '../../../src/shared/semantic/hash';
import {
  buildClassificationRequest,
  buildPreparationRequest,
  buildRetrievalRequest,
  CONTEXT_LIMITS,
  promptCacheKeyFor,
  selectCandidates,
  stableSectionContext,
} from '../../../src/shared/semantic/context';
import {
  SemanticLandmarkIndex,
  type LandmarkSpan,
} from '../../../src/shared/semantic/landmark-index';
import type {
  AssistSchedulingContext,
  LocalCandidate,
} from '../../../src/shared/semantic/types';

const FULL_SCRIPT_SECRET = 'ZZZ_THIS_SENTENCE_IS_ELSEWHERE_IN_THE_SCRIPT_ZZZ';

function candidate(overrides: Partial<LocalCandidate> & { id: string }): LocalCandidate {
  return {
    relationHint: 'continuity',
    distance: 'near_forward',
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

function context(overrides: Partial<AssistSchedulingContext> = {}): AssistSchedulingContext {
  return {
    sessionId: 's1',
    sessionGeneration: 1,
    scriptCompileHash: 'sc_1',
    semanticEpoch: 7,
    transcriptRevision: 993,
    sessionTimeMs: 0,
    trackingState: 'uncertain',
    behavior: 'paraphrase',
    currentSectionId: 'section_launch',
    currentSectionTitle: 'Launching the product',
    recentFinalTranscript: 'and the easiest way is to start with the people who already trust you',
    provisionalTail: 'then expand',
    hasNewFinalMeaningfulSpeech: true,
    newFinalTokenCount: 9,
    atPhraseBoundary: true,
    commandPending: false,
    sessionPaused: false,
    reanchorActive: false,
    localConfidence: 0.5,
    sustainedAmbiguityMs: 900,
    localTopMarginLogScore: 0.2,
    lexicalFailureMs: 0,
    candidates: [
      candidate({ id: 'cand_a' }),
      candidate({ id: 'cand_b', relationHint: 'retake', distance: 'previous_sentence' }),
    ],
    criticalChecks: [],
    ...overrides,
  };
}

describe('candidate selection (§37.1, §51 step 6)', () => {
  it('removes candidates the section graph already rejected', () => {
    const selected = selectCandidates([
      candidate({ id: 'ok' }),
      candidate({ id: 'prohibited', sectionTransitionAllowed: false }),
    ]);
    expect(selected.map((c) => c.id)).toEqual(['ok']);
  });

  it('removes candidates with no local support (§40.2)', () => {
    const selected = selectCandidates([
      candidate({ id: 'ok' }),
      candidate({ id: 'unsupported', supportKinds: [] }),
    ]);
    expect(selected.map((c) => c.id)).toEqual(['ok']);
  });

  it('caps the candidate set at the §37.1 maximum', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: `c${i}`, localLogScore: -i }),
    );
    expect(selectCandidates(many)).toHaveLength(CONTEXT_LIMITS.maxCandidates);
  });
});

describe('classification payload (§37.1, §57.2, Appendix C.2)', () => {
  it('sends only the candidate windows — never the whole script', () => {
    const build = buildClassificationRequest(context(), 'assist_1');
    expect(build).not.toBeNull();
    const serialized = JSON.stringify(build?.request.payload);
    expect(serialized).not.toContain(FULL_SCRIPT_SECRET);
    expect(build?.request.payload.candidates).toHaveLength(2);
    for (const candidatePayload of build?.request.payload.candidates ?? []) {
      expect(candidatePayload.text.length).toBeLessThanOrEqual(
        CONTEXT_LIMITS.maxCandidateChars + 1,
      );
    }
  });

  it('omits the provisional tail unless explicitly requested (§37.1)', () => {
    const withoutTail = buildClassificationRequest(context(), 'assist_1');
    expect(withoutTail?.request.payload.provisional_tail).toBe('');
    const withTail = buildClassificationRequest(context(), 'assist_1', {
      includeProvisional: true,
    });
    expect(withTail?.request.payload.provisional_tail).toBe('then expand');
  });

  it('bounds the finalized transcript tail', () => {
    const long = 'word '.repeat(400);
    const build = buildClassificationRequest(context({ recentFinalTranscript: long }), 'assist_1');
    expect(build?.request.payload.recent_final_transcript.length).toBeLessThanOrEqual(
      CONTEXT_LIMITS.maxFinalTranscriptChars,
    );
  });

  it('returns null when there are too few eligible candidates', () => {
    const build = buildClassificationRequest(
      context({ candidates: [candidate({ id: 'only' })] }),
      'assist_1',
    );
    expect(build).toBeNull();
  });

  it('carries the identity metadata stale checks depend on (§36.4)', () => {
    const build = buildClassificationRequest(context(), 'assist_1');
    expect(build?.request.requestId).toBe('assist_1');
    expect(build?.request.semanticEpoch).toBe(7);
    expect(build?.request.transcriptRevision).toBe(993);
    expect(build?.request.candidateSetHash).toBe(build?.request.payload.candidate_set_hash);
  });

  it('uses low reasoning effort and a small output budget (§38)', () => {
    const build = buildClassificationRequest(context(), 'assist_1');
    expect(build?.request.reasoningEffort).toBe('low');
    expect(build?.request.maxOutputTokens).toBeLessThanOrEqual(512);
  });
});

describe('prompt caching (§41)', () => {
  it('keeps the stable section context identical across requests in a section', () => {
    const first = buildClassificationRequest(context(), 'assist_1');
    const second = buildClassificationRequest(
      context({ transcriptRevision: 994, recentFinalTranscript: 'completely different words' }),
      'assist_2',
    );
    expect(first?.request.stableContext).toBe(second?.request.stableContext);
    expect(first?.request.stableContext).toBe(
      stableSectionContext('section_launch', 'Launching the product'),
    );
  });

  it('uses distinct, script-scoped cache keys per operation', () => {
    expect(promptCacheKeyFor('sc_1', 'classify')).not.toBe(promptCacheKeyFor('sc_1', 'retrieve'));
    expect(promptCacheKeyFor('sc_1', 'classify')).not.toBe(promptCacheKeyFor('sc_2', 'classify'));
  });
});

describe('hashes (§36.4)', () => {
  it('changes when candidate membership, span, or text changes', () => {
    const base = [candidate({ id: 'a' }), candidate({ id: 'b' })];
    const original = candidateSetHash(base);
    expect(candidateSetHash([...base].reverse())).not.toBe(original);
    expect(candidateSetHash([candidate({ id: 'a' })])).not.toBe(original);
    expect(
      candidateSetHash([candidate({ id: 'a', text: 'changed' }), candidate({ id: 'b' })]),
    ).not.toBe(original);
  });

  it('is deterministic', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
    expect(landmarkSetHash([{ id: 'x', proposition: 'p' }])).toBe(
      landmarkSetHash([{ id: 'x', proposition: 'p' }]),
    );
  });
});

describe('landmark index (§37.2, §37.3, §39.3)', () => {
  const spans: LandmarkSpan[] = [
    {
      spanId: 'lm_p1',
      sectionId: 'section_launch',
      level: 'paragraph',
      startTokenIndex: 0,
      endTokenIndex: 60,
      text: 'first paragraph',
    },
    {
      spanId: 'lm_p2',
      sectionId: 'section_launch',
      level: 'paragraph',
      startTokenIndex: 61,
      endTokenIndex: 140,
      text: 'second paragraph',
    },
    {
      spanId: 'lm_far',
      sectionId: 'section_closing',
      level: 'paragraph',
      startTokenIndex: 900,
      endTokenIndex: 960,
      text: `closing paragraph ${FULL_SCRIPT_SECRET}`,
    },
  ];

  function annotation(spanId: string) {
    return {
      spanId,
      proposition: `Proposition for ${spanId}`,
      topicLabels: ['launch'],
      criticalTerms: [],
      conversationalAliases: [],
      exactness: 'balanced' as const,
    };
  }

  function index(): SemanticLandmarkIndex {
    const built = new SemanticLandmarkIndex('sc_1');
    built.ingest(
      {
        schemaVersion: 1,
        requestId: 'p1',
        scriptCompileHash: 'sc_1',
        sectionId: 'section_launch',
        annotations: [annotation('lm_p1'), annotation('lm_p2')],
      },
      spans,
    );
    built.ingest(
      {
        schemaVersion: 1,
        requestId: 'p2',
        scriptCompileHash: 'sc_1',
        sectionId: 'section_closing',
        annotations: [annotation('lm_far')],
      },
      spans,
    );
    return built;
  }

  it('ignores a preparation result for another script compile', () => {
    const built = new SemanticLandmarkIndex('sc_1');
    const accepted = built.ingest(
      {
        schemaVersion: 1,
        requestId: 'p1',
        scriptCompileHash: 'other',
        sectionId: 'section_launch',
        annotations: [annotation('lm_p1')],
      },
      spans,
    );
    expect(accepted).toBe(0);
    expect(built.hasSection('section_launch')).toBe(false);
  });

  it('restricts retrieval to the current section (§37.2)', () => {
    const set = index().retrievalSet({
      currentSectionId: 'section_launch',
      cursorTokenIndex: 70,
      level: 'paragraph',
    });
    expect(set?.landmarks.map((l) => l.spanId)).toEqual(['lm_p1', 'lm_p2']);
    expect(JSON.stringify(set)).not.toContain(FULL_SCRIPT_SECRET);
  });

  it('includes the permitted sequential boundary corridor only', () => {
    const set = index().retrievalSet({
      currentSectionId: 'section_launch',
      boundarySectionId: 'section_closing',
      cursorTokenIndex: 70,
      level: 'paragraph',
    });
    expect(set?.landmarks.map((l) => l.spanId)).toContain('lm_far');
  });

  it('returns null for a section with no prepared index (§37.4)', () => {
    expect(
      index().retrievalSet({
        currentSectionId: 'section_unprepared',
        cursorTokenIndex: 0,
        level: 'paragraph',
      }),
    ).toBeNull();
  });

  it('opens padded exact windows and never crosses into an ineligible section', () => {
    const built = index();
    const windows = built.resolveWindows(['lm_p2', 'lm_far'], ['section_launch']);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.landmarkId).toBe('lm_p2');
    expect(windows[0]?.startTokenIndex).toBeLessThan(61);
    expect(windows[0]?.endTokenIndex).toBeGreaterThan(140);
  });

  it('drops unknown landmark IDs when opening windows', () => {
    expect(index().resolveWindows(['nope'], ['section_launch'])).toEqual([]);
  });
});

describe('retrieval and preparation requests', () => {
  it('builds a bounded retrieval payload', () => {
    const landmarks = [
      {
        spanId: 'lm_p1',
        sectionId: 'section_launch',
        level: 'paragraph' as const,
        startTokenIndex: 0,
        endTokenIndex: 60,
        text: 'exact text never sent',
        annotation: {
          spanId: 'lm_p1',
          proposition: 'Start with people who already trust you.',
          topicLabels: ['launch'],
          criticalTerms: [],
          conversationalAliases: [],
          exactness: 'balanced' as const,
        },
      },
    ];
    const build = buildRetrievalRequest(context(), 'recover_1', landmarks, 'lmhash', {
      direction: 'forward',
      fraction: 0.4,
    });
    expect(build?.request.landmarkSetHash).toBe('lmhash');
    expect(build?.request.payload.landmarks).toEqual([
      { id: 'lm_p1', proposition: 'Start with people who already trust you.', topics: ['launch'] },
    ]);
    // §37.2: retrieval sends propositions, not the exact script text.
    expect(JSON.stringify(build?.request.payload)).not.toContain('exact text never sent');
  });

  it('builds a preparation request bounded by span count', () => {
    const spans: LandmarkSpan[] = Array.from({ length: 200 }, (_, i) => ({
      spanId: `s${i}`,
      sectionId: 'section_launch',
      level: 'sentence',
      startTokenIndex: i,
      endTokenIndex: i + 1,
      text: `sentence ${i}`,
    }));
    const request = buildPreparationRequest('prep_1', 'sc_1', 'section_launch', 'Launch', spans);
    expect(request?.payload.spans).toHaveLength(CONTEXT_LIMITS.maxPreparationSpans);
    expect(buildPreparationRequest('prep_1', 'sc_1', 's', 't', [])).toBeNull();
  });
});
