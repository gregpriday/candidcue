/**
 * "Where will this take open?" — the question the product could not answer
 * (CCUX-004, CCUX-005).
 *
 * Settings named a panel called "Stage display", which is the panel used for
 * calibration, preview and display tests. Single-window presentation fills
 * whichever monitor the CONTROL WINDOW is on. Those are different panels, and a
 * user who chose and calibrated one, then pressed Present from the other, got
 * behaviour that follows the architecture exactly and contradicts everything
 * the interface had told them.
 *
 * What is pinned here is mostly about restraint: when the resolver must speak,
 * and — more importantly — when it must stay quiet. A mismatch notice that
 * fires on ordinary healthy setups is worse than none, because it gets ignored
 * on the day it is right.
 */
import { describe, expect, it } from 'vitest';
import {
  displayName,
  destinationAnnouncement,
  resolveTakeDestination,
  type TakeDestinationInput,
} from '../../../src/control/lib/take-destination';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';

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

const BUILT_IN = display({ fingerprint: 'builtin', name: 'Built-in Retina Display', primary: true });
const DELL = display({ fingerprint: 'dell', name: 'Dell 24-inch' });

/** A rig is a MEASURED optical profile in force, not a selected panel. */
function rig(display = BUILT_IN, rigName = 'Studio desk rig') {
  return { display, rigName };
}

function input(over: Partial<TakeDestinationInput> = {}): TakeDestinationInput {
  return {
    mode: 'prompter',
    currentDisplay: BUILT_IN,
    calibratedRigs: [rig()],
    ...over,
  };
}

describe('resolveTakeDestination', () => {
  it('names the panel the window is actually on', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: DELL, calibratedRigs: [rig(DELL)] }),
    );
    expect(destination.summary).toContain('Dell 24-inch');
    expect(destination.confidence).toBe('known');
    expect(destination.mismatch).toBeNull();
  });

  it('does not pretend to know a panel it cannot name', () => {
    // The honest answer is that the take fills this window's display, whichever
    // that turns out to be. Substituting the calibrated panel here would be the
    // original bug wearing a more confident face.
    const destination = resolveTakeDestination(input({ currentDisplay: null }));
    expect(destination.confidence).toBe('unknown');
    expect(destination.summary).not.toContain('Built-in');
    expect(destination.summary).toMatch(/this window/i);
  });

  /* -------------------------------------------------------------------- *
   * CCUX-005 — the mismatch, and the many times it must stay quiet
   * -------------------------------------------------------------------- */

  it('says so when the take opens away from the calibrated rig', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: BUILT_IN, calibratedRigs: [rig(DELL, 'Elgato rig')] }),
    );
    const mismatch = destination.mismatch;
    expect(mismatch).not.toBeNull();
    // All three facts the guide asks for: where it IS going, what the rig is
    // calibrated for, and the action.
    expect(mismatch!.title).toContain('Built-in Retina Display');
    expect(mismatch!.detail).toContain('Dell 24-inch');
    expect(mismatch!.detail).toContain('Elgato rig');
    expect(mismatch!.suggestion).toMatch(/drag/i);
  });

  it('offers carrying on, because presenting where the window is, is supported', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: BUILT_IN, calibratedRigs: [rig(DELL)] }),
    );
    // Deliberately not an error. `windows/present.rs` fills the window's own
    // monitor on purpose — teleporting it would take the app away from the
    // person driving it — so this is information, not a fault.
    expect(destination.mismatch!.suggestion).toMatch(/or carry on/i);
  });

  it('stays quiet when the window is already on the calibrated panel', () => {
    expect(resolveTakeDestination(input()).mismatch).toBeNull();
  });

  it('does not treat a merely SELECTED panel as a calibrated rig', () => {
    /*
     * `settings.stage.displayFingerprint` picks the panel used for previews,
     * display tests and calibration. It says nothing about whether anything was
     * ever measured. Reading it as "the calibrated rig" warned people who had
     * calibrated nothing at all that their non-existent rig was set up
     * elsewhere — so the input is a list of MEASURED rigs, and an empty list
     * means silence however many panels are pinned.
     */
    expect(resolveTakeDestination(input({ currentDisplay: DELL, calibratedRigs: [] })).mismatch)
      .toBeNull();
  });

  it('counts other calibrated displays when there is more than one', () => {
    const destination = resolveTakeDestination(
      input({
        currentDisplay: BUILT_IN,
        calibratedRigs: [rig(DELL, 'Elgato rig'), rig(display({ fingerprint: 'third', name: 'LG' }), 'Studio')],
      }),
    );
    expect(destination.mismatch!.detail).toMatch(/1 other calibrated display\b/);
  });

  it('stays quiet when nothing is calibrated at all', () => {
    // Display-based defaults are the ordinary case for a user with no glass.
    // Calling that a mismatch would nag every such user on every take.
    expect(resolveTakeDestination(input({ calibratedRigs: [] })).mismatch).toBeNull();
  });

  it('stays quiet when the current panel cannot be named', () => {
    // "This might be the wrong panel" is worse than saying nothing: a warning
    // that fires on uncertainty rather than on a known problem is the kind
    // people learn to dismiss.
    expect(
      resolveTakeDestination(input({ currentDisplay: null, calibratedRigs: [rig(DELL)] })).mismatch,
    ).toBeNull();
  });

  it('never warns a reading window about the wrong panel', () => {
    const destination = resolveTakeDestination(
      input({ mode: 'reader', currentDisplay: BUILT_IN, calibratedRigs: [rig(DELL)] }),
    );
    // A reader is placed by dragging it. Warning that it is on the "wrong"
    // display is warning about the thing the user just did on purpose.
    expect(destination.mismatch).toBeNull();
    expect(destination.confidence).toBe('window');
    expect(destination.summary).toMatch(/reading window/i);
  });

  it('falls back to a rig-neutral phrase when the rig has no name', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: BUILT_IN, calibratedRigs: [rig(DELL, '   ')] }),
    );
    expect(destination.mismatch!.detail).toMatch(/^a rig|\ba rig\b/i);
    // No empty quotes left behind by a blank name.
    expect(destination.mismatch!.detail).not.toContain('““');
    expect(destination.mismatch!.detail).not.toContain('“”');
  });
});

describe('displayName', () => {
  it('distinguishes the main display from a second one when unnamed', () => {
    expect(displayName(display({ fingerprint: 'a', name: undefined, primary: true }))).toMatch(
      /main/i,
    );
    expect(displayName(display({ fingerprint: 'b', name: undefined, primary: false }))).toMatch(
      /second/i,
    );
    // A whitespace-only name from the OS must not render as an empty label.
    expect(displayName(display({ fingerprint: 'c', name: '  ', primary: true }))).toMatch(/main/i);
  });

  it('says so plainly when there is no display at all', () => {
    expect(displayName(null)).toMatch(/unknown/i);
  });
});

describe('destinationAnnouncement', () => {
  it('drops the visual separators and keeps the mismatch', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: BUILT_IN, calibratedRigs: [rig(DELL)] }),
    );
    const spoken = destinationAnnouncement(destination);
    expect(spoken).not.toContain('·');
    expect(spoken).toContain('Built-in Retina Display');
    /*
     * The WHOLE mismatch, not just its title. A sighted user gets the
     * explanation from a tooltip the colour change invites them to hover; a
     * screen-reader user gets no such invitation, and a title that only repeats
     * the destination would say something is wrong without saying what.
     */
    expect(spoken).toContain('Dell 24-inch');
    expect(spoken).toMatch(/drag/i);
  });

  it('says only the destination when there is no mismatch', () => {
    const spoken = destinationAnnouncement(resolveTakeDestination(input()));
    expect(spoken).not.toContain('·');
    expect(spoken).not.toMatch(/calibrated for/i);
  });
});
