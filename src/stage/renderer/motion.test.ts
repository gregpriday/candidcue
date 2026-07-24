import { describe, it, expect } from 'vitest';
import {
  createScrollSpring,
  classifyTransition,
  glidePosition,
  DEFAULT_SPRING_CONFIG,
} from './motion';
import { segmentText } from './text';

describe('transition classification (spec §32.3, §16.3)', () => {
  it('uses the spring for alignment-driven advances and holds', () => {
    expect(
      classifyTransition({
        movement: 'advance',
        distancePx: 300,
        viewportHeightPx: 1000,
        reducedMotion: false,
      }),
    ).toBe('spring');
    expect(
      classifyTransition({
        movement: 'hold',
        distancePx: 10,
        viewportHeightPx: 1000,
        reducedMotion: false,
      }),
    ).toBe('spring');
  });

  it('glides explicit jumps within two viewport heights', () => {
    for (const movement of ['skip', 'retake', 'command', 'manual'] as const) {
      expect(
        classifyTransition({
          movement,
          distancePx: 1900,
          viewportHeightPx: 1000,
          reducedMotion: false,
        }),
      ).toBe('smooth_jump');
    }
  });

  it('fades larger jumps (fade down, reposition, fade up)', () => {
    expect(
      classifyTransition({
        movement: 'skip',
        distancePx: 2100,
        viewportHeightPx: 1000,
        reducedMotion: false,
      }),
    ).toBe('fade_jump');
  });

  it('respects reduced motion with near-instant repositioning', () => {
    expect(
      classifyTransition({
        movement: 'skip',
        distancePx: 5000,
        viewportHeightPx: 1000,
        reducedMotion: true,
      }),
    ).toBe('instant');
  });
});

describe('scroll spring (spec §16.3, A.5)', () => {
  it('converges to the target without oscillating wildly', () => {
    const spring = createScrollSpring();
    spring.reset(0);
    spring.setTarget(500);
    let overshoot = 0;
    let settled = false;
    for (let i = 0; i < 600; i++) {
      const r = spring.step(16.7);
      overshoot = Math.max(overshoot, r.position - 500);
      if (r.settled) {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    expect(spring.position).toBe(500);
    // Near-critically damped: any overshoot stays a small fraction of travel.
    expect(overshoot).toBeLessThan(50);
  });

  it('caps velocity at the configured maximum', () => {
    const spring = createScrollSpring(DEFAULT_SPRING_CONFIG);
    spring.reset(0);
    spring.setTarget(100000);
    const a = spring.step(16).position;
    const b = spring.step(16).position;
    const perSecond = ((b - a) / 16) * 1000;
    expect(perSecond).toBeLessThanOrEqual(DEFAULT_SPRING_CONFIG.maxVelocityPxPerS + 1);
  });

  it('jumpTo repositions instantly and kills velocity', () => {
    const spring = createScrollSpring();
    spring.reset(0);
    spring.setTarget(1000);
    spring.step(50);
    spring.jumpTo(4000);
    expect(spring.position).toBe(4000);
    expect(spring.step(16).settled).toBe(true);
  });

  it('is stable across large frame gaps (clamped dt)', () => {
    const spring = createScrollSpring();
    spring.reset(0);
    spring.setTarget(300);
    const r = spring.step(5000); // e.g. tab was hidden
    expect(Number.isFinite(r.position)).toBe(true);
    expect(r.position).toBeGreaterThanOrEqual(0);
    expect(r.position).toBeLessThanOrEqual(400);
  });
});

describe('glide easing', () => {
  it('starts at from, ends at to, and moves monotonically', () => {
    expect(glidePosition(100, 500, 0, 220)).toBe(100);
    expect(glidePosition(100, 500, 220, 220)).toBe(500);
    let prev = 100;
    for (let t = 0; t <= 220; t += 20) {
      const p = glidePosition(100, 500, t, 220);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });
});

describe('token segmentation', () => {
  it('assigns token indexes to words when the mapping aligns', () => {
    const segs = segmentText('hello brave world', [4, 5, 6]);
    const words = segs.filter((s) => !s.space);
    expect(words.map((w) => w.tokenIndex)).toEqual([4, 5, 6]);
    expect(segs.map((s) => s.text).join('')).toBe('hello brave world');
  });

  it('preserves whitespace segments verbatim', () => {
    const segs = segmentText('a  b\nc', [1, 2, 3]);
    expect(segs.map((s) => s.text).join('')).toBe('a  b\nc');
  });

  it('anchors only the run start when the mapping is misaligned', () => {
    const segs = segmentText('one two three', [9]);
    const words = segs.filter((s) => !s.space);
    expect(words[0]?.tokenIndex).toBe(9);
    expect(words[1]?.tokenIndex).toBeNull();
  });

  it('handles empty and whitespace-only runs', () => {
    expect(segmentText('', [])).toEqual([]);
    const segs = segmentText('   ');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.space).toBe(true);
  });
});
