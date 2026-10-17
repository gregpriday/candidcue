/**
 * §14.2 C — the Preflight transcription test must not be able to hold the
 * microphone and the recogniser open while nobody is watching.
 *
 * Before this, `runTranscriptionTest` stored the session's disposer and the
 * ONLY two callers of it were component unmount and the top of
 * `runTranscriptionTest` itself. There was no Stop and no timeout: starting
 * the test and then reading something else on the page held the microphone
 * and a live decoder open until the user navigated away.
 *
 * Every test here asserts THE DISPOSER RAN. "A timer was scheduled" is not the
 * same claim — a scheduled timer whose callback forgets the disposer leaks
 * exactly as badly as no timer at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIC_TEST_IDLE_TIMEOUT_MS,
  MIC_TEST_MAX_DURATION_MS,
  MicTestSession,
  micTestStopNotice,
  shouldAdoptRememberedMicrophone,
  type MicTestSnapshot,
} from '../../../src/control/services/mic-test-session';
import type { TranscriptTestEvents } from '../../../src/control/services/voice-facade';

interface Harness {
  session: MicTestSession;
  /** The disposer the facade handed back — i.e. "close the live session". */
  dispose: ReturnType<typeof vi.fn>;
  snapshots: MicTestSnapshot[];
  events: TranscriptTestEvents;
  deviceIds: Array<string | undefined>;
  last(): MicTestSnapshot;
}

function harness(options: { openRejection?: unknown } = {}): Harness {
  const dispose = vi.fn();
  const snapshots: MicTestSnapshot[] = [];
  const deviceIds: Array<string | undefined> = [];
  let events: TranscriptTestEvents | null = null;

  const session = new MicTestSession({
    open: async (deviceId, handlers) => {
      deviceIds.push(deviceId);
      if (options.openRejection !== undefined) throw options.openRejection;
      events = handlers;
      return dispose;
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    describe: (error) => (error instanceof Error ? error.message : String(error)),
  });

  return {
    session,
    dispose,
    snapshots,
    deviceIds,
    get events(): TranscriptTestEvents {
      if (events === null) throw new Error('the test session was never opened');
      return events;
    },
    last: () => snapshots[snapshots.length - 1] as MicTestSnapshot,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe('Stop closes the session', () => {
  it('runs the disposer when the user presses Stop', async () => {
    const h = harness();
    await h.session.start('mic-1');
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.session.running).toBe(true);

    h.session.stop('user');

    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.session.running).toBe(false);
    expect(h.last().state).toBe('idle');
  });

  it('is idempotent — a second Stop does not double-dispose', async () => {
    const h = harness();
    await h.session.start('mic-1');
    h.session.stop('user');
    h.session.stop('user');
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a session whose disposer arrives after the user left', async () => {
    // `startTranscriptionTest` only resolves once the capture is already open,
    // so a stop during acquisition must still close what arrives afterwards.
    const dispose = vi.fn();
    const opened: Array<(disposer: () => void) => void> = [];
    const session = new MicTestSession({
      open: () => new Promise<() => void>((resolve) => opened.push(resolve)),
      onChange: () => {},
      describe: String,
    });

    const running = session.start('mic-1');
    session.dispose(); // the screen unmounted mid-acquisition
    opened[0]?.(dispose);
    await running;

    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('the session closes itself when it is forgotten', () => {
  it('runs the disposer after the idle timeout with nothing transcribed', async () => {
    const h = harness();
    await h.session.start('mic-1');

    vi.advanceTimersByTime(MIC_TEST_IDLE_TIMEOUT_MS - 1);
    expect(h.dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.last().stoppedReason).toBe('idle_timeout');
    // The user is told, rather than finding a silently dead test.
    expect(micTestStopNotice(h.last().stoppedReason)).toMatch(/stopped itself/);
  });

  it('extends the idle deadline while transcription is actually arriving', async () => {
    const h = harness();
    await h.session.start('mic-1');

    vi.advanceTimersByTime(MIC_TEST_IDLE_TIMEOUT_MS - 1000);
    h.events.onPartial('CandidCue is');
    vi.advanceTimersByTime(MIC_TEST_IDLE_TIMEOUT_MS - 1000);
    // Without the reset this would already be past the deadline.
    expect(h.dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.last().stoppedReason).toBe('idle_timeout');
  });

  it('runs the disposer at the duration cap even under constant activity', async () => {
    const h = harness();
    await h.session.start('mic-1');

    // A noisy room: a partial every second forever. The idle timer alone would
    // never fire, which is exactly why the hard cap exists.
    for (let elapsed = 0; elapsed < MIC_TEST_MAX_DURATION_MS; elapsed += 1000) {
      vi.advanceTimersByTime(1000);
      if (h.dispose.mock.calls.length === 0) h.events.onPartial(`word ${String(elapsed)}`);
    }

    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.last().stoppedReason).toBe('max_duration');
  });

  it('releases the microphone once the transport reports it cannot transcribe', async () => {
    const h = harness();
    await h.session.start('mic-1');
    h.events.onError('The speech model could not be loaded.');

    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.last().error).toBe('The speech model could not be loaded.');
  });

  it('leaves no timer armed after the session closed', async () => {
    const h = harness();
    await h.session.start('mic-1');
    h.session.stop('user');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the moment the transcript comes back, because that is the answer', async () => {
    /*
     * The test exists to answer one question: is the microphone open and is
     * the recogniser returning text? A final transcript answers it. Holding the
     * input after that is holding it for a question that has been answered.
     *
     * This used to publish `success` and hold the transport for the full
     * 30-second idle timeout — and `running` reads false for `success`, so the
     * screen took away the Stop button and the in-progress notice at the exact
     * moment the session became invisible. Half a minute with the microphone
     * live and the UI insisting the test was over.
     */
    const h = harness();
    await h.session.start('mic-1');
    h.events.onFinal('CandidCue is following my voice.');

    expect(h.dispose, 'the live session must be closed by the answer').toHaveBeenCalledOnce();
    expect(vi.getTimerCount(), 'and it must leave no deadline behind').toBe(0);
    // The user still sees what was heard, and why it stopped.
    expect(h.last().state).toBe('success');
    expect(h.last().final).toBe('CandidCue is following my voice.');
    expect(h.last().stoppedReason).toBe('answered');
  });

  it('says nothing extra about a test that simply worked', () => {
    // The self-closing deadlines are worth explaining because they surprise;
    // "it worked and stopped" is not a notice, it is the expected ending.
    expect(micTestStopNotice('answered')).toBeNull();
  });
});

describe('restarting', () => {
  it('closes the previous session before opening another', async () => {
    const h = harness();
    await h.session.start('mic-1');
    await h.session.start('mic-2');

    expect(h.dispose).toHaveBeenCalledOnce(); // the FIRST session was closed
    expect(h.deviceIds).toEqual(['mic-1', 'mic-2']);
    expect(h.session.running).toBe(true);
  });

  it('re-arms both deadlines for the new session', async () => {
    const h = harness();
    await h.session.start('mic-1');
    vi.advanceTimersByTime(MIC_TEST_IDLE_TIMEOUT_MS - 1);
    await h.session.start('mic-2');

    vi.advanceTimersByTime(MIC_TEST_IDLE_TIMEOUT_MS - 1);
    expect(h.dispose).toHaveBeenCalledTimes(1); // only the restart's own close
    vi.advanceTimersByTime(1);
    expect(h.dispose).toHaveBeenCalledTimes(2);
  });
});

describe('a failed start leaves the screen usable', () => {
  it('reports the failure and arms no timers', async () => {
    const h = harness({ openRejection: new Error('mic busy') });
    await h.session.start('mic-1');

    expect(h.session.running).toBe(false); // the button is pressable again
    expect(h.last().state).toBe('idle');
    expect(h.last().error).toContain('mic busy');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a refusal reported while opening, and releases what was opened (#264)', async () => {
    // The real facade does not reject when `start_transcription` refuses — a
    // take holding the recogniser, say. It releases the capture, reports the
    // copy through `onError` and only then hands back its disposer.
    const dispose = vi.fn();
    const snapshots: MicTestSnapshot[] = [];
    const refusal = 'Transcription cannot be tested during a take.';
    const session = new MicTestSession({
      open: async (_deviceId, handlers) => {
        handlers.onError(refusal);
        return dispose;
      },
      onChange: (snapshot) => snapshots.push(snapshot),
      describe: String,
    });

    await session.start('mic-1');

    const last = snapshots[snapshots.length - 1] as MicTestSnapshot;
    expect(session.running).toBe(false); // the button is pressable again
    expect(last.state).toBe('idle');
    expect(last.error).toBe(refusal);
    expect(last.stoppedReason).toBe('error');
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the chosen deadlines', () => {
  it('are short enough to be about proving a microphone works', () => {
    // The test answers one question and one sentence answers it. These are the
    // numbers the copy on the screen promises, so they are asserted here too.
    expect(MIC_TEST_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(MIC_TEST_MAX_DURATION_MS).toBe(120_000);
    expect(MIC_TEST_IDLE_TIMEOUT_MS).toBeLessThan(MIC_TEST_MAX_DURATION_MS);
  });
});

describe('a microphone this machine already granted is adopted without a click', () => {
  const base = {
    remembered: true,
    attempted: false,
    adopted: false,
    permission: 'unknown' as const,
  };

  it('adopts when the grant is remembered and nothing is known yet', () => {
    expect(shouldAdoptRememberedMicrophone(base)).toBe(true);
  });

  it('does not adopt on a machine that has never granted access', () => {
    // The first take still asks, which is the one time asking is right.
    expect(shouldAdoptRememberedMicrophone({ ...base, remembered: false })).toBe(false);
  });

  it('tries once per visit, so a revoked permission cannot loop', () => {
    // `allowMicrophone` leaves `micPermission` at 'unknown' when the request
    // itself throws, so without this the effect would re-fire on every
    // settings change and reopen the device forever.
    expect(shouldAdoptRememberedMicrophone({ ...base, attempted: true })).toBe(false);
  });

  it('leaves a live grant and an explicit refusal alone', () => {
    expect(shouldAdoptRememberedMicrophone({ ...base, adopted: true })).toBe(false);
    expect(shouldAdoptRememberedMicrophone({ ...base, permission: 'granted' })).toBe(false);
    // 'denied' is the user's answer; reopening the device is not ours to do.
    expect(shouldAdoptRememberedMicrophone({ ...base, permission: 'denied' })).toBe(false);
  });
});
