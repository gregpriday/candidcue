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
import type { ReaderAppearance, StageAppearance } from '../../src/control/lib/stage-appearance';

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

    drag(slider(container, 'Reading line'), 44);
    drag(slider(container, 'Reading line'), 45);

    expect(onchange).toHaveBeenNthCalledWith(1, { readingBandCenterPercent: 44 });
    expect(onchange).toHaveBeenNthCalledWith(2, { readingBandCenterPercent: 45 });
    expect(onok).not.toHaveBeenCalled();
  });

  it('sends the field its own control owns', () => {
    const { container, onchange } = open();

    drag(slider(container, 'Text size'), 90);
    drag(slider(container, 'Line spacing'), 1.5);
    drag(slider(container, 'Text width'), 60);

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

describe('the size nudges', () => {
  /*
   * A slider alone cannot be operated accurately at two pixels a step — the
   * range is 24 to 320 across a track about 200px wide — and two pixels is
   * exactly the size of adjustment somebody makes when they are nearly right
   * and standing at the glass.
   */
  it('steps by two, and by ten with Shift', () => {
    const { getByLabelText, onchange } = open();

    getByLabelText('Larger text').click();
    flushSync();
    expect(onchange).toHaveBeenLastCalledWith({ fontSizePx: 66 });

    getByLabelText('Smaller text').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
    );
    flushSync();
    expect(onchange).toHaveBeenLastCalledWith({ fontSizePx: 54 });
  });

  /*
   * Stopped, not clamped-and-sent. A button that looks live and quietly posts
   * the value the control is already showing reads as a key that did not
   * register, which is the complaint `adjustFontSize` already carries a comment
   * about one screen along.
   */
  it('stops at the ends of the range it was given', () => {
    // Queried through each render's own container: two panels coexist in this
    // test, and a document-wide lookup finds both.
    const nudge = (container: HTMLElement, label: string) =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

    const top = open({ maxFontSizePx: 80, appearance: { ...APPEARANCE, fontSizePx: 80 } });
    expect(nudge(top.container, 'Larger text').disabled).toBe(true);
    expect(nudge(top.container, 'Smaller text').disabled).toBe(false);

    const bottom = open({ appearance: { ...APPEARANCE, fontSizePx: 24 } });
    expect(nudge(bottom.container, 'Smaller text').disabled).toBe(true);
  });
});

describe('the width control reports a measure, not only a percentage', () => {
  /*
   * The same 78% is a different measure on a 1024x600 Prompter, a 1080p
   * Prompter XL and a Sidecar iPad, and it is the CHARACTER count that governs
   * eye travel. Only the stage can produce it — control resolves geometry
   * against DIN fallbacks because control does not render the font — so it
   * arrives as a prop and is shown beside the thing being dragged.
   */
  it('shows the measured characters per line when the stage has reported one', () => {
    const { container } = open({ charactersPerLine: 42 });
    const value = [...container.querySelectorAll('.slider .value')].map((el) => el.textContent);
    expect(value).toContain('78% · 42 chars');
  });

  it('says nothing about it before the first line map', () => {
    const { container } = open({ charactersPerLine: null });
    const value = [...container.querySelectorAll('.slider .value')].map((el) => el.textContent);
    expect(value).toContain('78%');
  });
});

describe('keeping or discarding', () => {
  it('keeps on Done and discards on Cancel, and never both', () => {
    const { getByRole, onok, oncancel } = open();

    getByRole('button', { name: 'Done' }).click();
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
    expect(slider(container, 'Text size').max).toBe('400');
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
    expect(getByText('Calibrated')).toBeTruthy();
    expect(getByText(/Settings . Prompter display and rigs/i)).toBeTruthy();
  });

  /*
   * There is nothing here the sheet could save. A Done button would write the
   * RIG's resolved numbers into the global defaults — quietly changing what
   * every uncalibrated take opens with, on a panel the operator opened to look
   * at one display.
   */
  it('offers no Done, because it has nothing to save', () => {
    const { queryByRole, getByRole, oncancel } = open({ rigResolved: true });

    expect(queryByRole('button', { name: 'Done' })).toBeNull();
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

describe('a reading window', () => {
  /*
   * A reading window always runs a profile, and it used to get the
   * rig-resolved readout: "Prompter appearance", a "Calibrated" badge over a
   * window nobody calibrated, "worked out from how far away you stand", and
   * only Close. Its text is the reader preference now, and these are its
   * controls.
   */
  const READER: ReaderAppearance = {
    fontSizePx: 30,
    lineHeight: 1.38,
    characters: null,
    textIntensity: 'standard',
    readingCue: 'ticks',
  };

  function openReader(overrides: Record<string, unknown> = {}) {
    const onreaderchange = vi.fn();
    const opened = open({
      surface: 'reader',
      reader: READER,
      // A reading window always resolves through a profile; the panel must
      // not fall back to the readout because of it.
      rigResolved: true,
      onreaderchange,
      ...overrides,
    });
    return { ...opened, onreaderchange };
  }

  it('is titled for what it is, with no calibration badge', () => {
    const { getByRole, queryByText } = openReader();
    expect(getByRole('heading').textContent?.trim()).toBe('Reading appearance');
    expect(queryByText('Calibrated')).toBeNull();
    expect(queryByText('Automatic')).toBeNull();
    expect(queryByText(/how far away you stand/i)).toBeNull();
  });

  it('offers working controls, Cancel and Done', () => {
    const { container, getByRole, onreaderchange, onchange } = openReader();

    drag(slider(container, 'Text size'), 36);
    drag(slider(container, 'Line spacing'), 1.6);
    radio(container, 'Intensity', 'Strong').click();
    radio(container, 'Reading cue', 'Wash').click();
    flushSync();

    expect(onreaderchange).toHaveBeenCalledWith({ fontSizePx: 36 });
    expect(onreaderchange).toHaveBeenCalledWith({ lineHeight: 1.6 });
    expect(onreaderchange).toHaveBeenCalledWith({ intensity: 'strong' });
    expect(onreaderchange).toHaveBeenCalledWith({ readingCue: 'wash' });
    // Nothing reaches the prompter's fallback from here.
    expect(onchange).not.toHaveBeenCalled();
    expect(getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('draws the size over the reader’s range, not the prompter’s', () => {
    const { container } = openReader();
    const size = slider(container, 'Text size');
    expect(size.min).toBe('20');
    expect(size.max).toBe('96');
    const spacing = slider(container, 'Line spacing');
    expect(spacing.min).toBe('1.2');
    expect(spacing.max).toBe('1.8');
  });

  it('nudges by two, by ten with Shift, and stops at the ends', () => {
    const { getByLabelText, onreaderchange } = openReader();
    getByLabelText('Larger text').click();
    flushSync();
    expect(onreaderchange).toHaveBeenLastCalledWith({ fontSizePx: 32 });
    getByLabelText('Smaller text').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
    );
    flushSync();
    expect(onreaderchange).toHaveBeenLastCalledWith({ fontSizePx: 20 });

    const nudge = (container: HTMLElement, label: string) =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    const top = openReader({ reader: { ...READER, fontSizePx: 96 } });
    expect(nudge(top.container, 'Larger text').disabled).toBe(true);
    const bottom = openReader({ reader: { ...READER, fontSizePx: 20 } });
    expect(nudge(bottom.container, 'Smaller text').disabled).toBe(true);
  });

  /** One option of one segmented control — "Standard" is in two of them. */
  function radio(container: HTMLElement, group: string, name: string): HTMLElement {
    const groupEl = container.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${group}"]`);
    expect(groupEl, `no control labelled "${group}"`).not.toBeNull();
    const match = [...groupEl!.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (el) => el.textContent?.trim() === name,
    );
    expect(match, `no "${name}" in "${group}"`).toBeDefined();
    return match!;
  }

  it('offers three line widths, as measures, with Standard clearing the choice', () => {
    const standard = openReader();
    expect(radio(standard.container, 'Line width', 'Standard').getAttribute('aria-checked')).toBe(
      'true',
    );
    radio(standard.container, 'Line width', 'Narrower').click();
    flushSync();
    expect(standard.onreaderchange).toHaveBeenLastCalledWith({ characters: 55 });

    const wider = openReader({ reader: { ...READER, characters: 75 } });
    expect(radio(wider.container, 'Line width', 'Wider').getAttribute('aria-checked')).toBe('true');
    radio(wider.container, 'Line width', 'Standard').click();
    flushSync();
    expect(wider.onreaderchange).toHaveBeenLastCalledWith({ characters: null });
  });

  it('reports the measured characters, not a percentage of the display', () => {
    const { getByText, queryByText } = openReader({ charactersPerLine: 61 });
    expect(getByText('About 61 characters a line')).toBeTruthy();
    expect(queryByText(/%/)).toBeNull();
  });

  it('says where the choice is kept', () => {
    const { getByText } = openReader();
    expect(getByText('Done saves these for every reading window.')).toBeTruthy();
  });

  it('falls back to the prompter panel when there is no reading appearance to drive', () => {
    // A reading window with no panel to resolve against prompts from the flat
    // fields, and the ordinary controls are the ones that reach it.
    const { getByRole } = openReader({ reader: null, rigResolved: false });
    expect(getByRole('heading').textContent?.trim()).toBe('Prompter appearance');
  });

  /*
   * Dark or Paper. A reading window's field, offered beside the intensity of
   * the ink on it, applied on the way past like every other control here — and
   * a choice the prompter's panel never offers, because a prompter is black.
   */
  it('offers Dark and Paper, showing the one on the glass, and reports a choice', () => {
    const onreaderthemechange = vi.fn();
    const { container } = openReader({ readerTheme: 'dark', onreaderthemechange });
    expect(radio(container, 'Appearance', 'Dark').getAttribute('aria-checked')).toBe('true');
    expect(radio(container, 'Appearance', 'Paper').getAttribute('aria-checked')).toBe('false');

    radio(container, 'Appearance', 'Paper').click();
    flushSync();
    expect(onreaderthemechange).toHaveBeenCalledWith('paper');
  });

  it('reads as dark when nobody says otherwise', () => {
    const { container } = openReader();
    expect(radio(container, 'Appearance', 'Dark').getAttribute('aria-checked')).toBe('true');
  });

  it('turns into a sheet of paper over a paper reading window', () => {
    // The workspace palette, by the attribute every light surface in the app
    // already uses — so its controls are the light ones, not dark glass.
    const onPaper = openReader({ readerTheme: 'paper' });
    expect(onPaper.getByRole('dialog').getAttribute('data-theme')).toBe('workspace');

    const onDark = openReader({ readerTheme: 'dark' });
    expect(onDark.getAllByRole('dialog').at(-1)!.hasAttribute('data-theme')).toBe(false);
  });

  it('is never offered on the prompter’s panel, which stays dark glass', () => {
    const { container, getByRole } = open({ readerTheme: 'paper' });
    expect(container.querySelector('[role="radiogroup"][aria-label="Appearance"]')).toBeNull();
    expect(getByRole('dialog').hasAttribute('data-theme')).toBe(false);
  });
});
