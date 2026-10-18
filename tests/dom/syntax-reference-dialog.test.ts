/**
 * SyntaxReferenceDialog.svelte — the page, against the table it is drawn from.
 *
 * `syntax-reference.test.ts` proves every example compiles to what the table
 * says. What it cannot prove is that the page shows them: a dialog that dropped
 * a group, or rendered an example through Markdown and turned `**42%**` into
 * bold, would pass every compiler assertion while teaching something else. So
 * the rendered page is checked entry by entry, and the examples are checked as
 * the exact characters a user would type.
 */
import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import SyntaxReferenceDialog from '../../src/control/components/SyntaxReferenceDialog.svelte';
import { SYNTAX_REFERENCE, syntaxEntries } from '../../src/shared/markdown/syntax-reference';

/** Render the dialog and hand back its panel — required, so a component that
    rendered nothing fails loudly instead of every text assertion passing on ''. */
function open(onclose: () => void = () => {}): HTMLElement {
  render(SyntaxReferenceDialog, { props: { open: true, onclose } });
  const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!panel) throw new Error('the dialog did not render');
  return panel;
}

describe('SyntaxReferenceDialog', () => {
  it('renders nothing while closed', () => {
    render(SyntaxReferenceDialog, { props: { open: false, onclose: () => {} } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('is named for what it is', () => {
    const panel = open();
    const title = document.getElementById(panel.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent?.trim()).toBe('Script syntax reference');
  });

  it('shows every group and every entry, in the table order', () => {
    const panel = open();
    const groups = [...panel.querySelectorAll('section h3')].map((h) => h.textContent?.trim());
    expect(groups).toEqual(SYNTAX_REFERENCE.map((group) => group.title));

    const rendered = [...panel.querySelectorAll<HTMLElement>('[data-entry]')].map(
      (el) => el.dataset['entry'],
    );
    expect(rendered).toEqual(syntaxEntries().map((entry) => entry.id));
  });

  it('shows each example exactly as typed, with what it does', () => {
    const panel = open();
    for (const entry of syntaxEntries()) {
      const el = panel.querySelector<HTMLElement>(`[data-entry="${entry.id}"]`);
      if (!el) throw new Error(`${entry.id} is missing`);
      // textContent, so a bracket, brace or fence the page had interpreted
      // would show up here as missing characters.
      expect(el.querySelector('pre code')?.textContent).toBe(entry.example);
      expect(el.querySelector('h4')?.textContent?.trim()).toBe(entry.title);
      // The prose marks syntax with backticks, which the page sets as code.
      const plain = (text: string) => text.replaceAll('`', '');
      const captions = [...el.querySelectorAll('.outcome .caption')].map((p) =>
        p.textContent?.trim(),
      );
      expect(captions).toEqual([plain(entry.glass), plain(entry.following)]);
      for (const note of entry.notes ?? []) expect(el.textContent).toContain(plain(note));
    }
    // Nothing in an example became markup: no bold from `**`, no image from `![]()`.
    expect(panel.querySelector('pre strong, pre img, pre em')).toBeNull();
  });

  it('opens on the top of the page rather than on Done', async () => {
    const panel = open();
    await tick();
    const intro = panel.querySelector('[data-autofocus]');
    expect(intro).not.toBeNull();
    expect(document.activeElement).toBe(intro);
  });

  it('closes from Done and from Escape', () => {
    const onclose = vi.fn();
    const panel = open(onclose);
    const done = [...panel.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Done',
    );
    done?.click();
    expect(onclose).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it('says nothing about the retired coaching syntax', () => {
    const panel = open();
    const text = panel.textContent ?? '';
    expect(text).not.toMatch(/coach/i);
    expect(text).not.toMatch(/<!--\s*cc:/i);
    expect(text).not.toMatch(/\bcc:/i);
  });
});
