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
import { createRawSnippet, flushSync, tick } from 'svelte';
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
  const onfollowtoggle = vi.fn();
  const result = render(StageDock, {
    props: {
      pill: payload(),
      revealed: true,
      onend,
      onhold,
      onpopover,
      onappearanceopen,
      onappearanceclose,
      onfollowtoggle,
      ...overrides,
    } as never,
  });
  flushSync();
  return {
    ...result,
    onend,
    onhold,
    onpopover,
    onappearanceopen,
    onappearanceclose,
    onfollowtoggle,
  };
}

const endButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.dock-button.end')!;
const menuTrigger = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>('.dock-button.menu-trigger')!;
const confirmEnd = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.confirm-end');
const confirmCancel = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.confirm-cancel');

const menuRows = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('[data-menu-row]')];
const menuRow = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`[data-menu-row="${id}"]`);

/**
 * Open the menu and let the component's `tick()`-deferred focus land.
 *
 * The menu-button pattern requires focus to move onto a row the moment the menu
 * opens, and the row does not exist until Svelte has rendered it — so the
 * component defers the focus by a microtask and every test that cares about
 * where the keyboard went has to wait with it.
 */
async function openMenu(c: HTMLElement): Promise<void> {
  menuTrigger(c).click();
  flushSync();
  await tick();
  await tick();
}

/** A key, on whatever has the keyboard, the way a browser delivers it. */
async function press(node: Element, key: string): Promise<void> {
  node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  flushSync();
  await tick();
  await tick();
}

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

describe('the menu holds whatever this window can actually offer', () => {
  /*
   * The standalone stage window receives a resolved envelope and holds no
   * settings, and it is a window on a second display with no presentation mode
   * to toggle. Rows that opened an empty panel or flipped a mode this window
   * does not have would be promises it cannot keep, so the honest answer is not
   * to draw them — and `menu-nav` walks this array to work out what the arrows
   * do, so a row that is not offered may not occupy an index either.
   */
  it('offers only the follow switch when the host handed in nothing else', async () => {
    const { container } = mount();
    await openMenu(container);
    expect(menuRows(container).map((row) => row.dataset.menuRow)).toEqual(['follow']);
  });

  it('offers all three when the host owns settings and a window', async () => {
    const { container } = mount({ appearancePanel: PANEL, onpresentationtoggle: vi.fn() });
    await openMenu(container);
    expect(menuRows(container).map((row) => row.dataset.menuRow)).toEqual([
      'appearance',
      'present',
      'follow',
    ]);
  });

  /*
   * The three shapes are not interchangeable. A row that flips a mode where it
   * stands reports `aria-checked`; the row that opens a panel of SLIDERS says
   * `aria-haspopup="dialog"`, because a slider inside `role="menu"` loses its
   * own left/right arrows to the menu's and stops being operable at all; and,
   * in a reading window, the row that switches to the teleprompter is a
   * command, which claims neither.
   */
  it('says which rows are switches, which is a command and which opens another level', async () => {
    const { container } = mount({
      appearancePanel: PANEL,
      onpresentationtoggle: vi.fn(),
      presentationMode: 'reader',
    });
    await openMenu(container);

    const appearance = menuRow(container, 'appearance')!;
    expect(appearance.getAttribute('role')).toBe('menuitem');
    expect(appearance.getAttribute('aria-haspopup')).toBe('dialog');
    expect(appearance.getAttribute('aria-checked')).toBeNull();

    const present = menuRow(container, 'present')!;
    expect(present.getAttribute('role')).toBe('menuitem');
    expect(present.getAttribute('aria-checked')).toBeNull();
    expect(present.getAttribute('aria-haspopup')).toBeNull();
    expect(present.querySelector('.menu-mark svg'), 'a command draws no tick').toBeNull();

    const follow = menuRow(container, 'follow')!;
    expect(follow.getAttribute('role')).toBe('menuitemcheckbox');
    expect(follow.getAttribute('aria-checked')).toBe('true');
    expect(follow.getAttribute('aria-haspopup')).toBeNull();
  });

  it('reports how following is set', async () => {
    const off = mount({ onpresentationtoggle: vi.fn(), presentationMode: 'reader', followPaused: true });
    await openMenu(off.container);
    expect(menuRow(off.container, 'follow')!.getAttribute('aria-checked')).toBe('false');
    expect(menuRow(off.container, 'follow')!.querySelector('.menu-mark svg')).toBeNull();
    document.body.innerHTML = '';

    const on = mount({ onpresentationtoggle: vi.fn(), presentationMode: 'prompter' });
    await openMenu(on.container);
    expect(menuRow(on.container, 'follow')!.getAttribute('aria-checked')).toBe('true');
    // The tick is the same state said to an eye. A row that reported `checked`
    // to a screen reader and drew nothing would look like a menu of verbs.
    expect(menuRow(on.container, 'follow')!.querySelector('.menu-mark svg')).not.toBeNull();
  });

  /*
   * "Fill the display" described a different operation from a reading window:
   * there the row can move the window onto the pinned prompter panel,
   * re-resolve its optics and apply that panel's saved mirroring, so it names
   * the switch. A prompter take keeps the ticked switch it has always had — it
   * IS filling the display, and a control used at the glass keeps its shape.
   */
  it('names the switch in a reading window and keeps the prompter’s tick', async () => {
    const reading = mount({ onpresentationtoggle: vi.fn(), presentationMode: 'reader' });
    await openMenu(reading.container);
    expect(menuRow(reading.container, 'present')!.textContent?.trim()).toBe('Switch to teleprompter');
    expect(reading.container.textContent).not.toContain('Fill the display');
    document.body.innerHTML = '';

    const prompting = mount({ onpresentationtoggle: vi.fn(), presentationMode: 'prompter' });
    await openMenu(prompting.container);
    const present = menuRow(prompting.container, 'present')!;
    expect(present.textContent?.trim()).toBe('Fill the display');
    expect(present.getAttribute('role')).toBe('menuitemcheckbox');
    expect(present.getAttribute('aria-checked')).toBe('true');
    expect(present.querySelector('.menu-mark svg'), 'the tick is drawn').not.toBeNull();
  });

  it('calls the appearance panel a prompter’s only on a prompter', async () => {
    const reading = mount({ appearancePanel: PANEL, presentationMode: 'reader' });
    await openMenu(reading.container);
    expect(menuRow(reading.container, 'appearance')!.textContent?.trim()).toBe('Reading appearance…');
    document.body.innerHTML = '';

    const prompting = mount({ appearancePanel: PANEL, presentationMode: 'prompter' });
    await openMenu(prompting.container);
    expect(menuRow(prompting.container, 'appearance')!.textContent?.trim()).toBe('Prompter appearance…');
  });

  /*
   * A command does its one thing and the menu goes, the way any menu command
   * does — the switch reshapes the window and can move it to another panel, so
   * a menu left open would hang from where the window used to be. It hands the
   * keyboard to the trigger on the way out, and the next opening says the way
   * back.
   */
  it('closes on the switch, gives the trigger the keyboard, and offers the way back', async () => {
    const onpresentationtoggle = vi.fn();
    const { container, rerender } = mount({ onpresentationtoggle, presentationMode: 'reader' });
    await openMenu(container);

    menuRow(container, 'present')!.click();
    flushSync();
    expect(onpresentationtoggle).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.menu-popover'), 'the menu has gone').toBeNull();
    expect(document.activeElement).toBe(menuTrigger(container));

    await rerender({ onpresentationtoggle, presentationMode: 'prompter' } as never);
    flushSync();
    await openMenu(container);
    expect(menuRow(container, 'present')!.textContent?.trim()).toBe('Fill the display');
    expect(menuRow(container, 'present')!.getAttribute('aria-checked')).toBe('true');
    expect(onpresentationtoggle).toHaveBeenCalledTimes(1);
  });

  it('flips the prompter’s switch where it stands, as it always has', async () => {
    const onpresentationtoggle = vi.fn();
    const { container } = mount({ onpresentationtoggle, presentationMode: 'prompter' });
    await openMenu(container);
    menuRow(container, 'present')!.click();
    flushSync();
    expect(onpresentationtoggle).toHaveBeenCalledTimes(1);
    expect(menuRow(container, 'present'), 'the menu stays up').not.toBeNull();
  });

  /*
   * A switch flips where it stands and the menu STAYS OPEN. These are settings,
   * not commands: somebody may want to see one take effect and then reconsider,
   * and a menu that closed on every tick would make reconsidering a second hunt
   * for the trigger.
   */
  it('flips a mode without closing itself', async () => {
    const { container, onfollowtoggle } = mount();
    await openMenu(container);
    menuRow(container, 'follow')!.click();
    flushSync();
    expect(onfollowtoggle).toHaveBeenCalledTimes(1);
    expect(menuRow(container, 'follow'), 'the menu stays up').not.toBeNull();
  });

  it('replaces itself with the level the panel row opens', async () => {
    const { container, onappearanceopen } = mount({ appearancePanel: PANEL });
    await openMenu(container);
    menuRow(container, 'appearance')!.click();
    flushSync();
    expect(onappearanceopen).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.menu-popover'), 'level one is gone').toBeNull();
  });

  /*
   * The ORDER of those two things is load-bearing, and nothing else can see it.
   *
   * `StageAppearanceSheet` reads `document.activeElement` as it mounts and puts
   * focus back there when it closes. Unmounting the row before handing the
   * keyboard to the trigger would leave it recording `<body>` — so closing the
   * panel, by any route, would drop focus on a full-screen stage and the next
   * Tab would start from a page nobody can see. Both the panel and the menu
   * would still look perfectly correct.
   */
  it('hands the keyboard to the trigger before the level below opens', async () => {
    let openerAtMount: Element | null = null;
    const { container } = mount({
      appearancePanel: PANEL,
      onappearanceopen: () => (openerAtMount = document.activeElement),
    });
    await openMenu(container);
    menuRow(container, 'appearance')!.click();
    flushSync();
    expect(openerAtMount).toBe(menuTrigger(container));
  });

  /*
   * The host owns `appearanceOpen`, so "the menu closed it on the way past" is
   * a property of every path that exists TODAY rather than a guarantee. A
   * second opener added on the control side later would put both levels on the
   * glass at once, which this file promises in several places cannot happen.
   */
  it('never shows level one under a level two the host opened by itself', async () => {
    const { container, rerender } = mount({ appearancePanel: PANEL });
    await openMenu(container);
    expect(container.querySelector('.menu-popover')).not.toBeNull();

    await rerender({ appearancePanel: PANEL, appearanceOpen: true } as never);
    flushSync();
    expect(container.querySelector('.menu-popover')).toBeNull();
    expect(container.querySelector('.appearance-popover')).not.toBeNull();
  });

  it('renders the host panel above the dock when it is open', () => {
    const { container } = mount({ appearancePanel: PANEL, appearanceOpen: true });
    const panel = container.querySelector('[data-testid="panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.closest('.appearance-popover')).not.toBeNull();
  });

  /*
   * The trigger is NOT a way out of the second level. Pressing it used to
   * cancel, and cancel put back everything just tuned on a gesture that reads
   * as "close this". It calls the panel's attention instead, as a click away
   * does, and leaves Cancel and Done to say which. Re-opening the menu would
   * answer the press with more chrome.
   */
  it('holds the second level open when the trigger is pressed again', () => {
    const { container, onappearanceclose, onappearanceopen } = mount({
      appearancePanel: PANEL,
      appearanceOpen: true,
    });
    menuTrigger(container).click();
    flushSync();
    expect(onappearanceclose).not.toHaveBeenCalled();
    expect(onappearanceopen).not.toHaveBeenCalled();
    expect(container.querySelector('.menu-popover')).toBeNull();
    expect(container.querySelector('.appearance-popover')).not.toBeNull();
  });

  /*
   * A click away has no safe meaning while every move is already on the glass:
   * closing as cancel throws the tuning away, closing as Done saves an
   * experiment. It goes nowhere, and the panel stays.
   */
  it('holds a click away instead of answering it', () => {
    const { container, onappearanceclose } = mount({
      appearancePanel: PANEL,
      appearanceOpen: true,
    });
    const away = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(away);
    flushSync();
    expect(onappearanceclose).not.toHaveBeenCalled();
    expect(away.defaultPrevented).toBe(true);
    expect(container.querySelector('.appearance-popover')).not.toBeNull();
  });
});

describe('the menu is operable from the keyboard', () => {
  it('announces the popup and whether it is up', async () => {
    const { container } = mount();
    expect(menuTrigger(container).getAttribute('aria-haspopup')).toBe('menu');
    expect(menuTrigger(container).getAttribute('aria-expanded')).toBe('false');
    await openMenu(container);
    expect(menuTrigger(container).getAttribute('aria-expanded')).toBe('true');
  });

  /*
   * Both levels are the same popup as far as the trigger is concerned. Leaving
   * `aria-expanded` false while the appearance panel is up would tell a screen
   * reader the trigger does nothing, at the one moment pressing it is the way
   * back out.
   */
  it('stays expanded while the second level is showing', () => {
    const { container } = mount({ appearancePanel: PANEL, appearanceOpen: true });
    expect(menuTrigger(container).getAttribute('aria-expanded')).toBe('true');
  });

  /*
   * OPENED BY MOUSE, NOTHING IS DRAWN AS CHOSEN; OPENED BY KEY, SOMETHING IS.
   *
   * Focus must move onto a row either way — the menu-button pattern requires it
   * and a keyboard user has to be able to carry on with the arrows — but
   * painting that row as chosen is a different claim. A pointer has not said
   * which row it wants, and the top row drawn as chosen looks one Return away
   * from firing. A keyboard user, meanwhile, is left inside a menu with nothing
   * drawn to say where, because these rows deliberately suppress their outline.
   *
   * `detail` is the only discriminator a click carries: a pointer click counts
   * at least one, and a click synthesised from Enter/Space — or dispatched by
   * assistive technology — counts zero.
   */
  it('paints nothing as chosen when a pointer opened it', async () => {
    const { container } = mount();
    menuTrigger(container).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
    );
    flushSync();
    await tick();
    await tick();

    const row = menuRow(container, 'follow')!;
    expect(document.activeElement, 'focus still moves in').toBe(row);
    expect(row.classList.contains('active')).toBe(false);
  });

  it('paints the row it landed on when a key opened it', async () => {
    // `.click()` produces `detail: 0`, which is exactly what a browser
    // synthesises for Enter or Space on a focused button.
    const { container } = mount();
    await openMenu(container);
    expect(menuRow(container, 'follow')!.classList.contains('active')).toBe(true);
  });

  it('moves the highlight with the pointer, and only ever marks one row', async () => {
    const { container } = mount({ appearancePanel: PANEL, onpresentationtoggle: vi.fn() });
    await openMenu(container);
    menuRow(container, 'follow')!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    flushSync();
    await tick();

    const marked = menuRows(container).filter((row) => row.classList.contains('active'));
    expect(marked).toEqual([menuRow(container, 'follow')]);
  });

  it('moves the keyboard onto a row, as one tab stop', async () => {
    const { container } = mount({ appearancePanel: PANEL, onpresentationtoggle: vi.fn() });
    await openMenu(container);
    const rows = menuRows(container);
    expect(document.activeElement).toBe(rows[0]);
    expect(rows.map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('walks with the arrows and wraps', async () => {
    const { container } = mount({ appearancePanel: PANEL, onpresentationtoggle: vi.fn() });
    await openMenu(container);
    await press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(menuRow(container, 'present'));
    await press(document.activeElement!, 'End');
    expect(document.activeElement).toBe(menuRow(container, 'follow'));
    await press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(menuRow(container, 'appearance'));
  });

  it('opens onto the last row from ArrowUp on the trigger', async () => {
    const { container } = mount({ appearancePanel: PANEL, onpresentationtoggle: vi.fn() });
    await press(menuTrigger(container), 'ArrowUp');
    expect(document.activeElement).toBe(menuRow(container, 'follow'));
  });

  /*
   * ESCAPE MUST NOT REACH THE STAGE.
   *
   * The stage counts Escape towards the double press that ends a take, and it
   * listens on the window. A menu that merely closed would spend the
   * presenter's first press on itself and leave the second one ending the
   * session — the same defect the end confirmation's handler exists to stop.
   */
  it('closes on Escape, hands the keyboard back, and stops the key there', async () => {
    const stage = vi.fn();
    window.addEventListener('keydown', stage);
    try {
      const { container } = mount();
      await openMenu(container);
      await press(document.activeElement!, 'Escape');

      expect(container.querySelector('.menu-popover')).toBeNull();
      expect(document.activeElement).toBe(menuTrigger(container));
      expect(stage).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', stage);
    }
  });

  /*
   * Tab dismisses — a menu is not part of the tab ring — and hands the keyboard
   * back to the TRIGGER before it goes.
   *
   * The menu is rendered after the button row, so tabbing straight out of a row
   * skips the End control entirely and Shift+Tab walks backwards into it, both
   * of which disagree with where the menu visibly hangs from. Returning to the
   * trigger first makes the browser's own Tab continue from the control the
   * operator opened.
   */
  it('is not part of the tab ring: Tab dismisses it and gives the trigger back', async () => {
    const { container } = mount();
    await openMenu(container);
    await press(document.activeElement!, 'Tab');
    expect(container.querySelector('.menu-popover')).toBeNull();
    expect(document.activeElement).toBe(menuTrigger(container));
  });

  it('dismisses on a click anywhere else, keyboard included', async () => {
    const { container } = mount();
    await openMenu(container);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(container.querySelector('.menu-popover')).toBeNull();
    // Every route out of a popover in this file puts the keyboard back on the
    // control that opened it; a click away is not an exception.
    expect(document.activeElement).toBe(menuTrigger(container));
  });

  it('closes and gives the keyboard back when the trigger is pressed again', async () => {
    const { container } = mount();
    await openMenu(container);
    menuTrigger(container).click();
    flushSync();
    expect(container.querySelector('.menu-popover')).toBeNull();
    expect(document.activeElement).toBe(menuTrigger(container));
  });

  /*
   * A PRESS ON THE MENU'S OWN PADDING MAY NOT HAND THE SCRIPT THE KEYBOARD.
   *
   * This is the defect the window-level key handling and the pointerdown guard
   * both exist for. The stage answers ArrowUp/ArrowDown, PageUp/PageDown,
   * Space, `a` and `[`/`]` on the WINDOW, and stands down only for a key whose
   * target sits inside `[data-stage-chrome]`. Blur the focused row onto
   * `<body>` and every one of those keys starts scrolling the script, toggling
   * the transport and changing the auto-scroll pace behind a menu the operator
   * is looking straight at.
   */
  it('keeps a press on its own padding from handing the script the keyboard', async () => {
    const stage = vi.fn();
    window.addEventListener('keydown', stage);
    try {
      const { container } = mount({ appearancePanel: PANEL, onpresentationtoggle: vi.fn() });
      await openMenu(container);

      const panel = container.querySelector('.menu-popover')!;
      const onPadding = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
      panel.dispatchEvent(onPadding);
      expect(onPadding.defaultPrevented, 'the browser never moves focus off the row').toBe(true);

      // And the arrows still walk the menu, wherever the keyboard ended up, and
      // the stage never sees them.
      stage.mockClear();
      await press(document.body, 'ArrowDown');
      expect(document.activeElement).toBe(menuRow(container, 'present'));
      expect(stage).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', stage);
    }
  });

  /*
   * A press on a ROW still focuses it. The guard above is for the padding only;
   * blanket-preventing the default would break the pointer's own highlight.
   */
  it('still lets a press land on a row', async () => {
    const { container } = mount();
    await openMenu(container);
    const row = menuRow(container, 'follow')!;
    const onRow = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    row.dispatchEvent(onRow);
    expect(onRow.defaultPrevented).toBe(false);
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

  /*
   * The mode switches used to be buttons in this row and had to be stood down
   * individually; folding them into the menu retires that whole class of
   * mistake, because there is no menu to reach past an open panel. The two
   * levels are mutually exclusive by construction.
   */
  it('never shows the menu and the panel at once', () => {
    const { container } = mount({ appearancePanel: PANEL, appearanceOpen: true });
    expect(container.querySelector('.menu-popover')).toBeNull();
    expect(container.querySelector('.appearance-popover')).not.toBeNull();
  });

  it('hands the End control back the moment the panel closes', () => {
    // The stand-down is scoped to the modal being up, and nothing else — a
    // control that stayed dead afterwards would be a worse bug than the one
    // this fixes.
    const { container } = mount({ appearancePanel: PANEL });
    expect(endButton(container).disabled).toBe(false);
  });

  it('closes the end confirmation when the menu opens', async () => {
    const { container } = mount();
    endButton(container).click();
    flushSync();
    expect(confirmEnd(container)).not.toBeNull();

    await openMenu(container);
    expect(confirmEnd(container)).toBeNull();
  });

  it('closes the menu when the end confirmation opens', async () => {
    const { container } = mount();
    await openMenu(container);
    endButton(container).click();
    flushSync();
    expect(container.querySelector('.menu-popover')).toBeNull();
    expect(confirmEnd(container)).not.toBeNull();
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

  /*
   * The menu counts for both, and it is worth saying separately from the
   * confirmation: leaving `menuOpen` out of `held` would let the idle timer
   * fade the dock out from under an open menu, and leaving it out of
   * `popoverOpen` would leave the diagnostic transcript — which sits directly
   * above this dock — being read through a panel.
   */
  it('holds itself up and reports a popup for the menu too', async () => {
    const { container, onhold, onpopover } = mount({ revealed: false });
    await openMenu(container);
    expect(onhold).toHaveBeenLastCalledWith(true);
    expect(onpopover).toHaveBeenLastCalledWith(true);

    /*
     * Then take the keyboard away, which is what isolates the claim.
     *
     * Opening the menu puts focus on a row, and focus inside the dock holds it
     * up on its own — so the assertion above passes whether or not `menuOpen`
     * is wired into `held` at all. Dropping focus leaves the open menu as the
     * only reason left, and the hold has to survive on it or the idle timer
     * fades the dock out from under a menu somebody is reading.
     */
    (document.activeElement as HTMLElement).blur();
    flushSync();
    expect(onhold).toHaveBeenLastCalledWith(true);

    onpopover.mockClear();
    await press(document.body, 'Escape');
    expect(onpopover, 'and it lets the transcript back out on the way down').toHaveBeenLastCalledWith(
      false,
    );
  });
});

describe('a mode that is off may not hide inside the menu (§48)', () => {
  it('reports the decision rather than taking it', async () => {
    // §16.9: the stage never acts on a privileged decision itself. Following is
    // control's state — the same switch its own transport checkbox reads — so
    // the row says what happened and nothing else.
    const { container, onfollowtoggle } = mount();
    await openMenu(container);
    menuRow(container, 'follow')!.click();
    flushSync();
    expect(onfollowtoggle).toHaveBeenCalledTimes(1);
  });

  it('lets the trigger fade while following is on', () => {
    // On is the ordinary case and the whole take. A lit control in the corner
    // of a script that is behaving is a mark reporting nothing.
    const { container } = mount({ revealed: false, followPaused: false });
    expect(menuTrigger(container).getAttribute('data-hidden')).toBe('true');
  });

  it('keeps the trigger lit while following is off, even when nothing is revealed', () => {
    /*
     * The failure this prevents: a presenter looks up at a script that will not
     * move, and the answer is one click behind a cog they cannot see until they
     * happen to move the mouse. Everything else behind this trigger is a verb
     * somebody reaches for and forgets; this one sets a mode.
     */
    const { container } = mount({ revealed: false, followPaused: true });
    expect(menuTrigger(container).getAttribute('data-hidden')).toBe('false');
    // The way out still goes, which is the point: this is one control staying
    // behind, not the idle timer failing to fire.
    expect(endButton(container).getAttribute('data-hidden')).toBe('true');
  });

  it('says so on the trigger, in words, in colour and in a mark', () => {
    const on = mount({ followPaused: false });
    expect(menuTrigger(on.container).getAttribute('aria-label')).toBe('Take menu');
    expect(menuTrigger(on.container).classList.contains('flagged')).toBe(false);
    expect(on.container.querySelector('.menu-trigger .flag')).toBeNull();
    document.body.innerHTML = '';

    const off = mount({ followPaused: true });
    expect(menuTrigger(off.container).getAttribute('aria-label')).toContain('following is off');
    /*
     * Both, on purpose. A hue shift and a shape fail under different
     * conditions — colour goes first through a beamsplitter, geometry goes
     * first at 16px on a non-Retina panel — so the state that must never be
     * missed is carried twice.
     */
    expect(menuTrigger(off.container).classList.contains('flagged')).toBe(true);
    expect(off.container.querySelector('.menu-trigger .flag')).not.toBeNull();
  });
});

describe('operable without a mouse', () => {
  it('names both controls', () => {
    const { container } = mount({ appearancePanel: PANEL });
    expect(menuTrigger(container).getAttribute('aria-label')).toBe('Take menu');
    expect(endButton(container).getAttribute('aria-label')).toBe('End Take');
    // A tooltip as well as a name: an unlabelled × is also a plausible "close
    // this small panel", and the two readings have very different consequences.
    expect(endButton(container).getAttribute('title')).toBe('End Take');
  });

  it('skips the audio readout in the tab order', () => {
    // It is a readout, not a control. Landing on it would be a stop that does
    // nothing, between the two stops that do.
    const { container } = mount();
    const focusable = [...container.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')];
    expect(focusable.some((el) => el.classList.contains('voice-pill'))).toBe(false);
  });
});

/* --------------------------------------------------------------- practice */

/**
 * The dock, told that this reading is a rehearsal.
 *
 * Only the words change, and only on the way out. That is the whole surface —
 * a practice is doing the same job with the same controls, so a dock that
 * rearranged itself would be teaching a second layout for no reason. What it
 * must not do is offer to end a take somebody does not believe they started.
 */
describe('a practice says so where it matters', () => {
  it('names the exit for what it finishes', () => {
    const { container } = mount({ practice: true });
    expect(endButton(container).getAttribute('aria-label')).toBe('Finish Practice');
    expect(endButton(container).getAttribute('title')).toBe('Finish Practice');
  });

  it('asks about practising, and promises only what is true', () => {
    /*
     * "Your place in the script will be saved" answers a worry about losing a
     * take. A rehearsal does not create that worry; what somebody wants to know
     * before finishing one is that nothing is being written down about it.
     */
    const { container } = mount({ practice: true });
    endButton(container).click();
    flushSync();
    expect(container.querySelector('.confirm-title')?.textContent).toBe('Finish practising?');
    expect(container.querySelector('.confirm-body')?.textContent).toContain('Nothing is reported');
    expect(confirmEnd(container)?.textContent?.trim()).toBe('Finish Practice');
  });

  it('still ends through the same confirmed path', () => {
    // The copy is the only difference. The gesture, the anchor and the
    // confirmation are the take's, and the host is called exactly once.
    const { container, onend } = mount({ practice: true });
    endButton(container).click();
    flushSync();
    confirmEnd(container)!.click();
    flushSync();
    expect(onend).toHaveBeenCalledTimes(1);
  });

  it('leaves a take talking about takes', () => {
    const { container } = mount();
    expect(endButton(container).getAttribute('aria-label')).toBe('End Take');
    endButton(container).click();
    flushSync();
    expect(container.querySelector('.confirm-title')?.textContent).toBe('End take?');
  });
});
