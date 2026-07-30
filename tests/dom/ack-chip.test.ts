/**
 * The command acknowledgement chip.
 *
 * Two things were wrong with it, and both are the kind that only show up on
 * glass:
 *
 *   • it MOUNTED and UNMOUNTED. So it faded in over 120ms and then vanished
 *     between two frames, while every other overlay on this stage fades both
 *     ways. A single-frame disappearance in peripheral vision reads as a glitch
 *     rather than as something finishing;
 *   • it was sized from `var(--stage-secondary-min, 0.67em)`, and that property
 *     is only bound when an optical profile exists. On a rig that has never been
 *     calibrated it fell through to the em, which resolves at roughly 11px —
 *     decoration, not communication, and smaller than the fixed size the
 *     optical work replaced.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AckChip from '../../src/stage/renderer/AckChip.svelte';
import type { StageAckState } from '../../src/stage/renderer/stageState';

function ack(overrides: Partial<StageAckState> = {}): StageAckState {
  return { label: 'Chapter 1', durationMs: 900, seq: 1, ...overrides };
}

function chip(container: Element): HTMLElement {
  const el = container.querySelector('.ack');
  if (!(el instanceof HTMLElement)) throw new Error('the chip did not render');
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AckChip', () => {
  it('is mounted before anything has been acknowledged, and says nothing', async () => {
    const { container } = render(AckChip, { props: { ack: null } });
    expect(chip(container).dataset.visible).toBe('false');
    expect(chip(container).textContent?.trim()).toBe('');
  });

  it('shows an acknowledgement by attribute rather than by appearing', async () => {
    const { container, rerender } = render(AckChip, { props: { ack: null } });
    const before = chip(container);

    await rerender({ ack: ack({ label: 'Chapter 2' }) });
    expect(chip(container).dataset.visible).toBe('true');
    expect(chip(container).textContent?.trim()).toBe('Chapter 2');
    // The SAME element — a remount is what produced the pop this replaced.
    expect(chip(container)).toBe(before);
  });

  it('keeps its word through the exit fade instead of emptying the box first', async () => {
    /*
     * Clearing the text at the instant the opacity starts falling would empty
     * the box and shrink it — movement, beside a script somebody is reading,
     * which is the one thing this surface spends its design budget avoiding.
     * Same latch, and same reason, as the hold chip.
     */
    const { container } = render(AckChip, { props: { ack: ack({ durationMs: 700 }) } });
    expect(chip(container).dataset.visible).toBe('true');

    await vi.advanceTimersByTimeAsync(800);

    expect(chip(container).dataset.visible).toBe('false');
    // Still mounted, still carrying the word it is fading with.
    expect(chip(container).textContent?.trim()).toBe('Chapter 1');
  });

  it('does not let a spent acknowledgement cut a newer one short', async () => {
    const { container, rerender } = render(AckChip, { props: { ack: ack({ durationMs: 700 }) } });
    await vi.advanceTimersByTimeAsync(500);

    // A second command lands while the first is still up. Its own timer has to
    // replace the first, or the newer word would be taken away 200ms later.
    await rerender({ ack: ack({ label: 'Chapter 5', durationMs: 700, seq: 2 }) });
    await vi.advanceTimersByTimeAsync(400);

    expect(chip(container).dataset.visible).toBe('true');
    expect(chip(container).textContent?.trim()).toBe('Chapter 5');

    await vi.advanceTimersByTimeAsync(500);
    expect(chip(container).dataset.visible).toBe('false');
  });

  it('sizes itself at the optical floor, never at the em that resolves to ~11px', () => {
    const calibrated = render(AckChip, {
      props: { ack: ack(), secondaryMinPx: 43 },
    });
    expect(chip(calibrated.container).style.fontSize).toBe('43px');

    /*
     * An uncalibrated rig is the one where nobody has said how far away the
     * presenter is standing, so it is the last place that should silently get
     * the smallest type on the glass. 18px, deliberately above the 14px hard
     * floor — the identical rule the hold chip applies.
     */
    for (const bad of [0, -5, Number.NaN]) {
      const { container } = render(AckChip, { props: { ack: ack(), secondaryMinPx: bad } });
      expect(chip(container).style.fontSize, `${bad} must not size the chip`).toBe('18px');
    }

    // A profile that resolved absurdly small is floored rather than obeyed.
    const tiny = render(AckChip, { props: { ack: ack(), secondaryMinPx: 6 } });
    expect(chip(tiny.container).style.fontSize).toBe('14px');
  });
});
