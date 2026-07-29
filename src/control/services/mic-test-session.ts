/**
 * The microphone / transcription test lifecycle (spec §14.2 C).
 *
 * This is a local transcription session — it costs nothing but holds the microphone. The screen used to open one
 * and then hold it until the component unmounted: there was no Stop control
 * and no timeout, so starting the test and then reading something else on the
 * page left a realtime connection streaming the owner's microphone — and their
 * money — until they happened to navigate away.
 *
 * The lifecycle therefore lives here, out of the component, where every path
 * that closes the session can be proven to have run the disposer:
 *
 *   • Stop            — the user says so;
 *   • idle timeout    — nothing has been transcribed for a while;
 *   • duration cap    — the absolute ceiling, so a room full of noise cannot
 *                       keep resetting the idle timer forever;
 *   • restart/unmount — a second press, or leaving the screen.
 *
 * Choosing the numbers. The test exists to answer one question — is the
 * microphone open and is the recogniser returning text — and one spoken sentence
 * answers it in about five seconds. Everything past that is money spent on
 * nothing.
 *
 *  - `MIC_TEST_IDLE_TIMEOUT_MS` (30 s) is measured from the last transcription
 *    event, not from the start, so a user who is finding their place, clearing
 *    their throat or re-reading the prompt is not cut off mid-thought. Thirty
 *    seconds is roughly six times the length of the thing being proved, and it
 *    bounds a walk-away at half a minute of realtime billing.
 *  - `MIC_TEST_MAX_DURATION_MS` (2 min) exists because the idle timer alone is
 *    not a bound: a fan, a TV or an open-plan office produces a steady stream
 *    of partials that resets it indefinitely. Two minutes comfortably covers
 *    the longest legitimate use (the §30.3 calibration preview asks for one
 *    paragraph, ~45 s) and makes the worst case finite.
 */
import type { TranscriptTestEvents, Unsubscribe } from './voice-facade';

/** Idle time — since the last transcription event — before the session closes. */
export const MIC_TEST_IDLE_TIMEOUT_MS = 30_000;

/** Absolute ceiling on one test session, regardless of activity. */
export const MIC_TEST_MAX_DURATION_MS = 120_000;

export type MicTestState = 'idle' | 'opening' | 'listening' | 'waiting' | 'success';

export type MicTestStopReason =
  | 'user'
  | 'idle_timeout'
  | 'max_duration'
  | 'restart'
  | 'dispose'
  | 'error'
  /** The test proved what it exists to prove; there is nothing left to bill for. */
  | 'answered';

/** Everything the UI renders about the test. Replaced wholesale on change. */
export interface MicTestSnapshot {
  state: MicTestState;
  partial: string;
  final: string;
  /** Human copy; never a raw error code (see services/errors.ts). */
  error: string | null;
  /**
   * Why the last session ended, or null while one is running. The UI says so
   * when CandidCue closed the session on the user's behalf — an automatic stop
   * the operator cannot see is indistinguishable from a crash.
   */
  stoppedReason: MicTestStopReason | null;
}

/** Timer seam, so tests drive a virtual clock rather than waiting 30 s. */
export interface MicTestTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MicTestDeps {
  /** Opens the billable session and resolves with ITS disposer. */
  open(deviceId: string | undefined, events: TranscriptTestEvents): Promise<Unsubscribe>;
  /** Push a new snapshot to the UI. */
  onChange(snapshot: MicTestSnapshot): void;
  /** Turns any rejection into human copy (`services/errors.describeError`). */
  describe(error: unknown): string;
  timers?: MicTestTimers;
}

const IDLE_SNAPSHOT: MicTestSnapshot = {
  state: 'idle',
  partial: '',
  final: '',
  error: null,
  stoppedReason: null,
};

export class MicTestSession {
  private readonly timers: MicTestTimers;
  private snapshot: MicTestSnapshot = { ...IDLE_SNAPSHOT };
  /**
   * Cancellation token. `open` only hands back its disposer once the capture
   * is already running, so a stop issued during acquisition has to be recorded
   * as a generation bump and honoured when the disposer finally arrives.
   */
  private generation = 0;
  private disposer: Unsubscribe | null = null;
  private idleTimer: unknown = null;
  private capTimer: unknown = null;

  constructor(private readonly deps: MicTestDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    };
  }

  /** True while a session is open or being opened — i.e. while it can bill. */
  get running(): boolean {
    return this.snapshot.state !== 'idle' && this.snapshot.state !== 'success';
  }

  current(): MicTestSnapshot {
    return { ...this.snapshot };
  }

  async start(deviceId: string | undefined): Promise<void> {
    // A second press restarts rather than stacking a second billable session.
    this.stop('restart');
    const generation = (this.generation += 1);
    this.publish({ ...IDLE_SNAPSHOT, state: 'opening' });

    let disposer: Unsubscribe;
    try {
      disposer = await this.deps.open(deviceId, {
        onPartial: (text) => {
          if (generation !== this.generation) return;
          this.noteActivity();
          this.publish({ ...this.snapshot, state: 'waiting', partial: text });
        },
        onFinal: (text) => {
          if (generation !== this.generation) return;
          /*
           * A final transcript is the answer. Close the session.
           *
           * This used to publish `success` and leave the transport open until
           * the 30-second idle timer noticed — and `running` reads false for
           * `success`, so the screen took away the Stop button AND the "billing
           * your key" warning at the exact moment the session became invisible.
           * Half a minute of realtime billing, with the UI insisting the test
           * was over.
           */
          this.publish({ ...this.snapshot, final: text });
          this.stop('answered');
        },
        onError: (message) => {
          if (generation !== this.generation) return;
          // A reported failure ends the session: leaving the transport open
          // after it has said it cannot transcribe is billing for nothing.
          this.publish({ ...this.snapshot, error: message });
          this.stop('error');
        },
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.clearTimers();
      this.publish({
        ...IDLE_SNAPSHOT,
        error: `The transcription test could not start. ${this.deps.describe(error)}`,
        stoppedReason: 'error',
      });
      return;
    }

    if (generation !== this.generation) {
      // Stopped while the capture was opening: a disposer that arrives too
      // late to be stored must still be used, never dropped.
      disposer();
      return;
    }

    this.disposer = disposer;
    this.publish({ ...this.snapshot, state: 'listening' });
    this.armTimers();
  }

  /**
   * Close the session. Idempotent, and safe to call before `start` resolved —
   * the generation bump makes a late disposer dispose itself.
   */
  stop(reason: MicTestStopReason): void {
    const wasRunning = this.disposer !== null || this.snapshot.state === 'opening';
    this.generation += 1;
    this.clearTimers();
    const disposer = this.disposer;
    this.disposer = null;
    disposer?.();
    if (!wasRunning) return;
    if (reason === 'restart' || reason === 'dispose') {
      // The caller is about to replace or discard this UI entirely; there is
      // nobody to explain the stop to.
      this.publish({ ...IDLE_SNAPSHOT });
      return;
    }
    this.publish({
      ...this.snapshot,
      state: this.snapshot.final !== '' ? 'success' : 'idle',
      stoppedReason: reason,
    });
  }

  /** Unmount: never leave a capture (or a bill) running behind a dead screen. */
  dispose(): void {
    this.stop('dispose');
  }

  /* ---------------------------------------------------------------------- */

  private armTimers(): void {
    this.clearTimers();
    this.idleTimer = this.timers.setTimeout(
      () => this.stop('idle_timeout'),
      MIC_TEST_IDLE_TIMEOUT_MS,
    );
    this.capTimer = this.timers.setTimeout(
      () => this.stop('max_duration'),
      MIC_TEST_MAX_DURATION_MS,
    );
  }

  /** Transcription arrived: push the idle deadline out, never the hard cap. */
  private noteActivity(): void {
    if (this.disposer === null) return;
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(
      () => this.stop('idle_timeout'),
      MIC_TEST_IDLE_TIMEOUT_MS,
    );
  }

  private clearTimers(): void {
    if (this.idleTimer !== null) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.capTimer !== null) {
      this.timers.clearTimeout(this.capTimer);
      this.capTimer = null;
    }
  }

  private publish(snapshot: MicTestSnapshot): void {
    this.snapshot = snapshot;
    this.deps.onChange({ ...snapshot });
  }
}

/** Copy for an automatic stop. `null` when the user did it themselves. */
export function micTestStopNotice(reason: MicTestStopReason | null): string | null {
  switch (reason) {
    case 'idle_timeout':
      return 'The test stopped itself after 30 seconds with nothing transcribed, so it is not left holding the microphone.';
    case 'max_duration':
      return 'The test stopped itself after two minutes. Start it again if you need another look.';
    default:
      return null;
  }
}

/**
 * §28.1. Should Preflight open a microphone this machine has already granted,
 * without making the user click Allow again?
 *
 * Pure, because the condition it encodes is easy to get subtly wrong and was:
 * the first attempt read the remembered flag inside the permission watcher's
 * callback, and that callback fires once, at mount, often before the settings
 * store has loaded. The flag was still false at that instant and no second
 * callback ever comes, so the auto-adopt silently never happened and the user
 * kept clicking the button. Nothing about that failure was visible in the UI —
 * it looked exactly like the fix not existing.
 */
export function shouldAdoptRememberedMicrophone(input: {
  /** The machine has granted microphone access before (`audio.microphoneGranted`). */
  remembered: boolean;
  /** This visit has already tried; a revoked permission must not loop. */
  attempted: boolean;
  /** Devices have already been enumerated for a live grant. */
  adopted: boolean;
  /** What Preflight currently believes about the permission. */
  permission: 'unknown' | 'granted' | 'denied';
}): boolean {
  if (!input.remembered) return false;
  if (input.attempted || input.adopted) return false;
  // 'granted' needs nothing; 'denied' is the user's answer and is not ours to
  // overrule by reopening the device.
  return input.permission === 'unknown';
}
