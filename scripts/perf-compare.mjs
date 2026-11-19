#!/usr/bin/env node
/**
 * Compare a perf recording against a baseline (issue #240).
 *
 *   node scripts/perf-compare.mjs bench/perf/mac-studio-m4-max.json bench/perf/runs/<new>.json
 *
 * Exit 0: every series within its threshold. Exit 1: a series regressed at
 * its p50 or p95, a series the baseline has is missing, or the candidate has
 * an invalid pair. Exit 2: the two
 * cannot be compared (another Mac, scenario or fixture) or a file is
 * unreadable. It never writes either file: replacing a baseline is a
 * decision, made by copying a recording over it and committing that.
 */
import { readFileSync } from 'node:fs';
import { compareReports, formatComparison } from './perf-report.mjs';

const [basePath, candidatePath] = process.argv.slice(2);
if (!basePath || !candidatePath) {
  process.stderr.write('usage: node scripts/perf-compare.mjs <baseline.json> <candidate.json>\n');
  process.exit(2);
}

let base;
let candidate;
try {
  // Shape is checked by compareReports (exit 2); this only has to parse.
  base = JSON.parse(readFileSync(basePath, 'utf8'));
  candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

let result;
let text;
try {
  result = compareReports(base, candidate);
  text = formatComparison(result);
} catch (err) {
  // Anything the shape checks did not anticipate is still "cannot compare".
  process.stderr.write(`Not comparable: ${err.message}\n`);
  process.exit(2);
}
process.stdout.write(text);
if (!result.comparable) process.exit(2);
if (!result.passed) {
  process.stdout.write(
    `\n${result.regressions.length} series regressed, ${result.missing.length} missing, ` +
      `${result.invalidPairs.length} invalid pair(s)\n`,
  );
  process.exit(1);
}
