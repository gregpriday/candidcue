import { MetricsCollector } from '@main/diagnostics/metrics';
import type { TurnMetrics } from '@main/diagnostics/metrics';
import type { EndpointReason } from '@shared/domain';

/**
 * Build a TurnMetrics with sensible neutral defaults, overriding only the
 * fields a given test cares about. Keeps the test cases focused on the field
 * under examination.
 */
function turn(overrides: Partial<TurnMetrics> = {}): TurnMetrics {
  return {
    sessionId: 's1',
    turnId: 't1',
    sttFinalizeMs: null,
    cleanupMs: null,
    moderationMs: null,
    questionGenerationMs: null,
    questionRepairMs: null,
    ttsMs: null,
    stagePreloadMs: null,
    totalThinkTimeMs: null,
    questionWords: null,
    questionAudioMs: null,
    endpointReason: 'automatic',
    speakingClipIds: [],
    playbackRate: [],
    fallbackUsed: false,
    errors: [],
    ...overrides,
  };
}

describe('MetricsCollector.aggregate', () => {
  it('returns zeros (not NaN) for empty input', () => {
    const agg = new MetricsCollector().aggregate();
    expect(agg).toEqual({
      count: 0,
      avgThinkMs: 0,
      p95ThinkMs: 0,
      manualEndpoints: 0,
      automaticEndpoints: 0,
      cleanupFallbacks: 0,
      modelFallbacks: 0,
      ttsFailures: 0,
      forcedCuts: 0,
      deviceInterruptions: 0,
    });
    expect(Number.isNaN(agg.avgThinkMs)).toBe(false);
    expect(Number.isNaN(agg.p95ThinkMs)).toBe(false);
  });

  it('counts recorded turns', () => {
    const c = new MetricsCollector();
    c.record(turn());
    c.record(turn());
    c.record(turn());
    expect(c.size()).toBe(3);
    expect(c.aggregate().count).toBe(3);
  });

  it('computes average think time over non-null values only', () => {
    const c = new MetricsCollector();
    c.record(turn({ totalThinkTimeMs: 1000 }));
    c.record(turn({ totalThinkTimeMs: 2000 }));
    c.record(turn({ totalThinkTimeMs: 3000 }));
    c.record(turn({ totalThinkTimeMs: null })); // excluded from the timing set
    const agg = c.aggregate();
    expect(agg.count).toBe(4);
    expect(agg.avgThinkMs).toBe(2000); // mean of 1000,2000,3000
  });

  it('rounds a non-integer average', () => {
    const c = new MetricsCollector();
    c.record(turn({ totalThinkTimeMs: 1000 }));
    c.record(turn({ totalThinkTimeMs: 1001 }));
    // mean = 1000.5 -> rounds to 1001 (Math.round half-up)
    expect(c.aggregate().avgThinkMs).toBe(1001);
  });

  it('computes p95 with nearest-rank ceil(0.95*n)-1 over a known set of 10', () => {
    const c = new MetricsCollector();
    // Insert out of order to prove sorting; values 100..1000.
    const values = [300, 100, 1000, 500, 200, 900, 400, 800, 600, 700];
    for (const v of values) c.record(turn({ totalThinkTimeMs: v }));
    // n=10 -> ceil(9.5)-1 = 9 -> index 9 of sorted ascending = 1000.
    expect(c.aggregate().p95ThinkMs).toBe(1000);
  });

  it('computes p95 over a known set of 20', () => {
    const c = new MetricsCollector();
    // values 10,20,...,200
    for (let i = 1; i <= 20; i += 1) c.record(turn({ totalThinkTimeMs: i * 10 }));
    // n=20 -> ceil(19)-1 = 18 -> sorted index 18 = 190.
    expect(c.aggregate().p95ThinkMs).toBe(190);
  });

  it('p95 of a single value is that value', () => {
    const c = new MetricsCollector();
    c.record(turn({ totalThinkTimeMs: 4242 }));
    const agg = c.aggregate();
    expect(agg.p95ThinkMs).toBe(4242);
    expect(agg.avgThinkMs).toBe(4242);
  });

  it('p95 ignores null think times when sizing the set', () => {
    const c = new MetricsCollector();
    // Only two non-null values: 1000, 2000. n=2 -> ceil(1.9)-1 = 1 -> 2000.
    c.record(turn({ totalThinkTimeMs: 1000 }));
    c.record(turn({ totalThinkTimeMs: null }));
    c.record(turn({ totalThinkTimeMs: 2000 }));
    c.record(turn({ totalThinkTimeMs: null }));
    expect(c.aggregate().p95ThinkMs).toBe(2000);
  });

  it('counts manual vs automatic endpoints and ignores other reasons', () => {
    const c = new MetricsCollector();
    const reasons: EndpointReason[] = [
      'manual',
      'manual',
      'automatic',
      'automatic',
      'automatic',
      'timeout',
      'recovery',
    ];
    for (const r of reasons) c.record(turn({ endpointReason: r }));
    const agg = c.aggregate();
    expect(agg.manualEndpoints).toBe(2);
    expect(agg.automaticEndpoints).toBe(3);
  });

  it('tallies cleanup fallbacks, tts failures, forced cuts, and device interruptions via error markers', () => {
    const c = new MetricsCollector();
    c.record(turn({ errors: ['cleanup_fallback'] }));
    c.record(turn({ errors: ['tts_failure: inworld timeout'] }));
    c.record(turn({ errors: ['forced_cut'] }));
    c.record(turn({ errors: ['device_interruption'] }));
    c.record(turn({ errors: ['something_else'] }));
    const agg = c.aggregate();
    expect(agg.cleanupFallbacks).toBe(1);
    expect(agg.ttsFailures).toBe(1);
    expect(agg.forcedCuts).toBe(1);
    expect(agg.deviceInterruptions).toBe(1);
  });

  it('matches error markers case-insensitively and as substrings', () => {
    const c = new MetricsCollector();
    c.record(turn({ errors: ['TTS_FAILURE'] }));
    c.record(turn({ errors: ['stage prefix CLEANUP_FALLBACK suffix'] }));
    const agg = c.aggregate();
    expect(agg.ttsFailures).toBe(1);
    expect(agg.cleanupFallbacks).toBe(1);
  });

  it('counts model fallbacks from the fallbackUsed flag', () => {
    const c = new MetricsCollector();
    c.record(turn({ fallbackUsed: true }));
    c.record(turn({ fallbackUsed: true }));
    c.record(turn({ fallbackUsed: false }));
    expect(c.aggregate().modelFallbacks).toBe(2);
  });

  it('counts model fallbacks from an explicit error marker too, without double counting', () => {
    const c = new MetricsCollector();
    // flag set AND marker present -> counted once.
    c.record(turn({ fallbackUsed: true, errors: ['model_fallback'] }));
    // marker only.
    c.record(turn({ fallbackUsed: false, errors: ['model_fallback'] }));
    // neither.
    c.record(turn({ fallbackUsed: false, errors: [] }));
    expect(c.aggregate().modelFallbacks).toBe(2);
  });

  it('handles a single turn carrying multiple error markers at once', () => {
    const c = new MetricsCollector();
    c.record(
      turn({
        endpointReason: 'manual',
        fallbackUsed: true,
        errors: ['cleanup_fallback', 'tts_failure', 'forced_cut', 'device_interruption'],
      }),
    );
    const agg = c.aggregate();
    expect(agg.count).toBe(1);
    expect(agg.manualEndpoints).toBe(1);
    expect(agg.cleanupFallbacks).toBe(1);
    expect(agg.modelFallbacks).toBe(1);
    expect(agg.ttsFailures).toBe(1);
    expect(agg.forcedCuts).toBe(1);
    expect(agg.deviceInterruptions).toBe(1);
  });

  it('produces a fully populated aggregate over a realistic mixed session', () => {
    const c = new MetricsCollector();
    c.record(
      turn({
        turnId: 'a',
        totalThinkTimeMs: 2000,
        endpointReason: 'automatic',
        speakingClipIds: ['c1'],
        playbackRate: [1.0],
      }),
    );
    c.record(
      turn({
        turnId: 'b',
        totalThinkTimeMs: 4000,
        endpointReason: 'manual',
        fallbackUsed: true,
        errors: ['tts_failure'],
      }),
    );
    c.record(
      turn({
        turnId: 'c',
        totalThinkTimeMs: 6000,
        endpointReason: 'automatic',
        errors: ['forced_cut'],
      }),
    );
    const agg = c.aggregate();
    expect(agg.count).toBe(3);
    expect(agg.avgThinkMs).toBe(4000); // (2000+4000+6000)/3
    // n=3 -> ceil(2.85)-1 = 2 -> sorted index 2 = 6000.
    expect(agg.p95ThinkMs).toBe(6000);
    expect(agg.manualEndpoints).toBe(1);
    expect(agg.automaticEndpoints).toBe(2);
    expect(agg.modelFallbacks).toBe(1);
    expect(agg.ttsFailures).toBe(1);
    expect(agg.forcedCuts).toBe(1);
    expect(agg.cleanupFallbacks).toBe(0);
    expect(agg.deviceInterruptions).toBe(0);
  });
});
