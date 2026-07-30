import { describe, expect, it } from 'vitest';
import { defaultOpticalProfile, OPTICAL_HARDWARE, type OpticalHardwareKind } from './contracts/optical';
import { defaultDistanceMm } from './optical-discovery';
import { isPlausibleViewingDistanceMm } from './optics';
import {
  opticalProfileFieldsForPreset,
  profileMatchesPreset,
  RIG_PRESETS,
  teleprompterMirrorForPreset,
} from './optical-rig-presets';

const byId = Object.fromEntries(RIG_PRESETS.map((p) => [p.id, p]));

describe('RIG_PRESETS', () => {
  it('has exactly five presets with unique ids and labels', () => {
    expect(RIG_PRESETS).toHaveLength(5);
    expect(new Set(RIG_PRESETS.map((p) => p.id)).size).toBe(5);
    expect(new Set(RIG_PRESETS.map((p) => p.label)).size).toBe(5);
  });

  it('only patches the five fields a preset owns', () => {
    for (const preset of RIG_PRESETS) {
      expect(Object.keys(preset.patch).sort()).toEqual(
        ['bias', 'flips', 'hardwareKind', 'lens', 'viewingDistanceMm'].sort(),
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

  it('gives the two generic presets their own distances, further apart than the two Elgato units', () => {
    expect(byId['desk-webcam']!.patch.viewingDistanceMm).toBe(600);
    expect(byId['studio-glass']!.patch.viewingDistanceMm).toBeGreaterThan(
      byId['elgato-prompter-xl']!.patch.viewingDistanceMm,
    );
  });

  it('every distance is inside the range the wizard accepts', () => {
    for (const preset of RIG_PRESETS) {
      expect(isPlausibleViewingDistanceMm(preset.patch.viewingDistanceMm)).toBe(true);
    }
  });

  it('flips horizontal for glass/beamsplitter rigs, and leaves it off for direct-view rigs', () => {
    expect(byId['desk-webcam']!.patch.flips).toEqual({ horizontal: false, vertical: false });
    expect(byId['elgato-prompter']!.patch.flips).toEqual({ horizontal: true, vertical: false });
    expect(byId['elgato-prompter-xl']!.patch.flips).toEqual({ horizontal: true, vertical: false });
    expect(byId['studio-glass']!.patch.flips).toEqual({ horizontal: true, vertical: false });
    expect(byId['ipad-rig']!.patch.flips).toEqual({ horizontal: false, vertical: false });
  });

  it('leaves lens and bias at the neutral, uncalibrated defaults for every preset', () => {
    const neutral = defaultOpticalProfile();
    for (const preset of RIG_PRESETS) {
      expect(preset.patch.lens).toEqual(neutral.lens);
      expect(preset.patch.bias).toBe(neutral.bias);
    }
  });

  it('gives no two presets the exact same seven-field signature, so at most one card can ever show as selected', () => {
    const signatures = RIG_PRESETS.map((p) =>
      JSON.stringify([
        p.patch.hardwareKind,
        p.patch.viewingDistanceMm,
        p.patch.flips,
        p.patch.lens,
        p.patch.bias,
      ]),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe('opticalProfileFieldsForPreset', () => {
  it('returns the exact five owned fields, matching the preset', () => {
    for (const preset of RIG_PRESETS) {
      expect(opticalProfileFieldsForPreset(preset)).toEqual(preset.patch);
    }
  });

  it('returns fresh flips and lens objects on every call, never aliasing the catalog or each other', () => {
    // Every preset shares one `lens` reference internally (see NEUTRAL_LENS in
    // optical-rig-presets.ts) — mutating one call's result must not reach back
    // into the catalog and change what every OTHER preset, or a LATER
    // application of this one, hands out.
    for (const preset of RIG_PRESETS) {
      const first = opticalProfileFieldsForPreset(preset);
      const second = opticalProfileFieldsForPreset(preset);
      expect(first.lens).not.toBe(preset.patch.lens);
      expect(first.flips).not.toBe(preset.patch.flips);
      expect(first.lens).not.toBe(second.lens);
      expect(first.flips).not.toBe(second.flips);
      first.lens.x = -1;
      first.flips.horizontal = !first.flips.horizontal;
      expect(opticalProfileFieldsForPreset(preset).lens.x).not.toBe(-1);
      expect(opticalProfileFieldsForPreset(preset).flips).toEqual(preset.patch.flips);
    }
  });
});

describe('teleprompterMirrorForPreset', () => {
  it('builds both mirror axes into one object, never two', () => {
    expect(teleprompterMirrorForPreset(byId['desk-webcam']!)).toEqual({
      mirrorX: false,
      mirrorY: false,
    });
    expect(teleprompterMirrorForPreset(byId['elgato-prompter']!)).toEqual({
      mirrorX: true,
      mirrorY: false,
    });
  });
});

describe('profileMatchesPreset', () => {
  it('matches a profile whose owned fields equal the preset, however it got there', () => {
    const preset = byId['elgato-prompter']!;
    expect(profileMatchesPreset(opticalProfileFieldsForPreset(preset), preset)).toBe(true);
  });

  it('rejects a near miss — one field off from every other field matching', () => {
    const preset = byId['elgato-prompter']!;
    const fields = opticalProfileFieldsForPreset(preset);
    expect(profileMatchesPreset({ ...fields, bias: fields.bias + 0.01 }, preset)).toBe(false);
    expect(
      profileMatchesPreset({ ...fields, viewingDistanceMm: fields.viewingDistanceMm + 1 }, preset),
    ).toBe(false);
    expect(
      profileMatchesPreset(
        { ...fields, flips: { ...fields.flips, vertical: !fields.flips.vertical } },
        preset,
      ),
    ).toBe(false);
    expect(
      profileMatchesPreset({ ...fields, lens: { ...fields.lens, y: fields.lens.y + 0.01 } }, preset),
    ).toBe(false);
  });
});
