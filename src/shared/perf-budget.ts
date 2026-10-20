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
 * It claims that at least one warmed run came in under the budget — best-case
 * behaviour, not a bound on execution time, and worth being precise about
 * because "lower bound" reads like the opposite of what a minimum shows. A minimum
 * cannot see a regression that only some runs suffer: a cold-start cost, an
 * allocation pattern that provokes a collection every few passes, a cache-size
 * cliff, a tail. Those are real regressions and these tests will not catch
 * them — nor did the single-run version, reliably, since one sample on a busy
 * machine is not a measurement of anything.
 *
 * One test changed meaning: the stage wrap-plan budget used to time a COLD
 * first call and now times a warmed one, so it no longer says anything about
 * first-plan latency (which is what a presenter actually waits for). If that ever matters, it wants its own test that says so
 * rather than a budget quietly doing two jobs.
 *
 * ---------------------------------------------------------------------------
 * ONE ALLOWANCE, FOR THE WINDOWS RUNNER
 * ---------------------------------------------------------------------------
 * Best-of-N answers contention. It cannot answer a machine that is simply
 * slower, and CI's `windows-2025` runner is. The budgets were set where the
 * macOS and Linux jobs ran; when the Windows job joined (#437) its FASTEST run
 * landed on a budget's edge rather than under it — 120.4 and 126.8 ms against
 * the zero-width scan's 120, 251.2 ms against the entity retry's 250 — in runs
 * that touched neither module. On an M4 Max the same two measure 32–35 ms and
 * 51–61 ms, best of five, alone or under the whole suite: the runner is three
 * and a half to five times slower than the desk, and that is about all the
 * headroom the budgets had.
 *
 * So a Windows host is held to twice the written budget, applied here and
 * only here (`hostBudgetMs`, through `budgetMiss`), so that no call site can
 * forget it or carry a factor of its own. Twice, not just enough to clear the
 * failures seen (the worst was 1.06 of its budget): the runner's spread is
 * wide — that 251 ms best came with a 646 ms worst — and an allowance sized to
 * the last failure is the next failure. And no more than twice, because what
 * these budgets exist to catch costs far more than that. Measured on the M4
 * Max by undoing each fix: the unwindowed zero-width scan takes 6,022 ms where
 * the windowed one takes 32 (190×), and the uncapped prefix retry takes
 * 2,231 ms on entities against 51 (44×) and 255 ms on dropped blanks against
 * 16 (16×). That last is the weakest, and scaled by the slowdown above it
 * still lands at 1.8 to 2.5 times its doubled budget.
 *
 * macOS and Linux keep every budget exactly as written. What the allowance
 * gives up is what a budget claims about the Windows runner itself: there,
 * "a 5,000-word plan in well under a frame" is a tripwire for a regression,
 * not evidence about a frame, and the frame claim stands on the other jobs.
 *
 * It keys on `process.platform`, never `navigator.platform`. The node project
 * pins the navigator to a Mac on every host (tests/setup/node-platform.ts) so
 * that shortcut copy reads the same everywhere — and the speed of the machine
 * is the one thing a test here must not pretend about.
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

/**
 * What a slower host's budget is multiplied by. Measured, not guessed: the
 * header has the numbers. Every platform not named here is held to the
 * budget as written.
 */
const HOST_ALLOWANCE: Readonly<Partial<Record<NodeJS.Platform, number>>> = { win32: 2 };

/**
 * The budget a host is actually held to. The platform is a parameter so the
 * allowance can be tested on a Mac; callers leave it to default to the real OS.
 */
export function hostBudgetMs(budgetMs: number, platform: NodeJS.Platform = process.platform): number {
  return budgetMs * (HOST_ALLOWANCE[platform] ?? 1);
}

/**
 * Null when the fastest run came in under this host's budget; otherwise a
 * failure message that shows the spread, so a slow machine is obvious. Callers
 * assert `expect(budgetMiss(...)).toBeNull()` and write the budget ONCE — the
 * comparison lives here, so the number in the message and the number in the
 * assertion cannot drift apart, and neither can the allowance between files.
 */
export function budgetMiss(
  label: string,
  result: BestOfResult<unknown>,
  budgetMs: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const limitMs = hostBudgetMs(budgetMs, platform);
  if (result.elapsedMs < limitMs) return null;
  const spread = result.runsMs.map((ms) => ms.toFixed(1)).join(', ');
  const allowance = limitMs === budgetMs ? '' : `${budgetMs}ms ×${limitMs / budgetMs} on ${platform}; `;
  return `${label}: fastest of ${result.runsMs.length} runs was ${result.elapsedMs.toFixed(
    1,
  )}ms against a ${limitMs}ms budget (${allowance}all runs: ${spread}ms)`;
}
