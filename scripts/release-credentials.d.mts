/**
 * Types for what `release-credentials.mjs` exports to TypeScript.
 *
 * `tests/integration/release-gates.test.ts` reads `REQUIRED` to hold each
 * release workflow's secret mapping to the names the script checks. The
 * script itself is plain ESM, run by bare `node` in the release workflows.
 */
export declare const REQUIRED: {
  readonly build: {
    readonly macos: readonly string[];
    readonly windows: readonly string[];
    readonly linux: readonly string[];
  };
  readonly publish: readonly string[];
};

/** The names in `required` that are unset, empty or only whitespace in `env`. */
export declare function missing(
  required: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[];
