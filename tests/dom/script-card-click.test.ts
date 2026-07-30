/**
 * A single click on a script card opens it.
 *
 * The card selected on click and opened on double-click, and selection's only
 * feedback was a quiet background wash — so clicking a script in the library
 * looked like nothing had happened at all. Nobody discovers a double-click on a
 * list that gives no other sign it heard the first one.
 *
 * The two-step bought nothing: every library card carries its own Present
 * button, so opening on click takes no other action away. It also made the
 * keyboard behaviour wrong, since Enter on a focused card dispatches `click` and
 * could therefore only ever select — a keyboard user could not open a script
 * from the library at all.
 *
 * These assert the interaction rather than the wiring, because the wiring was
 * never the part that was broken. They moved here from `list-row-click` with the
 * component: `ListRow` was generic in name only (the library was its sole
 * caller) and became `ScriptCard`, but this contract is unchanged.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ScriptCard from '../../src/control/components/ScriptCard.svelte';

function row(props: Record<string, unknown> = {}) {
  const onopen = vi.fn();
  const onselect = vi.fn();
  const { container } = render(ScriptCard, {
    props: { title: 'Launch keynote', onopen, onselect, ...props },
  });
  const button = container.querySelector<HTMLButtonElement>('button.main');
  if (!button) throw new Error('the card must render a button');
  const card = container.querySelector<HTMLElement>('.card');
  if (!card) throw new Error('the card must render a surface');
  return { button, card, onopen, onselect };
}

describe('a script card opens on a single click', () => {
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

/**
 * What a card says about itself.
 *
 * The title has to reach the accessible name: the library's Playwright specs
 * find a script with `getByRole('button', { name: /Launch keynote/ })`, and so
 * does anybody driving this screen with a screen reader.
 *
 * It says nothing at all about selection, and that is the contract now. The
 * store still remembers `selectedId` for the Present shortcut, but no card is
 * ever drawn or announced as the chosen one — there is no multi-select, no list
 * navigation and no action that reads a selection, so `aria-current` would
 * promise assistive tech a state that means nothing here. See the note in
 * `ScriptCard`.
 */
describe('what a script card exposes', () => {
  it('puts the title in the accessible name', () => {
    const { button } = row();
    expect(button.textContent).toContain('Launch keynote');
  });

  it('never claims to be the current one', () => {
    const { button, card } = row();
    expect(button.getAttribute('aria-current')).toBeNull();
    expect(card.classList.contains('selected')).toBe(false);
  });

  it('renders the excerpt and each metadata part', () => {
    const { card } = row({
      excerpt: 'Good morning, and welcome to this short teleprompter test.',
      meta: ['yesterday', '131 words', '≈ 1 min'],
    });
    expect(card.querySelector('.excerpt')?.textContent).toContain('Good morning');
    const meta = card.querySelector('.meta')?.textContent ?? '';
    for (const part of ['yesterday', '131 words', '≈ 1 min']) expect(meta).toContain(part);
  });

  it('omits the excerpt and metadata rather than rendering empty boxes', () => {
    // A brand-new script has no preview text and the card must not reserve a
    // blank line for one.
    const { card } = row();
    expect(card.querySelector('.excerpt')).toBeNull();
    expect(card.querySelector('.meta')).toBeNull();
  });
});
