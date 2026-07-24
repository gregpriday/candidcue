/**
 * Monotonicity of the motion path under adversarial input (companion §7, §8).
 *
 * `sampleMotionPath` MUST be monotone non-decreasing in `spokenUnit`: it is the
 * only thing standing between the forward-only profiles and backward motion
 * during ordinary following. A single interval where the interpolant dips —
 * which unclamped cubic Hermite will do around a sharp change in slope — is a
 * frame where the document goes backward while the presenter reads forward, and
 * no controller limit can undo it because the TARGET is what moved.
 *
 * This is a fuzz test rather than a set of cases because the failure lives in
 * knot configurations nobody writes on purpose: near-duplicate abscissae (two
 * tokens on the same measured x), long runs of equal ys (a paragraph gap with
 * no spoken units), cliffs of thousands of pixels between adjacent knots
 * (media), and per-knot slope clamps interacting with the global one. The
 * second case drives the same property through the whole builder over randomly
 * shaped documents.
 */
import { describe, it, expect } from 'vitest';
import { buildRenderedLineMap, createMonotoneSpline } from '../../../src/stage/motion';
import { fixtureFingerprint, seededRandom, syntheticLayout } from '../../fixtures/layout';

describe('spline monotonicity fuzz', () => {
  it('createMonotoneSpline is monotone with dy>=0 for adversarial knots', () => {
    const random = seededRandom(987654321);
    const failures: string[] = [];
    for (let iter = 0; iter < 3000; iter++) {
      const n = 2 + Math.floor(random() * 12);
      const xs: number[] = [];
      const ys: number[] = [];
      let x = random() * 100;
      let y = random() * 100;
      for (let i = 0; i < n; i++) {
        xs.push(x);
        ys.push(y);
        // Adversarial gaps: tiny (1e-9), ordinary, huge; y steps: zero runs,
        // tiny, huge cliffs.
        const gapKind = random();
        x += gapKind < 0.25 ? 1e-9 + random() * 1e-6 : gapKind < 0.5 ? 1e-3 : random() * 50;
        const stepKind = random();
        y += stepKind < 0.3 ? 0 : stepKind < 0.55 ? random() * 1e-4 : random() * 4000;
      }
      const clamp = random() < 0.5 ? undefined : random() * 500;
      const perKnot = xs.map(() => (random() < 0.3 ? random() * 200 : undefined));
      const spline = createMonotoneSpline(xs, ys, {
        ...(clamp !== undefined ? { maxSlope: clamp } : {}),
        knotSlopeClamp: perKnot,
      });
      if (!spline) continue;
      const x0 = xs[0] ?? 0;
      const x1 = xs[xs.length - 1] ?? 0;
      let prevY = -Infinity;
      for (let k = 0; k <= 4000; k++) {
        const sx = x0 - 1 + ((x1 - x0 + 2) * k) / 4000;
        const s = spline.sample(sx);
        if (!Number.isFinite(s.y) || !Number.isFinite(s.dy)) {
          failures.push(`iter ${iter}: non-finite sample at x=${sx}`);
          break;
        }
        if (s.dy < 0) {
          failures.push(`iter ${iter}: negative dy=${s.dy} at x=${sx}`);
          break;
        }
        if (s.y < prevY - 1e-6 * Math.max(1, Math.abs(prevY))) {
          failures.push(`iter ${iter}: y regressed ${prevY} -> ${s.y} at x=${sx}`);
          break;
        }
        if (s.y < (ys[0] ?? 0) - 1e-6 || s.y > (ys[ys.length - 1] ?? 0) + 1e-6) {
          failures.push(`iter ${iter}: y=${s.y} outside knot range at x=${sx}`);
          break;
        }
        prevY = s.y;
      }
    }
    // eslint-disable-next-line no-console
    if (failures.length) console.log(failures.slice(0, 10).join('\n'));
    expect(failures).toEqual([]);
  });

  it('full builder maps stay monotone across randomized documents', () => {
    const random = seededRandom(24681357);
    const failures: string[] = [];
    for (let iter = 0; iter < 120; iter++) {
      const blocks: Array<{ kind: 'paragraph' | 'heading' | 'image'; tokens?: number; heightPx?: number }> = [];
      const count = 2 + Math.floor(random() * 6);
      for (let b = 0; b < count; b++) {
        const r = random();
        if (r < 0.2) blocks.push({ kind: 'heading', tokens: 1 + Math.floor(random() * 3) });
        else if (r < 0.4) blocks.push({ kind: 'image', heightPx: 100 + random() * 1200 });
        else blocks.push({ kind: 'paragraph', tokens: 1 + Math.floor(random() * 60) });
      }
      if (!blocks.some((b) => b.kind !== 'image')) blocks.push({ kind: 'paragraph', tokens: 12 });
      const lineHeightPx = 24 + random() * 80;
      const layout = syntheticLayout({
        blocks,
        columnWidthPx: 200 + random() * 1200,
        lineHeightPx,
        wordWidthPx: 30 + random() * 150,
        startY: random() * 900,
      });
      if (layout.tokens.length === 0) continue;
      const map = buildRenderedLineMap({
        fingerprint: fixtureFingerprint({ layoutGeneration: iter }),
        tokens: layout.tokens,
        blocks: layout.blocks,
        readingLineStartY: 100 + random() * 500,
        lineHeightPx,
        viewportHeightPx: 1080,
        maxScrollPx: Math.max(0, layout.contentHeightPx - random() * 400),
        maxSlopePxPerUnit: lineHeightPx * 8,
        boundarySlopeClampPxPerUnit: lineHeightPx * 3,
      });
      if (!map.valid) continue;
      const first = map.motionKnots[0]?.spokenUnit ?? 0;
      const last = map.motionKnots[map.motionKnots.length - 1]?.spokenUnit ?? 0;
      let prevY = -Infinity;
      for (let k = 0; k <= 3000; k++) {
        const u = first - 2 + ((last - first + 4) * k) / 3000;
        const s = map.sampleMotionPath(u);
        if (!s) continue;
        if (!Number.isFinite(s.scrollPx) || s.derivativePxPerUnit < 0) {
          failures.push(`iter ${iter}: bad sample at u=${u}: ${JSON.stringify(s)}`);
          break;
        }
        if (s.scrollPx < prevY - 1e-6) {
          failures.push(`iter ${iter}: scroll regressed ${prevY} -> ${s.scrollPx} at u=${u}`);
          break;
        }
        prevY = s.scrollPx;
      }
    }
    // eslint-disable-next-line no-console
    if (failures.length) console.log(failures.slice(0, 10).join('\n'));
    expect(failures).toEqual([]);
  });
});
