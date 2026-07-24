/**
 * LineHandoffPlanner (companion §8, §28, Appendix B.4).
 */
import { describe, it, expect } from 'vitest';
import {
  buildRenderedLineMap,
  createLineHandoffPlanner,
  emptyRenderedLineMap,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const R = 400;
const layout = syntheticLayout({
  blocks: [
    { kind: 'paragraph', tokens: 50 },
    { kind: 'paragraph', tokens: 50 },
  ],
  startY: 800,
});

const map: StageRenderedLineMap = buildRenderedLineMap({
  fingerprint: fixtureFingerprint(),
  tokens: layout.tokens,
  blocks: layout.blocks,
  readingLineStartY: R,
  lineHeightPx: layout.lineHeightPx,
  viewportHeightPx: 1080,
  maxScrollPx: layout.contentHeightPx,
});

const planner = createLineHandoffPlanner(map, { maxFeedForwardPxS: 900 });

describe('target and feed-forward (§28)', () => {
  it('places the current line at the reading position at each line start', () => {
    for (const line of map.lines) {
      const target = planner.target(line.spokenUnitStart, 0);
      expect(target.source).toBe('path');
      expect(target.lineId).toBe(line.lineId);
      expect(target.scrollPx).toBeCloseTo(line.baselineY - R, 6);
    }
  });

  it('derives feed-forward velocity from dScroll/dUnit × semantic velocity', () => {
    const semanticVelocity = 3.5;
    const line = map.lines[2];
    const u = (line?.spokenUnitStart ?? 0) + 1;
    const target = planner.target(u, semanticVelocity);
    expect(target.feedForwardVelocityPxS).toBeCloseTo(
      target.derivativePxPerUnit * semanticVelocity,
      6,
    );
    expect(target.feedForwardVelocityPxS).toBeGreaterThan(0);
  });

  it('clamps the feed-forward term so a boundary cannot command a lurch', () => {
    const target = planner.target(map.lines[1]?.spokenUnitStart ?? 0, 10_000);
    expect(target.feedForwardVelocityPxS).toBeLessThanOrEqual(900);
  });

  it('advances the target continuously across a whole line of speech', () => {
    const line = map.lines[3];
    expect(line).toBeDefined();
    const start = line?.spokenUnitStart ?? 0;
    const end = line?.spokenUnitEnd ?? start + 1;
    let previous = -Infinity;
    for (let u = start; u <= end; u += (end - start) / 20) {
      const t = planner.target(u, 3);
      expect(t.scrollPx).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = t.scrollPx;
    }
    // By the end of the line the next line has arrived at the reading position.
    const next = map.lines[4];
    if (next) {
      expect(planner.target(next.spokenUnitStart, 0).scrollPx).toBeCloseTo(
        next.baselineY - R,
        6,
      );
    }
  });

  it('reports positions outside measured coverage', () => {
    const beyond = planner.target((map.coverage?.unitEnd ?? 0) + 500, 2);
    expect(beyond.outOfCoverage).toBe(true);
  });

  it('returns no target at all when the map is invalid (§62)', () => {
    const blank = createLineHandoffPlanner(emptyRenderedLineMap(fixtureFingerprint()), {
      maxFeedForwardPxS: 900,
    });
    const target = blank.target(10, 3);
    expect(target.source).toBe('none');
    expect(target.feedForwardVelocityPxS).toBe(0);
  });
});
