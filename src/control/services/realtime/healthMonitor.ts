/**
 * Keepalive / session health monitor (spec §29.6, §29.8).
 *
 * Tracks the liveness markers the spec requires — last audio activity, last
 * server event, last completed item, credential expiry — plus a wall-clock
 * discontinuity check for sleep/wake detection. Pure with an injected clock;
 * the controller polls `check()` on its own cadence.
 */

export interface HealthMonitorConfig {
  /** No server event for this long while listening → stale connection. */
  staleServerEventMs: number;
  /** Audio active but no transcript events for this long → REALTIME_NO_TRANSCRIPTS. */
  noTranscriptDespiteAudioMs: number;
  /** Reconnect proactively when the credential expires within this margin. */
  credentialExpiryMarginMs: number;
  /** Wall-clock jump larger than this suggests system sleep (spec §29.8). */
  suspendGapMs: number;
}

export const DEFAULT_HEALTH_MONITOR_CONFIG: HealthMonitorConfig = {
  staleServerEventMs: 30_000,
  noTranscriptDespiteAudioMs: 12_000,
  credentialExpiryMarginMs: 15_000,
  suspendGapMs: 10_000,
};

export type HealthIssue =
  | 'stale_server_events'
  | 'no_transcripts_despite_audio'
  | 'credential_expiring'
  | 'suspend_detected';

export class SessionHealthMonitor {
  private lastServerEventAtMs: number | null = null;
  private lastAudioActivityAtMs: number | null = null;
  private lastCompletedItemAtMs: number | null = null;
  private credentialExpiresAt: number | null = null;
  private lastCheckAtMs: number | null = null;

  constructor(
    private readonly config: HealthMonitorConfig = DEFAULT_HEALTH_MONITOR_CONFIG,
    private readonly now: () => number = () => Date.now(),
  ) {}

  markServerEvent(atMs = this.now()): void {
    this.lastServerEventAtMs = atMs;
  }

  markAudioActivity(atMs = this.now()): void {
    this.lastAudioActivityAtMs = atMs;
  }

  markCompletedItem(atMs = this.now()): void {
    this.lastCompletedItemAtMs = atMs;
  }

  /** Epoch MILLISECONDS, same clock as `now()` (C1). */
  setCredentialExpiry(expiresAtEpochMs: number | null): void {
    this.credentialExpiresAt = expiresAtEpochMs;
  }

  /** Reset markers for a fresh connection. */
  reset(): void {
    this.lastServerEventAtMs = null;
    this.lastAudioActivityAtMs = null;
    this.lastCompletedItemAtMs = null;
    this.credentialExpiresAt = null;
    this.lastCheckAtMs = null;
  }

  /** Evaluate liveness now. Call periodically while connected. */
  check(atMs = this.now()): HealthIssue[] {
    const issues: HealthIssue[] = [];

    if (this.lastCheckAtMs !== null && atMs - this.lastCheckAtMs > this.config.suspendGapMs) {
      issues.push('suspend_detected');
    }
    this.lastCheckAtMs = atMs;

    if (
      this.lastServerEventAtMs !== null &&
      atMs - this.lastServerEventAtMs > this.config.staleServerEventMs
    ) {
      issues.push('stale_server_events');
    }

    if (
      this.lastAudioActivityAtMs !== null &&
      atMs - this.lastAudioActivityAtMs <= this.config.noTranscriptDespiteAudioMs &&
      (this.lastCompletedItemAtMs === null ||
        atMs - this.lastCompletedItemAtMs > this.config.noTranscriptDespiteAudioMs) &&
      (this.lastServerEventAtMs === null ||
        atMs - this.lastServerEventAtMs > this.config.noTranscriptDespiteAudioMs)
    ) {
      issues.push('no_transcripts_despite_audio');
    }

    if (
      this.credentialExpiresAt !== null &&
      this.credentialExpiresAt - atMs <= this.config.credentialExpiryMarginMs
    ) {
      issues.push('credential_expiring');
    }

    return issues;
  }
}
