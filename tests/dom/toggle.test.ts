/**
 * Toggle.svelte — the `role="switch"` contract, asserted against a real DOM.
 *
 * Before this project existed there was no way to test this component at all:
 * a switch is only a switch if the rendered element carries the role, the
 * accessible name and a live `aria-checked`, and none of those exist until
 * something mounts it. The nearest thing the repo had was a test of a sibling
 * `.ts` helper, which cannot see the markup.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Toggle from '../../src/control/components/Toggle.svelte';

function renderToggle(props: Partial<Record<string, unknown>> = {}) {
  return render(Toggle, {
    props: { checked: false, label: 'Save transcript', ...props },
  });
}

describe('Toggle (role=switch)', () => {
  it('exposes itself to assistive tech as a switch with a name and a state', () => {
    const { getByRole } = renderToggle();
    const swtch = getByRole('switch', { name: 'Save transcript' });
    expect(swtch.tagName).toBe('BUTTON');
    // A bare <button> submits by default inside a form; a switch must not.
    expect(swtch.getAttribute('type')).toBe('button');
    expect(swtch.getAttribute('aria-checked')).toBe('false');
  });

  it('flips aria-checked in the DOM, not just the internal variable', async () => {
    const { getByRole } = renderToggle();
    const swtch = getByRole('switch');
    expect(swtch.getAttribute('aria-checked')).toBe('false');

    swtch.click();
    // Svelte 5 flushes on a microtask; awaiting the event loop is enough.
    await Promise.resolve();
    expect(swtch.getAttribute('aria-checked')).toBe('true');

    swtch.click();
    await Promise.resolve();
    expect(swtch.getAttribute('aria-checked')).toBe('false');
  });

  it('reports the NEW value to onchange, not the value it had before', async () => {
    const onchange = vi.fn();
    const { getByRole } = renderToggle({ onchange });
    getByRole('switch').click();
    await Promise.resolve();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith(true);
  });

  it('a disabled switch neither changes state nor notifies', async () => {
    const onchange = vi.fn();
    const { getByRole } = renderToggle({ disabled: true, onchange });
    const swtch = getByRole('switch');
    expect((swtch as HTMLButtonElement).disabled).toBe(true);

    swtch.click();
    await Promise.resolve();
    expect(swtch.getAttribute('aria-checked')).toBe('false');
    expect(onchange).not.toHaveBeenCalled();
  });

  it('the visible label is wired to the control, so clicking the text toggles it', async () => {
    const { container, getByRole } = renderToggle();
    const swtch = getByRole('switch');
    const label = container.querySelector('label');
    expect(label, 'the row must render a <label>').not.toBeNull();
    // The `for`/`id` pair is what makes the label a click target and what
    // screen readers follow. A label with no `for` looks identical on screen.
    expect(label?.getAttribute('for')).toBe(swtch.getAttribute('id'));
    expect(swtch.getAttribute('id')).toBeTruthy();
  });

  it('two toggles on one screen do not collide on the same generated id', () => {
    const a = renderToggle({ label: 'One' });
    const b = renderToggle({ label: 'Two' });
    const idA = a.getByRole('switch', { name: 'One' }).getAttribute('id');
    const idB = b.getByRole('switch', { name: 'Two' }).getAttribute('id');
    expect(idA).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it('renders the optional description only when given one', () => {
    const bare = renderToggle();
    expect(bare.container.querySelector('.description')).toBeNull();

    const described = renderToggle({ description: 'Kept for 30 days' });
    expect(described.container.querySelector('.description')?.textContent).toBe('Kept for 30 days');
  });
});
