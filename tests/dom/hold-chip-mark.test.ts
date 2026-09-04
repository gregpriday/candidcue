/**
 * The hold chip's mark, mounted.
 *
 * `HoldStatus` latches what it is saying so the chip can FADE with its content
 * intact. The words were latched and the MARK was not, so when an ordinary hold
 * cleared the compact badge turned back into the full-width "Holding here" slab
 * at nearly full opacity and faded that instead — movement at the one moment
 * the presenter should be able to ignore entirely.
 *
 * This has to be mounted rather than server-rendered: the latch is an effect,
 * and a string of HTML has no second frame to be wrong on.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import HoldStatus from '../../src/stage/renderer/HoldStatus.svelte';

const base = {
  rung: 'message' as const,
  message: 'Holding here',
  tone: 'neutral' as const,
  secondaryMinPx: 28,
  glyph: 'held' as const,
};

describe('the hold chip mark', () => {
  it('draws the mark instead of the words, keeping the words for the ear', () => {
    const { container } = render(HoldStatus, { props: base });
    const chip = container.querySelector('.hold-status');
    expect(chip).not.toBeNull();
    expect(chip!.querySelector('svg.glyph')).not.toBeNull();

    // The sentence is present for `role="status"` and hidden from the glass.
    const spoken = chip!.querySelector('.sr-only');
    expect(spoken?.textContent).toBe('Holding here');
    /*
     * Not the transport's pause bars: this app already draws two upright bars
     * for its own Pause command on Space, and the same shape here would tell a
     * presenter capture had stopped — the one response that cannot clear an
     * alignment hold.
     */
    expect(chip!.querySelector('svg.glyph rect')).toBeNull();
  });

  it('keeps the mark through the fade rather than growing back into a slab', async () => {
    const { container, rerender } = render(HoldStatus, { props: base });
    expect(container.querySelector('svg.glyph')).not.toBeNull();

    // Following resumed: the chip starts fading, and holds its content while it
    // does. `glyph` clears immediately; the latch is what must not.
    await rerender({ ...base, rung: 'none' as const, message: null, glyph: null });

    const chip = container.querySelector('.hold-status');
    expect(chip?.getAttribute('data-visible')).toBe('false');
    expect(
      container.querySelector('svg.glyph'),
      'the mark must fade with the chip, not be replaced by the words it stood in for',
    ).not.toBeNull();
  });
});
