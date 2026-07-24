import { describe, expect, it } from 'vitest';
import type { TrackingSnapshot } from '../../../src/shared/contracts/tracking';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import {
  deriveVisualTarget,
  FixedSpeedScroller,
  maxScrollY,
  nearestTokenIndex,
  readingBandCenterY,
  type StageLayout,
} from '../../../src/shared/tracking/stage-target';
import { PaceEstimator, LatencyEstimator } from '../../../src/shared/tracking/pace';
import { mulberry32, randomInt } from '../helpers/rand';

const profile = DEFAULT_TRACKING_PROFILE;

function linearLayout(tokens = 200, pxPerToken = 12): StageLayout {
  return {
    tokenY: (index) => index * pxPerToken,
    lastTokenIndex: tokens - 1,
    contentHeight: tokens * pxPerToken,
    viewportHeight: 600,
    lineHeight: 36,
  };
}

function snapshot(partial: Partial<TrackingSnapshot>): TrackingSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId: 's',
    sessionGeneration: 1,
    stageGeneration: 1,
    scriptId: 'x',
    tokenIndex: 0,
    committedTokenIndex: 0,
    blockId: 'b0',
    sentenceId: 's0',
    confidence: 0.9,
    state: 'following',
    provisional: false,
    movement: 'advance',
    sourceItemIds: [],
    generatedAtMs: 0,
    ...partial,
  };
}

describe('deriveVisualTarget (§32, G.6)', () => {
  it('positions the active token at the reading band center', () => {
    const layout = linearLayout();
    const target = deriveVisualTarget(
      snapshot({ tokenIndex: 100, committedTokenIndex: 100 }),
      layout,
      profile,
      { currentY: 0 },
    );
    const band = readingBandCenterY(layout, profile);
    expect(target.y).toBeCloseTo(100 * 12 - band, 5);
  });

  it('holds inside the dead band (§32.5)', () => {
    const layout = linearLayout();
    const settled = deriveVisualTarget(
      snapshot({ tokenIndex: 100, committedTokenIndex: 100 }),
      layout,
      profile,
      { currentY: 100 * 12 - readingBandCenterY(layout, profile) + 10 },
    );
    expect(settled.movementClass).toBe('none');
    expect(settled.durationMs).toBe(0);
  });

  it('clamps provisional movement around the committed position (§31.8/G.6)', () => {
    const layout = linearLayout();
    const target = deriveVisualTarget(
      snapshot({ tokenIndex: 190, committedTokenIndex: 100, provisional: true }),
      layout,
      profile,
      { currentY: 0 },
    );
    const band = readingBandCenterY(layout, profile);
    expect(target.y).toBeLessThanOrEqual(100 * 12 + profile.provisionalForwardPx - band);
  });

  it('applies lead only when confidently following (§32.2)', () => {
    const layout = linearLayout();
    const confident = deriveVisualTarget(
      snapshot({ tokenIndex: 100, committedTokenIndex: 100, confidence: 0.9 }),
      layout,
      profile,
      { currentY: 0, leadTokens: 4 },
    );
    const shaky = deriveVisualTarget(
      snapshot({ tokenIndex: 100, committedTokenIndex: 100, confidence: 0.4, state: 'holding', movement: 'hold' }),
      layout,
      profile,
      { currentY: 0, leadTokens: 4 },
    );
    expect(confident.y).toBeGreaterThan(shaky.y);
  });

  it('classifies movement and durations per §32.3', () => {
    const layout = linearLayout();
    const skip = deriveVisualTarget(
      snapshot({ tokenIndex: 180, committedTokenIndex: 180, movement: 'skip' }),
      layout,
      profile,
      { currentY: 0 },
    );
    expect(skip.movementClass).toBe('skip');
    expect(skip.durationMs).toBeGreaterThanOrEqual(profile.skipTransitionMsMin);
    expect(skip.durationMs).toBeLessThanOrEqual(profile.skipTransitionMsMax);

    const retake = deriveVisualTarget(
      snapshot({ tokenIndex: 20, committedTokenIndex: 20, movement: 'retake' }),
      layout,
      profile,
      { currentY: 500 },
    );
    expect(retake.movementClass).toBe('retake');

    const command = deriveVisualTarget(
      snapshot({ tokenIndex: 50, committedTokenIndex: 50, movement: 'command' }),
      layout,
      profile,
      { currentY: 0 },
    );
    expect(command.movementClass).toBe('command');
    expect(command.durationMs).toBe(profile.commandTransitionMs);
  });

  it('respects reduced motion with instant jumps (§32.4)', () => {
    const layout = linearLayout();
    const target = deriveVisualTarget(
      snapshot({ tokenIndex: 150, committedTokenIndex: 150, movement: 'skip' }),
      layout,
      profile,
      { currentY: 0, reducedMotion: true },
    );
    expect(target.durationMs).toBe(0);
  });

  it('always returns a finite target within document bounds (§55.3 property)', () => {
    const rand = mulberry32(777);
    for (let trial = 0; trial < 300; trial++) {
      const tokens = randomInt(rand, 1, 400);
      const layout = linearLayout(tokens, randomInt(rand, 1, 40));
      const state = (['following', 'holding', 'searching'] as const)[randomInt(rand, 0, 2)];
      const movement = (['hold', 'advance', 'skip', 'retake', 'command', 'manual'] as const)[
        randomInt(rand, 0, 5)
      ];
      const target = deriveVisualTarget(
        snapshot({
          tokenIndex: randomInt(rand, -50, tokens + 50),
          committedTokenIndex: randomInt(rand, -50, tokens + 50),
          confidence: rand(),
          provisional: rand() < 0.5,
          state: state ?? 'following',
          movement: movement ?? 'advance',
        }),
        layout,
        profile,
        {
          currentY: randomInt(rand, -100, layout.contentHeight + 100),
          leadTokens: randomInt(rand, 0, 10),
          readingBandPercent: randomInt(rand, 0, 100),
        },
      );
      expect(Number.isFinite(target.y)).toBe(true);
      expect(target.y).toBeGreaterThanOrEqual(0);
      expect(target.y).toBeLessThanOrEqual(Math.max(0, maxScrollY(layout)) + layout.contentHeight);
      expect(Number.isFinite(target.durationMs)).toBe(true);
    }
  });
});

describe('fixed-speed and manual modes (§32.6)', () => {
  it('scrolls at a constant rate and clamps at the end', () => {
    const layout = linearLayout(100, 10); // content 1000, viewport 600 → max 400
    const scroller = new FixedSpeedScroller(0, 100);
    scroller.start();
    expect(scroller.advance(1000, layout)).toBeCloseTo(100);
    expect(scroller.advance(10_000, layout)).toBe(400);
    scroller.pause();
    expect(scroller.advance(1000, layout)).toBe(400);
  });

  it('derives px/s from words per minute using layout calibration', () => {
    const layout = linearLayout(100, 10);
    const scroller = new FixedSpeedScroller(0, 0);
    scroller.setSpeedWordsPerMinute(120, layout); // 2 tokens/s * 10 px/token
    expect(scroller.speedPxPerSecond).toBeCloseTo(20);
    scroller.adjustSpeedPercent(10);
    expect(scroller.speedPxPerSecond).toBeCloseTo(22);
  });

  it('mode switching preserves the nearest semantic position (§32.6)', () => {
    const layout = linearLayout(200, 12);
    const band = readingBandCenterY(layout, profile);
    const target = deriveVisualTarget(
      snapshot({ tokenIndex: 120, committedTokenIndex: 120 }),
      layout,
      profile,
      { currentY: 0 },
    );
    expect(nearestTokenIndex(layout, target.y, band)).toBeCloseTo(120, 0);
  });
});

describe('pace and latency estimation (§32.2)', () => {
  it('estimates tokens per second over the window', () => {
    const pace = new PaceEstimator();
    for (let i = 0; i < 10; i++) pace.record(3, 1000 * i);
    expect(pace.tokensPerSecond(10_000)).toBeGreaterThan(2);
    expect(pace.leadTokens(500, 10_000, profile.maxLeadTokens)).toBeGreaterThan(0);
    expect(pace.leadTokens(500, 10_000, profile.maxLeadTokens)).toBeLessThanOrEqual(
      profile.maxLeadTokens,
    );
  });

  it('returns zero lead without enough signal', () => {
    const pace = new PaceEstimator();
    pace.record(3, 0);
    expect(pace.leadTokens(500, 100, profile.maxLeadTokens)).toBe(0);
  });

  it('smooths latency observations and ignores garbage', () => {
    const latency = new LatencyEstimator(400);
    latency.observe(800);
    expect(latency.currentMs()).toBeGreaterThan(400);
    const before = latency.currentMs();
    latency.observe(Number.NaN);
    latency.observe(-50);
    latency.observe(99_999);
    expect(latency.currentMs()).toBe(before);
  });
});
