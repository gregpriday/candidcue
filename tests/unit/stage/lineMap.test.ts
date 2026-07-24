/**
 * RenderedLineMapBuilder (companion §7, §8) and the motion metrics that make
 * the line-handoff contract checkable (§70.1, §70.2).
 */
import { describe, it, expect } from 'vitest';
import {
  buildRenderedLineMap,
  emptyRenderedLineMap,
  handoffCurve,
  identityUnitScale,
  weightedUnitScale,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const R = 400;

function buildFromFixture(
  layout: ReturnType<typeof syntheticLayout>,
  overrides: Partial<Parameters<typeof buildRenderedLineMap>[0]> = {},
) {
  return buildRenderedLineMap({
    fingerprint: fixtureFingerprint(),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: R,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
    ...overrides,
  });
}

describe('line map construction (§7.1)', () => {
  it('groups measured rects into rendered lines instead of guessing from characters', () => {
    const layout = syntheticLayout({
      blocks: [{ kind: 'paragraph', tokens: 40 }],
      columnWidthPx: 600,
    });
    const map = buildFromFixture(layout);

    expect(map.valid).toBe(true);
    expect(map.lines.length).toBe(layout.lineCount);
    expect(map.lines.length).toBeGreaterThan(4);

    // Every token appears exactly once, in order, on exactly one line.
    const seen: number[] = [];
    for (const line of map.lines) {
      for (const stop of line.tokenStops) seen.push(stop.tokenIndex);
      expect(line.firstTokenIndex).toBeLessThanOrEqual(line.lastTokenIndex);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(layout.tokenCount);
  });

  it('records token stops with visual fractions across the measured line width', () => {
    const layout = syntheticLayout({ blocks: [{ kind: 'paragraph', tokens: 20 }] });
    const map = buildFromFixture(layout);
    const line = map.lines[0];
    expect(line).toBeDefined();
    const stops = line?.tokenStops ?? [];
    expect(stops[0]?.visualFractionStart).toBe(0);
    expect(stops[stops.length - 1]?.visualFractionEnd).toBeCloseTo(1, 5);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]?.visualFractionStart ?? 0).toBeGreaterThanOrEqual(
        stops[i - 1]?.visualFractionStart ?? 0,
      );
    }
  });

  it('flags paragraph, section, and visual-block boundaries', () => {
    const layout = syntheticLayout({
      blocks: [
        { kind: 'paragraph', tokens: 12 },
        { kind: 'paragraph', tokens: 12 },
        { kind: 'heading', tokens: 3 },
        { kind: 'paragraph', tokens: 12 },
        { kind: 'image', heightPx: 600 },
        { kind: 'paragraph', tokens: 12 },
      ],
    });
    const map = buildFromFixture(layout);
    const kinds = new Set(map.motionKnots.map((k) => k.boundaryKind));
    expect(kinds.has('ordinary')).toBe(true);
    expect(kinds.has('paragraph')).toBe(true);
    expect(kinds.has('section')).toBe(true);
    expect(kinds.has('visual_block')).toBe(true);
  });

  it('marks the first and last line of each block and section', () => {
    const layout = syntheticLayout({
      blocks: [
        { kind: 'heading', tokens: 3 },
        { kind: 'paragraph', tokens: 30 },
      ],
    });
    const map = buildFromFixture(layout);
    const first = map.lines[0];
    expect(first?.startsSection).toBe(true);
    expect(first?.startsParagraph).toBe(true);
    expect(map.lines[map.lines.length - 1]?.endsParagraph).toBe(true);
  });

  it('is invalid — not merely empty — when nothing could be measured (§62)', () => {
    const map = buildRenderedLineMap({
      fingerprint: fixtureFingerprint(),
      tokens: [],
      blocks: [],
      readingLineStartY: R,
      lineHeightPx: 64,
      viewportHeightPx: 1080,
      maxScrollPx: 1000,
    });
    expect(map.valid).toBe(false);
    expect(map.sampleMotionPath(10)).toBeNull();

    const blank = emptyRenderedLineMap(fixtureFingerprint());
    expect(blank.valid).toBe(false);
    expect(blank.covers(0)).toBe(false);
  });

  it('reports a measured baseline inversion instead of moving backward on it', () => {
    const layout = syntheticLayout({
      blocks: [{ kind: 'paragraph', tokens: 20 }],
      startY: 1200,
    });
    const broken = layout.tokens.map((t, i) =>
      i > 10 ? { ...t, topY: t.topY - 400, bottomY: t.bottomY - 400 } : t,
    );
    const map = buildFromFixture({ ...layout, tokens: broken });
    expect(map.issues.some((i) => i.code === 'nonmonotonic_baselines')).toBe(true);
    // The path still never reverses.
    let previous = -Infinity;
    for (let u = 0; u < layout.tokenCount; u += 0.25) {
      const sample = map.sampleMotionPath(u);
      expect(sample?.scrollPx ?? 0).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = sample?.scrollPx ?? previous;
    }
  });
});

describe('line-handoff path (§8, §70.1, §70.2)', () => {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'heading', tokens: 4 },
      { kind: 'paragraph', tokens: 60 },
      { kind: 'paragraph', tokens: 45 },
    ],
    startY: 600,
  });
  const map = buildFromFixture(layout);

  it('places every line start exactly at the reading position', () => {
    for (const line of map.lines) {
      const sample = map.sampleMotionPath(line.spokenUnitStart);
      expect(sample).not.toBeNull();
      const expected = Math.min(
        Math.max(line.baselineY - R, 0),
        layout.contentHeightPx,
      );
      // §70.1: target position continuity — the value at the knot is the knot.
      expect(sample?.scrollPx ?? 0).toBeCloseTo(expected, 6);
    }
  });

  it('has no target-position step when the active line changes (§3.2)', () => {
    for (const line of map.lines.slice(1)) {
      const u = line.spokenUnitStart;
      const before = map.sampleMotionPath(u - 1e-4)?.scrollPx ?? 0;
      const after = map.sampleMotionPath(u + 1e-4)?.scrollPx ?? 0;
      expect(Math.abs(after - before)).toBeLessThan(0.05);
    }
  });

  it('shares one derivative across ordinary line boundaries (§8.9)', () => {
    for (let i = 1; i < map.lines.length; i++) {
      const line = map.lines[i];
      const knot = map.motionKnots[i];
      if (!line || knot?.boundaryKind !== 'ordinary') continue;
      const u = line.spokenUnitStart;
      const left = map.sampleMotionPath(u - 1e-3)?.derivativePxPerUnit ?? 0;
      const right = map.sampleMotionPath(u + 1e-3)?.derivativePxPerUnit ?? 0;
      expect(Math.abs(left - right)).toBeLessThan(0.6);
    }
  });

  it('is monotone non-decreasing everywhere (property)', () => {
    let previous = -Infinity;
    for (let u = -5; u < layout.tokenCount + 10; u += 0.05) {
      const sample = map.sampleMotionPath(u);
      expect(sample).not.toBeNull();
      const y = sample?.scrollPx ?? 0;
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(sample?.derivativePxPerUnit ?? 0).toBeGreaterThanOrEqual(0);
      previous = y;
    }
  });

  it('never overshoots between knots', () => {
    for (let i = 0; i < map.motionKnots.length - 1; i++) {
      const a = map.motionKnots[i];
      const b = map.motionKnots[i + 1];
      if (!a || !b) continue;
      for (let t = 0; t <= 1; t += 0.05) {
        const u = a.spokenUnit + (b.spokenUnit - a.spokenUnit) * t;
        const y = map.sampleMotionPath(u)?.scrollPx ?? 0;
        expect(y).toBeGreaterThanOrEqual(a.scrollPx - 1e-6);
        expect(y).toBeLessThanOrEqual(b.scrollPx + 1e-6);
      }
    }
  });

  it('holds rather than extrapolating outside the knot range', () => {
    const before = map.sampleMotionPath(-50);
    expect(before?.scrollPx).toBeCloseTo(map.motionKnots[0]?.scrollPx ?? 0, 6);
    expect(before?.derivativePxPerUnit).toBe(0);
    const after = map.sampleMotionPath(layout.tokenCount + 500);
    const lastKnot = map.motionKnots[map.motionKnots.length - 1];
    expect(after?.scrollPx).toBeCloseTo(lastKnot?.scrollPx ?? 0, 6);
  });

  it('reports line progress that advances across the line', () => {
    const line = map.lines[3];
    expect(line).toBeDefined();
    const start = map.sampleMotionPath(line?.spokenUnitStart ?? 0);
    const mid = map.sampleMotionPath(
      ((line?.spokenUnitStart ?? 0) + (line?.spokenUnitEnd ?? 1)) / 2,
    );
    expect(start?.lineId).toBe(line?.lineId);
    expect(mid?.lineProgress ?? 0).toBeGreaterThan(start?.lineProgress ?? 0);
  });
});

describe('visual blocks and large gaps (§7.3, §8.6)', () => {
  it('bounds the path slope across a tall image instead of crawling or racing', () => {
    const layout = syntheticLayout({
      blocks: [
        { kind: 'paragraph', tokens: 20 },
        { kind: 'image', heightPx: 900 },
        { kind: 'paragraph', tokens: 20 },
      ],
      startY: 600,
    });
    const clamp = layout.lineHeightPx * 3;
    const map = buildFromFixture(layout, {
      boundarySlopeClampPxPerUnit: clamp,
      maxSlopePxPerUnit: layout.lineHeightPx * 8,
    });

    const visualKnotIndex = map.motionKnots.findIndex((k) => k.boundaryKind === 'visual_block');
    expect(visualKnotIndex).toBeGreaterThan(0);
    expect(map.motionKnots[visualKnotIndex]?.slopePxPerUnit ?? 0).toBeLessThanOrEqual(clamp + 1e-6);

    // The whole crossing stays under the absolute slope clamp: a media block
    // can never produce an unbounded spline slope.
    const from = map.motionKnots[visualKnotIndex - 1]?.spokenUnit ?? 0;
    const to = map.motionKnots[visualKnotIndex]?.spokenUnit ?? 1;
    for (let u = from; u <= to; u += (to - from) / 40) {
      expect(map.sampleMotionPath(u)?.derivativePxPerUnit ?? 0).toBeLessThanOrEqual(
        layout.lineHeightPx * 8 * 1.5 + 1e-6,
      );
    }
  });
});

describe('spoken-unit axis (§6, §8.3)', () => {
  it('locates lines by cumulative weighted units when weights are supplied', () => {
    const layout = syntheticLayout({ blocks: [{ kind: 'paragraph', tokens: 24 }] });
    const weights = Array.from({ length: layout.tokenCount }, (_, i) => (i % 4 === 0 ? 2 : 0.5));
    const scale = weightedUnitScale(weights);
    const map = buildFromFixture(layout, { unitScale: scale });

    for (const line of map.lines) {
      expect(line.spokenUnitStart).toBeCloseTo(scale.unitForToken(line.firstTokenIndex), 9);
      expect(line.spokenUnitEnd).toBeGreaterThan(line.spokenUnitStart);
    }
    // Strictly increasing line-start coordinates.
    for (let i = 1; i < map.lines.length; i++) {
      expect(map.lines[i]?.spokenUnitStart ?? 0).toBeGreaterThan(
        map.lines[i - 1]?.spokenUnitStart ?? 0,
      );
    }
  });

  it('defaults to one unit per token', () => {
    const scale = identityUnitScale();
    expect(scale.unitForToken(17)).toBe(17);
    expect(scale.unitSpanForToken(17)).toBe(1);
  });
});

describe('degraded per-line fallback (Appendix B.4)', () => {
  const layout = syntheticLayout({
    blocks: [{ kind: 'paragraph', tokens: 30 }],
    startY: 900,
  });
  const map = buildFromFixture(layout);

  it('interpolates toward the next baseline within a line', () => {
    const line = map.lines[1];
    expect(line).toBeDefined();
    const start = map.fallbackTarget(line?.spokenUnitStart ?? 0);
    const end = map.fallbackTarget((line?.spokenUnitEnd ?? 1) - 1e-6);
    expect(start?.scrollPx ?? 0).toBeCloseTo((line?.baselineY ?? 0) - R, 6);
    expect(end?.scrollPx ?? 0).toBeGreaterThan(start?.scrollPx ?? 0);
    expect(end?.scrollPx ?? 0).toBeLessThanOrEqual((line?.nextBaselineY ?? 0) - R + 1e-6);
  });

  it('uses the low-strength smoothstep blend of §8.4', () => {
    expect(handoffCurve(0, 0.35)).toBe(0);
    expect(handoffCurve(1, 0.35)).toBe(1);
    // Near-linear feel: it stays close to the secant.
    expect(Math.abs(handoffCurve(0.5, 0.35) - 0.5)).toBeLessThan(0.05);
  });
});
