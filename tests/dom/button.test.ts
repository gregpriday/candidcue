/**
 * Button.svelte — the contract the rest of the design system leans on.
 *
 * Two things here are load-bearing beyond this component. The `data-focus`
 * marker is how a shared control opts into the accent focus ring now that
 * tokens.css gives unmarked buttons the quiet edge instead; lose it and every
 * button in the product silently drops to the surface treatment. And `element`
 * is what lets a caller move focus onto a rendered button deliberately —
 * RevisionHistory's confirm step depends on it.
 *
 * The danger variant's colours are CSS and jsdom resolves no stylesheets, so
 * what is asserted here is that the variant class reaches the element; the
 * fill/lip/label contrast is proved arithmetically in
 * `tests/unit/control/design-system-tokens.test.ts`.
 */
import { render } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Button from '../../src/control/components/Button.svelte';

function label(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

function renderButton(props: Record<string, unknown> = {}) {
  return render(Button, { props: { children: label('Empty Trash'), ...props } });
}

describe('Button', () => {
  it('is a non-submitting button by default', () => {
    const { getByRole } = renderButton();
    const button = getByRole('button', { name: 'Empty Trash' });
    // A bare <button> submits the form it sits in; every caller here means
    // "do this", not "submit".
    expect(button.getAttribute('type')).toBe('button');
  });

  it('opts into the accent focus ring', () => {
    // tokens.css hands the accent ring out only on request — a button without
    // this marker gets the quiet surface edge meant for rows and tiles.
    expect(renderButton().getByRole('button').getAttribute('data-focus')).toBe('control');
  });

  it.each(['danger', 'primary', 'ghost'])('carries the %s variant onto the element', (variant) => {
    // Scoped to this render's own container: several buttons share the document
    // across a `describe`, and a document-wide role query matches all of them.
    const { container } = renderButton({ variant });
    expect(container.querySelector('button')?.classList).toContain(variant);
  });

  it('a disabled button neither reports a click nor pretends it can be used', () => {
    const onclick = vi.fn();
    const { getByRole } = renderButton({ disabled: true, onclick });
    const button = getByRole('button') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    button.click();
    flushSync();
    expect(onclick).not.toHaveBeenCalled();
  });

  it('renders a focusable element for a caller to move focus onto', () => {
    // The `element` binding itself needs a parent component to bind through, so
    // it is proved end-to-end in `tests/dom/revision-history.test.ts`, where
    // focus actually has to land on the rendered Cancel. What matters here is
    // that the thing being handed back is focusable at all.
    const { getByRole } = renderButton();
    const button = getByRole('button') as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
  });
});
