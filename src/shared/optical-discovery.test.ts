/**
 * Discovery, checked on the thing that matters: it must be RIGHT or say
 * nothing. A confident wrong physical size is the worst outcome available —
 * every size on the glass comes out wrong by the same factor, and nothing looks
 * broken.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_RIG_NAME,
  GENERIC_DISTANCE_DIAGONALS,
  GENERIC_DISTANCE_RANGE_MM,
  automaticProfile,
  defaultDistanceMm,
  discoverProfile,
  identifyHardware,
  isAutomaticProfile,
  scaleForDisplay,
  type DisplayShape,
} from './optical-discovery';
import { defaultOpticalProfile } from './contracts/optical';
import { inchesToMm, mmPerCssPixel } from './optics';

const prompter9: DisplayShape = {
  name: 'Elgato Prompter',
  physicalSize: { width: 1024, height: 600 },
  scaleFactor: 1,
};

describe('identifying the panel', () => {
  it('knows the 9-inch Prompter by name', () => {
    const id = identifyHardware(prompter9);
    expect(id.kind).toBe('elgato-prompter');
    expect(id.confidence).toBe('model');
    expect(id.diagonalInches).toBe(9);
  });

  it('separates the XL from the 9-inch, which only the name does', () => {
    const id = identifyHardware({
      name: 'Elgato Prompter XL',
      physicalSize: { width: 1920, height: 1080 },
      scaleFactor: 1,
    });
    expect(id.kind).toBe('elgato-prompter-xl');
    expect(id.diagonalInches).toBe(15.6);
  });

  it('falls back to the 1024x600 mode when the display reports no name', () => {
    // Some capture and bridge paths report nothing. 1024x600 is diagnostic on
    // its own — no mainstream monitor ships it.
    const id = identifyHardware({ physicalSize: { width: 1024, height: 600 }, scaleFactor: 1 });
    expect(id.kind).toBe('elgato-prompter');
    expect(id.confidence).toBe('resolution');
  });

  it('does not guess a size for an iPad', () => {
    // Sidecar reports a virtual geometry and iPads vary too much to assume.
    const id = identifyHardware({
      name: "Greg's iPad Pro",
      physicalSize: { width: 2388, height: 1668 },
      scaleFactor: 2,
    });
    expect(id.kind).toBe('ipad-sidecar');
    expect(id.diagonalInches).toBeNull();
  });

  it('says unknown rather than guessing at an ordinary monitor', () => {
    const id = identifyHardware({
      name: 'DELL U2720Q',
      physicalSize: { width: 3840, height: 2160 },
      scaleFactor: 2,
    });
    expect(id.kind).toBe('generic');
    expect(id.confidence).toBe('unknown');
    expect(id.diagonalInches).toBeNull();
  });

  it('survives a missing display entirely', () => {
    expect(identifyHardware(null).kind).toBe('generic');
    expect(identifyHardware(undefined).confidence).toBe('unknown');
  });
});

describe('deriving the physical scale', () => {
  it('matches the scale computed directly from the panel', () => {
    const scale = scaleForDisplay(prompter9, identifyHardware(prompter9));
    const direct = mmPerCssPixel({
      diagonalMm: inchesToMm(9),
      widthPx: 1024,
      heightPx: 600,
    });
    expect(scale?.mmPerCssPx).toBeCloseTo(direct as number, 8);
    expect(scale?.source).toBe('model');
  });

  it('divides the diagonal across LOGICAL pixels, not device pixels', () => {
    /*
     * The stage lays out in CSS pixels. A 2x display whose diagonal was divided
     * across device pixels would resolve to half the true millimetres per pixel,
     * and every size on the glass would come out at half its intended angle —
     * with nothing looking wrong.
     */
    const at1x = scaleForDisplay(
      { name: 'Elgato Prompter XL', physicalSize: { width: 1920, height: 1080 }, scaleFactor: 1 },
      identifyHardware({ name: 'Elgato Prompter XL', physicalSize: { width: 1920, height: 1080 }, scaleFactor: 1 }),
    );
    const at2x = scaleForDisplay(
      { name: 'Elgato Prompter XL', physicalSize: { width: 3840, height: 2160 }, scaleFactor: 2 },
      identifyHardware({ name: 'Elgato Prompter XL', physicalSize: { width: 3840, height: 2160 }, scaleFactor: 2 }),
    );
    // Same panel, same logical resolution: the scale must be identical.
    expect(at2x?.mmPerCssPx).toBeCloseTo(at1x?.mmPerCssPx as number, 8);
  });

  it('returns null for hardware it cannot size', () => {
    const display: DisplayShape = {
      name: 'DELL U2720Q',
      physicalSize: { width: 3840, height: 2160 },
      scaleFactor: 2,
    };
    expect(scaleForDisplay(display, identifyHardware(display))).toBeNull();
  });
});

describe('building a profile without asking', () => {
  it('produces an immediately usable profile for a known panel', () => {
    const { profile, answered, outstanding } = discoverProfile(prompter9);
    expect(profile.hardwareKind).toBe('elgato-prompter');
    expect(profile.scale).not.toBeNull();
    expect(profile.viewingDistanceMm).toBe(1200);
    expect(answered).toEqual(['hardware', 'scale', 'distance'].filter((s) => s !== 'distance'));
    // Distance is a per-hardware guess, so it is still outstanding for the user
    // to confirm even though a usable value is already in the profile.
    expect(outstanding).toContain('distance');
  });

  it('always leaves aperture, orientation and lens to a person', () => {
    // Three facts about a hood and a camera. Nothing in software can see them.
    const { outstanding } = discoverProfile(prompter9);
    expect(outstanding).toEqual(expect.arrayContaining(['safe-area', 'orientation', 'lens']));
  });

  it('never overwrites a ruler measurement with a model lookup', () => {
    /*
     * A ruler measures the finished optical path, including a beamsplitter that
     * magnifies; a model lookup only ever describes the panel. Recomputing over
     * the top would silently discard the better number on every relaunch.
     */
    const measured = {
      ...defaultOpticalProfile(),
      scale: { mmPerCssPx: 0.25, source: 'ruler' as const },
    };
    const { profile } = discoverProfile(prompter9, measured);
    expect(profile.scale?.source).toBe('ruler');
    expect(profile.scale?.mmPerCssPx).toBe(0.25);
  });

  it('keeps a distance the user already gave', () => {
    const existing = { ...defaultOpticalProfile(), viewingDistanceMm: 900 };
    const { profile, answered } = discoverProfile(prompter9, existing);
    expect(profile.viewingDistanceMm).toBe(900);
    expect(answered).toContain('distance');
  });

  it('keeps a rig name the user chose', () => {
    const named = { ...defaultOpticalProfile(), rigName: 'Studio hood' };
    expect(discoverProfile(prompter9, named).profile.rigName).toBe('Studio hood');
  });

  it('names the rig after the panel when the user has not', () => {
    expect(discoverProfile(prompter9).profile.rigName).toContain('Elgato Prompter');
  });

  it('leaves an unidentifiable display needing a ruler', () => {
    const { profile, outstanding } = discoverProfile({
      name: 'DELL U2720Q',
      physicalSize: { width: 3840, height: 2160 },
      scaleFactor: 2,
    });
    expect(profile.scale).toBeNull();
    expect(outstanding).toContain('scale');
  });
});

describe('default distances', () => {
  it('treats the 9-inch as a desk instrument and the XL as a studio one', () => {
    expect(defaultDistanceMm('elgato-prompter')).toBe(1200);
    expect(defaultDistanceMm('elgato-prompter-xl')).toBeGreaterThan(
      defaultDistanceMm('elgato-prompter') as number,
    );
    expect(defaultDistanceMm('generic')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * The panel's own millimetres, and the automatic profile built on them
 * ------------------------------------------------------------------------- */

/** A 27-inch 4K monitor that reports its EDID size, at 2x. */
const dell27: DisplayShape = {
  name: 'DELL U2720Q',
  physicalSize: { width: 3840, height: 2160 },
  scaleFactor: 2,
  physicalSizeMm: { width: 597, height: 336 },
};

describe('a panel that reports its own size', () => {
  it('is sized from that report when the model is unknown', () => {
    const id = identifyHardware(dell27);
    expect(id.kind).toBe('generic');
    expect(id.confidence).toBe('panel');
    expect(id.diagonalInches).toBeCloseTo(Math.hypot(597, 336) / 25.4, 3);
    expect(id.label).toContain('27');
    const scale = scaleForDisplay(dell27, id);
    expect(scale?.source).toBe('display');
    // 597mm across 1920 logical px, within EDID rounding of the diagonal route.
    expect(scale?.mmPerCssPx).toBeCloseTo(597 / 1920, 3);
  });

  it('does not believe a name the pixel grid contradicts', () => {
    // A 1080p panel calling itself a prompter is not the 9-inch, whatever it
    // says: with millimetres it is sized from those, without them it is unknown.
    const named = {
      name: 'Teleprompter Display',
      physicalSize: { width: 1920, height: 1080 },
      scaleFactor: 1,
    };
    expect(identifyHardware(named).confidence).toBe('unknown');
    const sized = identifyHardware({ ...named, physicalSizeMm: { width: 344, height: 194 } });
    expect(sized.kind).toBe('generic');
    expect(sized.confidence).toBe('panel');
    // And an XL is only an XL at 1920x1080.
    expect(
      identifyHardware({ name: 'Elgato Prompter XL', physicalSize: { width: 1024, height: 600 }, scaleFactor: 1 })
        .confidence,
    ).toBe('resolution');
    expect(
      identifyHardware({ name: 'Elgato Prompter XL', physicalSize: { width: 1920, height: 1080 }, scaleFactor: 1 })
        .kind,
    ).toBe('elgato-prompter-xl');
  });

  it('refuses a scale factor that is not a positive number', () => {
    for (const scaleFactor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const display = { ...dell27, scaleFactor };
      expect(scaleForDisplay(display, identifyHardware(display))).toBeNull();
      expect(automaticProfile(display)).toBeNull();
    }
  });

  it('still prefers the hardware table for a panel it recognises', () => {
    const id = identifyHardware({ ...prompter9, physicalSizeMm: { width: 200, height: 117 } });
    expect(id.confidence).toBe('model');
    expect(id.diagonalInches).toBe(9);
    expect(scaleForDisplay({ ...prompter9, physicalSizeMm: { width: 200, height: 117 } }, id)?.source).toBe(
      'model',
    );
  });

  it('ignores a report that is not a plausible panel', () => {
    for (const physicalSizeMm of [
      { width: 0, height: 0 },
      { width: 16, height: 9 },
      { width: 8000, height: 4500 },
      { width: Number.NaN, height: 100 },
      null,
      undefined,
    ]) {
      const id = identifyHardware({ ...dell27, physicalSizeMm });
      expect(id.confidence).toBe('unknown');
      expect(id.diagonalInches).toBeNull();
    }
  });

  it('does not count a size report as an answered hardware step', () => {
    const found = discoverProfile(dell27, null);
    expect(found.answered).toEqual(['scale']);
    expect(found.outstanding).toEqual(['distance', 'safe-area', 'orientation', 'lens']);
    expect(found.profile.scale?.source).toBe('display');
  });
});

describe('the distance guess for an unrecognised panel', () => {
  it('scales with the diagonal and is clamped to a range somebody would stand at', () => {
    const diagonal24 = Math.hypot(527, 296);
    expect(defaultDistanceMm('generic', diagonal24)).toBe(
      Math.round(diagonal24 * GENERIC_DISTANCE_DIAGONALS),
    );
    expect(defaultDistanceMm('generic', 60)).toBe(GENERIC_DISTANCE_RANGE_MM.min);
    expect(defaultDistanceMm('generic', 4000)).toBe(GENERIC_DISTANCE_RANGE_MM.max);
  });

  it('is nothing at all without a diagonal, so the wizard still asks', () => {
    expect(defaultDistanceMm('generic')).toBeNull();
    expect(defaultDistanceMm('generic', null)).toBeNull();
    expect(defaultDistanceMm('generic', Number.NaN)).toBeNull();
  });

  it('leaves the known hardware defaults exactly where they were', () => {
    expect(defaultDistanceMm('elgato-prompter', 5000)).toBe(1200);
    expect(defaultDistanceMm('elgato-prompter-xl')).toBe(2500);
    expect(defaultDistanceMm('ipad-sidecar')).toBe(1000);
  });
});

describe('the automatic profile', () => {
  it('is complete for a recognised prompter', () => {
    const profile = automaticProfile(prompter9);
    expect(profile).not.toBeNull();
    expect(profile?.rigName).toBe(AUTOMATIC_RIG_NAME);
    expect(profile?.hardwareKind).toBe('elgato-prompter');
    expect(profile?.scale?.source).toBe('model');
    expect(profile?.viewingDistanceMm).toBe(1200);
    expect(isAutomaticProfile(profile)).toBe(true);
  });

  it('is complete for an ordinary monitor that reports its size', () => {
    const profile = automaticProfile(dell27);
    expect(profile?.scale?.source).toBe('display');
    expect(profile?.viewingDistanceMm).toBe(
      Math.round(Math.hypot(597, 336) * GENERIC_DISTANCE_DIAGONALS),
    );
  });

  it('is nothing for a panel it cannot size, rather than a guess in a rig\'s clothing', () => {
    expect(
      automaticProfile({ name: 'DELL U2720Q', physicalSize: { width: 3840, height: 2160 }, scaleFactor: 2 }),
    ).toBeNull();
    // An iPad is recognised but has no assumable diagonal.
    expect(
      automaticProfile({ name: 'iPad', physicalSize: { width: 2360, height: 1640 }, scaleFactor: 2 }),
    ).toBeNull();
    expect(automaticProfile(null)).toBeNull();
    expect(automaticProfile(undefined)).toBeNull();
  });

  it('starts from the same defaults the calibration wizard opens with', () => {
    const profile = automaticProfile(prompter9);
    const base = defaultOpticalProfile();
    expect(profile?.safeArea).toEqual(base.safeArea);
    expect(profile?.flips).toEqual(base.flips);
    expect(profile?.lens).toEqual(base.lens);
    expect(profile?.lensPlacement).toBe(base.lensPlacement);
    expect(profile?.completedSteps).toEqual([]);
  });

  it('carries the presenter’s intensity and cue rather than the defaults', () => {
    const profile = automaticProfile(prompter9, { intensity: 'soft', readingCue: 'wash' });
    expect(profile?.intensity).toBe('soft');
    expect(profile?.readingCue).toBe('wash');
    expect(profile?.rigName).toBe(AUTOMATIC_RIG_NAME);
    // The seed cannot smuggle in anything else.
    expect(automaticProfile(prompter9)?.intensity).toBe(defaultOpticalProfile().intensity);
  });

  it('is told apart from a saved rig by its name alone', () => {
    expect(isAutomaticProfile(null)).toBe(false);
    expect(isAutomaticProfile({ ...defaultOpticalProfile(), rigName: 'Desk' })).toBe(false);
  });
});
