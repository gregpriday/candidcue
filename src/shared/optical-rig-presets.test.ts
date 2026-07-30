import { describe, expect, it } from 'vitest';
import { defaultOpticalProfile, OPTICAL_HARDWARE } from './contracts/optical';
import { defaultDistanceMm } from './optical-discovery';
import { isPlausibleViewingDistanceMm } from './optics';
import { RIG_PRESETS } from './optical-rig-presets';

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

  it('reuses defaultDistanceMm() for every hardware kind it already knows, so a preset pick and auto-discovery never disagree', () => {
    const byId = Object.fromEntries(RIG_PRESETS.map((p) => [p.id, p]));
    expect(byId['elgato-prompter']!.patch.viewingDistanceMm).toBe(
      defaultDistanceMm('elgato-prompter'),
    );
    expect(byId['elgato-prompter-xl']!.patch.viewingDistanceMm).toBe(
      defaultDistanceMm('elgato-prompter-xl'),
    );
    expect(byId['ipad-rig']!.patch.viewingDistanceMm).toBe(defaultDistanceMm('ipad-sidecar'));
  });

  it('gives the two generic presets their own distances, further apart than the two Elgato units', () => {
    const byId = Object.fromEntries(RIG_PRESETS.map((p) => [p.id, p]));
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
    const byId = Object.fromEntries(RIG_PRESETS.map((p) => [p.id, p]));
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
});
