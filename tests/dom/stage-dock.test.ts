/**
 * The session dock, as an operating surface.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * The dock replaced five independent pieces of stage furniture with one, and
 * almost everything that could go wrong with it is a property of the assembled
 * thing rather than of any part: whether an invisible button still takes a
 * click, whether revealing the buttons moves the audio readout, whether the
 * key that backs out of "end the session?" also counts towards ending it,
 * whether two panes of glass can be stacked over the same corner.
 *
 * None of those are visible from a unit test of a handler, so this mounts the
 * component and drives it.
 */
import { render } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StageDock from '../../src/stage/StageDock.svelte';
import type { StageVoicePillPayload } from '../../src/shared/contracts';

function payload(overrides: Partial<StageVoicePillPayload> = {}): StageVoicePillPayload {
  return {
    stageGeneration: 3,
    reading: 'listening',
    levels: [0.2, 0.5, 0.3],
    label: 'Listening',
    visible: true,
    sentAtMs: 1000,
    ...overrides,
  };
}

/** A stand-in for the host's appearance panel; the dock only positions it. */
const PANEL = createRawSnippet(() => ({
  render: () => '<div data-testid="panel"><button type="button">Done</button></div>',
}));

function mount(overrides: Record<string, unknown> = {}) {
  const onend = vi.fn();
  const onhold = vi.fn<(held: boolean) => void>();
  const onpopover = vi.fn<(open: boolean) => void>();
  const onappearanceopen = vi.fn();
  const onappearanceclose = vi.fn();
  const result = render(StageDock, {
    props: {
      pill: payload(),
      revealed: true,
      onend,
      onhold,
      onpopover,
      onappearanceopen,
      onappearanceclose,
      ...overrides,
    } as never,
  });
  flushSync();
  return { ...result, onend, onhold, onpopover, onappearanceopen, onappearanceclose };
}

const endButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.dock-button.end')!;
const adjustButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.dock-button.adjust');
const confirmEnd = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.confirm-end');
const confirmCancel = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.confirm-cancel');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the buttons come and go; the audio readout does not', () => {
  /*
   * Both halves of the hidden state matter, and only one of them is obvious.
   *
   * `opacity: 0` alone leaves a button that still takes a click — a trap in the
   * exact corner a pointer is likely to be resting when the idle timer expires.
   * `display: none` would fix that and break the other half: the row would
   * collapse, and the audio readout would jump sideways every time the mouse
   * moved, which is movement beside a script somebody is reading.
   *
   * jsdom cannot measure either, so this asserts the mechanism the component
   * actually uses rather than a computed style it would report wrongly.
   */
  it('keeps the hidden buttons in the layout', () => {
    const { container } = mount({ revealed: false });

    const end = endButton(container);
    expect(end, 'still mounted, so the row does not collapse').not.toBeNull();
    expect(end.dataset.hidden).toBe('true');

    const { container: shown } = mount({ revealed: true });
    expect(endButton(shown).dataset.hidden).toBe('false');
  });

  /*
   * The OTHER half — that a hidden button takes no click — is deliberately not
   * asserted here, and the missing assertion is the point.
   *
   * jsdom reports `pointer-events` as the initial `auto` without inheriting an
   * ancestor's `none`, so the obvious check passes with the rule deleted: a
   * test that cannot fail, counted as coverage. The real claim needs
   * hit-testing and lives in Playwright — see "a hidden dock button cannot be
   * clicked through" in tests/e2e/browser/stage-preview.spec.ts.
   */

  it('draws the audio readout whether or not the buttons are up', () => {
    const { container } = mount({ revealed: false });
    expect(container.querySelector('.voice-pill')).not.toBeNull();
  });

  it('holds its space before control has said anything about the audio', () => {
    // Otherwise the two buttons sit together at the top of a take and step
    // apart the moment the first level frame arrives.
    const { container } = mount({ pill: null });
    expect(container.querySelector('.audio-placeholder')).not.toBeNull();
  });
});

describe('the settings button exists only when something can be adjusted', () => {
  /*
   * The standalone stage window receives a resolved envelope and holds no
   * settings. A button that opened an empty panel there would be a promise the
   * window cannot keep, so the honest answer is not to draw it.
   */
  it('is absent when no panel was handed in', () => {
    const { container } = mount();
    expect(adjustButton(container)).toBeNull();
  });

  it('asks the host to open, and to close again on a second press', () => {
    const { container, onappearanceopen, onappearanceclose } = mount({ appearancePanel: PANEL });
    adjustButton(container)!.click();
    flushSync();
    expect(onappearanceopen).toHaveBeenCalledTimes(1);

    const { container: open, onappearanceclose: closeAgain } = mount({
      appearancePanel: PANEL,
      appearanceOpen: true,
    });
    adjustButton(open)!.click();
    flushSync();
    expect(closeAgain).toHaveBeenCalledTimes(1);
    expect(onappearanceclose).not.toHaveBeenCalled();
  });

  it('renders the host panel above the dock when it is open', () => {
    const { container } = mount({ appearancePanel: PANEL, appearanceOpen: true });
    const panel = container.querySelector('[data-testid="panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.closest('.appearance-popover')).not.toBeNull();
  });
});

describe('ending a take', () => {
  it('asks first, and one click can never end anything', () => {
    const { container, onend } = mount();
    endButton(container).click();
    flushSync();

    expect(confirmEnd(container), 'the confirmation should be up').not.toBeNull();
    expect(onend).not.toHaveBeenCalled();
  });

  it('gives Cancel the keyboard, so Enter cannot reach the destructive half', () => {
    const { container } = mount();
    endButton(container).click();
    flushSync();
    expect(document.activeElement).toBe(confirmCancel(container));
  });

  it('ends it once the confirmation is taken', () => {
    const { container, onend } = mount();
    endButton(container).click();
    flushSync();
    confirmEnd(container)!.click();
    flushSync();
    expect(onend).toHaveBeenCalledTimes(1);
  });

  /*
   * Escape backs out — and, the part that would be a disaster, does not reach
   * the stage's own handler, where it would be counted towards the double press
   * that ends the take. The one key somebody presses to say "no, don't" must
   * never be the key that does it.
   */
  it('cancels on Escape and stops the key reaching the take', () => {
    const stage = vi.fn();
    window.addEventListener('keydown', stage);
    try {
      const { container, onend } = mount();
      endButton(container).click();
      flushSync();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      flushSync();

      expect(confirmEnd(container)).toBeNull();
      expect(onend).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', stage);
    }
  });

  /*
   * Cmd+. is not one of the shortcuts Live delegates to the stage, so it can
   * still raise the host's "Stop the session?" dialog over this confirmation.
   * Nothing here claims `aria-modal`, which is correct — it is anchored and
   * scrimless — but it means the guard has to be explicit, or the capture
   * listener swallows the Escape that dialog is waiting for and leaves an
   * undismissable sheet.
   */
  it('leaves Escape to a real modal stacked on top of it', () => {
    const { container, onend } = mount();
    endButton(container).click();
    flushSync();

    const stacked = document.createElement('div');
    stacked.setAttribute('role', 'dialog');
    stacked.setAttribute('aria-modal', 'true');
    document.body.append(stacked);
    try {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      flushSync();

      expect(confirmEnd(container), 'the confirmation stays put').not.toBeNull();
      expect(event.defaultPrevented, 'and the key travels on').toBe(false);
      expect(onend).not.toHaveBeenCalled();
    } finally {
      stacked.remove();
    }
  });

  it('treats a click anywhere else as cancel, never as confirm', () => {
    const { container, onend } = mount();
    endButton(container).click();
    flushSync();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();

    expect(confirmEnd(container)).toBeNull();
    expect(onend).not.toHaveBeenCalled();
  });

  /*
   * EVERY route out, not just the button marked Cancel.
   *
   * Cancel holds the keyboard while the confirmation is open, so whichever way
   * it closes, the focused node is unmounted — and a route that merely cleared
   * the flag would drop focus on `<body>`, on a full-screen stage, which is the
   * "where did the keyboard go" defect the dock exists to stop happening.
   */
  it.each([
    ['Cancel', (c: HTMLElement) => confirmCancel(c)!.click()],
    [
      'Escape',
      () =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
    ],
    [
      'a click away',
      () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    ],
  ])('puts the keyboard back on the control that opened it (%s)', (_label, dismiss) => {
    const { container } = mount();
    endButton(container).click();
    flushSync();
    expect(document.activeElement).toBe(confirmCancel(container));

    dismiss(container);
    flushSync();
    expect(confirmEnd(container)).toBeNull();
    expect(document.activeElement).toBe(endButton(container));
  });
});

describe('never two panes of glass over one dock', () => {
  /*
   * The appearance panel declares `aria-modal`, which tells the keyboard and
   * assistive technology that everything outside it is inert. A pointer that
   * can still reach the End control makes that a lie — and reaching it does two
   * things at once: cancels the appearance transaction and opens a second
   * popover. The old top-right corner kept the promise by removing its trigger
   * entirely; the dock cannot, without the row collapsing under the audio
   * readout, so it stands the control down instead.
   */
  it('stands the End control down while the modal appearance panel is open', () => {
    const { container, onend } = mount({ appearancePanel: PANEL, appearanceOpen: true });
    expect(endButton(container).disabled).toBe(true);

    endButton(container).click();
    flushSync();
    expect(confirmEnd(container)).toBeNull();
    expect(onend).not.toHaveBeenCalled();
  });

  it('closes the end confirmation when the appearance panel opens', () => {
    const { container } = mount({ appearancePanel: PANEL });
    endButton(container).click();
    flushSync();
    expect(confirmEnd(container)).not.toBeNull();

    adjustButton(container)!.click();
    flushSync();
    expect(confirmEnd(container)).toBeNull();
  });
});

describe('what the dock tells the stage around it', () => {
  it('holds itself up while a popup is open, so the idle timer cannot take it', () => {
    const { container, onhold } = mount({ revealed: false });
    onhold.mockClear();
    endButton(container).click();
    flushSync();
    expect(onhold).toHaveBeenLastCalledWith(true);
  });

  it('holds itself up for a fault nobody has been warned about', () => {
    /*
     * The one moment somebody needs to find these controls without having been
     * told to look is the moment the rig has stopped working — and that is also
     * the moment they are least likely to have a hand on the mouse.
     */
    const { onhold } = mount({
      revealed: false,
      pill: payload({ reading: 'fault', label: 'No audio' }),
    });
    expect(onhold).toHaveBeenLastCalledWith(true);
  });

  it('reports a popup so the transcript can get out from behind it', () => {
    const { container, onpopover } = mount();
    onpopover.mockClear();
    endButton(container).click();
    flushSync();
    expect(onpopover).toHaveBeenLastCalledWith(true);
  });
});

describe('operable without a mouse', () => {
  it('names both controls', () => {
    const { container } = mount({ appearancePanel: PANEL });
    expect(adjustButton(container)!.getAttribute('aria-label')).toBe('Adjust the prompter');
    expect(endButton(container).getAttribute('aria-label')).toBe('End session');
    // A tooltip as well as a name: an unlabelled × is also a plausible "close
    // this small panel", and the two readings have very different consequences.
    expect(endButton(container).getAttribute('title')).toBe('End session');
  });

  it('says whether its popup is open', () => {
    const { container } = mount({ appearancePanel: PANEL, appearanceOpen: true });
    expect(adjustButton(container)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('skips the audio readout in the tab order', () => {
    // It is a readout, not a control. Landing on it would be a stop that does
    // nothing, between the two stops that do.
    const { container } = mount();
    const focusable = [...container.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')];
    expect(focusable.some((el) => el.classList.contains('voice-pill'))).toBe(false);
  });
});
