/**
 * The in-session appearance sheet, as an operating surface.
 *
 * Everything here is a promise that only exists once the thing is mounted over
 * a running take: that a slider reaches the stage on the way past rather than
 * on the way out, that Escape closes the panel instead of ending the session
 * behind it, and that a calibrated rig's four resolved values are not offered
 * as if the sheet decided them.
 *
 * The last one is why this is a DOM test rather than an assertion about props:
 * "disabled" is the entire user-facing difference between a control that is in
 * charge of the glass and one that is not.
 */
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import StageAppearanceSheet from '../../src/control/components/StageAppearanceSheet.svelte';
import { FOCUSABLE_SELECTOR } from '../../src/control/components/dialog-focus';
import type { StageAppearance } from '../../src/control/lib/stage-appearance';

const APPEARANCE: StageAppearance = {
  textIntensity: 'standard',
  fontSizePx: 64,
  lineHeight: 1.32,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
};

function open(overrides: Record<string, unknown> = {}) {
  const onchange = vi.fn();
  const onok = vi.fn();
  const oncancel = vi.fn();
  const result = render(StageAppearanceSheet, {
    props: {
      appearance: APPEARANCE,
      rigResolved: false,
      maxFontSizePx: 320,
      onchange,
      onok,
      oncancel,
      ...overrides,
    } as never,
  });
  flushSync();
  return { ...result, onchange, onok, oncancel };
}

/** The range input behind a label, by the label's text. */
function slider(container: HTMLElement, label: string): HTMLInputElement {
  const labels = [...container.querySelectorAll('label')];
  const match = labels.find((l) => l.textContent?.trim() === label);
  expect(match, `no slider labelled "${label}"`).toBeDefined();
  // By attribute rather than `#id`: Svelte's generated ids are not guaranteed
  // to be valid CSS identifiers, and jsdom has no `CSS.escape` to fix them.
  const input = container.querySelector<HTMLInputElement>(`[id="${match!.htmlFor}"]`);
  expect(input, `slider "${label}" has no input`).not.toBeNull();
  return input!;
}

function drag(input: HTMLInputElement, value: number): void {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('the sheet applies as you go', () => {
  /*
   * The whole reason these controls moved onto the stage. A reading band you
   * have to close a panel to see is a reading band you align twice — and the
   * second look is the one that costs a take.
   */
  it('reports every move, not just the last one', () => {
    const { container, onchange, onok } = open();

    drag(slider(container, 'Reading band position'), 44);
    drag(slider(container, 'Reading band position'), 45);

    expect(onchange).toHaveBeenNthCalledWith(1, { readingBandCenterPercent: 44 });
    expect(onchange).toHaveBeenNthCalledWith(2, { readingBandCenterPercent: 45 });
    expect(onok).not.toHaveBeenCalled();
  });

  it('sends the field its own control owns', () => {
    const { container, onchange } = open();

    drag(slider(container, 'Font size'), 90);
    drag(slider(container, 'Line height'), 1.5);
    drag(slider(container, 'Text column width'), 60);

    expect(onchange).toHaveBeenCalledWith({ fontSizePx: 90 });
    expect(onchange).toHaveBeenCalledWith({ lineHeight: 1.5 });
    expect(onchange).toHaveBeenCalledWith({ columnWidthPercent: 60 });
  });

  it('offers the three text intensities and reports the chosen one', () => {
    const { getByRole, onchange } = open();
    getByRole('radio', { name: 'Strong' }).click();
    flushSync();
    expect(onchange).toHaveBeenCalledWith({ textIntensity: 'strong' });
  });
});

describe('keeping or discarding', () => {
  it('keeps on OK and discards on Cancel, and never both', () => {
    const { getByRole, onok, oncancel } = open();

    getByRole('button', { name: 'OK' }).click();
    flushSync();
    expect(onok).toHaveBeenCalledTimes(1);
    expect(oncancel).not.toHaveBeenCalled();
  });

  it('cancels on Cancel', () => {
    const { getByRole, onok, oncancel } = open();

    getByRole('button', { name: 'Cancel' }).click();
    flushSync();
    expect(oncancel).toHaveBeenCalledTimes(1);
    expect(onok).not.toHaveBeenCalled();
  });

  /*
   * Escape over a running take means "close this panel", and it has to be
   * caught HERE or it means "end the session" — the stage answers the same key
   * a layer down. Dispatched at the window, in the capture phase, for the
   * reason Dialog.svelte states: clicking the sheet's own prose leaves focus on
   * `<body>`, and a panel-scoped handler would never see the key again.
   */
  it('treats Escape as Cancel, and stops it reaching the take', () => {
    /*
     * A spy standing in for the stage's own window keydown handler, which ends
     * the session on Escape. `defaultPrevented` alone would not catch a
     * regression here: dropping `stopPropagation` still leaves the event marked
     * prevented while the stage — which does not check that in the standalone
     * path — goes ahead and tears the take down.
     */
    const stage = vi.fn();
    window.addEventListener('keydown', stage);
    try {
      const { oncancel } = open();
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      flushSync();

      expect(oncancel).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(stage).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', stage);
    }
  });

  /*
   * Escape belongs to the TOPMOST dialog. Without the guard, the confirm sheet
   * a stacked "End session" puts up shares its Escape with the panel
   * underneath, so one press answers two questions.
   */
  it('leaves Escape to a dialog stacked on top of it', () => {
    const { oncancel } = open();
    const stacked = document.createElement('div');
    stacked.setAttribute('role', 'dialog');
    stacked.setAttribute('aria-modal', 'true');
    document.body.append(stacked);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      flushSync();
      expect(oncancel).not.toHaveBeenCalled();
    } finally {
      stacked.remove();
    }
  });
});

describe('the range the size slider draws', () => {
  /*
   * The ceiling is the take's, fixed when it opened, and handed in. Derived
   * from the live value instead it became a one-way ratchet: a take opened at
   * 400px and dragged down to 350 could never get back up, and Cancel — which
   * is just a request for the opening value — was clamped to the new lower
   * ceiling and silently kept the smaller type.
   */
  it('is the ceiling it was given, not one derived from the current value', () => {
    const { container } = open({ maxFontSizePx: 400, appearance: { ...APPEARANCE, fontSizePx: 350 } });
    expect(slider(container, 'Font size').max).toBe('400');
  });
});

describe('a rig-resolved take', () => {
  /*
   * §17.2. `buildStageSettings` works every one of these out from a measured
   * distance and never consults the loose values when a profile is in play —
   * INCLUDING text intensity, which a calibrated profile carries because it was
   * chosen at that glass. Controls here would move and change nothing, which is
   * the precise defect the Settings screen already carries a paragraph about,
   * reappearing one screen along.
   */
  it('offers no controls at all — it reports', () => {
    const { container } = open({ rigResolved: true });

    expect(container.querySelectorAll('input[type="range"]').length).toBe(0);
    expect(container.querySelectorAll('[role="radio"]').length).toBe(0);
  });

  it('says what the rig resolved, exactly, and where to change it', () => {
    const { getByText } = open({
      rigResolved: true,
      // Past the top of the ordinary sliders on purpose: a rig may legitimately
      // resolve a line height of 2.0, and a readout that clamped it to 1.80
      // would be describing type that is not on the glass.
      appearance: { ...APPEARANCE, fontSizePx: 234, lineHeight: 2 },
    });

    expect(getByText('234 px')).toBeTruthy();
    expect(getByText('2.00')).toBeTruthy();
    expect(getByText(/recalibrate this display/i)).toBeTruthy();
  });

  /*
   * There is nothing here the sheet could save. An OK button would write the
   * RIG's resolved numbers into the global defaults — quietly changing what
   * every uncalibrated take opens with, on a panel the operator opened to look
   * at one display.
   */
  it('offers no OK, because it has nothing to save', () => {
    const { queryByRole, getByRole, oncancel } = open({ rigResolved: true });

    expect(queryByRole('button', { name: 'OK' })).toBeNull();
    getByRole('button', { name: 'Close' }).click();
    flushSync();
    expect(oncancel).toHaveBeenCalledTimes(1);
  });
});

describe('the panel owns the keyboard while it is open', () => {
  it('declares itself modal, which is what stands the app shortcuts down', () => {
    const { getByRole } = open();
    const panel = getByRole('dialog');
    // `isModalOpen` in lib/shortcuts.ts looks for exactly this pair; without it
    // Space would pause the take from under somebody tabbing the controls.
    expect(panel.getAttribute('aria-modal')).toBe('true');
  });

  it('moves focus into itself on open', () => {
    const { container } = open();
    expect(container.contains(document.activeElement)).toBe(true);
  });

  /*
   * And gives it back. The sheet is UNMOUNTED by its caller rather than hidden,
   * so without this the focused node disappears and focus lands on `<body>` —
   * on a full-screen stage that means the next Tab starts from a page nobody
   * can see, nowhere near the button that opened this.
   */
  it('returns focus to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    try {
      const { unmount } = open();
      expect(document.activeElement).not.toBe(opener);
      unmount();
      flushSync();
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  /*
   * The trap's edges have to be stops Tab can actually reach. SegmentedControl
   * parks `tabindex="-1"` on every unselected radio, and a trap that counted
   * those as its "first" element held the line at an element Tab never visits —
   * so Shift+Tab from the real first stop walked straight out of the modal.
   */
  it('counts only tabbable elements as its edges', () => {
    const { container } = open();
    const focusables = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    expect(focusables.length).toBeGreaterThan(0);
    expect(focusables.some((el) => el.getAttribute('tabindex') === '-1')).toBe(false);
  });
});
