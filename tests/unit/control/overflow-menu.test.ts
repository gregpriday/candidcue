/**
 * OverflowMenu keyboard contract (spec §20).
 *
 * The component declared `role="menu"` / `role="menuitem"` and implemented
 * none of the pattern: no focus move on open, no arrow navigation, no roving
 * tabindex, and an Escape that closed the menu while leaving focus nowhere.
 * The trigger also exposed `aria-pressed` — a toggle-button promise — instead
 * of `aria-haspopup="menu"` + `aria-expanded`. On the Live transport this menu
 * is the only route to "Hard pause — mic off".
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import OverflowMenu from '../../../src/control/components/OverflowMenu.svelte';
import {
  firstEnabledIndex,
  lastEnabledIndex,
  menuItemTabIndex,
  nextMenuIndex,
  openIndexForTriggerKey,
} from '../../../src/control/components/menu-nav';

const ITEMS = [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }];
const WITH_DISABLED = [{ label: 'One' }, { label: 'Two', disabled: true }, { label: 'Three' }];

describe('opening from the trigger', () => {
  it('ArrowDown / Enter / Space open onto the first item, ArrowUp onto the last', () => {
    expect(openIndexForTriggerKey(ITEMS, 'ArrowDown')).toBe(0);
    expect(openIndexForTriggerKey(ITEMS, 'Enter')).toBe(0);
    expect(openIndexForTriggerKey(ITEMS, ' ')).toBe(0);
    expect(openIndexForTriggerKey(ITEMS, 'ArrowUp')).toBe(2);
  });

  it('skips disabled items at both ends', () => {
    const edges = [{ label: 'One', disabled: true }, { label: 'Two' }, { label: 'Three', disabled: true }];
    expect(openIndexForTriggerKey(edges, 'ArrowDown')).toBe(1);
    expect(openIndexForTriggerKey(edges, 'ArrowUp')).toBe(1);
  });

  it('ignores keys that do not open a menu', () => {
    expect(openIndexForTriggerKey(ITEMS, 'ArrowLeft')).toBeNull();
    expect(openIndexForTriggerKey(ITEMS, 'a')).toBeNull();
  });
});

describe('navigating an open menu', () => {
  it('walks with the arrows and wraps at both ends', () => {
    expect(nextMenuIndex(ITEMS, 0, 'ArrowDown')).toBe(1);
    expect(nextMenuIndex(ITEMS, 2, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(ITEMS, 0, 'ArrowUp')).toBe(2);
  });

  it('jumps with Home and End', () => {
    expect(nextMenuIndex(ITEMS, 1, 'Home')).toBe(0);
    expect(nextMenuIndex(ITEMS, 1, 'End')).toBe(2);
  });

  it('never lands on a disabled item', () => {
    expect(nextMenuIndex(WITH_DISABLED, 0, 'ArrowDown')).toBe(2);
    expect(nextMenuIndex(WITH_DISABLED, 2, 'ArrowUp')).toBe(0);
  });

  it('starts sensibly when focus has not landed on an item yet', () => {
    expect(nextMenuIndex(ITEMS, -1, 'ArrowDown')).toBe(0);
    expect(nextMenuIndex(ITEMS, -1, 'ArrowUp')).toBe(2);
  });

  it('leaves other keys alone', () => {
    expect(nextMenuIndex(ITEMS, 0, 'ArrowRight')).toBeNull();
    expect(nextMenuIndex(ITEMS, 0, 'Escape')).toBeNull();
    expect(nextMenuIndex([{ label: 'x', disabled: true }], -1, 'ArrowDown')).toBeNull();
  });

  it('has exactly one tab stop', () => {
    const stops = ITEMS.map((_, index) => menuItemTabIndex(1, index));
    expect(stops).toEqual([-1, 0, -1]);
    expect(stops.filter((s) => s === 0)).toHaveLength(1);
  });

  it('reports the enabled ends', () => {
    expect(firstEnabledIndex(WITH_DISABLED)).toBe(0);
    expect(lastEnabledIndex(WITH_DISABLED)).toBe(2);
    expect(firstEnabledIndex([{ label: 'x', disabled: true }])).toBe(-1);
  });
});

describe('rendered markup', () => {
  it('describes the trigger as a menu button, not a toggle button', () => {
    const { body } = render(OverflowMenu, {
      props: { items: [{ label: 'Hard pause', onselect: () => {} }], label: 'Pause options' },
    });
    expect(body).toContain('aria-haspopup="menu"');
    expect(body).toContain('aria-expanded="false"');
    expect(body).not.toContain('aria-pressed');
  });
});
