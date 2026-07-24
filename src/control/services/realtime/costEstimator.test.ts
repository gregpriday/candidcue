import { describe, expect, it } from 'vitest';
import {
  estimateTranscriptionCostUsd,
  formatUsdEstimate,
  SessionUsageTracker,
} from './costEstimator';

describe('estimateTranscriptionCostUsd (spec §35.1)', () => {
  it('prices gpt-realtime-whisper at ~$0.017/min', () => {
    const oneHour = estimateTranscriptionCostUsd(3600, 'gpt-realtime-whisper');
    expect(oneHour.usd).toBeCloseTo(1.02, 5);
    expect(oneHour.ratePerMinuteUsd).toBe(0.017);
    expect(oneHour.knownRate).toBe(true);
  });

  it('reports unknown rates honestly instead of claiming $0', () => {
    const estimate = estimateTranscriptionCostUsd(600, 'some-future-model');
    expect(estimate.knownRate).toBe(false);
    expect(estimate.ratePerMinuteUsd).toBeNull();
  });

  it('clamps negative durations', () => {
    expect(estimateTranscriptionCostUsd(-5, 'gpt-realtime-whisper').billableSeconds).toBe(0);
  });
});

describe('formatUsdEstimate (spec §35.2)', () => {
  it('formats zero, sub-cent, and normal values', () => {
    expect(formatUsdEstimate(0)).toBe('$0.00');
    expect(formatUsdEstimate(0.001)).toBe('<$0.01');
    expect(formatUsdEstimate(0.123)).toBe('~$0.12');
  });
});

describe('SessionUsageTracker (spec §29.7/§35.2)', () => {
  it('accrues connected time across segments; soft pause keeps accruing', () => {
    let now = 0;
    const tracker = new SessionUsageTracker(() => now);
    tracker.markConnected();
    now = 60_000; // one connected minute (even if soft-paused throughout)
    expect(tracker.getBillableSeconds()).toBe(60);
    tracker.markDisconnected(); // hard pause / stop
    now = 120_000; // a minute of disconnection accrues nothing
    expect(tracker.getBillableSeconds()).toBe(60);
    tracker.markConnected();
    now = 150_000;
    expect(tracker.getBillableSeconds()).toBe(90);
    const estimate = tracker.estimate('gpt-realtime-whisper');
    expect(estimate.usd).toBeCloseTo((90 / 60) * 0.017, 6);
  });

  it('is idempotent for repeated marks and resettable', () => {
    let now = 0;
    const tracker = new SessionUsageTracker(() => now);
    tracker.markConnected();
    tracker.markConnected(); // no double-count
    now = 10_000;
    tracker.markDisconnected();
    tracker.markDisconnected();
    expect(tracker.getBillableSeconds()).toBe(10);
    tracker.reset();
    expect(tracker.getBillableSeconds()).toBe(0);
  });
});
