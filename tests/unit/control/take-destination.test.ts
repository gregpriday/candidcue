/**
 * "Where will this take open?" — the question the product could not answer
 * (CCUX-004, CCUX-005, #302).
 *
 * A prompter take fills the panel pinned in Settings when it is connected, and
 * the monitor the CONTROL WINDOW is on otherwise (`windows/present.rs`). Every
 * screen that says where a take opens asks `resolvePrompterDisplay`; the first
 * block below pins it to the cases Rust decides, because the screens drifted
 * from Rust once already and each got a different case wrong.
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
  findPinnedDisplay,
  resolvePrompterDisplay,
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
    displays: [BUILT_IN, DELL],
    pinnedFingerprint: null,
    calibratedRigs: [rig()],
    pinnedRigName: null,
    ...over,
  };
}

/* The issue's rig: the editor on a desk monitor, a 1024×600 panel behind glass. */
const STUDIO = display({ fingerprint: 'dsp-studio', name: 'Studio Display', primary: true });
const ELGATO = display({
  fingerprint: 'dsp-elgato',
  name: 'Elgato Prompter',
  physicalSize: { width: 1024, height: 600 },
  logicalSize: { width: 1024, height: 600 },
  scaleFactor: 1,
});

describe('resolvePrompterDisplay — Present’s own rule', () => {
  it('fills the pinned panel while it is connected, wherever the window is', () => {
    expect(
      resolvePrompterDisplay({ displays: [STUDIO, ELGATO], pinnedFingerprint: 'dsp-elgato', windowDisplay: STUDIO }),
    ).toEqual({ display: ELGATO, reason: 'pinned' });
  });

  it('fills the window’s monitor when nothing is pinned — never the external guess', () => {
    /*
     * `chooseStageDisplay` prefers a non-primary panel, and Welcome and the
     * Automatic tile used to describe Present with it: a first-run user with a
     * second monitor read that takes open THERE, pressed Present, and the
     * monitor in front of them became the prompter.
     */
    expect(
      resolvePrompterDisplay({ displays: [STUDIO, ELGATO], pinnedFingerprint: null, windowDisplay: STUDIO }),
    ).toEqual({ display: STUDIO, reason: 'unpinned' });
    expect(
      resolvePrompterDisplay({ displays: [STUDIO, ELGATO], pinnedFingerprint: '', windowDisplay: ELGATO }),
    ).toEqual({ display: ELGATO, reason: 'unpinned' });
  });

  it('falls back to the window’s monitor when the pinned panel is unplugged', () => {
    expect(
      resolvePrompterDisplay({ displays: [STUDIO], pinnedFingerprint: 'dsp-elgato', windowDisplay: STUDIO }),
    ).toEqual({ display: STUDIO, reason: 'pin-missing' });
  });

  it('stays unknown rather than guessing when the window’s monitor cannot be named', () => {
    expect(
      resolvePrompterDisplay({ displays: [STUDIO, ELGATO], pinnedFingerprint: null, windowDisplay: null }),
    ).toEqual({ display: null, reason: 'unpinned' });
    expect(
      resolvePrompterDisplay({ displays: [STUDIO], pinnedFingerprint: 'dsp-elgato', windowDisplay: null }),
    ).toEqual({ display: null, reason: 'pin-missing' });
  });
});

describe('findPinnedDisplay — Rust’s match_display_index', () => {
  const twinA = display({ fingerprint: 'dsp-0a1b2c3d4e5f6a7b', name: 'Twin' });
  const twinB = display({ fingerprint: 'dsp-0a1b2c3d4e5f6a7b-1', name: 'Twin' });

  it('takes an exact fingerprint before an identity match', () => {
    expect(findPinnedDisplay([twinA, twinB], 'dsp-0a1b2c3d4e5f6a7b-1')).toBe(twinB);
    expect(findPinnedDisplay([twinA, twinB], 'dsp-0a1b2c3d4e5f6a7b')).toBe(twinA);
  });

  it('keeps resolving a pin whose ordinal shifted when its twin was unplugged', () => {
    // Pinned as the second of two identical panels; the first is gone, so the
    // survivor is listed without the ordinal. Present still fills it.
    const survivor = display({ fingerprint: 'dsp-0a1b2c3d4e5f6a7b', name: 'Twin' });
    expect(findPinnedDisplay([STUDIO, survivor], 'dsp-0a1b2c3d4e5f6a7b-1')).toBe(survivor);
    expect(
      resolvePrompterDisplay({
        displays: [STUDIO, survivor],
        pinnedFingerprint: 'dsp-0a1b2c3d4e5f6a7b-1',
        windowDisplay: STUDIO,
      }).reason,
    ).toBe('pinned');
  });

  it('never reads the dsp- prefix as an ordinal', () => {
    expect(findPinnedDisplay([display({ fingerprint: 'dsp' })], 'dsp-123')).toBeNull();
    expect(findPinnedDisplay([STUDIO, ELGATO], 'dsp-elsewhere')).toBeNull();
  });

  it('finds nothing when nothing is pinned', () => {
    expect(findPinnedDisplay([STUDIO, ELGATO], null)).toBeNull();
    expect(findPinnedDisplay([STUDIO, ELGATO], '')).toBeNull();
  });
});

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
    // Choosing the rig's panel, not dragging the window: once a panel is
    // pinned, moving the editor changes nothing about where Present goes.
    expect(mismatch!.suggestion).toMatch(/choose Dell 24-inch/i);
    expect(mismatch!.suggestion).not.toMatch(/drag/i);
  });

  it('offers carrying on, because a take on an uncalibrated panel is still a take', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: BUILT_IN, calibratedRigs: [rig(DELL)] }),
    );
    // Deliberately not an error: the take opens and is sized from the panel it
    // lands on, so this is information, not a fault.
    expect(destination.mismatch!.suggestion).toMatch(/or carry on/i);
  });

  it('stays quiet when the window is already on the calibrated panel', () => {
    expect(resolveTakeDestination(input()).mismatch).toBeNull();
  });

  it('does not treat a merely PINNED panel as a calibrated rig', () => {
    /*
     * `settings.stage.displayFingerprint` picks where a prompter take opens.
     * It says nothing about whether anything was ever measured. Reading it as
     * "the calibrated rig" warned people who had calibrated nothing at all
     * that their non-existent rig was set up elsewhere — so the input is a
     * list of MEASURED rigs, and an empty list means silence however many
     * panels are pinned.
     */
    expect(
      resolveTakeDestination(input({ currentDisplay: BUILT_IN, pinnedFingerprint: 'dell', calibratedRigs: [] }))
        .mismatch,
    ).toBeNull();
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
      input({
        mode: 'reader',
        currentDisplay: BUILT_IN,
        // A pin, even an unplugged one, is a prompter's: a reader ignores it.
        pinnedFingerprint: 'gone',
        calibratedRigs: [rig(DELL)],
      }),
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

describe('resolveTakeDestination — the pinned panel (#302)', () => {
  const rigOn = (panel: typeof ELGATO, name = 'Elgato rig') => ({ display: panel, rigName: name });

  it('names the pinned panel and stays quiet when its rig is the one in force', () => {
    /*
     * The issue's repro, inverted: the editor on the desk monitor, the Elgato
     * pinned with a chosen rig. Present fills the Elgato and lays the take out
     * from that rig — so the line beside Present names it, and the readiness
     * sheet has nothing to raise. It used to say the take would open on the
     * desk monitor and tell the operator to drag the window to the Elgato.
     */
    const destination = resolveTakeDestination(
      input({
        currentDisplay: STUDIO,
        displays: [STUDIO, ELGATO],
        pinnedFingerprint: 'dsp-elgato',
        calibratedRigs: [rigOn(ELGATO)],
        pinnedRigName: 'Elgato rig',
      }),
    );
    expect(destination.summary).toBe('Teleprompter · Elgato Prompter');
    expect(destination.confidence).toBe('known');
    expect(destination.mismatch).toBeNull();
  });

  it('names the pinned panel even when the window’s own monitor cannot be named', () => {
    const destination = resolveTakeDestination(
      input({ currentDisplay: null, displays: [STUDIO, ELGATO], pinnedFingerprint: 'dsp-elgato', calibratedRigs: [] }),
    );
    expect(destination.summary).toBe('Teleprompter · Elgato Prompter');
    expect(destination.confidence).toBe('known');
  });

  it('still warns when the pinned panel has no rig and another connected one does', () => {
    const destination = resolveTakeDestination(
      input({
        currentDisplay: STUDIO,
        displays: [STUDIO, ELGATO],
        pinnedFingerprint: 'dsp-elgato',
        calibratedRigs: [rigOn(STUDIO, 'Desk rig')],
      }),
    );
    expect(destination.mismatch!.title).toBe('This take will open on Elgato Prompter, which has no calibrated rig.');
    expect(destination.mismatch!.suggestion).toMatch(/^Choose Studio Display in Settings/);
  });

  it('says the pinned panel is unplugged and names where the take goes instead', () => {
    const destination = resolveTakeDestination(
      input({
        currentDisplay: STUDIO,
        displays: [STUDIO],
        pinnedFingerprint: 'dsp-elgato',
        calibratedRigs: [],
        pinnedRigName: 'Elgato rig',
      }),
    );
    expect(destination.summary).toBe('Teleprompter · Studio Display');
    const mismatch = destination.mismatch!;
    // The readiness sheet shows the title and nothing else, so it carries the
    // whole fact on its own.
    expect(mismatch.title).toBe(
      'The prompter display you chose is not connected, so this take will open on Studio Display, where the CandidCue window is.',
    );
    expect(mismatch.detail).toContain('“Elgato rig”');
    expect(mismatch.suggestion).toMatch(/reconnect/i);
    expect(mismatch.suggestion).toMatch(/or carry on/i);
  });

  it('stays quiet about an unplugged pin with no rig — nothing measured is lost', () => {
    /*
     * The line beside Present already says where the take goes. Raising the
     * readiness sheet on every take for somebody who left an uncalibrated
     * prompter at the studio would interrupt them to repeat it.
     */
    const destination = resolveTakeDestination(
      input({ currentDisplay: STUDIO, displays: [STUDIO], pinnedFingerprint: 'dsp-elgato', calibratedRigs: [] }),
    );
    expect(destination.summary).toBe('Teleprompter · Studio Display');
    expect(destination.mismatch).toBeNull();
  });

  it('describes the fallback rather than naming a guess when the window’s monitor is unknown', () => {
    const destination = resolveTakeDestination(
      input({
        currentDisplay: null,
        displays: [STUDIO],
        pinnedFingerprint: 'dsp-elgato',
        calibratedRigs: [],
        pinnedRigName: 'Elgato rig',
      }),
    );
    expect(destination.confidence).toBe('unknown');
    expect(destination.mismatch!.title).toBe(
      'The prompter display you chose is not connected, so this take will open on the display the CandidCue window is on.',
    );
  });

  it('stays quiet when an unplugged pin falls back to a panel with its own rig', () => {
    // The take lands on the panel whose rig it uses: nothing about how it will
    // look is wrong.
    expect(
      resolveTakeDestination(
        input({
          currentDisplay: STUDIO,
          displays: [STUDIO],
          pinnedFingerprint: 'dsp-elgato',
          calibratedRigs: [rigOn(STUDIO, 'Desk rig')],
          pinnedRigName: 'Elgato rig',
        }),
      ).mismatch,
    ).toBeNull();
  });

  it('does not call a pin unplugged on a list that named no panels at all', () => {
    expect(
      resolveTakeDestination(
        input({
          currentDisplay: null,
          displays: [],
          pinnedFingerprint: 'dsp-elgato',
          calibratedRigs: [],
          pinnedRigName: 'Elgato rig',
        }),
      ).mismatch,
    ).toBeNull();
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
    expect(spoken).toMatch(/or carry on/i);
  });

  it('says only the destination when there is no mismatch', () => {
    const spoken = destinationAnnouncement(resolveTakeDestination(input()));
    expect(spoken).not.toContain('·');
    expect(spoken).not.toMatch(/calibrated for/i);
  });
});
