/**
 * The numbers on the display tiles (#237).
 *
 * Identify displays puts a number on every panel, and the only use of that
 * number is to find the same panel among the tiles in Settings. These pin the
 * rule the tiles share with Rust's overlays (list position from 1, keyed by
 * fingerprint) and the check that tells Settings its list has gone stale.
 */
import { describe, expect, it } from 'vitest';
import { displayNumbers, identificationMatches } from './display-numbers';
import type { DisplayDescriptor, IdentificationSession } from '../services/stage-types';

function display(fingerprint: string, name: string, x = 0): DisplayDescriptor {
  return {
    id: `display-${fingerprint}`,
    name,
    physicalPosition: { x, y: 0 },
    physicalSize: { width: 1920, height: 1080 },
    scaleFactor: 1,
    logicalSize: { width: 1920, height: 1080 },
    primary: x === 0,
    fingerprint,
    topologyHash: `top-${fingerprint}`,
  };
}

/** What Rust's `identify_displays` returns for this list. */
function sessionFor(displays: DisplayDescriptor[]): IdentificationSession {
  return {
    sessionId: 'identify-test',
    durationMs: 2500,
    displays: displays.map((d, index) => ({
      number: index + 1,
      fingerprint: d.fingerprint,
      name: d.name,
      logicalSize: d.logicalSize,
      primary: d.primary,
    })),
  };
}

// Two monitors of the same model: identical names, told apart only by the
// ordinal Rust appends to the second one's fingerprint.
const laptop = display('dsp-laptop', 'Built-in Display', 0);
const twinA = display('dsp-dell', 'DELL P2419H', 1920);
const twinB = display('dsp-dell-1', 'DELL P2419H', 3840);

describe('displayNumbers', () => {
  it('numbers the panels from 1 in list order, the way the overlays are numbered', () => {
    const numbers = displayNumbers([laptop, twinA, twinB]);
    expect([...numbers.entries()]).toEqual([
      ['dsp-laptop', 1],
      ['dsp-dell', 2],
      ['dsp-dell-1', 3],
    ]);
  });

  it('gives identically named panels different numbers', () => {
    const numbers = displayNumbers([laptop, twinA, twinB]);
    expect(numbers.get(twinA.fingerprint)).not.toBe(numbers.get(twinB.fingerprint));
  });

  it('follows the list when the platform reorders it', () => {
    expect(displayNumbers([twinA, laptop]).get('dsp-laptop')).toBe(2);
  });

  it('numbers nothing when nothing is connected', () => {
    expect(displayNumbers([]).size).toBe(0);
  });
});

describe('identificationMatches', () => {
  it('agrees with a session numbered from the same list', () => {
    const displays = [laptop, twinA, twinB];
    expect(identificationMatches(sessionFor(displays), displays)).toBe(true);
  });

  it('matches by fingerprint, not by where an entry sits in the session', () => {
    const displays = [laptop, twinA];
    const session = sessionFor(displays);
    session.displays.reverse();
    expect(identificationMatches(session, displays)).toBe(true);
  });

  it('notices a panel plugged in after the tiles were listed', () => {
    expect(identificationMatches(sessionFor([laptop, twinA]), [laptop])).toBe(false);
  });

  it('notices a panel unplugged after the tiles were listed', () => {
    expect(identificationMatches(sessionFor([laptop]), [laptop, twinA])).toBe(false);
  });

  it('notices the same panels numbered in a different order', () => {
    expect(identificationMatches(sessionFor([twinA, laptop]), [laptop, twinA])).toBe(false);
  });

  it('notices a panel the tiles have never heard of', () => {
    expect(identificationMatches(sessionFor([laptop, twinB]), [laptop, twinA])).toBe(false);
  });

  it('notices identical monitors listed the other way round', () => {
    // The tiles were listed with the primary twin first. The platform now
    // lists the other one first, so it takes the bare fingerprint (and the
    // number 2) while the primary twin takes the ordinal: every fingerprint
    // still has its number, but the tiles describe the wrong panels.
    const primaryTwin = { ...twinA, primary: true };
    const otherTwin = { ...twinB, primary: false };
    const swapped = sessionFor([
      laptop,
      { ...otherTwin, fingerprint: primaryTwin.fingerprint },
      { ...primaryTwin, fingerprint: otherTwin.fingerprint },
    ]);
    expect(identificationMatches(swapped, [laptop, primaryTwin, otherTwin])).toBe(false);
  });

  it('notices a panel that was rescaled after the tiles were listed', () => {
    const session = sessionFor([laptop, twinA]);
    session.displays[1] = { ...session.displays[1]!, logicalSize: { width: 960, height: 540 } };
    expect(identificationMatches(session, [laptop, twinA])).toBe(false);
  });

  it('agrees about an empty list', () => {
    expect(identificationMatches(sessionFor([]), [])).toBe(true);
  });

  it('refuses a session that names one panel twice', () => {
    const session = sessionFor([laptop, twinA]);
    session.displays[1] = { ...session.displays[0]! };
    expect(identificationMatches(session, [laptop, twinA])).toBe(false);
  });
});
