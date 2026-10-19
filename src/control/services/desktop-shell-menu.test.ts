/**
 * A native menu command acts on the window it was addressed to, and no other.
 *
 * `menu.rs` delivers each command with `emit_to(label, …)`, but whether that is
 * honoured is decided by what the WEBVIEW registered: a listener whose target
 * is `Any` hears every `emit_to`, whatever label it named. With both windows
 * listening that way, ⌘W over Settings closed Settings and also closed the
 * script in the editor behind it (#265).
 *
 * These tests drive the real `@tauri-apps/api` against a fake
 * `__TAURI_INTERNALS__` that records each `plugin:event|listen` registration,
 * then deliver events by Tauri 2.11.5's own rule. A global `listen()` fails
 * them; only a window-scoped one passes.
 *
 * NOT PROVEN HERE: that `menu.rs::command_target` picks the right label, and
 * that the native runtime matches targets the way `hears` transcribes. Both
 * need two real windows and a real menu bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MENU_COMMAND_EVENT } from '../../shared/contracts/commands';
import type { CommandActions, CommandContext } from '../lib/commands';
import { installMenuCommands, installWindowMenuCommands } from './desktop-shell';

type ListenerTarget = { kind: string; label?: string };

interface Registration {
  event: string;
  target: ListenerTarget;
  handler: number;
  eventId: number;
}

/**
 * Whether a JS listener registered with `target` hears `emit_to(label, …)`.
 *
 * Transcribed from tauri 2.11.5: `event/listener.rs::match_any_or_filter` lets
 * an `Any` listener hear everything, and `manager/mod.rs::filter_target` matches
 * a label against a `Window`, `Webview`, `WebviewWindow` or `AnyLabel` listener
 * carrying that same label.
 */
function hears(target: ListenerTarget, label: string): boolean {
  if (target.kind === 'Any') return true;
  return (
    ['Window', 'Webview', 'WebviewWindow', 'AnyLabel'].includes(target.kind) &&
    target.label === label
  );
}

/** The slice of the Tauri runtime the event API touches. */
function fakeRuntime() {
  const callbacks = new Map<number, (event: unknown) => void>();
  const registrations: Registration[] = [];
  let nextId = 1;
  let label = 'control';
  let gate: Promise<void> | null = null;

  const internals = {
    metadata: {
      get currentWindow() {
        return { label };
      },
      get currentWebview() {
        return { label, windowLabel: label };
      },
    },
    transformCallback(callback: (event: unknown) => void): number {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
      if (command === 'plugin:event|listen') {
        const eventId = nextId++;
        registrations.push({
          event: args.event as string,
          target: args.target as ListenerTarget,
          handler: args.handler as number,
          eventId,
        });
        if (gate) await gate;
        return eventId;
      }
      if (command === 'plugin:event|unlisten') {
        const at = registrations.findIndex((r) => r.eventId === args.eventId);
        if (at >= 0) registrations.splice(at, 1);
        return null;
      }
      throw new Error(`the fake runtime does not answer ${command}`);
    },
  };

  return {
    internals,
    registrations,
    /** Which window the next install runs in, as its webview metadata says. */
    setWindow(next: string): void {
      label = next;
    },
    /** Hold every `listen` reply until the returned release is called. */
    holdRegistrations(): () => void {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    /** `AppHandle::emit_to(label, event, payload)`, as the webviews see it. */
    emitTo(target: string, event: string, payload: unknown): void {
      for (const r of [...registrations]) {
        if (r.event === event && hears(r.target, target)) {
          callbacks.get(r.handler)?.({ event, id: r.eventId, payload });
        }
      }
    },
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    route: { name: 'editor', scriptId: 'script-1' },
    sessionActive: false,
    stageRigResolved: false,
    sessionPaused: false,
    stageBlanked: false,
    stageMirrored: false,
    scriptOpen: true,
    saveState: 'idle',
    editorHasUnsavedWork: false,
    librarySelectionId: null,
    libraryInTrash: false,
    sidebarVisible: true,
    outlineVisible: true,
    editorLayout: 'edit',
    takeStarting: false,
    ...overrides,
  };
}

/** An actions object that records which method was called. */
function recordingActions(): { calls: string[]; actions: CommandActions } {
  const calls: string[] = [];
  const actions = new Proxy({} as CommandActions, {
    get: (_target, property: string) => () => {
      calls.push(property);
    },
  });
  return { calls, actions };
}

let runtime: ReturnType<typeof fakeRuntime>;
let teardowns: Array<() => void>;

/** Install in the named window and wait until its listener is registered. */
async function inWindow(label: string, install: () => () => void): Promise<() => void> {
  const before = runtime.registrations.length;
  runtime.setWindow(label);
  const teardown = install();
  teardowns.push(teardown);
  await vi.waitFor(() => expect(runtime.registrations.length).toBe(before + 1));
  return teardown;
}

beforeEach(() => {
  runtime = fakeRuntime();
  teardowns = [];
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: runtime.internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
});

afterEach(() => {
  for (const teardown of teardowns) teardown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('each window listens for the menu commands addressed to it', () => {
  it('registers against its own label rather than Any', async () => {
    await inWindow('control', () => installMenuCommands(context, () => recordingActions().actions));
    await inWindow('preferences', () => installWindowMenuCommands({}));

    expect(runtime.registrations.map((r) => [r.event, r.target])).toEqual([
      [MENU_COMMAND_EVENT, { kind: 'WebviewWindow', label: 'control' }],
      [MENU_COMMAND_EVENT, { kind: 'WebviewWindow', label: 'preferences' }],
    ]);
  });

  describe('with the document window and Settings both open', () => {
    let control: ReturnType<typeof recordingActions>;
    let settings: Record<string, ReturnType<typeof vi.fn>>;

    beforeEach(async () => {
      control = recordingActions();
      settings = {
        'file.close-script': vi.fn(),
        'edit.find': vi.fn(),
        'window.main': vi.fn(),
        'help.reveal-logs': vi.fn(),
      };
      await inWindow('control', () => installMenuCommands(context, () => control.actions));
      await inWindow('preferences', () => installWindowMenuCommands(settings));
    });

    it('⌘W over Settings closes Settings and leaves the script open', () => {
      runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 'file.close-script' });

      expect(settings['file.close-script']).toHaveBeenCalledTimes(1);
      expect(control.calls).toEqual([]);
    });

    it('⌘W in the editor closes the script and leaves Settings open', () => {
      runtime.emitTo('control', MENU_COMMAND_EVENT, { id: 'file.close-script' });

      expect(control.calls).toEqual(['closeScript']);
      expect(settings['file.close-script']).not.toHaveBeenCalled();
    });

    it('⌘F in Settings does not open the editor search', () => {
      runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 'edit.find' });

      expect(settings['edit.find']).toHaveBeenCalledTimes(1);
      expect(control.calls).toEqual([]);
    });

    it('Reveal Logs from Settings reveals the folder once', () => {
      runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 'help.reveal-logs' });

      expect(settings['help.reveal-logs']).toHaveBeenCalledTimes(1);
      expect(control.calls).toEqual([]);
    });

    it('a window command pressed over the stage still reaches the document window', () => {
      /* Over the stage, `command_target` forwards the context-free commands to
         control by name. That is an `emit_to('control')` like any other, so a
         window-scoped listener must still hear it — and Settings must not. */
      runtime.emitTo('control', MENU_COMMAND_EVENT, { id: 'window.main' });

      expect(control.calls).toEqual(['showMainWindow']);
      expect(settings['window.main']).not.toHaveBeenCalled();
    });
  });
});

describe('the document window', () => {
  it('reads its context when the command arrives, not when it was installed', async () => {
    const { calls, actions } = recordingActions();
    let current = context();
    await inWindow('control', () => installMenuCommands(() => current, () => actions));

    runtime.emitTo('control', MENU_COMMAND_EVENT, { id: 'file.close-script' });
    current = context({ route: { name: 'library', view: 'all' }, scriptOpen: false });
    runtime.emitTo('control', MENU_COMMAND_EVENT, { id: 'file.close-script' });

    expect(calls).toEqual(['closeScript', 'closeWindow']);
  });

  it('ignores an id this build does not know', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, actions } = recordingActions();
    await inWindow('control', () => installMenuCommands(context, () => actions));

    runtime.emitTo('control', MENU_COMMAND_EVENT, { id: 'file.from-the-future' });
    runtime.emitTo('control', MENU_COMMAND_EVENT, {});

    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('the Settings window', () => {
  it('answers only what it has a handler for', async () => {
    const close = vi.fn();
    await inWindow('preferences', () => installWindowMenuCommands({ 'file.close-script': close }));

    runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 'insert.link' });
    runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 42 });
    expect(close).not.toHaveBeenCalled();

    runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 'file.close-script' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('the menu chords, heard by the page', () => {
  /*
   * Off macOS the native bar cannot always hear its own keys — never on
   * WebView2, and on GTK not while a take hides the bar or in Settings, which
   * has none — so `installWindowMenuCommands` also listens for them in the page
   * (`lib/menu-keys.ts`). On macOS the application menu takes every chord
   * first and a second listener would run each command twice.
   */
  function asPlatform(platform: string, run: () => Promise<void>): Promise<void> {
    const pinned = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    return run().finally(() => {
      if (pinned) Object.defineProperty(navigator, 'platform', pinned);
    });
  }

  /** A window that can be listened on, and a way to press a chord at it. */
  function keyedWindow() {
    const listeners = new Set<(event: unknown) => void>();
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: runtime.internals,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener),
    });
    return (key: string) => {
      const event = {
        key,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        preventDefault() {},
        stopImmediatePropagation() {},
      };
      for (const listener of listeners) listener(event);
    };
  }

  it.each([
    ['Linux x86_64', 1],
    ['Win32', 1],
    ['MacIntel', 0],
  ])('on %s, Ctrl+W in Settings runs its Close %i time(s)', async (platform, runs) => {
    await asPlatform(platform, async () => {
      const press = keyedWindow();
      const close = vi.fn();
      await inWindow('preferences', () => installWindowMenuCommands({ 'file.close-script': close }));

      press('w');
      expect(close).toHaveBeenCalledTimes(runs);
    });
  });
});

describe('teardown', () => {
  it('stops listening', async () => {
    const close = vi.fn();
    const teardown = await inWindow('preferences', () =>
      installWindowMenuCommands({ 'file.close-script': close }),
    );

    teardown();
    await vi.waitFor(() => expect(runtime.registrations).toEqual([]));
    runtime.emitTo('preferences', MENU_COMMAND_EVENT, { id: 'file.close-script' });

    expect(close).not.toHaveBeenCalled();
  });

  it('still unregisters when it runs before the listener is registered', async () => {
    /* The window can unmount while `listen` is still in flight. The listener
       that lands afterwards belongs to nobody and must be removed on arrival. */
    const release = runtime.holdRegistrations();
    const { calls, actions } = recordingActions();
    runtime.setWindow('control');
    const teardown = installMenuCommands(context, () => actions);
    await vi.waitFor(() => expect(runtime.registrations).toHaveLength(1));

    teardown();
    release();
    await vi.waitFor(() => expect(runtime.registrations).toEqual([]));
    runtime.emitTo('control', MENU_COMMAND_EVENT, { id: 'file.close-script' });

    expect(calls).toEqual([]);
  });
});
