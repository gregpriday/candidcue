/**
 * Types for what `perf-report.mjs` exports to TypeScript.
 *
 * `tests/unit/perf-report.test.ts` drives the pure functions with supplied
 * numbers. The script itself is plain ESM, run under bare `node` by
 * `perf-run.mjs` and `perf-compare.mjs`, so its type surface lives here.
 */

export declare const REPORT_SCHEMA: number;
export declare const SCENARIO_ID: string;
export declare const LONG_FRAME_MS: number;

export interface PerfRecord {
  kind: string;
  [key: string]: unknown;
}

export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface FrameTail {
  frames: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  long: number;
}

export interface LaunchTimes {
  spawnToReadyMs: number | null;
  /** The head's first script (public/boot-mark.js) → the entry's first statement; null in older recordings. */
  bundleEvaluateMs: number | null;
  spawnToNavigationMs: number | null;
  navigationToEntryMs: number | null;
  entryToMountedMs: number | null;
  navigationToReadyMs: number | null;
}

export interface Pair {
  pair: number;
  valid: boolean;
  problems: string[];
  launches: { cold: LaunchTimes | null; warm: LaunchTimes | null };
  opens: { ms: number | null; words: unknown }[];
  presents: { ms: number | null; outcome: unknown }[];
  takes: {
    outcome: unknown;
    durationMs: number | null;
    displacementPx: number | null;
    longestStillMs: number | null;
    deltas: number[];
  }[];
  env: PerfRecord | null;
  /** The runner's 1-minute load average before and after the pair. */
  load?: [number, number];
}

export interface Threshold {
  relative: number;
  absolute: number;
}

export interface Report {
  schema: number;
  scenario: { id: string; fixtureSha256: string; [key: string]: unknown };
  machine: { model: string; chip: string; [key: string]: unknown };
  thresholds?: Record<string, Threshold>;
  pairs: Pair[];
  [key: string]: unknown;
}

export interface ComparisonRow {
  name: string;
  base: Summary;
  candidate: Summary;
  threshold: Threshold;
  crossed: ('p50' | 'p95')[];
}

export interface Comparison {
  comparable: boolean;
  /** Median 1-minute load at each pair's start, where the recordings carry it. */
  load?: { base: number | null; candidate: number | null };
  /** Comparable, nothing regressed, nothing missing, no invalid candidate pair. */
  passed: boolean;
  reasons: string[];
  rows: ComparisonRow[];
  missing: string[];
  regressions: string[];
  invalidPairs: { pair: number; problems: string[] }[];
}

export declare const DEFAULT_THRESHOLDS: Record<string, Threshold>;

export declare function parseTrace(text: string): PerfRecord[];
export declare function nearestRank(sorted: number[], p: number): number | null;
export declare function summarise(values: number[]): Summary;
export declare function frameTail(deltas: number[]): FrameTail;
export declare function assemblePair(input: {
  pair: number;
  firstUse: PerfRecord[];
  relaunch: PerfRecord[];
  spawnedAt: { firstUse: number; relaunch: number };
  /** The checkout's fixture digest, checked against the one the app reports. */
  fixtureSha256?: string | null;
}): Pair;
export declare function seriesOf(report: Pick<Report, 'pairs'>): Record<string, number[]>;
export declare function incompatibilities(base: Report, candidate: Report): string[];
export declare function compareReports(base: Report, candidate: Report): Comparison;
export declare function formatComparison(result: Comparison): string;
export declare function serialiseReport(report: unknown): string;
