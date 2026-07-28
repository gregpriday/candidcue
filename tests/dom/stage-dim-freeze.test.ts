/**
 * The dimming ramp holds while alignment is not following.
 *
 * A cursor keeps arriving after the engine has stopped following — it is the
 * last position anyone believed, and the fallback path still publishes it while
 * the aligner searches, holds, or calls the evidence ambiguous. Motion stops
 * there, deliberately (§16.4: weak evidence never moves the glass), but the
 * per-word styling used to keep walking on it: words went grey behind a reader
 * who had not been located for two seconds. That is the display making a claim
 * the engine explicitly refused to make, and it is the more damaging half,
 * because the presenter reads the dimming as "you are here".
 *
 * Mounted rather than server-rendered, because the whole behaviour is what
 * happens on the SECOND value of a prop: SSR has one render and nothing to
 * hold. tests/unit/stage/word-dim-ramp.test.ts covers the markup contract.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import InlineNodes from '../../src/stage/renderer/InlineNodes.svelte';
import type { SafeRenderNode } from '../../src/shared/contracts';

/** Ten words, tokens 0-9, so the cursor can travel with a ramp behind it. */
const nodes: SafeRenderNode[] = [
  {
    type: 'text',
    text: 'one two three four five six seven eight nine ten',
    tokenIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
];

function mount(props: { cursor: number | null; dimFrozen?: boolean }) {
  const result = render(InlineNodes, { props: { nodes, ...props } });
  /** The ramp step drawn on `token`, or null where nothing is claimed. */
  const dimAt = (token: number): string | null =>
    result.container.querySelector(`[data-t="${token}"]`)?.getAttribute('data-dim') ?? null;
  return { ...result, dimAt };
}

describe('the ramp while the engine is following', () => {
  it('advances with the cursor', async () => {
    const { dimAt, rerender } = mount({ cursor: 3 });
    expect(dimAt(2)).toBe('1');

    await rerender({ nodes, cursor: 6 });
    expect(dimAt(2)).toBe('4');
    expect(dimAt(5)).toBe('1');
  });
});

describe('the ramp while the engine is not following', () => {
  it('holds where it was when the hold began', async () => {
    const { dimAt, rerender } = mount({ cursor: 4 });
    expect(dimAt(3)).toBe('1');

    // The aligner loses the reader here. Whatever the cursor does next is not
    // something the engine is standing behind.
    await rerender({ nodes, cursor: 4, dimFrozen: true });
    await rerender({ nodes, cursor: 8, dimFrozen: true });

    expect(dimAt(3)).toBe('1');
    // …and above all: four more words did NOT go grey under the presenter.
    for (const token of [4, 5, 6, 7]) {
      expect(dimAt(token), `token ${token} dimmed during a hold`).toBeNull();
    }
  });

  it('does not un-dim what was already spoken', async () => {
    // Freezing is a refusal to advance, not a retraction. Everything the reader
    // genuinely passed stays passed, or the script would appear to rewind.
    const { container, rerender } = mount({ cursor: 6 });
    await rerender({ nodes, cursor: 6, dimFrozen: true });
    expect(container.querySelectorAll('.past').length).toBe(6);
  });

  it('resumes from the live cursor the moment following returns', async () => {
    const { dimAt, rerender } = mount({ cursor: 4 });
    await rerender({ nodes, cursor: 8, dimFrozen: true });
    expect(dimAt(7)).toBeNull();

    await rerender({ nodes, cursor: 8, dimFrozen: false });
    expect(dimAt(7)).toBe('1');
    expect(dimAt(4)).toBe('4');
  });

  it('holds from its first sight of the cursor when it mounts mid-hold', async () => {
    /*
     * Virtualization mounts blocks as they scroll into the window, so a block
     * can appear with the flag already set and no history of its own. The
     * honest thing is to hold the one position it has ever seen; tracking the
     * live cursor would let a fresh block advance a ramp its neighbours are
     * holding.
     */
    const { dimAt, rerender } = mount({ cursor: 3, dimFrozen: true });
    expect(dimAt(2)).toBe('1');

    await rerender({ nodes, cursor: 9, dimFrozen: true });
    expect(dimAt(2)).toBe('1');
    expect(dimAt(8)).toBeNull();
  });

  it('holds the first real cursor a block is handed, having mounted with none', async () => {
    /*
     * Only the block the reader is in is given a cursor at all; every other
     * block on screen is rendered with `null`. Blocks trade that title DURING a
     * hold, because the fallback path keeps `confirmedToken` moving after
     * following stops — so the block the presenter is standing in can easily be
     * one whose entire history is `null`. If a block with no position to hold
     * follows the live cursor instead, the ramp walks through the hold on the
     * one block it matters on.
     */
    const { dimAt, rerender } = mount({ cursor: null });
    await rerender({ nodes, cursor: 5, dimFrozen: true });
    expect(dimAt(4)).toBe('1');

    await rerender({ nodes, cursor: 9, dimFrozen: true });
    expect(dimAt(4)).toBe('1');
    for (const token of [5, 6, 7, 8]) {
      expect(dimAt(token), `token ${token} dimmed during a hold`).toBeNull();
    }
  });

  it('lets the ramp go when the block stops being the one the reader is in', async () => {
    /*
     * The other half of that trade. Losing the cursor is not a shaky estimate
     * to be frozen — it is a fact about which block the reader is in, and the
     * block that lost it takes whole-block past zoning on the way out. Holding
     * per-word dimming underneath that multiplies the two opacities together
     * and leaves the block's tail visibly darker than the past around it.
     */
    const { container, rerender } = mount({ cursor: 6 });
    await rerender({ nodes, cursor: 6, dimFrozen: true });
    expect(container.querySelectorAll('.past').length).toBe(6);

    await rerender({ nodes, cursor: null, dimFrozen: true });
    expect(container.querySelectorAll('.past').length).toBe(0);
    expect(container.querySelectorAll('[data-dim]').length).toBe(0);
  });
});
