/**
 * The stage's display position, pinned to the engine's with numbers.
 *
 * `alignmentDisplayAt` is the stage's copy of `Snapshot::display_at`. It used
 * to re-run the formula on token-space fields that Rust had projected one at a
 * time, which drifts wherever a token spans several atoms or an atom several
 * tokens; snapshots now carry `displayAtoms`, the engine's own coordinates and
 * the stretch of the axis the display can reach, and the stage maps the
 * engine's answer through it.
 *
 * The fixture is real: snapshots from a captured run of `figures.md` (the
 * script with the most spelled numbers), compiled the way the app compiles
 * it, each with the engine's intended token position sampled every 50 ms.
 * Regenerate with:
 *
 *   cd crates && cargo run --release -p cc-bench -- display-parity \
 *     figures__pauses__gemini --runs ../bench/runs-local \
 *     --out ../tests/fixtures/follow/display-parity-figures.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alignmentDisplayAt,
  validateAlignmentSnapshot,
  type AlignmentSnapshot,
} from '../../src/shared/contracts/alignment';

interface ParityFixture {
  cases: Array<{
    snapshot: AlignmentSnapshot;
    samples: Array<{ tAudioMs: number; token: number }>;
  }>;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/follow/display-parity-figures.json'), 'utf8'),
) as ParityFixture;

describe('alignmentDisplayAt against the engine', () => {
  it('reproduces every sampled position of a real take exactly', () => {
    let samples = 0;
    let worst = 0;
    for (const { snapshot, samples: points } of fixture.cases) {
      expect(validateAlignmentSnapshot(snapshot)).toBeNull();
      for (const { tAudioMs, token } of points) {
        worst = Math.max(worst, Math.abs(alignmentDisplayAt(snapshot, tAudioMs) - token));
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1e-9);
  });

  it('is a fixture the old token-space formula gets wrong', () => {
    // Without this the test above could pass on a fixture with no multi-atom
    // tokens in it, where both paths agree and nothing is being proved.
    let worst = 0;
    for (const { snapshot, samples } of fixture.cases) {
      const legacy = { ...snapshot, displayAtoms: undefined };
      for (const { tAudioMs, token } of samples) {
        worst = Math.max(worst, Math.abs(alignmentDisplayAt(legacy, tAudioMs) - token));
      }
    }
    expect(worst).toBeGreaterThan(0.5);
  });
});

describe('displayAtoms validation', () => {
  const base = fixture.cases[0]!.snapshot;

  it('accepts a snapshot without it, and with it null', () => {
    expect(validateAlignmentSnapshot({ ...base, displayAtoms: undefined })).toBeNull();
    expect(validateAlignmentSnapshot({ ...base, displayAtoms: null })).toBeNull();
  });

  it.each([
    ['a decreasing axis', { axis: [3, 2] }],
    ['an empty axis', { axis: [] }],
    ['a non-finite point', { axis: [1, Number.NaN] }],
    ['a fractional origin', { axisFrom: 1.5 }],
    ['a non-finite rate', { rate: Number.POSITIVE_INFINITY }],
    ['an implausibly long axis', { axis: Array.from({ length: 300 }, (_, i) => i) }],
    ['a negative margin', { margin: -2 }],
    ['a negative lead cap', { maxLead: -1 }],
    // Would clamp a display sitting at `observed - margin` FORWARD to the
    // window's first boundary.
    ['a window starting above the lowest reachable position', { observed: 10, margin: 1, ceiling: 20, axisFrom: 11, axis: [11, 12, 13, 14, 15] }],
    ['a window ending below the highest reachable position', { observed: 10, margin: 1, maxLead: 3.2, ceiling: 20, axisFrom: 9, axis: [9, 10, 11] }],
  ])('rejects %s', (_label, patch) => {
    const displayAtoms = { ...base.displayAtoms!, ...patch };
    expect(validateAlignmentSnapshot({ ...base, displayAtoms })).toBe('displayAtoms');
  });
});
