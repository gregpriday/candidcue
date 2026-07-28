/**
 * Discovery, checked on the thing that matters: it must be RIGHT or say
 * nothing. A confident wrong physical size is the worst outcome available —
 * every size on the glass comes out wrong by the same factor, and nothing looks
 * broken.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultDistanceMm,
  discoverProfile,
  identifyHardware,
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
