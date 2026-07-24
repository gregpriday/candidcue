import { describe, expect, it } from 'vitest';
import { SessionHealthMonitor } from './healthMonitor';

const config = {
  staleServerEventMs: 30_000,
  noTranscriptDespiteAudioMs: 12_000,
  credentialExpiryMarginMs: 15_000,
  suspendGapMs: 10_000,
};

describe('SessionHealthMonitor (spec §29.6/§29.8)', () => {
  it('reports nothing while markers are fresh', () => {
    const monitor = new SessionHealthMonitor(config, () => 0);
    monitor.markServerEvent(1000);
    monitor.markAudioActivity(1000);
    monitor.markCompletedItem(1000);
    expect(monitor.check(2000)).toEqual([]);
  });

  it('detects stale server events', () => {
    const monitor = new SessionHealthMonitor(config);
    monitor.markServerEvent(0);
    monitor.check(1000);
    expect(monitor.check(31_001)).toContain('stale_server_events');
  });

  it('detects audio without transcript events (REALTIME_NO_TRANSCRIPTS)', () => {
    const monitor = new SessionHealthMonitor(config);
    monitor.markServerEvent(0); // connection was alive once
    monitor.check(1000);
    monitor.markAudioActivity(20_000); // speaking recently…
    const issues = monitor.check(25_000); // …but no server events since 0
    expect(issues).toContain('no_transcripts_despite_audio');
  });

  it('flags an expiring credential within the margin', () => {
    // Large suspend gap so slow polling in this test is not misread as sleep.
    const monitor = new SessionHealthMonitor({ ...config, suspendGapMs: 1_000_000 });
    monitor.setCredentialExpiry(100_000);
    monitor.check(1000);
    expect(monitor.check(84_000)).toEqual([]);
    expect(monitor.check(86_000)).toContain('credential_expiring');
  });

  it('detects a wall-clock discontinuity as suspend (§29.8)', () => {
    const monitor = new SessionHealthMonitor(config);
    monitor.check(1000);
    monitor.check(6000);
    expect(monitor.check(60_000)).toContain('suspend_detected');
  });

  it('reset clears markers for a fresh connection', () => {
    const monitor = new SessionHealthMonitor(config);
    monitor.markServerEvent(0);
    monitor.setCredentialExpiry(5000);
    monitor.reset();
    expect(monitor.check(1_000_000)).toEqual([]);
  });
});
