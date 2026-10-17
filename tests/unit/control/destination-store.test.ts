/**
 * The destination store end to end, through the IPC seam (#302).
 *
 * `take-destination.test.ts` pins what the resolver decides; this pins that the
 * store hands it the facts it decides from — in particular the pinned panel,
 * which it never read, so the line beside Present named the monitor the editor
 * was on while Present filled the pinned one, and the readiness sheet told the
 * operator to drag the window somewhere it was already going.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { setInvokeForTesting, type InvokeFn } from '../../../src/control/services/ipc';
import { defaultOpticalProfile, type OpticalProfile } from '../../../src/shared/contracts';
import { opticalRigKey, type OpticalSettings } from '../../../src/control/services/settings-types';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import { watchDisplayChanges } from '../../../src/control/services/stage';
import { refreshTakeDestination, takeDestination } from '../../../src/control/stores/destination';

function display(over: Partial<DisplayDescriptor> & { fingerprint: string }): DisplayDescriptor {
  return {
    id: over.fingerprint,
    name: 'A Panel',
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 2560, height: 1440 },
    scaleFactor: 2,
    logicalSize: { width: 1280, height: 720 },
    primary: false,
    topologyHash: 'topo',
    ...over,
  };
}

const STUDIO = display({ fingerprint: 'dsp-studio', name: 'Studio Display', primary: true });
const ELGATO = display({
  fingerprint: 'dsp-elgato',
  name: 'Elgato Prompter',
  physicalSize: { width: 1024, height: 600 },
  logicalSize: { width: 1024, height: 600 },
  scaleFactor: 1,
});

function rig(rigName: string): OpticalProfile {
  return {
    ...defaultOpticalProfile(),
    rigName,
    hardwareKind: 'elgato-prompter',
    scale: { mmPerCssPx: 0.19, source: 'model', diagonalMm: 228.6 },
    viewingDistanceMm: 1200,
    completedSteps: ['hardware', 'distance'],
  };
}

/** A rig calibrated on `fingerprint` AND chosen for it — the only kind in force. */
function chosenRig(fingerprint: string, rigName: string): OpticalSettings {
  return {
    profiles: { [opticalRigKey(fingerprint, rigName)]: rig(rigName) },
    activeRig: { [fingerprint]: rigName },
    panelMirror: {},
  };
}

/** Rust, as far as the store asks it anything. */
function backend(facts: { displays: DisplayDescriptor[]; window: DisplayDescriptor | null }) {
  const calls: string[] = [];
  const invoke: InvokeFn = async <T,>(command: string): Promise<T> => {
    calls.push(command);
    if (command === 'list_displays') return facts.displays as T;
    if (command === 'current_window_display') return facts.window as T;
    throw new Error(`unexpected command ${command}`);
  };
  setInvokeForTesting(invoke);
  return calls;
}

afterEach(() => {
  setInvokeForTesting(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refreshTakeDestination', () => {
  it('names the pinned panel, with no mismatch, when Present is pressed from the desk monitor', async () => {
    // The issue's scratch test, which returned "Teleprompter · Studio Display"
    // and a drag suggestion while the take landed on the Elgato.
    backend({ displays: [STUDIO, ELGATO], window: STUDIO });
    await refreshTakeDestination({
      mode: 'prompter',
      optical: chosenRig('dsp-elgato', 'Elgato rig'),
      pinnedFingerprint: 'dsp-elgato',
    });
    const destination = get(takeDestination);
    expect(destination?.summary).toBe('Teleprompter · Elgato Prompter');
    expect(destination?.mismatch).toBeNull();
  });

  it('names the window’s monitor when nothing is pinned', async () => {
    backend({ displays: [STUDIO, ELGATO], window: STUDIO });
    await refreshTakeDestination({ mode: 'prompter', optical: chosenRig('dsp-studio', 'Desk'), pinnedFingerprint: null });
    expect(get(takeDestination)?.summary).toBe('Teleprompter · Studio Display');
    expect(get(takeDestination)?.mismatch).toBeNull();
  });

  it('names the unplugged pin’s rig, which only the pinned fingerprint can find', async () => {
    // The Elgato is gone from the list, so no CONNECTED panel carries its rig —
    // the store has to read it under the pin to say what the take goes without.
    backend({ displays: [STUDIO], window: STUDIO });
    await refreshTakeDestination({
      mode: 'prompter',
      optical: chosenRig('dsp-elgato', 'Elgato rig'),
      pinnedFingerprint: 'dsp-elgato',
    });
    const destination = get(takeDestination);
    expect(destination?.summary).toBe('Teleprompter · Studio Display');
    expect(destination?.mismatch?.title).toMatch(/you chose is not connected/);
    expect(destination?.mismatch?.detail).toContain('“Elgato rig”');
  });

  /*
   * A reading take, which the store used to describe without reading the one
   * setting that decides where it goes: the remembered frame. Every reading
   * take rewrites it on the way out, so the line beside Present said "where
   * this window is" while Present was about to put the reader back on another
   * panel.
   */
  it('names the panel a remembered reading window is going back to', async () => {
    // STUDIO is 1280×720 logical at the origin; the Elgato sits to its right.
    const elgatoRight = { ...ELGATO, physicalPosition: { x: 1280, y: 0 } };
    backend({ displays: [STUDIO, elgatoRight], window: STUDIO });
    await refreshTakeDestination({
      mode: 'reader',
      optical: chosenRig('dsp-elgato', 'Elgato rig'),
      pinnedFingerprint: 'dsp-elgato',
      readerFrame: { x: 1400, y: 40, width: 600, height: 400 },
      restoreWindows: true,
    });
    const destination = get(takeDestination);
    expect(destination?.summary).toBe('Reading window · last position on Elgato Prompter');
    // A reader is placed by the person reading, so it is never a mismatch.
    expect(destination?.mismatch).toBeNull();
  });

  it('says a reading window opens here once "Restore windows" is turned off', async () => {
    backend({ displays: [STUDIO, { ...ELGATO, physicalPosition: { x: 1280, y: 0 } }], window: STUDIO });
    await refreshTakeDestination({
      mode: 'reader',
      readerFrame: { x: 1400, y: 40, width: 600, height: 400 },
      restoreWindows: false,
    });
    expect(get(takeDestination)?.summary).toBe('Reading window · opens here');

    // And back on, through the same partial update a settings change makes.
    await refreshTakeDestination({ restoreWindows: true });
    expect(get(takeDestination)?.summary).toBe('Reading window · last position on Elgato Prompter');
  });

  it('follows the frame when a take rewrites it', async () => {
    backend({ displays: [STUDIO, { ...ELGATO, physicalPosition: { x: 1280, y: 0 } }], window: STUDIO });
    await refreshTakeDestination({ mode: 'reader', readerFrame: null, restoreWindows: true });
    expect(get(takeDestination)?.summary).toBe('Reading window · opens here');

    await refreshTakeDestination({ readerFrame: { x: 100, y: 80, width: 600, height: 400 } });
    expect(get(takeDestination)?.summary).toBe('Reading window · last size and position');
  });

  it('names where a frame whose panel is unplugged will open', async () => {
    backend({ displays: [STUDIO], window: STUDIO });
    await refreshTakeDestination({
      mode: 'reader',
      readerFrame: { x: 1400, y: 40, width: 600, height: 400 },
      restoreWindows: true,
    });
    expect(get(takeDestination)?.summary).toBe('Reading window · opens on Studio Display');
  });

  it('asks Rust for the list and the window’s monitor once per refresh', async () => {
    const calls = backend({ displays: [STUDIO, ELGATO], window: STUDIO });
    await refreshTakeDestination({ mode: 'prompter', optical: chosenRig('dsp-elgato', 'r'), pinnedFingerprint: 'dsp-elgato' });
    expect(calls.sort()).toEqual(['current_window_display', 'list_displays']);
  });
});

describe('watchDisplayChanges', () => {
  it('coalesces a burst of focus events into one refresh, and stops on teardown', async () => {
    vi.useFakeTimers();
    // A window with no Tauri internals: the topology half is inert here, which
    // leaves focus as the one trigger under test.
    const target = new EventTarget();
    vi.stubGlobal('window', target);

    const handler = vi.fn();
    const stop = watchDisplayChanges(handler, { focus: true });
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(100);
    target.dispatchEvent(new Event('focus'));
    target.dispatchEvent(new Event('focus'));
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(handler).toHaveBeenCalledTimes(1);

    // A pending refresh does not outlive the teardown, and neither does the listener.
    target.dispatchEvent(new Event('focus'));
    stop();
    await vi.advanceTimersByTimeAsync(500);
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores focus unless asked to listen for it', async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal('window', target);

    const handler = vi.fn();
    const stop = watchDisplayChanges(handler);
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).not.toHaveBeenCalled();
    stop();
  });
});
