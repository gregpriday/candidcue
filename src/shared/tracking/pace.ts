/**
 * Speaking-pace and lead estimation (spec §32.2). Pure and deterministic —
 * timestamps are supplied by the caller.
 */

interface PaceSample {
  atMs: number;
  matchedTokens: number;
}

const WINDOW_MS = 12_000;

export class PaceEstimator {
  private samples: PaceSample[] = [];

  /** Record matched tokens observed at `atMs` (from committed alignments). */
  record(matchedTokens: number, atMs: number): void {
    if (matchedTokens <= 0) return;
    this.samples.push({ atMs, matchedTokens });
    const cutoff = atMs - WINDOW_MS;
    while (this.samples.length > 0) {
      const first = this.samples[0];
      if (first === undefined || first.atMs >= cutoff) break;
      this.samples.shift();
    }
  }

  /** Tokens per second over the recent window; 0 with insufficient data. */
  tokensPerSecond(nowMs: number): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    if (first === undefined) return 0;
    const spanMs = Math.max(1, nowMs - first.atMs);
    if (spanMs < 1500) return 0; // too little signal to trust
    let total = 0;
    for (const sample of this.samples) total += sample.matchedTokens;
    return (total / spanMs) * 1000;
  }

  /**
   * Forward lead in tokens compensating transcription + animation lag
   * (spec §32.2, G.6). Clamped by the caller's profile.
   */
  leadTokens(latencyMs: number, nowMs: number, maxLeadTokens: number): number {
    const pace = this.tokensPerSecond(nowMs);
    if (pace <= 0) return 0;
    const lead = (pace * Math.max(0, latencyMs)) / 1000;
    return Math.max(0, Math.min(maxLeadTokens, Math.round(lead)));
  }

  reset(): void {
    this.samples = [];
  }
}

/** Rolling estimate of end-to-end transcription latency (spec §32.2). */
export class LatencyEstimator {
  private estimateMs: number;

  constructor(initialMs = 450) {
    this.estimateMs = initialMs;
  }

  /** Feed one observation: audioEndMs → usable-text receivedAtMs delta. */
  observe(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > 5000) return;
    // Exponential smoothing keeps this deterministic and stable.
    this.estimateMs = this.estimateMs * 0.8 + deltaMs * 0.2;
  }

  currentMs(): number {
    return this.estimateMs;
  }
}
