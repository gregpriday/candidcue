/**
 * Wall-clock budgets that survive a loaded machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Four tests time a pure computation and assert it finished inside a budget.
 * Every one of them measured a SINGLE run, and a single wall-clock measurement
 * on a machine running 40 other vitest workers is not a measurement of the
 * code: the 16 ms line-break budget was seen at 36 ms, and the release gate
 * failed on it while the same test passed on its own seconds later. A budget
 * that fails when the machine is busy trains everyone to re-run rather than to
 * read, which is worse than having no budget.
 *
 * The fix is not a wider budget — that would stop catching the quadratic
 * regressions these were written for. It is to measure BEST-OF-N. Contention
 * can only ever make a run slower, so the minimum of several runs is the
 * closest estimate of the true cost available, and it converges on the honest
 * number as the machine frees up. A genuine 2× regression in the algorithm
 * fails every one of the runs, so the assertion keeps all of its teeth.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BUDGET MEASURED THIS WAY DOES AND DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * It claims a WARMED STEADY-STATE lower bound, and nothing else. A minimum
 * cannot see a regression that only some runs suffer: a cold-start cost, an
 * allocation pattern that provokes a collection every few passes, a cache-size
 * cliff, a tail. Those are real regressions and these tests will not catch
 * them — nor did the single-run version, reliably, since one sample on a busy
 * machine is not a measurement of anything.
 *
 * One test changed meaning: the stage wrap-plan budget used to time a COLD
 * first call and now times a warmed one, so it no longer says anything about
 * first-plan latency. If that ever matters, it wants its own test that says so
 * rather than a budget quietly doing two jobs.
 *
 * Not exported from a test file, because two of the callers live under `src/`
 * and two under `tests/`, and a helper copied four times is a helper that drifts.
 */

/** How many timed runs to take. Small: each one is a full workload. */
const DEFAULT_RUNS = 5;

export interface BestOfResult<T> {
  /** The fastest observed run, in milliseconds. */
  elapsedMs: number;
  /** Every run, fastest first — for a failure message worth reading. */
  runsMs: number[];
  /** Whatever the last run returned, so the caller can assert on the output. */
  value: T;
}

/**
 * Run `work` a few times and report the fastest.
 *
 * ONE untimed warm-up: what these budgets are about is the solve, not the JIT
 * compiling it. Callers used to do this by hand and two of them forgot. (The
 * first version of this ran two, while its own comment said one — harmless
 * here, and exactly the kind of drift between a comment and its code that makes
 * a timing helper untrustworthy.)
 */
export function bestOf<T>(work: () => T, runs: number = DEFAULT_RUNS): BestOfResult<T> {
  let value = work();
  const runsMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const startedAt = performance.now();
    value = work();
    runsMs.push(performance.now() - startedAt);
  }
  runsMs.sort((a, b) => a - b);
  return { elapsedMs: runsMs[0] ?? 0, runsMs, value };
}

/** A failure message that shows the spread, so a slow machine is obvious. */
export function budgetMessage(label: string, result: BestOfResult<unknown>, budgetMs: number): string {
  const spread = result.runsMs.map((ms) => ms.toFixed(1)).join(', ');
  return `${label}: fastest of ${result.runsMs.length} runs was ${result.elapsedMs.toFixed(
    1,
  )}ms against a ${budgetMs}ms budget (all runs: ${spread}ms)`;
}
