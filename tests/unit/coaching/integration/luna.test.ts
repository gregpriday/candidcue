/**
 * §20 / §23 / §25.5 through the integrator.
 *
 * Two things are proved here that no lane suite can prove on its own:
 *
 * 1. `observeParaphrase` asks the materiality *question* and only Luna answers
 *    it. The candidate is never offered to the policy locally, so
 *    `MATERIAL_MEANING_CHANGE` reaches the glass by exactly one route and
 *    carries `source: 'luna_validated'` when it does.
 * 2. `LunaCoachObserver` requires a **live** clock/epoch/take-pass reader. This
 *    is its first production call site, and a `liveContext` built from
 *    issue-time values would make every staleness rule in §23.1 unfireable —
 *    which is the bug it was just fixed for.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness, prose } from './harness';
import type {
  CoachObserverResponse,
  CoachObserverTransport,
} from '../../../../src/shared/coaching/coach/luna-observer';
import type { LunaCoachRequest } from '../../../../src/shared/contracts/coaching';
import type { FidelitySpanObservation } from '../../../../src/shared/coaching/fidelity/comparator';

const AUTHORED =
  'the platform reduces onboarding effort for every new customer account across the region';
// Half the authored content words survive: divergence ≈ 0.5, inside the
// 0.35–0.8 band where a paraphrase is likelier than a misalignment.
const SPOKEN = 'the platform reduces onboarding effort in a different way for every user';

/**
 * A span the presenter delivered in their own words: enough authored content
 * words to be worth asking about, and a divergence inside the 0.35–0.8 band
 * where "paraphrase" is likelier than "misalignment".
 */
function paraphrasedSpan(startMs: number, endMs: number, takePassId: string): FidelitySpanObservation {
  const authoredWords = AUTHORED.split(' ');
  const spokenWords = SPOKEN.split(' ');
  const step = (endMs - startMs) / spokenWords.length;
  return {
    spanId: 'span-1',
    authored: authoredWords.map((surface, index) => ({ tokenIndex: index, surface })),
    spoken: spokenWords.map((surface, index) => ({
      transcriptIndex: index,
      surface,
      final: true,
      audioStartMs: startMs + index * step,
      audioEndMs: startMs + (index + 1) * step,
      commitSequence: 1,
    })),
    alignment: [{ transcriptIndex: 0, scriptTokenIndex: 0 }],
    trackingEpoch: 0,
    takePassId,
  };
}

class ScriptedTransport implements CoachObserverTransport {
  readonly requests: LunaCoachRequest[] = [];
  /** Resolves the next classification; a test can hold it open. */
  private release: (() => void) | null = null;

  constructor(
    private readonly reply: (request: LunaCoachRequest) => CoachObserverResponse,
    private readonly hold = false,
  ) {}

  async classify(request: LunaCoachRequest): Promise<CoachObserverResponse> {
    this.requests.push(request);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return this.reply(request);
  }

  cancel(): void {
    /* best-effort; correctness never depends on it */
  }

  releaseHeld(): void {
    this.release?.();
    this.release = null;
  }
}

function materialityDecision(request: LunaCoachRequest): CoachObserverResponse {
  const evidenceId = request.candidates.find((c) => c.type === 'material_meaning_change')?.evidenceId;
  return {
    result: {
      decision: 'candidate',
      tip_code: 'MATERIAL_MEANING_CHANGE',
      confidence: 0.92,
      evidence_ids: evidenceId === undefined ? [] : [evidenceId],
      scope: 'current_phrase',
      reason_code: 'MATERIAL_DIFFERENCE_CONFIRMED',
      valid_for_ms: 4_000,
    },
    latencyMs: 320,
  };
}

async function runParaphraseTake(
  transport: ScriptedTransport,
  options: { epochBump?: boolean; advanceMsWhileInFlight?: number } = {},
): Promise<TakeHarness> {
  const harness = new TakeHarness({ deps: { lunaTransport: transport } });
  const span = harness.say(prose(15), 6_000);
  harness.orchestrator.noteFidelitySpan(
    paraphrasedSpan(span.startMs, span.endMs, harness.orchestrator.hostState().takePassId),
  );
  // §20.3: candidates coalesce for 800 ms before a request is issued.
  harness.settle(1_200);
  if (options.advanceMsWhileInFlight !== undefined) {
    // Real audio time passes while the model is thinking. §22's
    // `validUntilAudioTimeMs` is measured against *this*.
    harness.speak(options.advanceMsWhileInFlight);
  }
  if (options.epochBump === true) {
    // §5.4: the presenter's position was re-established while the request was
    // in flight. Everything observed before it describes a different
    // performance.
    harness.orchestrator.setHostState({ trackingEpoch: 1 });
  }
  transport.releaseHeld();
  await harness.orchestrator.lunaObserver()?.settle();
  harness.settle(400);
  return harness;
}

describe('coaching integration — Luna', () => {
  it('routes the paraphrase question to Luna and shows the answer as luna_validated', async () => {
    const transport = new ScriptedTransport(materialityDecision);
    const harness = await runParaphraseTake(transport);

    expect(transport.requests).toHaveLength(1);
    // §20.2: the request exists because a candidate needed *semantic* judgement.
    expect(transport.requests[0]?.candidates.map((c) => c.type)).toContain(
      'material_meaning_change',
    );

    const tip = harness.latest()?.activeTip;
    expect(tip?.code).toBe('MATERIAL_MEANING_CHANGE');
    // §25.5 / §20.1: the one code the local layer may ask about but never
    // answer. Reaching the glass any other way would be the bug.
    expect(tip?.source).toBe('luna_validated');
    // §25: an authored key and a bounded substitution, never model prose.
    expect(tip?.textKey).toMatch(/^coach\.tip\.MATERIAL_MEANING_CHANGE/u);
    expect(harness.orchestrator.diagnostics().lunaResponses).toBe(1);
    // §37: the wall-clock round trip is measured, and only here.
    expect(harness.orchestrator.diagnostics().lunaMeanLatencyMs).toBeGreaterThan(0);
  });

  it('never shows the paraphrase tip without Luna', async () => {
    const harness = new TakeHarness();
    const span = harness.say(prose(15), 6_000);
    harness.orchestrator.noteFidelitySpan(
      paraphrasedSpan(span.startMs, span.endMs, harness.orchestrator.hostState().takePassId),
    );
    harness.settle(1_600);
    await Promise.resolve();

    // The candidate exists — the local question was asked and admitted…
    expect(
      harness.orchestrator
        .telemetry()
        .activeCandidates.some((c) => c.type === 'material_meaning_change'),
    ).toBe(true);
    // …and with no observer it can never become a tip.
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
  });

  it('rejects an answer that arrives after its own validity window (§20.5)', async () => {
    const transport = new ScriptedTransport(materialityDecision, true);
    // Five seconds of real audio elapse while the model is thinking — past the
    // request's 4 s `validUntilAudioTimeMs`.
    const harness = await runParaphraseTake(transport, { advanceMsWhileInFlight: 5_000 });

    expect(transport.requests).toHaveLength(1);
    // This is what `liveContext` buys. The observer reads the audio clock at
    // *application* time; built from issue-time values it would compare the
    // request against itself, `past_valid_until` could not fire under any
    // input, and a stale critical alert would have reached the glass.
    expect(harness.orchestrator.diagnostics().lunaRejected).toBe(1);
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
  });

  it('disowns an in-flight answer when the tracking epoch changes (§20.5)', async () => {
    const transport = new ScriptedTransport(materialityDecision, true);
    const harness = await runParaphraseTake(transport, { epochBump: true });

    expect(transport.requests).toHaveLength(1);
    // §26.5: an epoch change drops everything queued and disowns everything in
    // flight, so the answer is never even validated — a stronger guarantee than
    // rejecting it, and the reason `cancelAll` bumps a generation rather than
    // trusting the transport's best-effort `cancel`.
    expect(harness.orchestrator.diagnostics().lunaResponses).toBe(0);
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
  });

  it('disowns the in-flight answer without walking the filler count back (§20.5)', async () => {
    // The two halves of an epoch change, asserted together, because fixing one
    // by breaking the other is exactly what happened before: the count was kept
    // by never propagating the epoch (so nothing was ever disowned), and the
    // epoch was propagated by clearing the count.
    const transport = new ScriptedTransport(materialityDecision, true);
    const harness = new TakeHarness({ deps: { lunaTransport: transport } });
    harness.say('um we should start here', 2_000);
    harness.say('um the next part matters', 2_000);
    const span = harness.say(prose(15), 6_000);
    harness.orchestrator.noteFidelitySpan(
      paraphrasedSpan(span.startMs, span.endMs, harness.orchestrator.hostState().takePassId),
    );
    harness.settle(1_200);
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(harness.latest()?.fillers.confirmedCount).toBe(2);

    harness.orchestrator.setHostState({ trackingEpoch: 1 });
    transport.releaseHeld();
    await harness.orchestrator.lunaObserver()?.settle();
    harness.settle(400);

    // The answer was computed against the pre-jump position and is never
    // applied…
    expect(harness.orchestrator.diagnostics().lunaResponses).toBe(0);
    // …while the number the presenter has been reading all take stands.
    expect(harness.latest()?.fillers.confirmedCount).toBe(2);
  });

  it('does not call Luna for purely local candidates (§20.2)', async () => {
    const transport = new ScriptedTransport(materialityDecision);
    const harness = new TakeHarness({ deps: { lunaTransport: transport } });
    harness.speak(1_500);
    harness.speak(400, { peakDbfs: 0, clippingRatio: 0.05 });
    harness.settle(2_000);
    await harness.orchestrator.lunaObserver()?.settle();

    // A microphone fault is a measurement. Paying a model to restate it is the
    // failure §2.2 exists to prevent.
    expect(transport.requests).toHaveLength(0);
    expect(harness.latest()?.activeTip?.code).toBe('MIC_CLIPPING');
  });
});
