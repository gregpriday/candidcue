/**
 * The desk follows the system's light or dark appearance (issue #231).
 *
 * `followSystemAppearance` is the one seam: it writes `data-appearance` on the
 * root before first paint, and `tokens.css` retunes the workspace palette
 * under it. These pin what the windows rely on — the answer is there at once,
 * it moves when the system does, it stops moving once the window lets go of
 * it, and a host that cannot be asked gets the light desk.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followSystemAppearance, systemAppearance } from '../../../src/control/lib/appearance';

type Listener = (event: MediaQueryListEvent) => void;

/** A system whose appearance the test can change, with its listeners in view. */
function fakeSystem(initiallyDark: boolean) {
  const listeners = new Set<Listener>();
  const queries: string[] = [];
  let dark = initiallyDark;
  const matchMedia = (query: string) => {
    queries.push(query);
    return {
      get matches() {
        return dark;
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
    listeners,
    queries,
    setDark(next: boolean) {
      dark = next;
      for (const listener of [...listeners]) {
        listener({ matches: next } as MediaQueryListEvent);
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
    expect(system.listeners.size).toBe(1);

    stop();
    expect(system.listeners.size).toBe(0);

    system.setDark(true);
    expect(root.dataset['appearance']).toBe('light');
  });

  it('still gives the root the light desk where the system cannot be asked', () => {
    vi.stubGlobal('window', {});
    const root = fakeRoot();
    const stop = followSystemAppearance(root);
    expect(root.dataset['appearance']).toBe('light');
    expect(() => stop()).not.toThrow();
  });
});

/*
 * Both desk windows must apply it, before their first paint: a window that
 * forgets is a light window on a dark desk, which is the bug #231 describes.
 */
describe('the desk windows', () => {
  it.each([
    ['the control window', '../../../src/control/main.ts'],
    ['the Settings window', '../../../src/preferences/main.ts'],
  ])('%s follows the system appearance on its document root', (_name, path) => {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    expect(source).toMatch(/followSystemAppearance\(\s*document\.documentElement\s*\)/);
  });
});
