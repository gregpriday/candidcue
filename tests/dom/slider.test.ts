/**
 * Slider.svelte — mounted, because the thing worth asserting is the markup.
 *
 * The §28.4 sensitivity control is the reason this file exists. That slider is
 * safe to offer only because it moves the speech threshold and nothing else,
 * and the only place a user can learn that is the description under the track.
 * A `description` prop that is accepted and never rendered is exactly the shape
 * of defect this app has shipped repeatedly — a value carried faithfully to the
 * last step and then dropped — and it is invisible to any test that does not
 * mount the component.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Slider from '../../src/control/components/Slider.svelte';
import { VAD_SENSITIVITY_COPY } from '../../src/control/services/settings-audio';

function renderSlider(props: Record<string, unknown> = {}) {
  return render(Slider, {
    props: { value: 50, min: 0, max: 100, label: 'Voice-detection sensitivity', ...props },
  });
}

function text(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

describe('Slider', () => {
  it('is a labelled range input, not a styled div', () => {
    const { getByRole } = renderSlider();
    const input = getByRole('slider', { name: 'Voice-detection sensitivity' });
    expect(input.getAttribute('type')).toBe('range');
    expect((input as HTMLInputElement).value).toBe('50');
  });

  it('renders the description when one is given, and nothing when it is not', () => {
    const withCopy = renderSlider({ description: VAD_SENSITIVITY_COPY.description });
    expect(text(withCopy.container)).toContain(VAD_SENSITIVITY_COPY.description);

    const without = renderSlider();
    expect(without.container.querySelector('.description')).toBeNull();
  });

  it('shows the formatted value, so the readout can name the default', () => {
    const { container } = renderSlider({ value: 50, format: VAD_SENSITIVITY_COPY.format });
    expect(text(container)).toContain('Default');

    const off = renderSlider({ value: 72, format: VAD_SENSITIVITY_COPY.format });
    expect(text(off.container)).toContain('72%');
  });

  /*
   * Rendering the sentence is only half of it. The §28.4 description is the
   * only place the sensitivity control explains what it moves, and until the
   * input pointed at it a screen-reader user got a bare percentage with no
   * explanation anywhere in the accessibility tree.
   */
  it('points the range input at its description, so it is announced with the control', () => {
    const { getByRole } = renderSlider({ description: VAD_SENSITIVITY_COPY.description });
    const input = getByRole('slider');

    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy, 'the range must reference a description').toBeTruthy();

    // Resolved out of the document, the way assistive tech resolves it.
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      VAD_SENSITIVITY_COPY.description,
    );
  });

  it('claims no description when it has none to give', () => {
    expect(renderSlider().getByRole('slider').getAttribute('aria-describedby')).toBeNull();
  });

  it('two described sliders point at their own description, not each other’s', () => {
    // A hard-coded description id would satisfy every single-instance test here
    // and collide on the settings screens that stack several of these.
    const a = renderSlider({ label: 'One', description: 'First' });
    const b = renderSlider({ label: 'Two', description: 'Second' });

    const idA = a.getByRole('slider', { name: 'One' }).getAttribute('aria-describedby');
    const idB = b.getByRole('slider', { name: 'Two' }).getAttribute('aria-describedby');
    expect(idA).not.toBe(idB);
    expect(document.getElementById(idA!)?.textContent).toBe('First');
    expect(document.getElementById(idB!)?.textContent).toBe('Second');
  });

  it('reports the new number upward on input', async () => {
    const onchange = vi.fn();
    const { getByRole } = renderSlider({ onchange });
    const input = getByRole('slider') as HTMLInputElement;

    input.value = '80';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    expect(onchange).toHaveBeenCalledTimes(1);
    // A number, not the string the DOM hands back — the callers divide by 100.
    expect(onchange.mock.calls[0]![0]).toBe(80);
  });
});
