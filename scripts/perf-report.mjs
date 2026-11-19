/**
 * The recorded performance of a presenter's waits, and how to compare two
 * recordings (issue #240).
 *
 * `src/shared/perf-budget.ts` takes the FASTEST of several warmed runs, which
 * is what keeps the unit budgets stable under parallel vitest load and also
 * what makes them blind to a cold start, a collection every few passes, or a
 * tail. This file is the other half: a distribution, recorded on a named Mac
 * from the packaged app (`scripts/perf-run.mjs`), compared against another
 * distribution by its median AND its 95th percentile, with every maximum
 * shown. One slow launch in twenty moves the p95 and the max here; it would
 * have vanished into a minimum.
 *
 * Pure: no filesystem, no clock, no process. The runner and the comparison
 * CLI own those, and `tests/unit/perf-report.test.ts` drives everything here
 * with supplied numbers, so nothing in the test suite is a wall-clock
 * measurement that could flake under load.
 *
 * Plain ESM run under bare `node`; the type surface is `perf-report.d.mts`.
 */

/** Bumped when a record's or a report's shape changes incompatibly. */
export const REPORT_SCHEMA = 1;

/** The scenario the page runs. A change to what it does is a new id. */
export const SCENARIO_ID = 'huge-two-takes-v1';

/** What the control page prefixes its JSON with in the client trace. */
const TRACE_LINE = /^\S+ \[perf\] (\{.*\})\s*$/;

/** A frame longer than this is counted as long: three missed 60 Hz frames. */
export const LONG_FRAME_MS = 50;

/**
 * Pull the scenario's records out of a `client-trace.log`.
 *
 * Lines from any other scope, and lines that are not JSON, are skipped rather
 * than fatal: the trace is shared with the audio tracer, and the runner judges
 * completeness from the records it needed, not from the absence of noise.
 */
export function parseTrace(text) {
  const records = [];
  for (const line of text.split('\n')) {
    const match = TRACE_LINE.exec(line);
    if (match === null) continue;
    try {
      const record = JSON.parse(match[1]);
      if (record !== null && typeof record === 'object' && typeof record.kind === 'string') {
        records.push(record);
      }
    } catch {
      // A line truncated at the command's 2,000-character cap, most likely.
      // The frame chunks are sized under it, so this is a bug worth seeing in
      // the pair's validity, not here.
    }
  }
  return records;
}

/** Nearest-rank percentile of an ascending array: the value at ceil(p·n). */
export function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** n, p50, p95, max. Null fields for an empty series. */
export function summarise(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
}

/** One take's frame-interval tail: what a presenter sees as a hitch. */
export function frameTail(deltas) {
  const sorted = deltas.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  return {
    frames: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
    long: sorted.filter((v) => v > LONG_FRAME_MS).length,
  };
}

function only(records, kind, predicate = () => true) {
  return records.filter((r) => r.kind === kind && predicate(r));
}

/**
 * Join one launch pair's records into the pair the report keeps.
 *
 * `firstUse` and `relaunch` are the two processes' records; `spawnedAt` gives
 * each process's spawn time on the epoch clock, which the page's
 * `performance.timeOrigin` shares — so "spawn to ready" includes the native
 * start and the webview's creation, which no in-page clock can see.
 *
 * Anything missing, duplicated, errored or invalid makes the pair INVALID and
 * says why. An invalid pair stays in the report — a launch that timed out is
 * a finding, not noise — and is kept out of every series.
 */
export function assemblePair({ pair, firstUse, relaunch, spawnedAt }) {
  const problems = [];
  const launch = (records, phase, spawned) => {
    const found = only(records, 'launch', (r) => r.phase === phase);
    if (found.length !== 1) {
      problems.push(`${phase}: ${found.length} launch records`);
      return null;
    }
    const r = found[0];
    if (!only(records, 'done', (d) => d.phase === phase).length) problems.push(`${phase}: no done record`);
    return {
      spawnToReadyMs: round(r.timeOrigin + r.readyMs - spawned),
      spawnToNavigationMs: round(r.timeOrigin - spawned),
      navigationToEntryMs: round(r.entryMs),
      entryToMountedMs: round(r.mountedMs - r.entryMs),
      navigationToReadyMs: round(r.readyMs),
    };
  };
  for (const [phase, records] of [
    ['first-use', firstUse],
    ['relaunch', relaunch],
  ]) {
    for (const e of only(records, 'error')) problems.push(`${phase}: ${e.step}: ${e.message}`);
  }
  const ordinals = (kind) => {
    const found = only(relaunch, kind).sort((a, b) => a.ordinal - b.ordinal);
    if (found.length !== 2 || found[0].ordinal !== 1 || found[1].ordinal !== 2) {
      problems.push(`relaunch: expected ${kind} records 1 and 2, found ${found.map((r) => r.ordinal).join(',') || 'none'}`);
    }
    return found;
  };
  const opens = ordinals('open').map((r) => ({ ms: round(r.ms), words: r.words }));
  const presents = ordinals('present').map((r) => {
    if (r.outcome !== 'readable') problems.push(`present ${r.ordinal}: ${r.outcome}`);
    return { ms: round(r.ms), outcome: r.outcome };
  });
  const takes = ordinals('take').map((r) => {
    if (r.outcome !== 'ok') problems.push(`take ${r.ordinal}: ${r.outcome}`);
    const chunks = only(relaunch, 'frames', (f) => f.ordinal === r.ordinal).sort((a, b) => a.part - b.part);
    const parts = chunks[0]?.parts ?? 0;
    if (chunks.length !== parts || chunks.some((c, i) => c.part !== i + 1 || c.parts !== parts)) {
      problems.push(`take ${r.ordinal}: frame chunks incomplete (${chunks.length} of ${parts})`);
    }
    const deltas = chunks.flatMap((c) => c.deltas);
    if (deltas.length !== r.frameCount) {
      problems.push(`take ${r.ordinal}: ${deltas.length} frame intervals, the page counted ${r.frameCount}`);
    }
    if (!(r.displacementPx > 0)) problems.push(`take ${r.ordinal}: the script did not move`);
    return {
      outcome: r.outcome,
      durationMs: round(r.durationMs),
      displacementPx: round(r.displacementPx),
      deltas,
    };
  });
  const env = only(relaunch, 'env')[0] ?? only(firstUse, 'env')[0] ?? null;
  // Before `valid` is read: each of these adds its own problems.
  const launches = {
    cold: launch(firstUse, 'first-use', spawnedAt.firstUse),
    warm: launch(relaunch, 'relaunch', spawnedAt.relaunch),
  };
  return {
    pair,
    valid: problems.length === 0,
    problems,
    launches,
    opens,
    presents,
    takes,
    env,
  };
}

function round(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null;
}

/**
 * Every compared series, one value per VALID pair.
 *
 * Cold and warm are always separate series, never pooled: a first launch and
 * a relaunch are different waits, and pooling them would let a cold-start
 * regression hide behind twenty quick relaunches. Cold means first use of a
 * fresh profile (launch) or the first time in a process (open, Present,
 * take); warm means the second.
 */
export function seriesOf(report) {
  const series = {};
  const push = (name, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    (series[name] ??= []).push(value);
  };
  for (const pair of report.pairs.filter((p) => p.valid)) {
    for (const temp of ['cold', 'warm']) {
      const l = pair.launches[temp];
      push(`launch.${temp}.spawn-to-ready`, l?.spawnToReadyMs);
      push(`launch.${temp}.spawn-to-navigation`, l?.spawnToNavigationMs);
      push(`launch.${temp}.navigation-to-entry`, l?.navigationToEntryMs);
    }
    ['cold', 'warm'].forEach((temp, i) => {
      push(`open.${temp}`, pair.opens[i]?.ms);
      push(`present.${temp}`, pair.presents[i]?.ms);
      const take = pair.takes[i];
      if (take !== undefined) {
        const tail = frameTail(take.deltas);
        push(`frames.${temp}.p95`, tail.p95);
        push(`frames.${temp}.p99`, tail.p99);
        push(`frames.${temp}.max`, tail.max);
        push(`frames.${temp}.long`, tail.long);
      }
    });
  }
  return series;
}

/**
 * How much worse a candidate may be before it is a regression, by series
 * family: `base × (1 + relative) + absoluteMs`. The defaults are a starting
 * point; a baseline carries its own, set from repeat runs of an unchanged
 * build on its Mac (bench/perf/README.md), and those win.
 */
export const DEFAULT_THRESHOLDS = {
  launch: { relative: 0.2, absolute: 60 },
  open: { relative: 0.2, absolute: 40 },
  present: { relative: 0.2, absolute: 40 },
  frames: { relative: 0.25, absolute: 4 },
  // A COUNT of frames over LONG_FRAME_MS per take, not milliseconds: most
  // takes have none, so a relative allowance alone would make one stray
  // frame a regression.
  longFrames: { relative: 0.5, absolute: 1 },
};

function thresholdFor(name, thresholds) {
  const family = name.endsWith('.long') ? 'longFrames' : name.split('.')[0];
  return thresholds[family] ?? DEFAULT_THRESHOLDS[family] ?? { relative: 0.2, absolute: 0 };
}

/** Reasons two reports cannot be compared at all. Empty when they can. */
export function incompatibilities(base, candidate) {
  const reasons = [];
  if (base.schema !== candidate.schema) reasons.push(`schema ${base.schema} vs ${candidate.schema}`);
  if (base.scenario?.id !== candidate.scenario?.id) {
    reasons.push(`scenario ${base.scenario?.id} vs ${candidate.scenario?.id}`);
  }
  if (base.scenario?.fixtureSha256 !== candidate.scenario?.fixtureSha256) reasons.push('the fixture script differs');
  if (base.machine?.model !== candidate.machine?.model || base.machine?.chip !== candidate.machine?.chip) {
    reasons.push(
      `machine ${base.machine?.model} ${base.machine?.chip} vs ${candidate.machine?.model} ${candidate.machine?.chip}`,
    );
  }
  return reasons;
}

/**
 * Compare a candidate against a baseline.
 *
 * A series regresses when the candidate's p50 OR p95 is past the baseline's
 * by more than the threshold. The p95 is what a minimum could never show: one
 * cold-start cost in a few launches lands there. Maxima are reported but
 * never decide a verdict — one sample is the max, and a single scheduler
 * hiccup on a desk Mac would otherwise fail every comparison — so they are
 * shown for a person to read.
 *
 * An invalid candidate pair fails the comparison outright: a launch that
 * never became ready is the worst regression there is, and dropping it from
 * the series would report the survivors as a pass.
 */
export function compareReports(base, candidate) {
  const reasons = incompatibilities(base, candidate);
  if (reasons.length) return { comparable: false, reasons, rows: [], regressions: [], invalidPairs: [] };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(base.thresholds ?? {}) };
  const a = seriesOf(base);
  const b = seriesOf(candidate);
  const rows = [];
  for (const name of Object.keys(a).filter((n) => n in b).sort()) {
    const sa = summarise(a[name]);
    const sb = summarise(b[name]);
    const t = thresholdFor(name, thresholds);
    const limit = (v) => v * (1 + t.relative) + t.absolute;
    const crossed = [];
    if (sb.p50 > limit(sa.p50)) crossed.push('p50');
    if (sb.p95 > limit(sa.p95)) crossed.push('p95');
    rows.push({ name, base: sa, candidate: sb, threshold: t, crossed });
  }
  const missing = Object.keys(a).filter((n) => !(n in b));
  const invalidPairs = candidate.pairs.filter((p) => !p.valid).map((p) => ({ pair: p.pair, problems: p.problems }));
  return {
    comparable: true,
    reasons: [],
    rows,
    missing,
    regressions: rows.filter((r) => r.crossed.length > 0).map((r) => r.name),
    invalidPairs,
  };
}

/** The comparison as plain text, one row per series. */
export function formatComparison(result) {
  if (!result.comparable) return `Not comparable: ${result.reasons.join('; ')}\n`;
  const ms = (v) => (v === null || v === undefined ? '—' : v.toFixed(1));
  const pct = (a, b) => (a > 0 ? `${(((b - a) / a) * 100).toFixed(0)}%` : '—');
  const lines = [
    'series                               n   base p50/p95/max          cand p50/p95/max          Δp50     Δp95   verdict',
  ];
  for (const r of result.rows) {
    const verdict = r.crossed.length ? `REGRESSED (${r.crossed.join(', ')})` : 'ok';
    lines.push(
      [
        r.name.padEnd(34),
        String(r.candidate.n).padStart(3),
        `${ms(r.base.p50)}/${ms(r.base.p95)}/${ms(r.base.max)}`.padStart(24),
        `${ms(r.candidate.p50)}/${ms(r.candidate.p95)}/${ms(r.candidate.max)}`.padStart(24),
        pct(r.base.p50, r.candidate.p50).padStart(8),
        pct(r.base.p95, r.candidate.p95).padStart(8),
        `  ${verdict}`,
      ].join(' '),
    );
  }
  for (const name of result.missing ?? []) lines.push(`${name.padEnd(34)} missing from the candidate`);
  for (const p of result.invalidPairs) lines.push(`pair ${p.pair} INVALID: ${p.problems.join('; ')}`);
  return `${lines.join('\n')}\n`;
}
