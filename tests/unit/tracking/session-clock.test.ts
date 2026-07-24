/**
 * Companion §9.1 — the session clock.
 *
 * §9.1 requires `sessionTimeMs = 0` at session start and forbids ordering on
 * wall-clock time. The worker did neither: it passed the control window's
 * `Date.now()` through untouched, so every `SemanticMotionFrame` was stamped
 * with an absolute epoch millisecond and an NTP correction or a sleep/wake
 * mid-take moved that stamp *backwards*. Downstream, a frame that goes
 * backwards is evidence from the future, then a negative age, then a predictor
 * that quietly loses its horizon.
 *
 * The realistic trigger is not exotic. `Date.now()` steps whenever NTP corrects
 * the host, when the laptop lid closes and reopens in a different timezone, or
 * when a user fixes their clock — all of which happen during a recording
 * session as readily as outside one.
 *
 * The worker's own tests use a *simulated* speech clock (`TranscriptScripter`
 * advances 220 ms per word), which is exactly why the fix must not be "read
 * `performance.now()` in the worker": that would tie the engine to wall time
 * and make every deterministic fixture non-reproducible. What is asserted here
 * is the property §9.1 actually names — the domain is session-relative and
 * never decreases — with the simulation intact.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SessionClock } from '../../../src/shared/tracking/session-clock';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../../src/shared/tracking/worker-protocol';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

describe('SessionClock (§9.1)', () => {
  it('defines sessionTimeMs = 0 at session start', () => {
    const clock = new SessionClock();
    clock.start(1_785_000_000_000);
    expect(clock.sessionTimeMs).toBe(0);
    expect(clock.advance(1_785_000_000_000)).toBe(0);
    expect(clock.advance(1_785_000_001_250)).toBe(1250);
  });

  it('never returns less than it returned last time', () => {
    const clock = new SessionClock();
    clock.start(1000);
    expect(clock.advance(3000)).toBe(2000);
    // A five-second NTP correction backwards.
    expect(clock.advance(-2000)).toBe(2000);
    expect(clock.rebaseCount).toBe(1);
  });

  it('re-bases rather than clamping, so a step does not stall the session', () => {
    const clock = new SessionClock();
    clock.start(1000);
    expect(clock.advance(3000)).toBe(2000);
    clock.advance(-2000); // the step itself
    // Clamping would swallow the next five seconds of real speech; re-basing
    // resumes accumulating immediately.
    expect(clock.advance(-1000)).toBe(3000);
    expect(clock.advance(0)).toBe(4000);
  });

  it('maps a secondary stamp through the same transform without moving the clock', () => {
    const clock = new SessionClock();
    clock.start(1000);
    clock.advance(5000);
    // `audioStartMs` sits 400 ms before its own receipt; the offset survives.
    expect(clock.map(4600)).toBe(3600);
    expect(clock.sessionTimeMs).toBe(4000);
    // And a secondary stamp cannot re-base the session.
    expect(clock.map(-9999)).toBe(0);
    expect(clock.rebaseCount).toBe(0);
    expect(clock.advance(6000)).toBe(5000);
  });

  it('ignores a non-finite stamp instead of poisoning the domain', () => {
    const clock = new SessionClock();
    clock.start(1000);
    clock.advance(2000);
    expect(clock.advance(Number.NaN)).toBe(1000);
    expect(clock.advance(Number.POSITIVE_INFINITY)).toBe(1000);
    expect(clock.advance(3000)).toBe(2000);
  });
});

/* ---------------------------------------------------------------------------
 * The real worker, driven end to end.
 * ------------------------------------------------------------------------- */

const outbox: TrackingWorkerOutbound[] = [];
let dispatch: (message: TrackingWorkerInbound) => void;

beforeAll(async () => {
  const fakeSelf = {
    onmessage: undefined as ((event: MessageEvent<TrackingWorkerInbound>) => void) | undefined,
    postMessage: (message: TrackingWorkerOutbound) => {
      outbox.push(message);
    },
  };
  (globalThis as Record<string, unknown>).self = fakeSelf;
  await import('../../../src/workers/tracking.worker');
  if (fakeSelf.onmessage === undefined) throw new Error('worker did not register onmessage');
  const handler = fakeSelf.onmessage;
  dispatch = (message) => handler({ data: message } as MessageEvent<TrackingWorkerInbound>);
});

/** A plausible wall clock: 24 July 2026, the same shape `Date.now()` produces. */
const WALL_CLOCK_ORIGIN = 1_785_100_000_000;

function frameTimes(): number[] {
  return outbox.flatMap((m) => (m.type === 'semantic_frame' ? [m.frame.sessionTimeMs] : []));
}

function startSession(sessionId: string): TranscriptScripter {
  outbox.length = 0;
  dispatch({
    type: 'initialize',
    document: demoDocument(),
    session: { sessionId, sessionGeneration: 1, stageGeneration: 1 },
    nowMs: WALL_CLOCK_ORIGIN,
  });
  return new TranscriptScripter(WALL_CLOCK_ORIGIN, 1);
}

describe('the tracking worker publishes session time, not wall-clock time (§9.1)', () => {
  it('stamps frames from zero rather than from the epoch', () => {
    const scripter = startSession('clock-1');
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      dispatch({ type: 'transcript_event', event });
    }
    const times = frameTimes();
    expect(times.length).toBeGreaterThan(0);
    // The bug in one number: every one of these used to be ~1.785e12.
    expect(Math.min(...times)).toBeLessThan(60_000);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(0);
    // And the *intervals* the engine measures pace against are untouched: the
    // simulated speech clock advanced by exactly this much.
    expect(Math.max(...times)).toBeCloseTo(scripter.clockMs - WALL_CLOCK_ORIGIN, -1);
  });

  it('keeps frame order through a wall-clock step backwards', () => {
    const scripter = startSession('clock-2');
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      dispatch({ type: 'transcript_event', event });
    }
    const beforeStep = frameTimes();
    expect(beforeStep.length).toBeGreaterThan(0);

    // NTP corrects the host four seconds backwards, mid-take. The presenter
    // keeps talking; the transcriber keeps producing; only the clock moved.
    const stepped = new TranscriptScripter(scripter.clockMs - 4_000, 1);
    // Same generation, fresh item ids, so the ledger accepts them.
    stepped.speak({ text: 'ignored warm up turn' });
    for (const event of stepped.speak({ text: 'It is good to be back with you today.' })) {
      dispatch({ type: 'transcript_event', event });
    }

    const times = frameTimes();
    expect(times.length).toBeGreaterThan(beforeStep.length);
    for (let i = 1; i < times.length; i++) {
      expect(times[i], `frame ${i} of ${JSON.stringify(times)}`).toBeGreaterThanOrEqual(
        times[i - 1]!,
      );
    }
    // Monotonicity alone is too weak to be worth asserting on its own: the
    // frame emitter's rate gate happens to *pin* the clock at its last value
    // when the input goes backwards, which is monotone and also wrong — the
    // stage would see a session that has stopped while the presenter is still
    // talking. So the load-bearing assertion is that session time genuinely
    // advanced across the step, by about as much as the presenter spoke.
    const spokenAfterStep = Math.max(...times) - Math.max(...beforeStep);
    expect(spokenAfterStep, JSON.stringify(times)).toBeGreaterThan(1_000);
  });

  it('keeps a tick after a backward step from rewinding the session', () => {
    startSession('clock-3');
    dispatch({ type: 'tick', nowMs: WALL_CLOCK_ORIGIN + 5_000 });
    dispatch({ type: 'tick', nowMs: WALL_CLOCK_ORIGIN - 30_000 });
    dispatch({ type: 'tick', nowMs: WALL_CLOCK_ORIGIN - 29_000 });
    const times = frameTimes();
    expect(times.length).toBeGreaterThan(0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!);
    }
    expect(Math.max(...times)).toBeLessThan(60_000);
  });
});
