/**
 * §20.3/§23 wiring test for the production coach-observer transport.
 *
 * Proves the transport forwards the bounded request through the single budgeted
 * Rust command and maps the response back into `CoachObserverResponse` — and
 * that a rejected invoke surfaces as a rejected promise, which the observer
 * treats as a silent failure (§23.2) rather than a tip.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCoachingObserverTransport } from '../../../src/control/services/coaching-luna';
import type { LunaCoachRequest } from '../../../src/shared/contracts/coaching';

function request(): LunaCoachRequest {
  return {
    schemaVersion: '1.0',
    sessionId: '00000000-0000-0000-0000-000000000001',
    scriptId: '00000000-0000-0000-0000-000000000002',
    scriptRevision: 1,
    trackingEpoch: 0,
    takePassId: 'take-1',
    requestAudioTimeMs: 4200,
    validUntilAudioTimeMs: 8200,
    language: 'en',
    state: {
      alignmentConfidence: 0.9,
      commandActive: false,
      retakeState: 'none',
      reacquiring: false,
      microphoneHealthy: true,
    },
    profile: {
      coachingMode: 'coach',
      deliveryStyle: 'conversational',
      targetWpmLow: 130,
      targetWpmHigh: 170,
      targetVarietyLow: 0.4,
      targetVarietyHigh: 0.7,
      liveTipFrequency: 'normal',
    },
    authoredSpans: [],
    speech: { finalText: '', provisionalTail: '', finalAudioStartMs: 0, finalAudioEndMs: 0 },
    metrics: {
      displayWpm: 150,
      paceState: 'on_target',
      pacePersistenceMs: 0,
      terminalRushRatio: null,
      varietyLevel: null,
      varietyState: 'balanced',
      varietyPersistenceMs: 0,
      cadenceBalance: null,
      runOnCount: 0,
      choppyPauseCount: 0,
      confirmedFillersLast20s: 0,
      confirmedFillersLast60s: 0,
    },
    candidates: [],
  };
}

describe('coach observer transport (§20.3)', () => {
  it('invokes the single budgeted Rust command and maps the response', async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({
      result: { decision: 'none', tip_code: 'NONE' },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15,
      },
      latencyMs: 320,
    }));
    const transport = createCoachingObserverTransport(invoke as never);

    const response = await transport.classify(request());

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0]!;
    // The single coaching path — not a second, separate one.
    expect(command).toBe('classify_coaching_window');
    const payload = (args as { request: { requestId: string; payload: LunaCoachRequest } }).request;
    // The bounded request is forwarded verbatim as the payload.
    expect(payload.payload.takePassId).toBe('take-1');
    expect(payload.requestId).toContain('take-1');
    // The raw decision is passed through untouched for local re-validation.
    expect(response.result).toEqual({ decision: 'none', tip_code: 'NONE' });
    expect(response.usage?.totalTokens).toBe(15);
    expect(response.latencyMs).toBe(320);
  });

  it('propagates a rejected invoke so the observer fails silently (§23.2)', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('AUTH_MODEL_UNAVAILABLE');
    });
    const transport = createCoachingObserverTransport(invoke as never);
    await expect(transport.classify(request())).rejects.toThrow();
  });
});
