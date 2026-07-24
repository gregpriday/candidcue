/**
 * §5.2. Lane failure isolation.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 * "The stage must continue scrolling smoothly even if every coaching process
 * fails." That is only true if a throw inside one lane cannot reach the frame
 * pump, and if the *rest* of the subsystem keeps running when one lane stops.
 *
 * The policy implemented here:
 *
 * 1. Every call into a lane goes through {@link LaneGuard.run}. A throw is
 *    caught, reported, and replaced by the caller's fallback value.
 * 2. A lane that throws {@link LaneGuard} `failureLimit` times consecutively is
 *    **taken out of service for the rest of the take pass**. The default limit
 *    is 1: an object that threw is in an unknown internal state, and a pace
 *    tile that keeps reporting a number computed from half-updated accumulators
 *    is worse than one that honestly says nothing.
 * 3. A disabled lane's display state falls back to the contract's "we do not
 *    know yet" shape — `wpm: null`, `level: null` — never to the last value it
 *    produced. A frozen number on the glass is indistinguishable from a live
 *    one and is the exact failure §27.1 calls out.
 * 4. A successful call clears the lane's consecutive-failure count, so a lane
 *    with a limit above 1 is not killed by two unrelated hiccups a minute apart.
 * 5. `resetForTakePass()` restores every lane. A new performance gets a clean
 *    subsystem; the lanes are reset alongside it.
 *
 * Nothing here logs to a console or throws on its own: the guard is the last
 * thing between a bad lane and the session, so it cannot be a source of
 * failure itself.
 */
import type { CoachingLaneFailure, CoachingLaneId } from './types';

export interface LaneGuardOptions {
  /** Consecutive throws allowed before the lane is disabled. Default 1. */
  failureLimit?: number;
  onFailure?: (failure: CoachingLaneFailure) => void;
}

interface LaneRecord {
  consecutiveFailures: number;
  totalFailures: number;
  disabled: boolean;
}

export class LaneGuard {
  private readonly failureLimit: number;
  private readonly onFailure: ((failure: CoachingLaneFailure) => void) | undefined;
  private readonly lanes = new Map<CoachingLaneId, LaneRecord>();

  constructor(options: LaneGuardOptions = {}) {
    this.failureLimit = Math.max(1, options.failureLimit ?? 1);
    this.onFailure = options.onFailure;
  }

  /** Lanes currently out of service, in a stable order. */
  disabledLanes(): CoachingLaneId[] {
    const out: CoachingLaneId[] = [];
    for (const [lane, record] of this.lanes) {
      if (record.disabled) out.push(lane);
    }
    out.sort();
    return out;
  }

  isDisabled(lane: CoachingLaneId): boolean {
    return this.lanes.get(lane)?.disabled === true;
  }

  failureCount(lane: CoachingLaneId): number {
    return this.lanes.get(lane)?.totalFailures ?? 0;
  }

  /** A new take pass. Every lane gets another chance. */
  resetForTakePass(): void {
    this.lanes.clear();
  }

  /**
   * Run `work` for `lane`, returning `fallback` when the lane is disabled or
   * the call throws.
   *
   * `fallback` is a thunk rather than a value so the caller does not pay to
   * build an unused honest-default state on the (overwhelmingly common)
   * success path.
   */
  run<T>(
    lane: CoachingLaneId,
    phase: string,
    audioTimeMs: number,
    work: () => T,
    fallback: () => T,
  ): T {
    if (this.isDisabled(lane)) return fallback();
    try {
      const result = work();
      const record = this.lanes.get(lane);
      if (record !== undefined) record.consecutiveFailures = 0;
      return result;
    } catch (error: unknown) {
      this.noteFailure(lane, phase, error, audioTimeMs);
      return fallback();
    }
  }

  /** `run` for work with nothing to return. */
  runVoid(lane: CoachingLaneId, phase: string, audioTimeMs: number, work: () => void): void {
    this.run(lane, phase, audioTimeMs, work, () => undefined);
  }

  private noteFailure(
    lane: CoachingLaneId,
    phase: string,
    error: unknown,
    audioTimeMs: number,
  ): void {
    const record = this.lanes.get(lane) ?? {
      consecutiveFailures: 0,
      totalFailures: 0,
      disabled: false,
    };
    record.consecutiveFailures += 1;
    record.totalFailures += 1;
    if (record.consecutiveFailures >= this.failureLimit) record.disabled = true;
    this.lanes.set(lane, record);

    // A reporting callback that throws must not become the failure it is
    // reporting on; the guard is the bottom of the stack here.
    try {
      this.onFailure?.({
        lane,
        phase,
        error,
        audioTimeMs,
        failureCount: record.totalFailures,
        disabled: record.disabled,
      });
    } catch {
      /* observer faults are not the session's problem */
    }
  }
}
