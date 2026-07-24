/**
 * Usage / cost estimation (spec §35.1–35.2).
 *
 * The rate table is a published *estimate* — the UI must always pair it with
 * "Rates may change" and never promise a fixed amount. Billable time is
 * connected-session time: soft pause keeps the session (and cost) running;
 * hard pause and stop disconnect (spec §29.7).
 */

/** Published per-minute USD rates at research cut-off (spec §35.1). */
export const REALTIME_TRANSCRIPTION_RATES_USD_PER_MINUTE: Readonly<Record<string, number>> = {
  'gpt-realtime-whisper': 0.017,
};

export interface CostEstimate {
  usd: number;
  ratePerMinuteUsd: number | null;
  /** False when the model has no published rate — show "unknown", not $0. */
  knownRate: boolean;
  billableSeconds: number;
}

export function estimateTranscriptionCostUsd(
  billableSeconds: number,
  model: string,
  rates: Readonly<Record<string, number>> = REALTIME_TRANSCRIPTION_RATES_USD_PER_MINUTE,
): CostEstimate {
  const seconds = Math.max(0, billableSeconds);
  const rate = rates[model];
  if (rate === undefined) {
    return { usd: 0, ratePerMinuteUsd: null, knownRate: false, billableSeconds: seconds };
  }
  return {
    usd: (seconds / 60) * rate,
    ratePerMinuteUsd: rate,
    knownRate: true,
    billableSeconds: seconds,
  };
}

/** "~$0.12" style display string; below half a cent shows "<$0.01". */
export function formatUsdEstimate(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.005) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}

/**
 * Accumulates connected (billable) time across connect/disconnect segments.
 * Soft pause does NOT stop accrual; only disconnection does.
 */
export class SessionUsageTracker {
  private connectedSinceMs: number | null = null;
  private accumulatedMs = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get connected(): boolean {
    return this.connectedSinceMs !== null;
  }

  markConnected(atMs = this.now()): void {
    if (this.connectedSinceMs === null) this.connectedSinceMs = atMs;
  }

  markDisconnected(atMs = this.now()): void {
    if (this.connectedSinceMs !== null) {
      this.accumulatedMs += Math.max(0, atMs - this.connectedSinceMs);
      this.connectedSinceMs = null;
    }
  }

  getBillableSeconds(atMs = this.now()): number {
    let total = this.accumulatedMs;
    if (this.connectedSinceMs !== null) total += Math.max(0, atMs - this.connectedSinceMs);
    return total / 1000;
  }

  estimate(model: string, atMs = this.now()): CostEstimate {
    return estimateTranscriptionCostUsd(this.getBillableSeconds(atMs), model);
  }

  reset(): void {
    this.connectedSinceMs = null;
    this.accumulatedMs = 0;
  }
}
