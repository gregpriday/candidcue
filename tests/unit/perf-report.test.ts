/**
 * The perf report's arithmetic and verdicts, with supplied numbers only.
 *
 * Nothing here times anything: issue #240's constraint is that the unit
 * suite stays stable under parallel load, so the distributions the comparison
 * judges are recorded on a Mac by `scripts/perf-run.mjs` and these tests only
 * prove what the comparison does with them.
 */
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
    { kind: 'launch', phase: 'relaunch', timeOrigin: 2_000_150, entryMs: 30, mountedMs: 50, readyMs: 150 },
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
    expect(pair.launches.cold).toMatchObject({ spawnToReadyMs: 500, spawnToNavigationMs: 300, navigationToEntryMs: 40 });
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
