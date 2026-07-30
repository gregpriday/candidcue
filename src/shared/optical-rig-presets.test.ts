import { describe, expect, it } from 'vitest';
import { defaultOpticalProfile, OPTICAL_HARDWARE, type OpticalHardwareKind } from './contracts/optical';
import { defaultDistanceMm } from './optical-discovery';
import { isPlausibleViewingDistanceMm } from './optics';
import {
  opticalProfileFieldsForPreset,
  profileMatchesPreset,
  RIG_PRESETS,
} from './optical-rig-presets';

const byId = Object.fromEntries(RIG_PRESETS.map((p) => [p.id, p]));

describe('RIG_PRESETS', () => {
  it('has exactly six presets with unique ids and labels', () => {
    expect(RIG_PRESETS).toHaveLength(6);
    expect(new Set(RIG_PRESETS.map((p) => p.id)).size).toBe(6);
    expect(new Set(RIG_PRESETS.map((p) => p.label)).size).toBe(6);
  });

  it('only patches the four fields a preset owns', () => {
    for (const preset of RIG_PRESETS) {
      expect(Object.keys(preset.patch).sort()).toEqual(
        ['flips', 'hardwareKind', 'lensPlacement', 'viewingDistanceMm'].sort(),
      );
    }
  });

  it('every hardwareKind is a real OPTICAL_HARDWARE entry', () => {
    for (const preset of RIG_PRESETS) {
      expect(Object.keys(OPTICAL_HARDWARE)).toContain(preset.patch.hardwareKind);
    }
  });

  // An explicit id-to-kind table, rather than "is a valid key" above: swapping
  // the iPad and an Elgato kind by accident would still pass the looser check.
  it('maps each preset id to the exact hardware kind it names', () => {
    const expected: Record<string, OpticalHardwareKind> = {
      'desk-reading': 'generic',
      'desk-webcam': 'generic',
      'elgato-prompter': 'elgato-prompter',
      'elgato-prompter-xl': 'elgato-prompter-xl',
      'studio-glass': 'generic',
      'ipad-rig': 'ipad-sidecar',
    };
    for (const [id, kind] of Object.entries(expected)) {
      expect(byId[id]!.patch.hardwareKind).toBe(kind);
    }
  });

  it('reuses defaultDistanceMm() for every hardware kind it already knows, so a preset pick and auto-discovery never disagree', () => {
    expect(byId['elgato-prompter']!.patch.viewingDistanceMm).toBe(
      defaultDistanceMm('elgato-prompter'),
    );
    expect(byId['elgato-prompter-xl']!.patch.viewingDistanceMm).toBe(
      defaultDistanceMm('elgato-prompter-xl'),
    );
    expect(byId['ipad-rig']!.patch.viewingDistanceMm).toBe(defaultDistanceMm('ipad-sidecar'));
  });

  it('gives the generic presets their own distances, further apart than the two Elgato units', () => {
    expect(byId['desk-webcam']!.patch.viewingDistanceMm).toBe(600);
    expect(byId['studio-glass']!.patch.viewingDistanceMm).toBeGreaterThan(
      byId['elgato-prompter-xl']!.patch.viewingDistanceMm,
    );
    /*
     * Reading is CLOSER than being filmed at a desk, and the ordering is the
     * assertion rather than the literal.
     *
     * Both presets are "at a desk" and it would be easy to give them the same
     * number and call it tidy — but `desk-webcam` describes somebody sitting back
     * far enough to be in frame, and this one describes somebody reading. If they
     * ever converge, the reading preset has stopped saying anything.
     */
    expect(byId['desk-reading']!.patch.viewingDistanceMm).toBeLessThan(
      byId['desk-webcam']!.patch.viewingDistanceMm,
    );
  });

  it('every distance is inside the range the wizard accepts', () => {
    for (const preset of RIG_PRESETS) {
      expect(isPlausibleViewingDistanceMm(preset.patch.viewingDistanceMm)).toBe(true);
    }
  });

  it('flips horizontal for glass/beamsplitter rigs, and leaves it off for direct-view rigs', () => {
    expect(byId['desk-reading']!.patch.flips).toEqual({ horizontal: false, vertical: false });
    expect(byId['desk-webcam']!.patch.flips).toEqual({ horizontal: false, vertical: false });
    expect(byId['elgato-prompter']!.patch.flips).toEqual({ horizontal: true, vertical: false });
    expect(byId['elgato-prompter-xl']!.patch.flips).toEqual({ horizontal: true, vertical: false });
    expect(byId['studio-glass']!.patch.flips).toEqual({ horizontal: true, vertical: false });
    expect(byId['ipad-rig']!.patch.flips).toEqual({ horizontal: false, vertical: false });
  });

  // Placement, not the crosshair: where the camera sits relative to the glass
  // follows from the rig's shape, so a beamsplitter hood is 'in-panel' and the
  // two direct-view rigs put the camera above the picture entirely. Inheriting
  // the default 'in-panel' on those two would resolve their reading band from a
  // `lens.y` that describes nothing.
  it('places the lens by physical shape, off-panel for the two direct-view rigs', () => {
    /*
     * `'none'`, and it must not be `'above'`.
     *
     * The reading preset is the only one with no camera anywhere, and the two
     * answers are not interchangeable: `'above'` pins the reading band to the top
     * 5% of the glass so the reader's eyeline sits near a lens clipped to the
     * monitor. Inheriting that for a rig with no lens would push a reader's text
     * to the top edge of their window for the sake of a camera that is not there.
     */
    expect(byId['desk-reading']!.patch.lensPlacement).toBe('none');
    expect(byId['desk-webcam']!.patch.lensPlacement).toBe('above');
    expect(byId['ipad-rig']!.patch.lensPlacement).toBe('above');
    expect(byId['elgato-prompter']!.patch.lensPlacement).toBe('in-panel');
    expect(byId['elgato-prompter-xl']!.patch.lensPlacement).toBe('in-panel');
    expect(byId['studio-glass']!.patch.lensPlacement).toBe('in-panel');
  });

  // A preset must not touch the lens crosshair or the text-size bias at all:
  // it is the wizard's FIRST step, so writing even the neutral default there
  // would wipe a returning presenter's measured values the moment they click
  // their own rig's card. `lensPlacement` is not an exception to this — it is a
  // fact about the rig's shape rather than a measurement taken through it.
  it('never claims a lens position or a text-size bias', () => {
    for (const preset of RIG_PRESETS) {
      expect(preset.patch).not.toHaveProperty('lens');
      expect(preset.patch).not.toHaveProperty('bias');
    }
  });

  it('gives no two presets the exact same five-field signature, so at most one card can ever show as selected', () => {
    const signatures = RIG_PRESETS.map((p) =>
      JSON.stringify([
        p.patch.hardwareKind,
        p.patch.viewingDistanceMm,
        p.patch.flips,
        p.patch.lensPlacement,
      ]),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe('opticalProfileFieldsForPreset', () => {
  it('returns the exact four owned fields, matching the preset', () => {
    for (const preset of RIG_PRESETS) {
      expect(opticalProfileFieldsForPreset(preset)).toEqual(preset.patch);
    }
  });

  it('returns a fresh flips object on every call, never aliasing the catalog or each other', () => {
    // Mutating one call's result must not reach back into the catalog and
    // change what a LATER application of the same preset hands out.
    for (const preset of RIG_PRESETS) {
      const first = opticalProfileFieldsForPreset(preset);
      const second = opticalProfileFieldsForPreset(preset);
      expect(first.flips).not.toBe(preset.patch.flips);
      expect(first.flips).not.toBe(second.flips);
      first.flips.horizontal = !first.flips.horizontal;
      expect(opticalProfileFieldsForPreset(preset).flips).toEqual(preset.patch.flips);
    }
  });
});

describe('profileMatchesPreset', () => {
  it('matches a profile whose owned fields equal the preset, however it got there', () => {
    const preset = byId['elgato-prompter']!;
    expect(profileMatchesPreset(opticalProfileFieldsForPreset(preset), preset)).toBe(true);
  });

  // One case per compared field, so a refactor that quietly drops any single
  // comparison still fails here.
  it('rejects a near miss — one field off from every other field matching', () => {
    const preset = byId['elgato-prompter']!;
    const fields = opticalProfileFieldsForPreset(preset);
    expect(profileMatchesPreset({ ...fields, hardwareKind: 'generic' }, preset)).toBe(false);
    expect(
      profileMatchesPreset({ ...fields, viewingDistanceMm: fields.viewingDistanceMm + 1 }, preset),
    ).toBe(false);
    expect(
      profileMatchesPreset(
        { ...fields, flips: { ...fields.flips, horizontal: !fields.flips.horizontal } },
        preset,
      ),
    ).toBe(false);
    expect(
      profileMatchesPreset(
        { ...fields, flips: { ...fields.flips, vertical: !fields.flips.vertical } },
        preset,
      ),
    ).toBe(false);
    expect(profileMatchesPreset({ ...fields, lensPlacement: 'above' }, preset)).toBe(false);
  });

  // The whole reason the parameter's distance is `number | null` is that a real
  // `OpticalProfile` gets passed straight in, and its distance is null until the
  // distance step asks — so an uncalibrated rig must light up no card at all.
  it('matches no preset for an uncalibrated profile, whose distance is still null', () => {
    const fresh = defaultOpticalProfile();
    expect(fresh.viewingDistanceMm).toBeNull();
    expect(RIG_PRESETS.every((p) => !profileMatchesPreset(fresh, p))).toBe(true);
  });
});
