/**
 * Semantic assist scheduler (companion §35, §36, §42, §58, Appendix B.6).
 * Modes, cadence, lanes, staleness, budget, and degraded operation.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts/smooth-follow';
import { SemanticLandmarkIndex } from '../../../src/shared/semantic/landmark-index';
import {
  classifyAssistTrigger,
  landmarkRecoveryAllowed,
  SemanticAssistScheduler,
  type SemanticInvoker,
} from '../../../src/shared/semantic/scheduler';
import type {
  AssistSchedulingContext,
  CoachTipCandidate,
  IntelligenceMode,
  LocalCandidate,
  SemanticAssistMessage,
  SemanticAvailability,
  SemanticOperationResponse,
} from '../../../src/shared/semantic/types';

/* ------------------------------------------------------------------ setup */

function candidate(overrides: Partial<LocalCandidate> & { id: string }): LocalCandidate {
  return {
    relationHint: 'continuity',
    distance: 'near_forward',
    text: 'The simplest approach is to begin with customers who already trust you.',
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
    provisionalTail: '',
    hasNewFinalMeaningfulSpeech: true,
    newFinalTokenCount: 9,
    atPhraseBoundary: true,
    commandPending: false,
    sessionPaused: false,
    reanchorActive: false,
    localConfidence: 0.5,
    sustainedAmbiguityMs: 1_000,
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

function assistResponse(
  requestId: string,
  candidateSetHash: string,
  overrides: Record<string, unknown> = {},
): SemanticOperationResponse<unknown> {
  return {
    result: {
      schemaVersion: 1,
      requestId,
      semanticEpoch: 7,
      transcriptRevision: 993,
      candidateSetHash,
      relation: 'paraphrase',
      selectedCandidateId: 'cand_a',
      selectedCandidateConfidence: 0.8,
      transcriptCoverage: 0.7,
      candidateCoverage: 0.6,
      shouldInfluenceTracking: true,
      criticalMismatch: 'none',
      coachTipCode: 'none',
      confidence: 0.78,
      ...overrides,
    },
    usage: {
      inputTokens: 1200,
      cachedInputTokens: 1024,
      outputTokens: 30,
      reasoningTokens: 8,
      totalTokens: 1230,
    },
    cache: { cachedInputTokens: 1024, cacheHit: true, cacheHitRatio: 0.85, promptCacheKey: 'k' },
    latencyMs: 180,
    model: 'gpt-5.6-luna',
  };
}

interface Harness {
  scheduler: SemanticAssistScheduler;
  invoker: SemanticInvoker;
  classify: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  assists: SemanticAssistMessage[];
  tips: CoachTipCandidate[];
  availability: SemanticAvailability[];
  setNow: (ms: number) => void;
}

function harness(
  options: {
    mode?: IntelligenceMode;
    classifyImpl?: (request: unknown) => Promise<SemanticOperationResponse<unknown>>;
    retrieveImpl?: (request: unknown) => Promise<SemanticOperationResponse<unknown>>;
    landmarkIndex?: SemanticLandmarkIndex;
    budget?: { maxRequestsPerSession?: number };
  } = {},
): Harness {
  let nowMs = 100_000;
  const assists: SemanticAssistMessage[] = [];
  const tips: CoachTipCandidate[] = [];
  const availability: SemanticAvailability[] = [];

  const classify = vi.fn(
    options.classifyImpl ??
      ((request: { requestId: string; candidateSetHash: string }) =>
        Promise.resolve(assistResponse(request.requestId, request.candidateSetHash))),
  );
  const retrieve = vi.fn(
    options.retrieveImpl ?? (() => Promise.reject(new Error('no retrieve impl'))),
  );
  const cancel = vi.fn();
  const invoker = { classify, retrieve, cancel } as unknown as SemanticInvoker;

  const scheduler = new SemanticAssistScheduler({
    invoker,
    now: () => nowMs,
    profile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
    sessionId: 's1',
    sessionGeneration: 1,
    mode: options.mode ?? 'balanced',
    landmarkIndex: options.landmarkIndex,
    budget: options.budget,
    onAssist: (message) => assists.push(message),
    onTipCandidate: (tip) => tips.push(tip),
    onAvailabilityChange: (value) => availability.push(value),
  });

  return {
    scheduler,
    invoker,
    classify,
    retrieve,
    cancel,
    assists,
    tips,
    availability,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

/* ------------------------------------------------------------------ tests */

describe('intelligence modes (§35)', () => {
  it('local_only makes no live requests at all', async () => {
    const h = harness({ mode: 'local_only' });
    for (let i = 0; i < 10; i++) h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.scheduler.getAvailability()).toBe('disabled');
  });

  it('balanced only fires on a material ambiguity trigger', async () => {
    const h = harness({ mode: 'balanced' });
    // Confident, unambiguous read: nothing to resolve.
    h.scheduler.observe(
      context({
        localConfidence: 0.97,
        sustainedAmbiguityMs: 0,
        localTopMarginLogScore: 4,
        trackingState: 'following',
        behavior: 'normal',
      }),
    );
    await h.scheduler.settle();
    expect(h.classify).not.toHaveBeenCalled();

    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it('enhanced additionally analyzes stable finalized windows', () => {
    const stable = context({
      localConfidence: 0.97,
      sustainedAmbiguityMs: 0,
      localTopMarginLogScore: 4,
      trackingState: 'following',
      behavior: 'normal',
      atPhraseBoundary: true,
      newFinalTokenCount: 12,
    });
    expect(classifyAssistTrigger(stable, 'balanced').material).toBe(false);
    const enhanced = classifyAssistTrigger(stable, 'enhanced');
    expect(enhanced.material).toBe(true);
    expect(enhanced.reason).toBe('stable_window');
  });

  /**
   * H7. This test used to resolve with `assistResponse('assist_1', 'x')` — a
   * WRONG candidate-set hash. The response was rejected by schema validation,
   * not by cancellation, so it proved nothing at all about mode switching. It
   * now resolves with a FULLY VALID response and asserts the cancellation
   * diagnostic, which is the only thing that can distinguish the two.
   */
  it('switching to local_only cancels everything in flight', async () => {
    let resolve: ((value: SemanticOperationResponse<unknown>) => void) | undefined;
    let sentHash = '';
    const h = harness({
      classifyImpl: (request) => {
        sentHash = (request as { candidateSetHash: string }).candidateSetHash;
        return new Promise<SemanticOperationResponse<unknown>>((r) => {
          resolve = r;
        });
      },
    });
    h.scheduler.observe(context());
    expect(h.classify).toHaveBeenCalledTimes(1);
    h.scheduler.setMode('local_only');
    expect(h.cancel).toHaveBeenCalledTimes(1);

    // A response the transport failed to abort — `invoker.cancel` is
    // documented as best-effort, so this WILL happen in practice.
    resolve?.(assistResponse('assist_1', sentHash));
    await h.scheduler.settle();

    expect(h.assists).toHaveLength(0);
    const diagnostics = h.scheduler.getDiagnostics();
    // Discarded as stale/cancelled — NOT as a malformed payload.
    expect(diagnostics.staleDiscarded).toBe(1);
    expect(diagnostics.rejectedInvalid).toBe(0);
    expect(diagnostics.acceptedResults).toBe(0);
  });
});

describe('minimum useful input and cadence (§36.2, §36.3)', () => {
  it('does not call for one or two ordinary words', () => {
    const tiny = context({
      newFinalTokenCount: 2,
      atPhraseBoundary: false,
      sustainedAmbiguityMs: 200,
      criticalChecks: [],
    });
    expect(classifyAssistTrigger(tiny, 'balanced').material).toBe(false);
  });

  it('balanced honours the ordinary interval and the burst allowance', async () => {
    const h = harness({ mode: 'balanced' });
    h.setNow(100_000);
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);

    // 1 s later: inside both the ordinary and the burst interval.
    h.setNow(101_000);
    h.scheduler.observe(context({ transcriptRevision: 994 }));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);

    // 2.6 s later: burst interval satisfied, allowance available.
    h.setNow(102_600);
    h.scheduler.observe(context({ transcriptRevision: 995 }));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it('a non-burst trigger must wait the full ordinary interval', async () => {
    const ambiguous = (revision: number) =>
      context({
        transcriptRevision: revision,
        localConfidence: 0.5,
        sustainedAmbiguityMs: 900,
        localTopMarginLogScore: 4,
        trackingState: 'following',
        behavior: 'normal',
      });
    const h = harness({ mode: 'balanced' });
    h.setNow(200_000);
    h.scheduler.observe(ambiguous(1));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);

    h.setNow(203_000);
    h.scheduler.observe(ambiguous(2));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);

    h.setNow(205_100);
    h.scheduler.observe(ambiguous(3));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it('never calls while paused or while command text is pending', async () => {
    const h = harness();
    h.scheduler.observe(context({ sessionPaused: true }));
    h.scheduler.observe(context({ commandPending: true }));
    await h.scheduler.settle();
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('keeps at most one classification request in flight (§36.1)', async () => {
    let pending = 0;
    const h = harness({
      classifyImpl: () => {
        pending += 1;
        return new Promise(() => undefined);
      },
    });
    h.setNow(300_000);
    h.scheduler.observe(context());
    h.setNow(310_000);
    h.scheduler.observe(context({ transcriptRevision: 994 }));
    expect(pending).toBe(1);
  });

  it('supersedes an active request only for a strictly more urgent trigger', () => {
    const h = harness({ classifyImpl: () => new Promise(() => undefined) });
    h.setNow(400_000);
    h.scheduler.observe(context()); // close_candidates, urgency 3
    expect(h.classify).toHaveBeenCalledTimes(1);
    h.setNow(410_000);
    h.scheduler.observe(
      context({
        transcriptRevision: 994,
        criticalChecks: [
          { kind: 'number', scriptFragment: '15%', transcriptFragment: '50%', spanId: 'sp1' },
        ],
      }),
    );
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  /**
   * H7. The supersession test above never resolved the CANCELLED request after
   * its replacement started, so neither of the two defects it should have
   * caught was exercised:
   *   1. A's late settle did `active.delete(lane)` unconditionally, wiping B's
   *      bookkeeping — slackening the in-flight gate and making `cancelAll`
   *      unable to cancel B at all.
   *   2. Supersession is driven by urgency alone and needs no revision bump,
   *      so a late A looked perfectly fresh and was APPLIED over its own
   *      replacement.
   */
  describe('H7: a superseded request settling late', () => {
    interface Deferred {
      resolve(value: SemanticOperationResponse<unknown>): void;
      reject(error: unknown): void;
      hash: string;
    }

    function supersessionHarness(): { h: Harness; calls: Deferred[] } {
      const calls: Deferred[] = [];
      const h = harness({
        classifyImpl: (request) => {
          const hash = (request as { candidateSetHash: string }).candidateSetHash;
          return new Promise<SemanticOperationResponse<unknown>>((resolve, reject) => {
            calls.push({ resolve, reject, hash });
          });
        },
      });
      h.setNow(400_000);
      h.scheduler.observe(context()); // A: close_candidates (urgency 3)
      h.setNow(410_000);
      h.scheduler.observe(
        context({
          criticalChecks: [
            { kind: 'number', scriptFragment: '15%', transcriptFragment: '50%', spanId: 'sp1' },
          ],
        }),
      ); // B: critical_token (urgency 5) — strictly more urgent, supersedes A
      expect(h.classify).toHaveBeenCalledTimes(2);
      return { h, calls };
    }

    /** B never settles in these tests, so `settle()` would hang. */
    async function flush(): Promise<void> {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }

    it('does not apply the cancelled request even when nothing else changed', async () => {
      const { h, calls } = supersessionHarness();
      // A resolves with a completely valid response for its OWN request:
      // correct request id, correct candidate-set hash, unchanged revision.
      calls[0]?.resolve(assistResponse('assist_1', calls[0].hash));
      await flush();

      expect(h.assists).toHaveLength(0);
      expect(h.scheduler.getDiagnostics().acceptedResults).toBe(0);
      expect(h.scheduler.getDiagnostics().staleDiscarded).toBe(1);
      // Discarded for cancellation, not for a malformed payload.
      expect(h.scheduler.getDiagnostics().rejectedInvalid).toBe(0);
    });

    it('does not destroy the replacement request bookkeeping', async () => {
      const { h, calls } = supersessionHarness();
      calls[0]?.resolve(assistResponse('assist_1', calls[0].hash));
      await flush();

      // B is still genuinely in flight, so `cancelAll` must still reach it.
      h.cancel.mockClear();
      h.scheduler.cancelAll();
      expect(h.cancel).toHaveBeenCalledTimes(1);
    });

    it('a late FAILURE from the cancelled request also leaves the replacement intact', async () => {
      const { h, calls } = supersessionHarness();
      calls[0]?.reject(new Error('A failed after being superseded'));
      await flush();

      h.cancel.mockClear();
      h.scheduler.cancelAll();
      expect(h.cancel).toHaveBeenCalledTimes(1); // B still tracked
    });

    it('applies the replacement normally once IT settles', async () => {
      const { h, calls } = supersessionHarness();
      calls[0]?.resolve(assistResponse('assist_1', calls[0].hash));
      await flush();
      calls[1]?.resolve(assistResponse('assist_2', calls[1].hash));
      await flush();

      expect(h.scheduler.getDiagnostics().acceptedResults).toBe(1);
    });
  });

  /**
   * H7: reused candidate ids with changed spans. The old check was an id
   * SUBSET test, so a candidate whose span/section/text had moved under a
   * stable id passed as "still fresh" and its stale classification was applied
   * — pointing the follower at the wrong place in the script.
   */
  it('H7: rejects a response when a candidate id was reused with a changed span', async () => {
    let resolve: ((value: SemanticOperationResponse<unknown>) => void) | undefined;
    let sentHash = '';
    const h = harness({
      classifyImpl: (request) => {
        sentHash = (request as { candidateSetHash: string }).candidateSetHash;
        return new Promise<SemanticOperationResponse<unknown>>((r) => {
          resolve = r;
        });
      },
    });
    h.setNow(500_000);
    const before = context();
    h.scheduler.observe(before);
    expect(h.classify).toHaveBeenCalledTimes(1);

    // Same ids, same revision/epoch/compile hash — but the spans moved.
    h.scheduler.observe(
      context({
        candidates: before.candidates.map((candidate) => ({
          ...candidate,
          startTokenIndex: candidate.startTokenIndex + 40,
          endTokenIndex: candidate.endTokenIndex + 40,
        })),
      }),
    );

    resolve?.(assistResponse('assist_1', sentHash));
    await h.scheduler.settle();

    expect(h.assists).toHaveLength(0);
    expect(h.scheduler.getDiagnostics().staleDiscarded).toBeGreaterThan(0);
    expect(h.scheduler.getDiagnostics().acceptedResults).toBe(0);
  });

  /**
   * H7: finality must match. Evidence computed over a provisional tail cannot
   * be presented as final — `finalEvidence` was read off the CURRENT context
   * rather than the one the request was built over.
   */
  it('H7: rejects a response whose finality no longer matches the request', async () => {
    let resolve: ((value: SemanticOperationResponse<unknown>) => void) | undefined;
    let sentHash = '';
    const h = harness({
      classifyImpl: (request) => {
        sentHash = (request as { candidateSetHash: string }).candidateSetHash;
        return new Promise<SemanticOperationResponse<unknown>>((r) => {
          resolve = r;
        });
      },
    });
    h.setNow(600_000);
    h.scheduler.observe(context({ provisionalTail: '' })); // final evidence
    h.scheduler.observe(context({ provisionalTail: 'and then we' })); // now provisional

    resolve?.(assistResponse('assist_1', sentHash));
    await h.scheduler.settle();
    expect(h.assists).toHaveLength(0);
    expect(h.scheduler.getDiagnostics().acceptedResults).toBe(0);
  });

  /**
   * H7: the tracking worker rejects assist evidence by source item set, so
   * evidence must not be labelled with items it was never computed over.
   */
  it('H7: rejects a response whose source items have moved on', async () => {
    let resolve: ((value: SemanticOperationResponse<unknown>) => void) | undefined;
    let sentHash = '';
    const h = harness({
      classifyImpl: (request) => {
        sentHash = (request as { candidateSetHash: string }).candidateSetHash;
        return new Promise<SemanticOperationResponse<unknown>>((r) => {
          resolve = r;
        });
      },
    });
    h.setNow(700_000);
    h.scheduler.observe(context({ sourceItemIds: ['item_1', 'item_2'] }));
    h.scheduler.observe(context({ sourceItemIds: ['item_3', 'item_4'] }));

    resolve?.(assistResponse('assist_1', sentHash));
    await h.scheduler.settle();
    expect(h.assists).toHaveLength(0);
    expect(h.scheduler.getDiagnostics().acceptedResults).toBe(0);
  });
});

describe('stale responses (§36.4)', () => {
  it('discards a response whose semantic epoch was superseded', async () => {
    let resolve: ((value: SemanticOperationResponse<unknown>) => void) | undefined;
    const h = harness({
      classifyImpl: (request) =>
        new Promise((r) => {
          resolve = () =>
            r(
              assistResponse(
                (request as { requestId: string }).requestId,
                (request as { candidateSetHash: string }).candidateSetHash,
              ),
            );
        }),
    });
    h.scheduler.observe(context());
    // A command navigation bumps the epoch while the request is in flight.
    h.scheduler.observe(context({ semanticEpoch: 8 }));
    resolve?.(assistResponse('x', 'y'));
    await h.scheduler.settle();
    expect(h.assists).toHaveLength(0);
    expect(h.scheduler.getDiagnostics().staleDiscarded).toBe(1);
  });

  it('discards a response after the script recompiled', async () => {
    let resolve: (() => void) | undefined;
    const h = harness({
      classifyImpl: (request) =>
        new Promise((r) => {
          resolve = () =>
            r(
              assistResponse(
                (request as { requestId: string }).requestId,
                (request as { candidateSetHash: string }).candidateSetHash,
              ),
            );
        }),
    });
    h.scheduler.observe(context());
    h.scheduler.observe(context({ scriptCompileHash: 'sc_2' }));
    resolve?.();
    await h.scheduler.settle();
    expect(h.assists).toHaveLength(0);
    expect(h.scheduler.getDiagnostics().staleDiscarded).toBe(1);
  });

  it('applies a response that is still current', async () => {
    const h = harness();
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.assists).toHaveLength(1);
    expect(h.assists[0]?.evidence[0]?.candidateId).toBe('cand_a');
    expect(h.scheduler.getDiagnostics().acceptedResults).toBe(1);
  });

  it('rejects an invalid response without applying anything', async () => {
    const h = harness({
      classifyImpl: (request) =>
        Promise.resolve(
          assistResponse(
            (request as { requestId: string }).requestId,
            (request as { candidateSetHash: string }).candidateSetHash,
            { selectedCandidateId: 'cand_invented' },
          ),
        ),
    });
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.assists).toHaveLength(0);
    expect(h.scheduler.getDiagnostics().rejectedInvalid).toBe(1);
  });
});

describe('lanes (§36.1, §37.4)', () => {
  function preparedIndex(): SemanticLandmarkIndex {
    const index = new SemanticLandmarkIndex('sc_1');
    index.ingest(
      {
        schemaVersion: 1,
        requestId: 'prep',
        scriptCompileHash: 'sc_1',
        sectionId: 'section_launch',
        annotations: [
          {
            spanId: 'lm_p1',
            proposition: 'Start with the audience that already trusts the product.',
            topicLabels: ['launch'],
            criticalTerms: [],
            conversationalAliases: [],
            exactness: 'balanced',
          },
        ],
      },
      [
        {
          spanId: 'lm_p1',
          sectionId: 'section_launch',
          level: 'paragraph',
          startTokenIndex: 90,
          endTokenIndex: 140,
          text: 'exact script text',
        },
      ],
    );
    return index;
  }

  const lostContext = () =>
    context({
      localConfidence: 0.2,
      sustainedAmbiguityMs: 0,
      localTopMarginLogScore: 4,
      trackingState: 'lost_local',
      behavior: 'lost',
      atPhraseBoundary: false,
      newFinalTokenCount: 10,
      lexicalFailureMs: 6_000,
      candidates: [candidate({ id: 'cand_a', localScoreBand: 'weak' })],
    });

  it('runs recovery only after sustained lexical failure', () => {
    const index = preparedIndex();
    expect(landmarkRecoveryAllowed(lostContext(), index)).toBe(true);
    expect(landmarkRecoveryAllowed({ ...lostContext(), lexicalFailureMs: 500 }, index)).toBe(false);
  });

  it('never runs recovery without a prepared landmark index', () => {
    expect(landmarkRecoveryAllowed(lostContext(), undefined)).toBe(false);
    expect(landmarkRecoveryAllowed(lostContext(), new SemanticLandmarkIndex('sc_1'))).toBe(false);
  });

  it('never runs recovery when an ordinary candidate is already strong', () => {
    const strong = {
      ...lostContext(),
      candidates: [candidate({ id: 'cand_a', localScoreBand: 'strong' as const })],
    };
    expect(landmarkRecoveryAllowed(strong, preparedIndex())).toBe(false);
  });

  it('a landmark response opens candidate windows and never moves the cursor', async () => {
    const index = preparedIndex();
    const windows: unknown[] = [];
    let nowMs = 500_000;
    const scheduler = new SemanticAssistScheduler({
      invoker: {
        classify: () => Promise.reject(new Error('unused')),
        retrieve: (request) =>
          Promise.resolve({
            result: {
              schemaVersion: 1,
              requestId: request.requestId,
              semanticEpoch: 7,
              transcriptRevision: 993,
              landmarkSetHash: request.landmarkSetHash,
              relation: 'likely_current_passage',
              candidateLandmarkIds: ['lm_p1'],
              confidence: 0.8,
            },
            usage: {
              inputTokens: 200,
              cachedInputTokens: 0,
              outputTokens: 10,
              reasoningTokens: 0,
              totalTokens: 210,
            },
            cache: {
              cachedInputTokens: 0,
              cacheHit: false,
              cacheHitRatio: 0,
              promptCacheKey: null,
            },
            latencyMs: 120,
            model: 'gpt-5.6-luna',
          }),
        cancel: () => undefined,
      },
      now: () => nowMs,
      profile: DEFAULT_SMOOTH_FOLLOW_PROFILE,
      sessionId: 's1',
      sessionGeneration: 1,
      mode: 'balanced',
      landmarkIndex: index,
      onCandidateWindows: (value) => windows.push(...value),
    });
    nowMs = 500_000;
    scheduler.observe(lostContext());
    await scheduler.settle();
    expect(windows).toHaveLength(1);
    expect(scheduler.getDiagnostics().requestsByLane.landmark_recovery).toBe(1);
  });
});

describe('cost controls and degraded operation (§42, §58)', () => {
  it('stops making requests when the session budget is exhausted', async () => {
    const h = harness({ budget: { maxRequestsPerSession: 1 } });
    h.setNow(600_000);
    h.scheduler.observe(context());
    await h.scheduler.settle();
    h.setNow(700_000);
    h.scheduler.observe(context({ transcriptRevision: 994 }));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.scheduler.getAvailability()).toBe('budget_exhausted');
  });

  it('accumulates usage and cache diagnostics', async () => {
    const h = harness();
    h.scheduler.observe(context());
    await h.scheduler.settle();
    const diagnostics = h.scheduler.getDiagnostics();
    expect(diagnostics.usage.cachedInputTokens).toBe(1024);
    expect(diagnostics.cacheHits).toBe(1);
    expect(diagnostics.latencySamplesMs).toEqual([180]);
    expect(diagnostics.estimatedCostUsd).toBeNull();
  });

  it('degrades silently on a quota error and backs off', async () => {
    const h = harness({
      classifyImpl: () => Promise.reject({ code: 'QUOTA_EXHAUSTED', category: 'quota' }),
    });
    h.setNow(800_000);
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.scheduler.getAvailability()).toBe('degraded_quota');
    expect(h.availability).toContain('degraded_quota');

    // Still inside the backoff window: no further requests.
    h.setNow(801_000);
    h.scheduler.observe(context({ transcriptRevision: 994 }));
    await h.scheduler.settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it('classifies timeout and rate-limit failures distinctly', async () => {
    const timeout = harness({
      classifyImpl: () => Promise.reject({ code: 'NETWORK_TIMEOUT' }),
    });
    timeout.scheduler.observe(context());
    await timeout.scheduler.settle();
    expect(timeout.scheduler.getAvailability()).toBe('degraded_timeout');

    const limited = harness({ classifyImpl: () => Promise.reject({ code: 'RATE_LIMITED' }) });
    limited.scheduler.observe(context());
    await limited.scheduler.settle();
    expect(limited.scheduler.getAvailability()).toBe('degraded_rate_limited');
  });

  it('a local cancellation is not a failure and triggers no backoff', async () => {
    const h = harness({
      classifyImpl: () =>
        Promise.reject({
          code: 'PROVIDER_UNAVAILABLE',
          details: { semanticFailure: 'cancelled' },
        }),
    });
    h.setNow(900_000);
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.scheduler.getDiagnostics().failures).toBe(0);
    expect(h.scheduler.getAvailability()).toBe('ready');
  });

  it('recovers to ready after a successful result', async () => {
    let fail = true;
    const h = harness({
      classifyImpl: (request) => {
        if (fail) {
          fail = false;
          return Promise.reject({ code: 'NETWORK_TIMEOUT' });
        }
        return Promise.resolve(
          assistResponse(
            (request as { requestId: string }).requestId,
            (request as { candidateSetHash: string }).candidateSetHash,
          ),
        );
      },
    });
    h.setNow(1_000_000);
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.scheduler.getAvailability()).toBe('degraded_timeout');

    h.setNow(1_010_000); // past the first backoff step
    h.scheduler.observe(context({ transcriptRevision: 994 }));
    await h.scheduler.settle();
    expect(h.scheduler.getAvailability()).toBe('ready');
  });
});

describe('tip candidates', () => {
  it('forwards a validated tip code with final-evidence provenance', async () => {
    const h = harness({
      classifyImpl: (request) =>
        Promise.resolve(
          assistResponse(
            (request as { requestId: string }).requestId,
            (request as { candidateSetHash: string }).candidateSetHash,
            { criticalMismatch: 'number', coachTipCode: 'number_changed', relation: 'near_exact' },
          ),
        ),
    });
    h.scheduler.observe(context());
    await h.scheduler.settle();
    expect(h.tips).toHaveLength(1);
    expect(h.tips[0]?.code).toBe('number_changed');
    expect(h.tips[0]?.finalEvidence).toBe(true);
  });

  it('marks a tip as provisional when a provisional tail is present', async () => {
    const h = harness({
      classifyImpl: (request) =>
        Promise.resolve(
          assistResponse(
            (request as { requestId: string }).requestId,
            (request as { candidateSetHash: string }).candidateSetHash,
            { criticalMismatch: 'name', coachTipCode: 'name_changed', relation: 'near_exact' },
          ),
        ),
    });
    h.scheduler.observe(context({ provisionalTail: 'then expand' }));
    await h.scheduler.settle();
    expect(h.tips[0]?.finalEvidence).toBe(false);
  });
});
