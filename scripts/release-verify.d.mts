/**
 * Types for the one thing `release-verify.mjs` exports to TypeScript.
 *
 * `tests/integration/release-gates.test.ts` imports `PLAN` to assert that CI
 * claims every step in it. The runner itself is plain ESM — it has to run under
 * bare `node` with no build step, because it is what proves the build works —
 * so its type surface lives here rather than in the script.
 *
 * Only `PLAN` is declared. Everything else in that file is a side effect of
 * being invoked as a program, and importing the module deliberately runs
 * nothing.
 */
export declare const PLAN: ReadonlyArray<{
  /** Cheapest tier this step belongs to; a tier is a floor, not a filter. */
  readonly tier: 'fast' | 'code' | 'full';
  /** The name CI passes to `--only=`. */
  readonly name: string;
  /** What a green run of this step actually establishes. */
  readonly proves: string;
}>;
