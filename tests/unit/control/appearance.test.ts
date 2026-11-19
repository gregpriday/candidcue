/**
 * The desk follows the system's light or dark appearance (issue #231).
 *
 * `followSystemAppearance` is the one seam: it writes `data-appearance` on the
 * root before first paint, and `tokens.css` retunes the workspace palette
 * under it. These pin what the windows rely on — the answer is there at once,
 * it moves when the system does, it stops moving once the window lets go of
 * it, and a host that cannot be asked gets the light desk. That both windows
 * actually call it is `tests/e2e/browser/desk-dark-appearance.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followSystemAppearance, systemAppearance } from '../../../src/control/lib/appearance';

type Listener = (event: MediaQueryListEvent) => void;

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * A system whose appearance the test can change. Each `matchMedia` call gets
 * a list of its own, answering only its own query, as a browser's does: a
 * subscription to the wrong query, or a release made on a different list
 * than the one subscribed to, shows up as a listener that never fires or
 * never leaves.
 */
function fakeSystem(initiallyDark: boolean) {
  const lists: { query: string; listeners: Set<Listener> }[] = [];
  let dark = initiallyDark;
  const answers = (query: string) => query === DARK_QUERY && dark;
  const matchMedia = (query: string) => {
    const listeners = new Set<Listener>();
    lists.push({ query, listeners });
    return {
      get matches() {
        return answers(query);
      },
      media: query,
      addEventListener: (type: string, listener: Listener) => {
        if (type === 'change') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: Listener) => {
        if (type === 'change') listeners.delete(listener);
      },
    };
  };
  vi.stubGlobal('window', { matchMedia });
  return {
    get queries() {
      return lists.map((list) => list.query);
    },
    /** Listeners still subscribed, across every list handed out. */
    get subscribed() {
      return lists.reduce((sum, list) => sum + list.listeners.size, 0);
    },
    setDark(next: boolean) {
      dark = next;
      for (const list of lists) {
        for (const listener of [...list.listeners]) {
          listener({ matches: answers(list.query), media: list.query } as MediaQueryListEvent);
        }
      }
    },
  };
}

function fakeRoot(): HTMLElement {
  return { dataset: {} } as unknown as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('systemAppearance', () => {
  it('asks the colour-scheme question', () => {
    const system = fakeSystem(true);
    expect(systemAppearance()).toBe('dark');
    expect(system.queries).toEqual(['(prefers-color-scheme: dark)']);
  });

  it('reports light when the system is light', () => {
    fakeSystem(false);
    expect(systemAppearance()).toBe('light');
  });

  it('falls back to light where there is no window to ask', () => {
    expect(typeof window).toBe('undefined');
    expect(systemAppearance()).toBe('light');
  });

  it('falls back to light where the window cannot answer media queries', () => {
    vi.stubGlobal('window', {});
    expect(systemAppearance()).toBe('light');
  });
});

describe('followSystemAppearance', () => {
  it('puts the system appearance on the root before anything else runs', () => {
    fakeSystem(true);
    const root = fakeRoot();
    followSystemAppearance(root);
    expect(root.dataset['appearance']).toBe('dark');
  });

  it('follows the system as it changes, both ways', () => {
    const system = fakeSystem(false);
    const root = fakeRoot();
    followSystemAppearance(root);
    expect(root.dataset['appearance']).toBe('light');

    system.setDark(true);
    expect(root.dataset['appearance']).toBe('dark');

    system.setDark(false);
    expect(root.dataset['appearance']).toBe('light');
  });

  it('stops following once released, and leaves its listener behind nowhere', () => {
    const system = fakeSystem(false);
    const root = fakeRoot();
    const stop = followSystemAppearance(root);
    expect(system.subscribed).toBe(1);

    stop();
    expect(system.subscribed).toBe(0);

    system.setDark(true);
    expect(root.dataset['appearance']).toBe('light');
  });

  it('gives the root the light desk where there is no window at all', () => {
    expect(typeof window).toBe('undefined');
    const root = fakeRoot();
    const stop = followSystemAppearance(root);
    expect(root.dataset['appearance']).toBe('light');
    expect(() => stop()).not.toThrow();
  });

  it('still gives the root the light desk where the system cannot be asked', () => {
    vi.stubGlobal('window', {});
    const root = fakeRoot();
    const stop = followSystemAppearance(root);
    expect(root.dataset['appearance']).toBe('light');
    expect(() => stop()).not.toThrow();
  });
});
