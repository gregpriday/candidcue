/**
 * Workspace layout parsing.
 *
 * `localStorage` is the one input to this application that no schema check
 * protects: it is user-writable, it survives a downgrade, and it is read before
 * anything is painted. A stored width of 40000 is a workspace with no workspace
 * in it, and a stored `NaN` is a layout that never lays out — so the parser
 * treats what it finds as a suggestion, and these tests are the proof.
 *
 * It is also written by TWO windows — control and Settings — each holding the
 * copy it loaded at startup. The last block here is the proof that a write in
 * one carries only what that window changed (#274).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  DEFAULT_WORKSPACE,
  DOCUMENT_SCALE_STEPS,
  PANE_LIMITS,
  clamp,
  nearestScaleStep,
  parseWorkspace,
} from './workspace';

describe('parseWorkspace', () => {
  it('returns the defaults for nothing stored', () => {
    expect(parseWorkspace(null)).toEqual(DEFAULT_WORKSPACE);
  });

  it('returns the defaults for text that is not JSON', () => {
    expect(parseWorkspace('{oh no')).toEqual(DEFAULT_WORKSPACE);
  });

  it('returns the defaults for JSON that is not an object', () => {
    expect(parseWorkspace('"a string"')).toEqual(DEFAULT_WORKSPACE);
    expect(parseWorkspace('null')).toEqual(DEFAULT_WORKSPACE);
    expect(parseWorkspace('42')).toEqual(DEFAULT_WORKSPACE);
  });

  it('keeps values that are within range', () => {
    const parsed = parseWorkspace(
      JSON.stringify({ sidebarWidth: 300, outlineWidth: 320, sidebarVisible: false }),
    );
    expect(parsed.sidebarWidth).toBe(300);
    expect(parsed.outlineWidth).toBe(320);
    expect(parsed.sidebarVisible).toBe(false);
  });

  it('drops the retired diagnosticsVisible flag and keeps everything stored beside it', () => {
    // Written by builds that had View › Show Diagnostics. The pane it toggled
    // never rendered during a take, so the flag went with the menu item.
    const parsed = parseWorkspace(
      JSON.stringify({ diagnosticsVisible: false, outlineVisible: false, diagnosticsWidth: 320 }),
    );
    expect(parsed).not.toHaveProperty('diagnosticsVisible');
    expect(parsed.outlineVisible).toBe(false);
    expect(parsed.diagnosticsWidth).toBe(320);
  });

  it('clamps a width past its pane maximum', () => {
    const parsed = parseWorkspace(JSON.stringify({ sidebarWidth: 40000 }));
    expect(parsed.sidebarWidth).toBe(PANE_LIMITS.sidebar.max);
  });

  it('clamps a width below its pane minimum', () => {
    const parsed = parseWorkspace(JSON.stringify({ sidebarWidth: -12 }));
    expect(parsed.sidebarWidth).toBe(PANE_LIMITS.sidebar.min);
  });

  it('falls back for a width that is not finite', () => {
    // `JSON.stringify(NaN)` is `null`, which is the shape this actually arrives
    // in — a store written by a build where a division went wrong.
    const parsed = parseWorkspace('{"sidebarWidth": null, "outlineWidth": "wide"}');
    expect(parsed.sidebarWidth).toBe(DEFAULT_WORKSPACE.sidebarWidth);
    expect(parsed.outlineWidth).toBe(DEFAULT_WORKSPACE.outlineWidth);
  });

  it('rejects an editor layout it does not recognise', () => {
    expect(parseWorkspace('{"editorLayout": "three-up"}').editorLayout).toBe(
      DEFAULT_WORKSPACE.editorLayout,
    );
    expect(parseWorkspace('{"editorLayout": "split"}').editorLayout).toBe('split');
  });

  it('snaps a document scale onto a real step', () => {
    // A value between two steps came from somewhere else; snapping means the
    // next Larger/Smaller press lands on a step rather than appearing to do
    // nothing.
    expect(parseWorkspace('{"documentScale": 1.07}').documentScale).toBe(1.1);
    expect(parseWorkspace('{"documentScale": 99}').documentScale).toBe(
      DOCUMENT_SCALE_STEPS[DOCUMENT_SCALE_STEPS.length - 1],
    );
  });

  it('refuses an absurd settings section', () => {
    expect(parseWorkspace('{"settingsSection": ""}').settingsSection).toBe('general');
    expect(parseWorkspace(`{"settingsSection": "${'x'.repeat(200)}"}`).settingsSection).toBe(
      'general',
    );
    expect(parseWorkspace('{"settingsSection": "speech"}').settingsSection).toBe('speech');
  });

  it('ignores a boolean stored as something else', () => {
    expect(parseWorkspace('{"sidebarVisible": "yes"}').sidebarVisible).toBe(true);
    expect(parseWorkspace('{"sidebarVisible": 0}').sidebarVisible).toBe(true);
  });

  it('produces a state every field of the default has', () => {
    // A partial store must not produce a partial state: a missing key here is a
    // pane with an `undefined` width, which lays out as zero.
    const parsed = parseWorkspace('{"sidebarWidth": 240}');
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_WORKSPACE).sort());
  });
});

describe('clamp', () => {
  it('substitutes the fallback for a non-finite value', () => {
    expect(clamp(Number.NaN, 0, 10, 5)).toBe(5);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10, 5)).toBe(5);
  });

  it('bounds a finite value', () => {
    expect(clamp(-1, 0, 10, 5)).toBe(0);
    expect(clamp(11, 0, 10, 5)).toBe(10);
    expect(clamp(7, 0, 10, 5)).toBe(7);
  });
});

describe('nearestScaleStep', () => {
  it('returns a value from the step table', () => {
    for (const value of [0.1, 0.9, 1, 1.05, 1.3, 4]) {
      expect(DOCUMENT_SCALE_STEPS).toContain(nearestScaleStep(value));
    }
  });

  it('leaves a value that is already a step alone', () => {
    for (const step of DOCUMENT_SCALE_STEPS) {
      expect(nearestScaleStep(step)).toBe(step);
    }
  });
});

/*
 * TWO WINDOWS, ONE KEY.
 *
 * The control window and the Settings window are two webviews of one origin, so
 * they share `localStorage` — and each evaluates this module for itself, loading
 * its own copy once and never refreshing it. Here a window is a fresh module
 * instance (`vi.resetModules` before each import) over one shared storage, which
 * is exactly that arrangement without a DOM.
 */
describe('two windows writing one workspace', () => {
  const KEY = 'candidcue.workspace.v1';

  type WorkspaceModule = typeof import('./workspace');

  function sharedStorage() {
    const items = new Map<string, string>();
    return {
      getItem: (key: string): string | null => items.get(key) ?? null,
      setItem: (key: string, value: string): void => void items.set(key, String(value)),
      removeItem: (key: string): void => void items.delete(key),
      clear: (): void => items.clear(),
      key: (index: number): string | null => [...items.keys()][index] ?? null,
      get length(): number {
        return items.size;
      },
    };
  }

  let disk: ReturnType<typeof sharedStorage>;

  /** Open a window: evaluate the store module again, as a new webview does. */
  async function openWindow(): Promise<WorkspaceModule> {
    vi.resetModules();
    return import('./workspace');
  }

  function stored(): Record<string, unknown> {
    const raw = disk.getItem(KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    disk = sharedStorage();
    vi.stubGlobal('localStorage', disk);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps what both windows changed through the sequence the issue reports', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    settings.updateWorkspace({ settingsSection: 'audio' });
    vi.advanceTimersByTime(250);
    expect(stored()).toMatchObject({ settingsSection: 'audio', editorLayout: 'edit' });

    // The editor's switch to Preview used to put back `general`, the section
    // this window loaded with.
    control.updateWorkspace({ editorLayout: 'preview' });
    vi.advanceTimersByTime(250);
    expect(stored()).toMatchObject({ settingsSection: 'audio', editorLayout: 'preview' });

    // And the next Settings click used to put back `edit`.
    settings.updateWorkspace({ settingsSection: 'teleprompter' });
    vi.advanceTimersByTime(250);
    expect(stored()).toMatchObject({ settingsSection: 'teleprompter', editorLayout: 'preview' });
  });

  it('reopens Settings where it was left after a main-window layout change (§14.4)', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();
    control.setPaneWidth('sidebar', 300);
    vi.advanceTimersByTime(250);

    // ⌘, names no section, so the window that opens reads what is stored.
    const reopened = await openWindow();
    expect(get(reopened.workspace).settingsSection).toBe('audio');
    expect(get(reopened.workspace).sidebarWidth).toBe(300);
  });

  it('merges a write still waiting on the debounce over what landed meanwhile', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    control.updateWorkspace({ sidebarVisible: false });
    // Past the pane's maximum: the clamp has to reach the patch, because the
    // merge parses only the STORED side.
    control.setPaneWidth('editorOutline', 9999);
    settings.updateWorkspace({ settingsSection: 'speech' });
    settings.flushWorkspace();

    vi.advanceTimersByTime(249);
    expect(stored()).toMatchObject({ settingsSection: 'speech', sidebarVisible: true });
    vi.advanceTimersByTime(1);
    expect(stored()).toMatchObject({
      settingsSection: 'speech',
      sidebarVisible: false,
      outlineWidth: PANE_LIMITS.editorOutline.max,
    });
    expect(get(control.workspace).outlineWidth).toBe(PANE_LIMITS.editorOutline.max);
  });

  it('never moves the live layout of the other window', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    control.updateWorkspace({ editorLayout: 'split' });
    settings.updateWorkspace({ settingsSection: 'audio' });
    vi.advanceTimersByTime(250);

    expect(stored()).toMatchObject({ editorLayout: 'split', settingsSection: 'audio' });
    expect(get(control.workspace).settingsSection).toBe('general');
    expect(get(settings.workspace).editorLayout).toBe('edit');
  });

  it('writes a field it was asked to even when its own copy already held that value', async () => {
    // A changed field is one NAMED in a patch, not one that differs from this
    // window's copy — that copy is stale. "Settings › General" from the main
    // window has to land over the Audio that Settings stored since.
    const control = await openWindow();
    const settings = await openWindow();

    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();
    control.updateWorkspace({ settingsSection: 'general' });
    control.flushWorkspace();

    expect(stored().settingsSection).toBe('general');
  });

  it('does not replay a field it already wrote over a newer one', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    // Written by the debounce rather than a flush: both have to let go of
    // what they wrote.
    control.updateWorkspace({ settingsSection: 'privacy' });
    vi.advanceTimersByTime(250);
    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();
    control.updateWorkspace({ outlineVisible: false });
    vi.advanceTimersByTime(250);

    expect(stored()).toMatchObject({ settingsSection: 'audio', outlineVisible: false });
  });

  it('steps the document scale without carrying the rest of its own copy', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();

    control.stepDocumentScale(1);
    control.stepDocumentScale(1);
    vi.advanceTimersByTime(250);
    expect(stored()).toMatchObject({ documentScale: 1.25, settingsSection: 'audio' });

    control.stepDocumentScale(-1);
    vi.advanceTimersByTime(250);
    expect(stored()).toMatchObject({ documentScale: 1.1, settingsSection: 'audio' });

    control.stepDocumentScale(0);
    vi.advanceTimersByTime(250);
    expect(stored()).toMatchObject({ documentScale: 1, settingsSection: 'audio' });
    expect(get(control.workspace).documentScale).toBe(1);
  });

  it('still steps from the nearest step when the live scale sits between two', async () => {
    // Loading snaps a stored scale, so only a scale set in THIS run can be
    // off-table — and stepping now reads it from the live copy.
    const control = await openWindow();
    control.updateWorkspace({ documentScale: 1.07 });

    control.stepDocumentScale(1);
    control.flushWorkspace();
    expect(get(control.workspace).documentScale).toBe(1.25);
    expect(stored().documentScale).toBe(1.25);
  });

  it('persists the later patch when a subscriber answers one with another', async () => {
    // Subscribers run inside `update`. Queued after notifying, the outer patch
    // landed over the one its subscriber made, and disk said Preview while the
    // screen said Both.
    const control = await openWindow();
    const stop = control.workspace.subscribe((current) => {
      if (current.editorLayout === 'preview') control.updateWorkspace({ editorLayout: 'split' });
    });

    control.updateWorkspace({ editorLayout: 'preview' });
    stop();
    control.flushWorkspace();

    expect(get(control.workspace).editorLayout).toBe('split');
    expect(stored().editorLayout).toBe('split');
  });

  it('flushes synchronously, so a window opened straight after reads the section', async () => {
    // `openSettingsWindow`: write, flush, then ask Rust for the window — which
    // mounts faster than the debounce.
    const control = await openWindow();
    const writes = vi.spyOn(disk, 'setItem');

    control.updateWorkspace({ settingsSection: 'privacy' });
    control.flushWorkspace();
    const settings = await openWindow();
    expect(get(settings.workspace).settingsSection).toBe('privacy');

    // The flush took the pending timer with it.
    vi.advanceTimersByTime(250);
    control.flushWorkspace();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('still lets a reset overwrite every field', async () => {
    const control = await openWindow();
    const settings = await openWindow();

    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();
    control.updateWorkspace({ editorLayout: 'preview' });
    control.flushWorkspace();

    control.resetWorkspace();
    control.flushWorkspace();
    expect(stored()).toEqual(DEFAULT_WORKSPACE);
  });

  it('repairs a stored value that fails the clamp rather than carrying it', async () => {
    const control = await openWindow();
    // Written after this window loaded — by a hand edit, or another build.
    disk.setItem(
      KEY,
      JSON.stringify({ sidebarWidth: 40000, settingsSection: 'audio', retiredFlag: true }),
    );

    control.updateWorkspace({ editorLayout: 'split' });
    control.flushWorkspace();

    expect(stored()).toMatchObject({
      sidebarWidth: PANE_LIMITS.sidebar.max,
      settingsSection: 'audio',
      editorLayout: 'split',
    });
    expect(stored()).not.toHaveProperty('retiredFlag');
  });

  it('writes nothing when the stored copy cannot be read', async () => {
    // Merging over defaults instead would reset every field the other window
    // owns, which is the bug this store just stopped having.
    const control = await openWindow();
    const settings = await openWindow();
    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();

    vi.spyOn(disk, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    control.updateWorkspace({ editorLayout: 'preview' });
    expect(() => control.flushWorkspace()).not.toThrow();
    vi.restoreAllMocks();

    expect(stored()).toMatchObject({ settingsSection: 'audio', editorLayout: 'edit' });
    expect(get(control.workspace).editorLayout).toBe('preview');

    // Once storage reads again, the abandoned patch stays abandoned.
    settings.updateWorkspace({ settingsSection: 'speech' });
    settings.flushWorkspace();
    control.updateWorkspace({ sidebarVisible: false });
    control.flushWorkspace();
    expect(stored()).toMatchObject({
      settingsSection: 'speech',
      editorLayout: 'edit',
      sidebarVisible: false,
    });
  });

  it('lays out from memory when there is no storage at all', async () => {
    vi.stubGlobal('localStorage', undefined);
    const control = await openWindow();

    control.updateWorkspace({ editorLayout: 'split' });
    expect(() => control.flushWorkspace()).not.toThrow();
    expect(get(control.workspace).editorLayout).toBe('split');
  });

  it('drops a patch whose write failed rather than retrying it later', async () => {
    // Kept for the next write, the abandoned section would land over whatever
    // Settings has stored since.
    const control = await openWindow();
    const settings = await openWindow();

    vi.spyOn(disk, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    control.updateWorkspace({ settingsSection: 'privacy' });
    expect(() => control.flushWorkspace()).not.toThrow();

    settings.updateWorkspace({ settingsSection: 'audio' });
    settings.flushWorkspace();
    control.updateWorkspace({ outlineVisible: false });
    control.flushWorkspace();

    expect(stored()).toMatchObject({ settingsSection: 'audio', outlineVisible: false });
  });
});
