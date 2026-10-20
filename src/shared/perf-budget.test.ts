import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BestOfResult, bestOf, budgetMiss, hostBudgetMs } from './perf-budget';

/** The Windows runner's zero-width scan on PR #439: on the edge of 120. */
const WINDOWS_ZERO_WIDTH: BestOfResult<undefined> = {
  elapsedMs: 126.8,
  runsMs: [126.8, 136.0, 154.1, 156.9, 174.1],
  value: undefined,
};

function result(runsMs: number[]): BestOfResult<undefined> {
  return { elapsedMs: runsMs[0] ?? 0, runsMs, value: undefined };
}

describe('hostBudgetMs', () => {
  it('holds macOS and Linux to the budget as written', () => {
    expect(hostBudgetMs(120, 'darwin')).toBe(120);
    expect(hostBudgetMs(120, 'linux')).toBe(120);
  });

  it('gives Windows twice the budget', () => {
    expect(hostBudgetMs(120, 'win32')).toBe(240);
    expect(hostBudgetMs(16, 'win32')).toBe(32);
  });

  it('reads the real OS, not the navigator the node project pins to a Mac', () => {
    // The pin is in force on every host (tests/setup/node-platform.ts), so an
    // allowance keyed on it would never reach the Windows runner it is for.
    expect(navigator.platform).toBe('MacIntel');
    expect(hostBudgetMs(100)).toBe(process.platform === 'win32' ? 200 : 100);
  });
});

describe('budgetMiss', () => {
  it('is null when the fastest run is under the budget', () => {
    expect(budgetMiss('scan', result([31.5, 33.2, 34.9]), 120, 'darwin')).toBeNull();
  });

  it('names the fastest run, the budget and the spread when it misses', () => {
    expect(budgetMiss('zero-width scan', WINDOWS_ZERO_WIDTH, 120, 'darwin')).toBe(
      'zero-width scan: fastest of 5 runs was 126.8ms against a 120ms budget ' +
        '(all runs: 126.8, 136.0, 154.1, 156.9, 174.1ms)',
    );
  });

  it('misses on the budget itself, as the strict comparison it replaced did', () => {
    expect(budgetMiss('scan', result([120]), 120, 'darwin')).not.toBeNull();
  });

  it('passes the Windows runner its measured edge, and says so when it misses', () => {
    expect(budgetMiss('zero-width scan', WINDOWS_ZERO_WIDTH, 120, 'win32')).toBeNull();
    expect(budgetMiss('zero-width scan', result([250.4, 260.0]), 120, 'win32')).toBe(
      'zero-width scan: fastest of 2 runs was 250.4ms against a 240ms budget ' +
        '(120ms ×2 on win32; all runs: 250.4, 260.0ms)',
    );
  });
});

describe('bestOf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warms up once untimed, then reports the fastest timed run first', () => {
    // Each timed run reads the clock twice; these pairs last 30, 10 and 20 ms.
    const clock = [0, 30, 100, 110, 200, 220];
    vi.spyOn(performance, 'now').mockImplementation(() => clock.shift() ?? 0);
    let calls = 0;

    const run = bestOf(() => ++calls, 3);

    expect(calls).toBe(4);
    expect(run.runsMs).toEqual([10, 20, 30]);
    expect(run.elapsedMs).toBe(10);
    expect(run.value).toBe(4);
  });
});
