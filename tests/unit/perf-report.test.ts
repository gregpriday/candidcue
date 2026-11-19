/**
 * The perf report's arithmetic and verdicts, with supplied numbers only.
 *
 * Nothing here times anything: issue #240's constraint is that the unit
 * suite stays stable under parallel load, so the distributions the comparison
 * judges are recorded on a Mac by `scripts/perf-run.mjs` and these tests only
 * prove what the comparison does with them.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assemblePair,
  compareReports,
  formatComparison,
  frameTail,
  nearestRank,
  parseTrace,
  REPORT_SCHEMA,
  SCENARIO_ID,
  serialiseReport,
  seriesOf,
  summarise,
  type Pair,
  type PerfRecord,
  type Report,
} from '../../scripts/perf-report.mjs';

describe('nearest-rank percentiles', () => {
  it('takes the value at ceil(p·n), never interpolating', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(twenty, 0.5)).toBe(10);
    expect(nearestRank(twenty, 0.95)).toBe(19);
    expect(nearestRank([7], 0.95)).toBe(7);
    expect(nearestRank([], 0.5)).toBeNull();
  });

  it('lets one slow run in twenty reach the p95 and the max, where a minimum hides it', () => {
    const runs = [...Array.from({ length: 18 }, () => 100), 400, 400];
    const s = summarise(runs);
    expect(Math.min(...runs)).toBe(100);
    expect(s.p50).toBe(100);
    expect(s.p95).toBe(400);
    expect(s.max).toBe(400);
  });

  it('ignores values that are not finite numbers', () => {
    expect(summarise([3, Number.NaN, 1, Number.POSITIVE_INFINITY, 2])).toEqual({ n: 3, p50: 2, p95: 3, max: 3 });
  });
});

describe('frame tails', () => {
  it('keeps a single long frame among smooth ones', () => {
    const deltas = [...Array.from({ length: 599 }, () => 16.7), 120];
    const tail = frameTail(deltas);
    expect(tail.frames).toBe(600);
    expect(tail.p95).toBe(16.7);
    expect(tail.max).toBe(120);
    expect(tail.long).toBe(1);
  });
});

describe('parsing the client trace', () => {
  it('takes perf lines, skips other scopes and broken JSON', () => {
    const text = [
      '2026-11-19T00:00:00Z [realtime] #1 +3ms begin',
      '2026-11-19T00:00:00Z [realtime] {"kind":"launch","phase":"first-use"}',
      '2026-11-19T00:00:00Z [perf] {"kind": nope}',
      '2026-11-19T00:00:00Z [perf] {"v":1,"phase":"first-use"}',
      '2026-11-19T00:00:01Z [perf] {"v":1,"kind":"launch","phase":"first-use"}',
      '2026-11-19T00:00:02Z [perf] {"v":1,"kind":"frames","ordinal":1,"deltas":[16.',
      '2026-11-19T00:00:03Z [perf] {"v":1,"kind":"done","phase":"first-use"}',
      '',
    ].join('\n');
    expect(parseTrace(text).map((r) => r.kind)).toEqual(['launch', 'done']);
  });
});

function firstUse(): PerfRecord[] {
  return [
    { kind: 'launch', phase: 'first-use', timeOrigin: 1_000_300, entryMs: 40, mountedMs: 70, readyMs: 200 },
    { kind: 'done', phase: 'first-use' },
  ];
}

function relaunch(overrides: { frames?: number[]; presentOutcome?: string; extra?: PerfRecord[] } = {}): PerfRecord[] {
  const deltas = overrides.frames ?? [16.7, 16.7, 16.6, 33.4];
  return [
    {
      kind: 'launch',
      phase: 'relaunch',
      timeOrigin: 2_000_150,
      entryMs: 30,
      mountedMs: 50,
      readyMs: 150,
      headParsedMs: 12,
    },
    { kind: 'env', fixtureSha256: 'abc' },
    { kind: 'open', ordinal: 1, ms: 420, words: 5073 },
    { kind: 'open', ordinal: 2, ms: 180, words: 5073 },
    { kind: 'present', ordinal: 1, ms: 600, outcome: overrides.presentOutcome ?? 'readable' },
    { kind: 'take', ordinal: 1, outcome: 'ok', durationMs: 10_000, frameCount: deltas.length, displacementPx: 900 },
    { kind: 'frames', ordinal: 1, part: 1, parts: 2, deltas: deltas.slice(0, 2) },
    { kind: 'frames', ordinal: 1, part: 2, parts: 2, deltas: deltas.slice(2) },
    { kind: 'present', ordinal: 2, ms: 300, outcome: 'readable' },
    { kind: 'take', ordinal: 2, outcome: 'ok', durationMs: 10_000, frameCount: 2, displacementPx: 880 },
    { kind: 'frames', ordinal: 2, part: 1, parts: 1, deltas: [16.7, 16.7] },
    { kind: 'done', phase: 'relaunch' },
    ...(overrides.extra ?? []),
  ];
}

const spawnedAt = { firstUse: 1_000_000, relaunch: 2_000_000 };

describe('assembling a pair', () => {
  it('measures launch from the spawn, on the clock the page shares', () => {
    const pair = assemblePair({ pair: 1, firstUse: firstUse(), relaunch: relaunch(), spawnedAt });
    expect(pair.problems).toEqual([]);
    expect(pair.valid).toBe(true);
    expect(pair.launches.cold).toMatchObject({
      spawnToReadyMs: 500,
      spawnToNavigationMs: 300,
      navigationToEntryMs: 40,
    });
    expect(pair.launches.warm).toMatchObject({ spawnToReadyMs: 300, spawnToNavigationMs: 150 });
    expect(pair.opens.map((o) => o.ms)).toEqual([420, 180]);
    expect(pair.takes[0]?.deltas).toEqual([16.7, 16.7, 16.6, 33.4]);
  });

  it('marks a pair invalid, and says why, for each way a run can be incomplete', () => {
    const cases: [string, Pair][] = [
      ['no done record', assemblePair({ pair: 1, firstUse: firstUse().slice(0, 1), relaunch: relaunch(), spawnedAt })],
      ['present 1: timeout', assemblePair({ pair: 1, firstUse: firstUse(), relaunch: relaunch({ presentOutcome: 'timeout' }), spawnedAt })],
      [
        'open records 1 and 2',
        assemblePair({ pair: 1, firstUse: firstUse(), relaunch: relaunch({ extra: [{ kind: 'open', ordinal: 2, ms: 1 }] }), spawnedAt }),
      ],
      [
        'step: boom',
        assemblePair({ pair: 1, firstUse: firstUse(), relaunch: relaunch({ extra: [{ kind: 'error', step: 'step', message: 'boom' }] }), spawnedAt }),
      ],
      [
        'frame chunks incomplete',
        assemblePair({
          pair: 1,
          firstUse: firstUse(),
          relaunch: relaunch().filter((r) => !(r.kind === 'frames' && r.ordinal === 1 && r.part === 2)),
          spawnedAt,
        }),
      ],
    ];
    for (const [needle, pair] of cases) {
      expect(pair.valid, needle).toBe(false);
      expect(pair.problems.join(' | '), needle).toContain(needle);
    }
  });

  it('refuses a take that never moved the script', () => {
    const records = relaunch().map((r) => (r.kind === 'take' && r.ordinal === 2 ? { ...r, displacementPx: 0 } : r));
    const pair = assemblePair({ pair: 1, firstUse: firstUse(), relaunch: records, spawnedAt });
    expect(pair.problems).toContain('take 2: the script did not move');
  });
});

function report(pairs: Pair[], extra: Partial<Report> = {}): Report {
  return {
    schema: REPORT_SCHEMA,
    scenario: { id: SCENARIO_ID, fixtureSha256: 'abc' },
    machine: { model: 'Mac16,9', chip: 'Apple M4 Max' },
    pairs,
    ...extra,
  };
}

function pairs(n: number, frames?: number[]): Pair[] {
  return Array.from({ length: n }, (_, i) =>
    assemblePair({ pair: i + 1, firstUse: firstUse(), relaunch: relaunch(frames ? { frames } : {}), spawnedAt }),
  );
}

describe('series', () => {
  it('keeps cold and warm apart and leaves invalid pairs out', () => {
    const broken = assemblePair({ pair: 99, firstUse: [], relaunch: relaunch(), spawnedAt });
    const series = seriesOf(report([...pairs(3), broken]));
    expect(series['launch.cold.spawn-to-ready']).toEqual([500, 500, 500]);
    expect(series['launch.warm.spawn-to-ready']).toEqual([300, 300, 300]);
    expect(series['launch.cold.spawn-to-entry']).toEqual([340, 340, 340]);
    expect(series['launch.cold.entry-to-ready']).toEqual([160, 160, 160]);
    // Navigation start is bimodal on WKWebView, so nothing is measured from it.
    expect(Object.keys(series).some((name) => name.includes('navigation'))).toBe(false);
    expect(series['open.cold']).toEqual([420, 420, 420]);
    expect(series['open.warm']).toEqual([180, 180, 180]);
    expect(series['frames.cold.max']).toEqual([33.4, 33.4, 33.4]);
  });
});

describe('comparing two recordings', () => {
  it('passes an unchanged recording', () => {
    const result = compareReports(report(pairs(5)), report(pairs(5)));
    expect(result.comparable).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(formatComparison(result)).toContain('open.cold');
  });

  it('catches a tail that only some runs suffer, which a minimum would not', () => {
    const base = report(pairs(20));
    const candidatePairs = pairs(20);
    // Two of twenty cold opens take four times as long; the fastest is unchanged.
    for (const p of candidatePairs.slice(0, 2)) p.opens[0] = { ms: 1680, words: 5073 };
    const result = compareReports(base, report(candidatePairs));
    expect(result.regressions).toContain('open.cold');
    const row = result.rows.find((r) => r.name === 'open.cold');
    expect(row?.crossed).toEqual(['p95']);
    expect(row?.candidate.p50).toBe(420);
  });

  it('catches a long frame regression in the take', () => {
    const result = compareReports(report(pairs(5)), report(pairs(5, [16.7, 16.7, 16.6, 120])));
    expect(result.regressions).toEqual(expect.arrayContaining(['frames.cold.p99', 'frames.cold.max']));
    // One long frame per take is within the count's allowance; three are not.
    expect(result.regressions).not.toContain('frames.cold.long');
    const worse = compareReports(report(pairs(5)), report(pairs(5, [16.7, 80, 90, 120])));
    expect(worse.regressions).toContain('frames.cold.long');
  });

  it('holds a change to the threshold edge, not past it', () => {
    const base = report(pairs(5), { thresholds: { open: { relative: 0.5, absolute: 0 } } });
    const at = pairs(5);
    for (const p of at) p.opens[0] = { ms: 630, words: 5073 };
    expect(compareReports(base, report(at)).regressions).not.toContain('open.cold');
    for (const p of at) p.opens[0] = { ms: 631, words: 5073 };
    expect(compareReports(base, report(at)).regressions).toContain('open.cold');
  });

  it('fails a candidate with an invalid pair rather than reporting the survivors', () => {
    const broken = assemblePair({ pair: 6, firstUse: [], relaunch: relaunch(), spawnedAt });
    const result = compareReports(report(pairs(5)), report([...pairs(5), broken]));
    expect(result.invalidPairs).toHaveLength(1);
    expect(formatComparison(result)).toContain('pair 6 INVALID');
  });

  it('refuses to compare across machines, scenarios or fixtures', () => {
    const base = report(pairs(2));
    expect(compareReports(base, report(pairs(2), { machine: { model: 'Mac15,3', chip: 'Apple M3' } })).comparable).toBe(false);
    expect(compareReports(base, report(pairs(2), { scenario: { id: 'other', fixtureSha256: 'abc' } })).reasons).toEqual([
      `scenario ${SCENARIO_ID} vs other`,
    ]);
    expect(compareReports(base, report(pairs(2), { scenario: { id: SCENARIO_ID, fixtureSha256: 'def' } })).reasons).toEqual([
      'the fixture script differs',
    ]);
  });
});

describe('serialising a report', () => {
  it('keeps number arrays on one line and round-trips', () => {
    const r = report(pairs(2));
    const text = serialiseReport(r);
    expect(text).toContain('[16.7,16.7,16.6,33.4]');
    // Structural: a string that merely looks like a number list is left alone.
    const withProse = serialiseReport({ ...r, note: 'scenario said [1, 2]' });
    expect(JSON.parse(withProse).note).toBe('scenario said [1, 2]');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(r)));
  });
});

describe('what a pair refuses', () => {
  const broken = (records: PerfRecord[], first: PerfRecord[] = firstUse()) =>
    assemblePair({ pair: 1, firstUse: first, relaunch: records, spawnedAt, fixtureSha256: 'abc' });

  it('a frame chunk without intervals, rather than counting it as a frame', () => {
    const records = relaunch().map((r) =>
      r.kind === 'frames' && r.ordinal === 2 ? { kind: 'frames', ordinal: 2, part: 1, parts: 1 } : r,
    );
    expect(broken(records).problems).toContain('take 2: a frame chunk is not a list of intervals');
  });

  it('launch marks out of order, rather than inventing an interval from them', () => {
    const first = firstUse().map((r) => (r.kind === 'launch' ? { ...r, readyMs: 10 } : r));
    expect(broken(relaunch(), first).problems).toContain('first-use: launch marks missing or out of order');
  });

  it('a duplicated done record', () => {
    expect(broken(relaunch({ extra: [{ kind: 'done', phase: 'relaunch' }] })).problems).toContain('relaunch: 2 done records');
  });

  it('a build that embeds a different fixture from the checkout', () => {
    const records = relaunch().map((r) => (r.kind === 'env' ? { ...r, fixtureSha256: 'stale' } : r));
    expect(broken(records).problems).toContain('the app embeds a different fixture from the checkout');
  });

  it('a relaunch with no environment record', () => {
    expect(broken(relaunch().filter((r) => r.kind !== 'env')).problems).toContain('relaunch: 0 env records');
    expect(broken(relaunch({ extra: [{ kind: 'env', fixtureSha256: 'abc' }] })).problems).toContain('relaunch: 2 env records');
    const three = [{ kind: 'env', fixtureSha256: 'abc' }, { kind: 'env', fixtureSha256: 'abc' }];
    expect(broken(relaunch({ extra: three })).problems).toContain('relaunch: 3 env records');
  });

  it('a build that does not say which fixture it embeds, or differs only after the first character', () => {
    const without = relaunch().map((r) => (r.kind === 'env' ? { kind: 'env' } : r));
    expect(broken(without).problems).toContain('the app did not report its fixture');
    for (const digest of ['abz', 'xbc']) {
      const near = relaunch().map((r) => (r.kind === 'env' ? { ...r, fixtureSha256: digest } : r));
      expect(broken(near).problems).toContain('the app embeds a different fixture from the checkout');
    }
  });

  it('a mount before the entry, and a done record for the other process', () => {
    const first = firstUse().map((r) => (r.kind === 'launch' ? { ...r, mountedMs: 10 } : r));
    expect(broken(relaunch(), first).problems).toContain('first-use: launch marks missing or out of order');
    const misfiled = firstUse().map((r) => (r.kind === 'done' ? { ...r, phase: 'relaunch' } : r));
    expect(broken(relaunch(), misfiled).problems).toContain('first-use: no done record');
    // A stray done beside the right one is refused too, not ignored.
    const stray = [...firstUse(), { kind: 'done', phase: 'relaunch' }];
    expect(broken(relaunch(), stray).problems).toContain('first-use: 1 done record(s) for the other process');
  });

  it('a non-finite frame interval', () => {
    for (const deltas of [[16.7, null], [16.7, Number.NaN], [16.7, -3]]) {
      const records = relaunch().map((r) => (r.kind === 'frames' && r.ordinal === 2 ? { ...r, deltas } : r));
      expect(broken(records).problems).toContain('take 2: a frame chunk is not a list of intervals');
    }
  });

  it('keeps the last step a broken process reached', () => {
    const records = relaunch()
      .filter((r) => !(r.kind === 'take' && r.ordinal === 2) && r.kind !== 'done')
      .concat([
        { kind: 'step', step: 'take 2: roll' },
        { kind: 'step', step: 'take 2: sample' },
      ]);
    expect(broken(records).problems).toContain('relaunch: last step "take 2: sample"');
  });

  it('a take that stopped moving', () => {
    for (const outcome of ['stopped moving', 'stalled (frames stopped; hidden)', 'hidden']) {
      const records = relaunch().map((r) => (r.kind === 'take' && r.ordinal === 1 ? { ...r, outcome } : r));
      expect(broken(records).problems).toContain(`take 1: ${outcome}`);
    }
  });
});

describe('the bundle interval', () => {
  it('is entry minus the moment the head began to parse, when the page reports it', () => {
    const series = seriesOf(report(pairs(2)));
    expect(series['launch.warm.bundle-evaluate']).toEqual([18, 18]);
    // The first-use fixture reports no head mark: absent, not zero.
    expect(series['launch.cold.bundle-evaluate']).toBeUndefined();
  });

  it('is absent when the head mark comes after the entry or before navigation', () => {
    for (const headParsedMs of [31, -5]) {
      const odd = relaunch().map((r) => (r.kind === 'launch' ? { ...r, headParsedMs } : r));
      const pair = assemblePair({ pair: 1, firstUse: firstUse(), relaunch: odd, spawnedAt });
      expect(pair.launches.warm?.bundleEvaluateMs).toBeNull();
    }
    // At the entry exactly is a (zero) measurement, not an absence.
    const same = relaunch().map((r) => (r.kind === 'launch' ? { ...r, headParsedMs: 30 } : r));
    expect(assemblePair({ pair: 1, firstUse: firstUse(), relaunch: same, spawnedAt }).launches.warm?.bundleEvaluateMs).toBe(0);
  });

  it('catches a bundle that got slower to evaluate, which spawn-to-entry absorbs', () => {
    const slower = pairs(5);
    for (const p of slower) {
      const warm = p.launches.warm;
      if (warm === null) throw new Error('fixture');
      p.launches.warm = { ...warm, bundleEvaluateMs: (warm.bundleEvaluateMs ?? 0) + 60 };
    }
    expect(compareReports(report(pairs(5)), report(slower)).regressions).toContain('launch.warm.bundle-evaluate');
  });

  it('gives the bundle its relative allowance as well as its absolute one', () => {
    // 18 ms → 40 ms: past 18 + 20 = 38, inside 18 × 1.2 + 20 = 41.6.
    const slower = pairs(5);
    for (const p of slower) {
      const warm = p.launches.warm;
      if (warm === null) throw new Error('fixture');
      p.launches.warm = { ...warm, bundleEvaluateMs: 40 };
    }
    expect(compareReports(report(pairs(5)), report(slower)).regressions).not.toContain('launch.warm.bundle-evaluate');
  });

  it('holds the bundle to its own allowance, tighter than the launch family', () => {
    // 18 ms → 50 ms: inside launch's 18 × 1.2 + 40 = 61.6, past bundle's 18 × 1.2 + 20 = 41.6.
    const slower = pairs(5);
    for (const p of slower) {
      const warm = p.launches.warm;
      if (warm === null) throw new Error('fixture');
      p.launches.warm = { ...warm, bundleEvaluateMs: 50 };
    }
    expect(compareReports(report(pairs(5)), report(slower)).regressions).toContain('launch.warm.bundle-evaluate');
  });
});

describe('verdicts the first tests did not pin down', () => {
  it('fails a shift of the whole distribution at the p50, not only the p95', () => {
    const shifted = pairs(20);
    for (const p of shifted) p.opens[0] = { ms: 1000, words: 5073 };
    const row = compareReports(report(pairs(20)), report(shifted)).rows.find((r) => r.name === 'open.cold');
    expect(row?.crossed).toEqual(['p50', 'p95']);
  });

  it('lets a single spike reach the maximum without failing the comparison', () => {
    const spiked = pairs(20);
    const first = spiked[0];
    if (first === undefined) throw new Error('fixture');
    first.opens[0] = { ms: 5000, words: 5073 };
    const result = compareReports(report(pairs(20)), report(spiked));
    expect(result.rows.find((r) => r.name === 'open.cold')?.candidate.max).toBe(5000);
    expect(result.passed).toBe(true);
  });

  it('holds a take\'s worst frame to its own allowance, wider than the percentiles\'', () => {
    // 50 ms: past the frame percentiles' limit (33.4 × 1.25 + 4 = 45.75), inside
    // the worst frame's (33.4 × 1.5 + 8 = 58.1).
    const result = compareReports(report(pairs(5)), report(pairs(5, [16.7, 16.7, 16.6, 50])));
    expect(result.regressions).toContain('frames.cold.p99');
    expect(result.regressions).not.toContain('frames.cold.max');
  });

  it('does not fail on floating-point equality at the limit', () => {
    const base = pairs(5);
    for (const p of base) p.opens[0] = { ms: 300.5, words: 5073 };
    const candidate = pairs(5);
    for (const p of candidate) p.opens[0] = { ms: 400.6, words: 5073 };
    const thresholds = { open: { relative: 0.2, absolute: 40 } };
    expect(compareReports(report(base, { thresholds }), report(candidate)).regressions).not.toContain('open.cold');
    for (const p of candidate) p.opens[0] = { ms: 400.7, words: 5073 };
    expect(compareReports(report(base, { thresholds }), report(candidate)).regressions).toContain('open.cold');
  });

  it('fails a series measured in only some of the valid pairs', () => {
    const partial = pairs(4);
    for (const p of partial.slice(1)) {
      const warm = p.launches.warm;
      if (warm === null) throw new Error('fixture');
      p.launches.warm = { ...warm, bundleEvaluateMs: null };
    }
    const result = compareReports(report(pairs(4)), report(partial));
    expect(result.passed).toBe(false);
    expect(result.missing).toContain('launch.warm.bundle-evaluate (1 of 4 pairs)');
  });

  it('fails a candidate with no measurements at all', () => {
    const result = compareReports(report(pairs(5)), report([]));
    expect(result.passed).toBe(false);
    expect(result.missing).toContain('open.cold');
  });

  it('refuses a baseline with no valid pairs, a malformed report, or an unusable threshold', () => {
    const broken = assemblePair({ pair: 1, firstUse: [], relaunch: [], spawnedAt });
    expect(compareReports(report([broken]), report(pairs(2))).reasons).toContain('the baseline has no valid pairs');
    expect(compareReports(report(pairs(2)), { pairs: null } as unknown as Report).comparable).toBe(false);
    const thresholds = { open: { relative: 0.2 } } as unknown as Report['thresholds'];
    expect(compareReports(report(pairs(2), { thresholds }), report(pairs(2))).reasons).toContain(
      "the baseline's open threshold is not two non-negative numbers",
    );
    for (const bad of [{ relative: -1, absolute: 0 }, { relative: 0.2, absolute: -1 }]) {
      expect(compareReports(report(pairs(2), { thresholds: { open: bad } }), report(pairs(2))).comparable).toBe(false);
    }
    // Pairs that are present but hollow, or not objects at all.
    const hollow = { pair: 1, valid: true, problems: [], launches: {}, opens: [], presents: [], takes: [], env: null };
    expect(compareReports(report([hollow as unknown as Pair]), report([])).reasons).toContain('the baseline has no measurements');
    expect(compareReports(report(pairs(2)), report([null as unknown as Pair])).comparable).toBe(false);
  });

  it('refuses a baseline that measures only part of the scenario', () => {
    const partial = pairs(3).map((p) => ({ ...p, opens: [], presents: [], takes: [] }));
    const reasons = compareReports(report(partial), report(pairs(3))).reasons;
    expect(reasons[0]).toMatch(/^the baseline does not measure .*open\.cold/);
  });

  it('refuses reports without their metadata, rather than matching on nothing', () => {
    const bare = { pairs: pairs(2) } as unknown as Report;
    expect(compareReports(bare, bare).reasons).toEqual(['the baseline lacks its schema, scenario, fixture or machine']);
  });

  it('drops a negative sample from a series rather than counting it as fast', () => {
    const odd = pairs(2);
    const first = odd[0];
    if (first === undefined) throw new Error('fixture');
    first.opens[0] = { ms: -50, words: 5073 };
    expect(seriesOf(report(odd))['open.cold']).toEqual([420]);
  });

  it('refuses another machine on the model alone and on the chip alone', () => {
    const base = report(pairs(2));
    expect(compareReports(base, report(pairs(2), { machine: { model: 'Mac15,3', chip: 'Apple M4 Max' } })).comparable).toBe(false);
    expect(compareReports(base, report(pairs(2), { machine: { model: 'Mac16,9', chip: 'Apple M3' } })).comparable).toBe(false);
  });
});

describe('the comparison CLI', () => {
  const run = (base: unknown, candidate: unknown): number | null => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-compare-'));
    try {
      writeFileSync(join(dir, 'base.json'), JSON.stringify(base));
      writeFileSync(join(dir, 'candidate.json'), JSON.stringify(candidate));
      return spawnSync(process.execPath, ['scripts/perf-compare.mjs', join(dir, 'base.json'), join(dir, 'candidate.json')], {
        encoding: 'utf8',
      }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 on a pass, 1 on a regression, a missing series or an invalid pair, 2 when incomparable', () => {
    expect(run(report(pairs(3)), report(pairs(3)))).toBe(0);
    expect(run(report(pairs(3)), report(pairs(3, [16.7, 80, 90, 120])))).toBe(1);
    expect(run(report(pairs(3)), report([]))).toBe(1);
    const broken = assemblePair({ pair: 4, firstUse: [], relaunch: relaunch(), spawnedAt });
    expect(run(report(pairs(3)), report([...pairs(3), broken]))).toBe(1);
    expect(run(report(pairs(3)), report(pairs(3), { scenario: { id: 'other', fixtureSha256: 'abc' } }))).toBe(2);
    expect(run(report(pairs(3)), { pairs: null })).toBe(2);
    // A pair whose problems are not a list is not a report: 2, not a crash's 1.
    const odd = { ...report(pairs(3)), pairs: [{ ...pairs(1)[0], valid: false, problems: null }] };
    expect(run(report(pairs(3)), odd)).toBe(2);
  });
});

describe('machine load', () => {
  it('is shown beside the verdict when the recordings carry it', () => {
    const loaded = pairs(3).map((p, i) => ({ ...p, load: [[2, 3, 10][i] ?? 0, 9] as [number, number] }));
    const result = compareReports(report(pairs(3)), report(loaded));
    // The MEDIAN load at each pair's START: not after it (9), not the mean (5).
    expect(result.load).toEqual({ base: null, candidate: 3 });
    expect(formatComparison(result)).toContain('candidate 3');
  });
});
