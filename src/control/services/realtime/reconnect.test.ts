import { describe, expect, it } from 'vitest';
import { computeReconnectDelayMs, DEFAULT_RECONNECT_POLICY, ReconnectScheduler } from './reconnect';

const noJitter = { ...DEFAULT_RECONNECT_POLICY, jitterRatio: 0 };

describe('computeReconnectDelayMs (spec §29.6)', () => {
  it('makes the first retry immediate', () => {
    expect(computeReconnectDelayMs(1, noJitter)).toBe(0);
  });

  it('then backs off exponentially with a cap', () => {
    expect(computeReconnectDelayMs(2, noJitter)).toBe(1000);
    expect(computeReconnectDelayMs(3, noJitter)).toBe(2000);
    expect(computeReconnectDelayMs(4, noJitter)).toBe(4000);
    expect(computeReconnectDelayMs(5, noJitter)).toBe(8000);
    expect(computeReconnectDelayMs(6, noJitter)).toBe(15000); // capped
    expect(computeReconnectDelayMs(7, noJitter)).toBe(15000);
  });

  it('is bounded: returns null past maxAttempts', () => {
    expect(computeReconnectDelayMs(noJitter.maxAttempts, noJitter)).not.toBeNull();
    expect(computeReconnectDelayMs(noJitter.maxAttempts + 1, noJitter)).toBeNull();
    expect(computeReconnectDelayMs(0, noJitter)).toBeNull();
  });

  it('applies bounded jitter downward only', () => {
    const withJitter = { ...DEFAULT_RECONNECT_POLICY, jitterRatio: 0.5 };
    const delay = computeReconnectDelayMs(3, withJitter, () => 1);
    expect(delay).toBe(1000); // 2000 - 50%
    const noRandom = computeReconnectDelayMs(3, withJitter, () => 0);
    expect(noRandom).toBe(2000);
  });
});

describe('ReconnectScheduler', () => {
  it('steps through the policy and resets after success', () => {
    const scheduler = new ReconnectScheduler(noJitter);
    expect(scheduler.nextDelayMs()).toBe(0);
    expect(scheduler.nextDelayMs()).toBe(1000);
    expect(scheduler.attemptCount).toBe(2);
    scheduler.reset();
    expect(scheduler.attemptCount).toBe(0);
    expect(scheduler.nextDelayMs()).toBe(0);
  });

  it('exhausts to null', () => {
    const scheduler = new ReconnectScheduler({ ...noJitter, maxAttempts: 2 });
    expect(scheduler.nextDelayMs()).toBe(0);
    expect(scheduler.nextDelayMs()).toBe(1000);
    expect(scheduler.nextDelayMs()).toBeNull();
  });
});
