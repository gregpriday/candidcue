/**
 * The one confirmation sheet, and what happens to a question it stops showing.
 *
 * A second `requestConfirm` replaces the first on screen. The first promise used
 * to be dropped — nothing would ever resolve it — which turned File › Close
 * Window into a dead key: ⌘W asked "End this take?", ⌘. raised End Take's own
 * question over it, and the close flow stayed suspended with its in-flight
 * latch set, so every later ⌘W was refused (#266 review).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { pendingConfirm, requestConfirm, settleConfirm } from '../../../src/control/stores/confirm';

const ask = (title: string) => ({ title, body: 'Body', confirmLabel: 'Yes' });

afterEach(() => {
  settleConfirm(false);
});

describe('requestConfirm', () => {
  it('resolves with the answer given', async () => {
    const answer = requestConfirm(ask('First'));
    settleConfirm(true);
    await expect(answer).resolves.toBe(true);
    expect(get(pendingConfirm)).toBeNull();
  });

  it('answers a replaced question "no" instead of leaving it pending', async () => {
    const first = requestConfirm(ask('First'));
    const second = requestConfirm(ask('Second'));

    // Nobody agreed to the first question; it is no longer on screen.
    await expect(first).resolves.toBe(false);
    expect(get(pendingConfirm)?.request.title).toBe('Second');

    settleConfirm(true);
    await expect(second).resolves.toBe(true);
  });
});
