/**
 * Session clock (companion §9.1).
 *
 * §9.1 asks for two things: `sessionTimeMs = 0` at session start, and ordering
 * that is never based on wall-clock time alone. The tracking worker had
 * neither. Every inbound message carried a control-thread `Date.now()` and the
 * engine passed it straight through, so `SemanticMotionFrame.sessionTimeMs`
 * was an absolute epoch millisecond — roughly 1.78e12, growing since 1970 —
 * and an NTP step or a sleep/wake mid-take moved it *backwards*. Downstream
 * that reads as evidence from the future, then negative ages, then a predictor
 * that has silently lost its horizon.
 *
 * ## Why the conversion lives here and not on a monotonic clock read
 *
 * The obvious fix is for the worker to call `performance.now()` itself. It
 * must not: `worker-protocol.ts` states the design — "the control window drives
 * this from its animation loop so the worker never reads a clock of its own" —
 * and that property is what makes the engine deterministic, replayable by the
 * playback harness, and testable at simulated speech rates. A worker that read
 * a real clock would run every deterministic fixture against wall time.
 *
 * §9.1 allows exactly this: payloads "use this time domain **or include a
 * verified conversion**". The conversion is an affine map from the producer's
 * clock into the session domain, and the verification is that the map is
 * re-based rather than trusted whenever the producer's clock contradicts
 * itself. Nothing needs a second clock to notice that time went backwards.
 *
 * ## Re-base, not clamp
 *
 * Clamping a backward step to the last value stalls the session for exactly as
 * long as the step was large: a five-second NTP correction would freeze
 * `sessionTimeMs` for five seconds of real speech, and the pace estimator and
 * the prediction horizon are both measured against it. Re-basing loses only the
 * instant of the step and resumes accumulating immediately.
 */
export class SessionClock {
  /** Producer-clock value that maps to `sessionTimeMs = 0`. */
  private origin = 0;
  private last = 0;
  private started = false;
  private rebases = 0;

  /** §9.1: define `sessionTimeMs = 0` here. */
  start(producerMs: number): void {
    this.origin = Number.isFinite(producerMs) ? producerMs : 0;
    this.last = 0;
    this.started = true;
    this.rebases = 0;
  }

  /**
   * Session time for an *ordering* stamp, and the only method that moves the
   * clock. Never returns less than it returned last time.
   */
  advance(producerMs: number): number {
    if (!this.started) this.start(producerMs);
    if (!Number.isFinite(producerMs)) return this.last;
    const candidate = producerMs - this.origin;
    if (candidate < this.last) {
      this.origin = producerMs - this.last;
      this.rebases++;
      return this.last;
    }
    this.last = candidate;
    return candidate;
  }

  /**
   * Apply the *current* mapping to a secondary stamp on the same producer
   * clock (`audioStartMs`, `audioEndMs`). Deliberately not `advance`: a
   * secondary stamp must not re-base the session, and mapping it through the
   * same affine transform preserves its offset from the event's own receipt
   * time exactly.
   */
  map(producerMs: number): number {
    if (!Number.isFinite(producerMs)) return this.last;
    return Math.max(0, producerMs - this.origin);
  }

  /** Session time as of the last ordering stamp. */
  get sessionTimeMs(): number {
    return this.last;
  }

  /** How many times the producer's clock has contradicted itself (§64). */
  get rebaseCount(): number {
    return this.rebases;
  }
}
