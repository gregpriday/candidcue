/**
 * Reconnect policy (spec §29.6): one immediate reconnect for transient
 * network loss, then bounded exponential backoff capped at a short interval
 * while the user remains in Live mode. A fresh credential is minted for
 * every attempt (enforced by the controller/transport, not here). Pure.
 */

export interface ReconnectPolicyConfig {
  /** First retry is immediate (spec §29.6). */
  immediateFirstRetry: boolean;
  baseDelayMs: number;
  multiplier: number;
  /** Cap — "a short interval" while Live mode is active. */
  maxDelayMs: number;
  /** Bounded attempts (Appendix A.6: reconnect attempts are policy-bounded). */
  maxAttempts: number;
  /** 0..1 fraction of the delay randomized to avoid thundering herds. */
  jitterRatio: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicyConfig = {
  immediateFirstRetry: true,
  baseDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 15_000,
  maxAttempts: 8,
  jitterRatio: 0.2,
};

/**
 * Delay in ms before reconnect attempt `attempt` (1-based), or null when the
 * policy is exhausted.
 */
export function computeReconnectDelayMs(
  attempt: number,
  config: ReconnectPolicyConfig = DEFAULT_RECONNECT_POLICY,
  random: () => number = Math.random,
): number | null {
  if (attempt < 1 || attempt > config.maxAttempts) return null;
  if (config.immediateFirstRetry && attempt === 1) return 0;
  const backoffStep = config.immediateFirstRetry ? attempt - 2 : attempt - 1;
  const raw = config.baseDelayMs * config.multiplier ** Math.max(0, backoffStep);
  const capped = Math.min(raw, config.maxDelayMs);
  const jitter = capped * config.jitterRatio * random();
  return Math.round(capped - jitter);
}

/** Stateful convenience wrapper used by the session controller. */
export class ReconnectScheduler {
  private attempt = 0;

  constructor(
    private readonly config: ReconnectPolicyConfig = DEFAULT_RECONNECT_POLICY,
    private readonly random: () => number = Math.random,
  ) {}

  get attemptCount(): number {
    return this.attempt;
  }

  /** Next delay in ms, or null when attempts are exhausted. */
  nextDelayMs(): number | null {
    this.attempt += 1;
    return computeReconnectDelayMs(this.attempt, this.config, this.random);
  }

  /** Call after a successful, verified reconnection. */
  reset(): void {
    this.attempt = 0;
  }
}
