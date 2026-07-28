/**
 * Who owns a keystroke during single-window presentation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS A MOUNTED STAGE
 * ---------------------------------------------------------------------------
 * Presentation puts three keyboard consumers in one window: the app shortcut
 * layer (`installShortcuts`), the Live route's handler, and the stage's own
 * `<svelte:window onkeydown>`. Each is individually correct and the bugs live
 * between them — a key answered twice, or answered by the wrong one. Only a
 * real listener on a real window can see that, which is why this drives a
 * mounted `StageApp` rather than calling a handler.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEFECTS
 * ---------------------------------------------------------------------------
 * 1. The stage listens on the WINDOW, so it also hears keys aimed at the host's
 *    operator chrome. Space on the focused session-menu button toggled pause
 *    and called `preventDefault()`, which additionally suppressed the button's
 *    own activation: one key, the wrong action, and the right one cancelled.
 *
 * 2. The first fix for that stood the stage down whenever the event was already
 *    `defaultPrevented` — which is EVERY key the shortcut layer resolves, since
 *    `emit()` prevents default on all of them. Live delegates Space and Escape
 *    to the stage on purpose, so the guard silenced exactly the keys it was
 *    supposed to protect. Both halves are pinned here.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  StageIntent,
  StageRenderDocument,
  StageSessionEnvelope,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

const StageApp = (await import('../../src/stage/StageApp.svelte')).default;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
});

function renderDocument(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello there friend', tokenIndexes: [0, 1, 2] }],
        startTokenIndex: 0,
        endTokenIndex: 2,
        source: { utf16Start: 0, utf16End: 18 },
        spoken: true,
      },
    ],
    tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
    assets: {},
    sentences: [{ id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 2 }],
  } as unknown as StageRenderDocument;
}

function envelope(): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: 0,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: buildStageSettings({}),
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

/** The host's operator chrome, marked the way the Live route marks it. */
let chrome: HTMLElement;
let trigger: HTMLButtonElement;

function mount(chromeOpen = false) {
  const onexit = vi.fn();
  const onintent = vi.fn<(intent: StageIntent) => void>();
  render(StageApp, {
    props: {
      embedded: {
        envelope: envelope(),
        alignment: null,
        transcript: '',
        voicePill: null,
        onexit,
        onintent,
        chromeOpen,
      },
    } as never,
  });
  return { onexit, onintent };
}

/** Dispatch a key the way a browser does: at the deepest focused node. */
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  chrome = document.createElement('div');
  chrome.setAttribute('data-stage-chrome', '');
  trigger = document.createElement('button');
  chrome.append(trigger);
  document.body.append(chrome);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a key aimed at the host chrome', () => {
  it('does not reach the script', () => {
    const { onintent } = mount();

    press(trigger, ' ');
    press(trigger, 'ArrowDown');

    // Neither a pause nor a step: the button owns its own Space, and the menu
    // its own arrows.
    expect(onintent).not.toHaveBeenCalled();
  });

  it('leaves the button its own activation', () => {
    mount();
    // The stage used to call `preventDefault()` on this, which is what stops a
    // <button> activating on Space at keyup.
    expect(press(trigger, ' ').defaultPrevented).toBe(false);
  });

  /*
   * Escape is exempt, the same exemption `resolveShortcut` makes: somebody
   * reaching for Escape over a full-screen stage has no interest in which
   * button happens to hold focus. Without the exemption, closing the menu left
   * focus on its trigger and the key that ends a take silently stopped working.
   */
  it('still answers Escape, wherever focus is parked', () => {
    const { onexit } = mount();

    /*
     * TWO presses, and that is the change worth pinning.
     *
     * Presentation used to end the take on the FIRST Escape while the
     * standalone stage window asked for a second — the same key, on the same
     * screen, meaning two different things depending on an architectural detail
     * nobody using it can see. The confirmation is now universal, so one press
     * shows the prompt and ends nothing.
     */
    press(trigger, 'Escape');
    expect(onexit).not.toHaveBeenCalled();

    press(trigger, 'Escape');
    expect(onexit).toHaveBeenCalledTimes(1);
  });
});

describe('a key aimed at the stage', () => {
  /*
   * The app shortcut layer calls `preventDefault()` on every key it resolves,
   * and Live then delegates Space and Escape to the stage deliberately. A guard
   * that stood down for an already-prevented event silenced both.
   */
  it('is answered even after the shortcut layer has claimed it', () => {
    const { onintent, onexit } = mount();

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    space.preventDefault(); // what `emit()` does before this handler ever runs
    window.dispatchEvent(space);

    for (const _ of [1, 2]) {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      escape.preventDefault();
      window.dispatchEvent(escape);
    }

    expect(onintent).toHaveBeenCalledWith({ kind: 'toggle_pause' });
    expect(onexit).toHaveBeenCalledTimes(1);
  });

  it('stands the whole keyboard down while chrome is open', () => {
    const { onintent, onexit } = mount(true);

    press(window, ' ');
    press(window, 'Escape');
    press(window, 'ArrowDown');

    expect(onintent).not.toHaveBeenCalled();
    expect(onexit).not.toHaveBeenCalled();
  });
});
