/**
 * A single click on a list row opens it.
 *
 * The row selected on click and opened on double-click, and selection's only
 * feedback is a quiet background wash — so clicking a script in the library
 * looked like nothing had happened at all. Nobody discovers a double-click on a
 * list that gives no other sign it heard the first one.
 *
 * The two-step bought nothing: every library row carries its own Present
 * button, so opening on click takes no other action away. It also made the
 * keyboard behaviour wrong, since Enter on a focused row dispatches `click` and
 * could therefore only ever select — a keyboard user could not open a script
 * from the library at all.
 *
 * These assert the interaction rather than the wiring, because the wiring was
 * never the part that was broken.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ListRow from '../../src/control/components/ListRow.svelte';

function row(props: Record<string, unknown> = {}) {
  const onopen = vi.fn();
  const onselect = vi.fn();
  const { container } = render(ListRow, {
    props: { title: 'Launch keynote', onopen, onselect, ...props },
  });
  const button = container.querySelector<HTMLButtonElement>('button.main');
  if (!button) throw new Error('the row must render a button');
  return { button, onopen, onselect };
}

describe('a list row opens on a single click', () => {
  it('opens', () => {
    const { button, onopen } = row();
    button.click();
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it('selects as well, and selects first', () => {
    // The caller opens by navigating away; the selection is what the library
    // remembers for the return trip, so it has to be recorded before the move.
    const order: string[] = [];
    const { button } = row({
      onselect: () => order.push('select'),
      onopen: () => order.push('open'),
    });
    button.click();
    expect(order).toEqual(['select', 'open']);
  });

  it('opens from the keyboard, which the old binding made impossible', () => {
    // Enter on a focused button dispatches a click. Under the old wiring that
    // reached `onselect` only, so a script could not be opened without a mouse.
    const { button, onopen } = row();
    button.focus();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it('still selects when there is nothing to open', () => {
    // The Trash view passes an `onopen` that deliberately does nothing; the row
    // must stay selectable there rather than becoming inert.
    const { button, onselect } = row({ onopen: undefined });
    button.click();
    expect(onselect).toHaveBeenCalledTimes(1);
  });

  it('does not open twice on a double click', () => {
    // A double click is two clicks. Now that the first one opens, the second
    // must not re-fire a navigation on a screen that has already left.
    const onopen = vi.fn();
    const { button } = row({ onopen });
    button.click();
    // Whatever the row does next, the caller saw exactly one open from the
    // click that mattered — this pins that a `dblclick` handler was not left
    // behind alongside the new one.
    expect(onopen).toHaveBeenCalledTimes(1);
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onopen).toHaveBeenCalledTimes(1);
  });
});
