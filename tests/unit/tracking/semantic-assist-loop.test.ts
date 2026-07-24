/**
 * B4 regression: Luna semantic assist had no input, so it never happened.
 *
 * `SemanticAssistScheduler`, its validation, its fusion, and the worker's
 * `semantic_assist` handler were all complete and all correct. What did not
 * exist was the *other* direction: `AssistSchedulingContext.candidates` must be
 * `LocalCandidate[]` from the alignment engine, and `TrackingWorkerOutbound`
 * had no candidate message at all. The sidecar was therefore inert by
 * construction — no context could ever be built, so no request was ever issued
 * and no evidence ever reached the beam.
 *
 * This file closes the loop and pins the two properties that make it safe:
 *
 *  - candidates are emitted AFTER the hard section-eligibility gate, so a
 *    prohibited destination is never even shown to Luna (§13, §51 step 6);
 *  - the emission is rate-limited and finalized-evidence-only, so it never
 *    lands on the per-transcript-event path (§63).
 *
 * The loop is exercised through the REAL tracking worker module, the REAL
 * scheduler, and the REAL fusion/validation layers.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { candidateIdFor } from '../../../src/shared/tracking/alignment-v2';
import { SemanticSidecar } from '../../../src/control/services/semantic-sidecar';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import {
  createWorkerTrackingDriver,
  setTrackingWorkerFactoryForTesting,
} from '../../../src/control/services/session';
import type { CompiledScript } from '../../../src/shared/contracts';
import { resolveSmoothFollowProfile } from '../../../src/shared/tracking/profile';
import type { SemanticAssistEvidence } from '../../../src/shared/tracking/semantic-assist';
import type {
  AssistSchedulingContext,
  SemanticAssistResult,
  SemanticClassificationRequest,
  SemanticOperationResponse,
} from '../../../src/shared/semantic';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../../src/shared/tracking/worker-protocol';
import { compileFixtureScript, demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

/**
 * A script that says the same sentence twice inside one section, so the local
 * aligner genuinely has two comparable candidates — which is the only situation
 * in which asking Luna is worth anything at all.
 */
const AMBIGUOUS_SOURCE = `# Chapter

The signal drifts and the colours settle into place before the metronome begins.
Everything is calm for a while and then the room changes again completely.
The signal drifts and the colours settle into place before the metronome begins.
And afterwards we talk about what the audience actually noticed in the room.`;

function ambiguousDocument() {
  return compileFixtureScript(AMBIGUOUS_SOURCE, { rareWords: ['metronome', 'colours'] });
}

/* ---------------------------------------------------------------------------
 * The real worker module, hosted on a stubbed `self`
 * ------------------------------------------------------------------------- */

let workerOnMessage: ((event: { data: TrackingWorkerInbound }) => void) | null = null;
let posted: TrackingWorkerOutbound[] = [];

beforeAll(async () => {
  const stub = {
    postMessage(message: TrackingWorkerOutbound): void {
      posted.push(message);
    },
    onmessage: null as unknown,
  };
  (globalThis as unknown as { self: unknown }).self = stub;
  await import('../../../src/workers/tracking.worker');
  workerOnMessage = stub.onmessage as typeof workerOnMessage;
  expect(workerOnMessage).toBeTypeOf('function');
});

function send(message: TrackingWorkerInbound): void {
  workerOnMessage?.({ data: message });
}

function outbound<T extends TrackingWorkerOutbound['type']>(
  type: T,
): Array<Extract<TrackingWorkerOutbound, { type: T }>> {
  return posted.filter((m) => m.type === type) as Array<
    Extract<TrackingWorkerOutbound, { type: T }>
  >;
}

afterEach(() => {
  setInvokeForTesting(null);
});

/* ---------------------------------------------------------------------------
 * Emission
 * ------------------------------------------------------------------------- */

describe('the worker emits the local candidate set (companion §37.1)', () => {
  it('posts semantic_context with beam-minted ids and post-gate candidates', () => {
    posted = [];
    send({
      type: 'initialize',
      document: ambiguousDocument(),
      session: { sessionId: 'loop', sessionGeneration: 1, stageGeneration: 1 },
      nowMs: 0,
    });
    send({ type: 'resume', nowMs: 0 });

    const scripter = new TranscriptScripter(10_000, 1);
    for (const event of scripter.speak({
      text: 'The signal drifts and the colours settle into place before the metronome begins.',
    })) {
      send({ type: 'transcript_event', event });
    }

    const contexts = outbound('semantic_context');
    // Pre-fix this message type did not exist; `posted` could never contain one.
    expect(contexts.length).toBeGreaterThan(0);
    const context = contexts[contexts.length - 1]!.context;
    expect(context.candidates.length).toBeGreaterThanOrEqual(2);
    for (const candidate of context.candidates) {
      // The id must be the beam's own, or a returned opinion attaches to nothing.
      expect(candidate.id).toMatch(/^[a-z_]+:\d+$/);
      expect(candidate.sectionTransitionAllowed).toBe(true);
      expect(candidate.text.length).toBeGreaterThan(0);
      expect(candidate.supportKinds.length).toBeGreaterThan(0);
    }
    expect(context.sessionId).toBe('loop');
    expect(context.currentSectionId).toBe('h0');
  });

  it('is rate-limited, not per-event (§63)', () => {
    posted = [];
    send({
      type: 'initialize',
      document: ambiguousDocument(),
      session: { sessionId: 'cadence', sessionGeneration: 1, stageGeneration: 1 },
      nowMs: 0,
    });
    send({ type: 'resume', nowMs: 0 });

    const scripter = new TranscriptScripter(10_000, 1);
    let events = 0;
    let firstAtMs = Infinity;
    let lastAtMs = 0;
    for (const text of [
      'The signal drifts and the colours settle',
      'into place before the metronome begins',
      'Everything is calm for a while',
      'and then the room changes again completely',
    ]) {
      for (const event of scripter.speak({ text })) {
        events++;
        firstAtMs = Math.min(firstAtMs, event.receivedAtMs);
        lastAtMs = Math.max(lastAtMs, event.receivedAtMs);
        send({ type: 'transcript_event', event });
      }
    }

    const contexts = outbound('semantic_context');
    const spanMs = lastAtMs - firstAtMs;
    const ceiling = Math.ceil(spanMs / DEFAULT_TRACKING_PROFILE.semanticContextIntervalMs) + 1;
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.length).toBeLessThanOrEqual(ceiling);
    // The point of the throttle: far fewer emissions than transcript events.
    expect(contexts.length).toBeLessThan(events);
  });
});

/* ---------------------------------------------------------------------------
 * The section gate
 * ------------------------------------------------------------------------- */

describe('a section-ineligible candidate is never offered to Luna (§13, §51 step 6)', () => {
  it('the blocked distant-chapter candidate is absent from every emitted list', () => {
    posted = [];
    send({
      type: 'initialize',
      document: demoDocument(),
      session: { sessionId: 'gate', sessionGeneration: 1, stageGeneration: 1 },
      nowMs: 0,
    });
    send({ type: 'resume', nowMs: 0 });

    const scripter = new TranscriptScripter(10_000, 1);
    // Acquire inside "Welcome" (tokens 0–61).
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      send({ type: 'transcript_event', event });
    }
    // Then speak a sentence that exists only in "The Kaleidoscope Demo" (62+).
    for (const event of scripter.speak({
      text: 'Now watch the kaleidoscope demo carefully because the colors shift like a metronome keeping perfect time.',
    })) {
      send({ type: 'transcript_event', event });
    }

    const contexts = outbound('semantic_context');
    expect(contexts.length).toBeGreaterThan(0);

    const offered = contexts.flatMap((m) => m.context.candidates);
    expect(offered.length).toBeGreaterThan(0);
    // Not one candidate lies in the prohibited chapter, and none claims a
    // section other than the one the cursor is actually in.
    for (const candidate of offered) {
      expect(candidate.startTokenIndex).toBeLessThan(62);
      expect(candidate.sectionId).toBe('h0');
    }
  });

  it('the engine did see and reject the distant candidate (it was gated, not outscored)', () => {
    const engine = new AlignmentEngine(demoDocument(), {
      sessionId: 'gate-direct',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      engine.handleTranscriptEvent(event);
    }
    const contexts: AssistSchedulingContext[] = [];
    for (const event of scripter.speak({
      text: 'Now watch the kaleidoscope demo carefully because the colors shift like a metronome keeping perfect time.',
    })) {
      const out = engine.handleTranscriptEvent(event);
      if (out.semanticContext) contexts.push(out.semanticContext);
    }
    // The gate rejected candidates on this pass…
    expect(engine.measurement?.blockedCount ?? 0).toBeGreaterThan(0);
    const blocked = engine.measurement?.blocked;
    expect(blocked?.reason).toBe('prohibited_non_contiguous');
    // …and the rejected position is not in anything we offered.
    const blockedId =
      blocked === undefined ? '' : candidateIdFor('continuity', blocked.tokenPosition);
    for (const context of contexts) {
      expect(context.candidates.map((c) => c.id)).not.toContain(blockedId);
      for (const candidate of context.candidates) {
        expect(candidate.startTokenIndex).not.toBe(blocked?.tokenPosition);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * The whole loop
 * ------------------------------------------------------------------------- */

/** A Luna response the validator accepts, built from the request it answers. */
function classificationResponse(
  request: SemanticClassificationRequest,
  selectedCandidateId: string,
): SemanticOperationResponse<SemanticAssistResult> {
  const result: SemanticAssistResult = {
    schemaVersion: 1,
    requestId: request.requestId,
    semanticEpoch: request.semanticEpoch,
    transcriptRevision: request.transcriptRevision,
    candidateSetHash: request.candidateSetHash,
    relation: 'near_exact',
    selectedCandidateId,
    selectedCandidateConfidence: 0.9,
    transcriptCoverage: 0.9,
    candidateCoverage: 0.9,
    shouldInfluenceTracking: true,
    criticalMismatch: 'none',
    coachTipCode: 'none',
    confidence: 0.9,
  };
  return {
    result,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningTokens: 0,
      totalTokens: 120,
    },
    cache: { cachedInputTokens: 0, cacheHit: false, cacheHitRatio: 0, promptCacheKey: null },
    latencyMs: 40,
    model: 'gpt-5.6-luna',
  };
}

describe('end to end: candidates → scheduler → semantic_assist the worker accepts', () => {
  it('closes the loop and the beam applies the bounded evidence', async () => {
    posted = [];
    send({
      type: 'initialize',
      document: ambiguousDocument(),
      session: { sessionId: 'e2e', sessionGeneration: 1, stageGeneration: 1 },
      nowMs: 0,
    });
    send({ type: 'resume', nowMs: 0 });

    const scripter = new TranscriptScripter(10_000, 1);
    for (const event of scripter.speak({
      text: 'The signal drifts and the colours settle into place before the metronome begins.',
    })) {
      send({ type: 'transcript_event', event });
    }
    const context = outbound('semantic_context').at(-1)?.context;
    expect(context).toBeDefined();
    if (context === undefined) throw new Error('no candidate context');

    // The forward/continuity candidate is the one Luna will endorse.
    const target = context.candidates.find((c) => c.relationHint === 'continuity');
    expect(target).toBeDefined();

    let requested: SemanticClassificationRequest | null = null;
    setInvokeForTesting(<T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command !== 'classify_semantic_tracking_window') return Promise.resolve(null as T);
      requested = (args as { request: SemanticClassificationRequest }).request;
      return Promise.resolve(
        classificationResponse(requested, target!.id) as unknown as T,
      );
    });

    const evidence: SemanticAssistEvidence[] = [];
    let emit: ((c: AssistSchedulingContext) => void) | null = null;
    const sidecar = new SemanticSidecar({
      sessionId: 'e2e',
      sessionGeneration: 1,
      profile: resolveSmoothFollowProfile(),
      // §35.3: Enhanced analyses stable finalized windows, which is what a
      // clean read of a repeated sentence is.
      mode: 'enhanced',
      now: () => context.sessionTimeMs,
      postAssistEvidence: (value) => {
        evidence.push(value);
        // The single integration line the fusion module documents.
        send({ type: 'semantic_assist', evidence: value });
      },
    });
    sidecar.attachContextSource((sink) => {
      emit = sink;
      return () => {
        emit = null;
      };
    });
    expect(emit).not.toBeNull();

    emit!(context);
    await sidecar.scheduler.settle();

    // 1. A request was actually issued, candidate-bounded.
    expect(requested).not.toBeNull();
    expect(requested!.payload.candidates.map((c) => c.id)).toContain(target!.id);
    expect(requested!.payload.candidates.length).toBeLessThanOrEqual(6);

    // 2. Fused, validated evidence came back in the worker's inbound shape.
    expect(evidence).toHaveLength(1);
    const value = evidence[0]!;
    expect(value.epoch).toBe(context.semanticEpoch);
    expect(value.sourceItemIds).toEqual(context.sourceItemIds);
    expect(value.opinions.map((o) => o.candidateId)).toEqual([target!.id]);

    // 3. The worker accepted the message — no protocol error was raised.
    expect(outbound('error')).toEqual([]);

    // 4. And the beam actually applies it. Replayed on an identical engine
    //    (same document, same scripter seed and timing) so the candidate ids
    //    and the clocks are the ones the evidence was built against — the
    //    evidence goes in exactly as the sidecar produced it, TTL included.
    const engine = new AlignmentEngine(ambiguousDocument(), {
      sessionId: 'e2e',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const replay = new TranscriptScripter(10_000, 1);
    for (const event of replay.speak({
      text: 'The signal drifts and the colours settle into place before the metronome begins.',
    })) {
      engine.handleTranscriptEvent(event);
    }
    expect(engine.measurement?.candidates.map((c) => candidateIdFor(c.window.scope, c.absolutePosition))).toContain(
      target!.id,
    );
    engine.applySemanticAssist(value);

    // The presenter reads on; the assist rides the following passes.
    const cap = resolveSmoothFollowProfile().alignment.semanticInfluenceMax;
    let applied = 0;
    let maxInfluence = 0;
    for (const event of replay.speak({
      text: 'The signal drifts and the colours settle into place before the metronome begins.',
    })) {
      engine.handleTranscriptEvent(event);
      if (engine.measurement?.semanticAssistId !== value.assistId) continue;
      applied++;
      for (const hypothesis of engine.measurement.hypotheses) {
        maxInfluence = Math.max(maxInfluence, Math.abs(hypothesis.semanticScore));
      }
    }
    // Pre-fix nothing could ever produce this evidence, so `applied` was 0.
    expect(applied).toBeGreaterThan(0);
    expect(maxInfluence).toBeGreaterThan(0);
    // Bounded (§40.1): never more than the profile cap scaled by local score.
    expect(maxInfluence).toBeLessThanOrEqual(cap + 1e-9);
  });

  it('the control-side driver carries both halves of the seam', () => {
    const worker = {
      posted: [] as TrackingWorkerInbound[],
      listener: null as null | ((event: MessageEvent) => void),
      postMessage(message: unknown) {
        this.posted.push(message as TrackingWorkerInbound);
      },
      addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        this.listener = listener;
      },
      terminate() {},
    };
    setTrackingWorkerFactoryForTesting(() => worker);
    try {
      const document = ambiguousDocument();
      const received: AssistSchedulingContext[] = [];
      const driver = createWorkerTrackingDriver({
        sessionId: 'seam',
        scriptId: document.scriptId,
        sentences: [],
        totalTokens: document.spokenTokens.length,
        // The driver only needs the compiled shape for initialization here.
        compiled: {
          ...(document as unknown as CompiledScript),
          sentences: [],
          literalCommandRanges: [],
        },
        onSnapshot: () => {},
        onTranscript: () => {},
        onSemanticContext: (context) => received.push(context),
      });

      const context = { sessionId: 'seam', candidates: [] } as unknown as AssistSchedulingContext;
      worker.listener?.({
        data: { type: 'semantic_context', revision: 7, context },
      } as MessageEvent);
      expect(received).toEqual([context]);

      const evidence: SemanticAssistEvidence = {
        assistId: 'a1',
        epoch: 0,
        requestRevision: 7,
        sourceItemIds: ['item-1-0'],
        receivedAtMs: 1,
        opinions: [{ candidateId: 'continuity:13', relation: 'near_exact', confidence: 0.9 }],
      };
      driver.applySemanticAssist(evidence);
      expect(worker.posted).toContainEqual({ type: 'semantic_assist', evidence });
    } finally {
      setTrackingWorkerFactoryForTesting(null);
    }
  });

  it('a stale epoch is rejected outright (§25.7)', () => {
    const engine = new AlignmentEngine(ambiguousDocument(), {
      sessionId: 'stale',
      sessionGeneration: 1,
      stageGeneration: 1,
    });
    const scripter = new TranscriptScripter(10_000, 1);
    for (const event of scripter.speak({ text: 'The signal drifts and the colours settle' })) {
      engine.handleTranscriptEvent(event);
    }
    engine.applySemanticAssist({
      assistId: 'stale-1',
      epoch: engine.semanticEpoch + 1,
      requestRevision: 1,
      sourceItemIds: [],
      receivedAtMs: 0,
      opinions: [{ candidateId: candidateIdFor('continuity', 5), relation: 'near_exact', confidence: 1 }],
    });
    for (const event of scripter.speak({ text: 'into place before the metronome begins' })) {
      engine.handleTranscriptEvent(event);
    }
    expect(engine.measurement?.semanticAssistId).toBeUndefined();
  });
});
