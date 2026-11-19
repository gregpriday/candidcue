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
 * shown. Two slow launches in twenty move the p95 here (one moves the max);
 * either would have vanished into a minimum.
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
export function assemblePair({ pair, firstUse, relaunch, spawnedAt, fixtureSha256 = null }) {
  const problems = [];
  const launch = (records, phase, spawned) => {
    const found = only(records, 'launch', (r) => r.phase === phase);
    const done = only(records, 'done', (d) => d.phase === phase).length;
    if (done !== 1) problems.push(`${phase}: ${done === 0 ? 'no done record' : `${done} done records`}`);
    if (found.length !== 1) {
      problems.push(`${phase}: ${found.length} launch records`);
      return null;
    }
    const r = found[0];
    // Every mark finite and in the order the page reaches them; anything else
    // would turn into an invented interval below.
    const marks = [r.timeOrigin, r.entryMs, r.mountedMs, r.readyMs, spawned];
    if (!marks.every(finite) || !(0 <= r.entryMs && r.entryMs <= r.mountedMs && r.mountedMs <= r.readyMs)) {
      problems.push(`${phase}: launch marks missing or out of order`);
      return null;
    }
    // The head's first script (public/boot-mark.js) to entry: the control
    // bundle's fetch, parse and evaluation. Absent from older recordings.
    const parsed = finite(r.headParsedMs) && r.headParsedMs <= r.entryMs ? r.headParsedMs : null;
    return {
      spawnToReadyMs: round(r.timeOrigin + r.readyMs - spawned),
      bundleEvaluateMs: parsed === null ? null : round(r.entryMs - parsed),
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
  const timed = (kind) =>
    ordinals(kind).map((r) => {
      if (!finite(r.ms) || r.ms < 0) problems.push(`${kind} ${r.ordinal}: no time`);
      return r;
    });
  const opens = timed('open').map((r) => ({ ms: round(r.ms), words: r.words }));
  const presents = timed('present').map((r) => {
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
    if (chunks.some((c) => !Array.isArray(c.deltas) || !c.deltas.every(finite))) {
      problems.push(`take ${r.ordinal}: a frame chunk is not a list of intervals`);
    }
    const deltas = chunks.flatMap((c) => (Array.isArray(c.deltas) ? c.deltas.filter(finite) : []));
    if (deltas.length === 0) problems.push(`take ${r.ordinal}: no frame intervals`);
    if (deltas.length !== r.frameCount) {
      problems.push(`take ${r.ordinal}: ${deltas.length} frame intervals, the page counted ${r.frameCount}`);
    }
    if (!(r.displacementPx > 0)) problems.push(`take ${r.ordinal}: the script did not move`);
    return {
      outcome: r.outcome,
      durationMs: round(r.durationMs),
      displacementPx: round(r.displacementPx),
      longestStillMs: round(r.longestStillMs),
      deltas,
    };
  });
  const envs = only(relaunch, 'env');
  if (envs.length !== 1) problems.push(`relaunch: ${envs.length} env records`);
  const env = envs[0] ?? null;
  // The fixture the BUILD embeds, against the one the runner hashed: an old
  // bundle run from a newer checkout would otherwise claim the new fixture.
  if (fixtureSha256 !== null && typeof env?.fixtureSha256 === 'string' && env.fixtureSha256 !== fixtureSha256) {
    problems.push('the app embeds a different fixture from the checkout');
  }
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

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
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
      // Not navigation start: WKWebView stamps it at one of two points
      // about 60 ms apart while the native side is still starting, so
      // anything measured from it is bimodal while spawn-to-entry is not
      // (bench/perf/README.md). It stays in the report; it is not compared.
      // Derived here, from fields every recording has, so a recording made
      // before a series existed still compares on it.
      const sum = (a, b) => (finite(a) && finite(b) ? round(a + b) : null);
      const diff = (a, b) => (finite(a) && finite(b) ? round(a - b) : null);
      push(`launch.${temp}.spawn-to-ready`, l?.spawnToReadyMs);
      push(`launch.${temp}.spawn-to-entry`, sum(l?.spawnToNavigationMs, l?.navigationToEntryMs));
      push(`launch.${temp}.entry-to-ready`, diff(l?.navigationToReadyMs, l?.navigationToEntryMs));
      // The bundle alone: the head began to parse → entry's first statement.
      push(`launch.${temp}.bundle-evaluate`, l?.bundleEvaluateMs);
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
 * family: `base × (1 + relative) + absolute`. Set from two recordings of
 * one unchanged build on the baseline's Mac, both ways round
 * (bench/perf/README.md has the numbers). A baseline may carry its own
 * `thresholds`, which win; a new Mac should be measured the same way.
 */
export const DEFAULT_THRESHOLDS = {
  launch: { relative: 0.2, absolute: 40 },
  open: { relative: 0.2, absolute: 30 },
  present: { relative: 0.1, absolute: 30 },
  frames: { relative: 0.25, absolute: 4 },
  // A take's single worst frame: one sample per take, so its p95 over twenty
  // takes is the second-worst frame of the run, and two recordings of the
  // same build put that at 30 and 42 ms.
  frameMax: { relative: 0.5, absolute: 8 },
  // The bundle's fetch, parse and evaluation (~40 or ~105 ms, bimodal): the
  // launch family's 40 ms would let a 60 ms regression of it through.
  bundle: { relative: 0.2, absolute: 20 },
  // A COUNT of frames over LONG_FRAME_MS per take, not milliseconds: most
  // takes have none, so a relative allowance alone would make one stray
  // frame a regression.
  longFrames: { relative: 0.5, absolute: 1 },
};

function thresholdFor(name, thresholds) {
  const family = name.endsWith('.long')
    ? 'longFrames'
    : name.endsWith('.bundle-evaluate')
      ? 'bundle'
    : name.startsWith('frames.') && name.endsWith('.max')
      ? 'frameMax'
      : name.split('.')[0];
  return thresholds[family] ?? DEFAULT_THRESHOLDS[family] ?? { relative: 0.2, absolute: 0 };
}

/** Not a regression at exact equality: `0.1 + 0.2` must not cross `0.3`. */
const EPSILON = 1e-6;

/** Reasons two reports cannot be compared at all. Empty when they can. */
export function incompatibilities(base, candidate) {
  const reasons = [];
  for (const [name, r] of [
    ['baseline', base],
    ['candidate', candidate],
  ]) {
    if (r === null || typeof r !== 'object' || !Array.isArray(r.pairs)) {
      reasons.push(`the ${name} is not a perf report`);
      return reasons;
    }
  }
  if (!base.pairs.some((p) => p.valid)) reasons.push('the baseline has no valid pairs');
  for (const [family, t] of Object.entries(base.thresholds ?? {})) {
    if (!finite(t?.relative) || !finite(t?.absolute) || t.relative < 0 || t.absolute < 0) {
      reasons.push(`the baseline's ${family} threshold is not two non-negative numbers`);
    }
  }
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
  if (reasons.length) {
    return { comparable: false, passed: false, reasons, rows: [], missing: [], regressions: [], invalidPairs: [] };
  }
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
    if (sb.p50 > limit(sa.p50) + EPSILON) crossed.push('p50');
    if (sb.p95 > limit(sa.p95) + EPSILON) crossed.push('p95');
    rows.push({ name, base: sa, candidate: sb, threshold: t, crossed });
  }
  // A series the baseline measures and the candidate does not is a FAILURE,
  // not a skipped row: a candidate with no pairs at all would otherwise pass.
  const missing = Object.keys(a).filter((n) => !(n in b));
  const invalidPairs = candidate.pairs.filter((p) => !p.valid).map((p) => ({ pair: p.pair, problems: p.problems }));
  const regressions = rows.filter((r) => r.crossed.length > 0).map((r) => r.name);
  return {
    comparable: true,
    load: { base: medianLoad(base), candidate: medianLoad(candidate) },
    passed: regressions.length === 0 && missing.length === 0 && invalidPairs.length === 0,
    reasons: [],
    rows,
    missing,
    regressions,
    invalidPairs,
  };
}

/** The median 1-minute load the runner saw at the start of each pair, if it recorded one. */
function medianLoad(report) {
  const loads = report.pairs.map((p) => p.load?.[0]).filter(finite);
  return summarise(loads).p50;
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
  for (const name of result.missing ?? []) lines.push(`${name.padEnd(34)} MISSING from the candidate`);
  for (const p of result.invalidPairs) lines.push(`pair ${p.pair} INVALID: ${p.problems.join('; ')}`);
  if (result.load && (result.load.base !== null || result.load.candidate !== null)) {
    lines.push(
      `machine load (median 1-min average at each pair's start): base ${result.load.base ?? '—'}, candidate ${result.load.candidate ?? '—'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A report as committed: indented, but every array of plain numbers on one
 * line. A baseline holds tens of thousands of frame intervals, and one per
 * line would make it a file nobody can read or review.
 */
export function serialiseReport(report) {
  // Structural, not a regex over the text: number arrays are swapped for
  // tokens before stringifying and back after, so a string that happens to
  // contain "[1, 2]" is never rewritten.
  const arrays = [];
  const text = JSON.stringify(
    report,
    (_key, value) =>
      Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')
        ? `\u0000numbers:${arrays.push(JSON.stringify(value)) - 1}`
        : value,
    1,
  );
  return `${text.replace(/"\\u0000numbers:(\d+)"/g, (_, i) => arrays[Number(i)])}\n`;
}
