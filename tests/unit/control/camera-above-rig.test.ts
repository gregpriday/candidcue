/**
 * "Camera above this screen" (#238): the rig a laptop's built-in camera, or a
 * webcam above a monitor, gets in one choice — and the Present-menu row that
 * offers it.
 *
 * The rig is stored against the panel, so what is pinned here is mostly about
 * the store: the right geometry with nothing measured, one panel's mirror and
 * nobody else's, and choosing it twice neither piling up rigs nor throwing away
 * somebody's adjustment or measurements.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CAMERA_ABOVE_RIG_NAME,
  cameraAboveProfile,
  isCameraOffPanelProfile,
  isMirroredGlassRig,
  isPrompterGlass,
  withCameraAboveRig,
} from '../../../src/control/lib/camera-above-rig';
import { CAMERA_ABOVE_LABEL, presentMenuItems } from '../../../src/control/lib/present-menu';
import {
  activeOpticalProfile,
  defaultAppSettings,
  opticalRigKey,
  panelMirrorFor,
  type OpticalSettings,
} from '../../../src/control/services/settings-types';
import { stageSettingsFromSettings } from '../../../src/control/services/stage-envelope';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import { defaultOpticalProfile } from '../../../src/shared/contracts/optical';

const LAPTOP: DisplayDescriptor = {
  id: 'display-laptop',
  name: 'Built-in Retina Display',
  primary: true,
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 3024, height: 1964 },
  logicalSize: { width: 1512, height: 982 },
  scaleFactor: 2,
  fingerprint: 'panel-laptop',
  topologyHash: 'topology-laptop',
  physicalSizeMm: { width: 302, height: 196 },
};
const ELGATO: DisplayDescriptor = {
  id: 'display-elgato',
  name: 'Monitor #1234',
  primary: false,
  physicalPosition: { x: 3024, y: 0 },
  physicalSize: { width: 1024, height: 600 },
  logicalSize: { width: 1024, height: 600 },
  scaleFactor: 1,
  fingerprint: 'panel-elgato',
  topologyHash: 'topology-elgato',
};

function empty(): OpticalSettings {
  return { profiles: {}, activeRig: {}, panelMirror: {} };
}

describe('cameraAboveProfile', () => {
  it('is the desk-webcam geometry with the panel’s own scale and nothing measured', () => {
    const profile = cameraAboveProfile(LAPTOP);
    expect(profile.rigName).toBe(CAMERA_ABOVE_RIG_NAME);
    expect(profile.lensPlacement).toBe('above');
    expect(profile.viewingDistanceMm).toBe(600);
    expect(profile.flips).toEqual({ horizontal: false, vertical: false });
    expect(profile.hardwareKind).toBe('generic');
    // The EDID millimetres: 302 mm over 1512 CSS px.
    expect(profile.scale?.mmPerCssPx).toBeCloseTo(302 / 1512, 4);
    expect(profile.completedSteps).toEqual([]);
    expect(profile.overrides).toEqual({});
  });

  it('carries the presenter’s own intensity, cue and size bias', () => {
    const profile = cameraAboveProfile(LAPTOP, { intensity: 'soft', readingCue: 'wash', bias: 0.25 });
    expect(profile.intensity).toBe('soft');
    expect(profile.readingCue).toBe('wash');
    expect(profile.bias).toBe(0.25);
    const strong = cameraAboveProfile(LAPTOP, { intensity: 'strong', readingCue: 'ticks', bias: 7 });
    expect(strong.intensity).toBe('strong');
    expect(strong.readingCue).toBe('ticks');
    expect(strong.bias).toBe(1);
    // Nothing expressed leaves discovery's own value.
    expect(cameraAboveProfile(LAPTOP, { bias: Number.NaN }).bias).toBe(cameraAboveProfile(LAPTOP).bias);
  });

  it('takes its scale from the panel, so a different panel sizes differently', () => {
    const bigger = { ...LAPTOP, physicalSizeMm: { width: 604, height: 392 } };
    expect(cameraAboveProfile(bigger).scale?.mmPerCssPx).toBeCloseTo(604 / 1512, 3);
  });

  it('is still a camera rig on a panel that cannot be sized', () => {
    const unsized = { ...LAPTOP, physicalSizeMm: undefined, name: 'Mystery panel' };
    const profile = cameraAboveProfile(unsized);
    expect(profile.scale).toBeNull();
    expect(profile.lensPlacement).toBe('above');
  });
});

describe('withCameraAboveRig', () => {
  it('chooses the rig for this panel and clears only this panel’s mirror', () => {
    const elgatoRig = { ...defaultOpticalProfile(), rigName: 'Elgato rig', viewingDistanceMm: 1200 };
    const optical: OpticalSettings = {
      profiles: { [opticalRigKey(ELGATO.fingerprint, elgatoRig.rigName)]: elgatoRig },
      activeRig: { [ELGATO.fingerprint]: elgatoRig.rigName },
      panelMirror: {
        [LAPTOP.fingerprint]: { horizontal: true, vertical: true },
        [ELGATO.fingerprint]: { horizontal: true, vertical: false },
      },
    };
    const next = withCameraAboveRig(optical, LAPTOP);
    // Every other panel's rig rides along untouched.
    expect(activeOpticalProfile(next, ELGATO.fingerprint)?.viewingDistanceMm).toBe(1200);
    expect(activeOpticalProfile(next, LAPTOP.fingerprint)?.rigName).toBe(CAMERA_ABOVE_RIG_NAME);
    expect(panelMirrorFor(next, LAPTOP.fingerprint)).toEqual({ horizontal: false, vertical: false });
    expect(panelMirrorFor(next, ELGATO.fingerprint)).toEqual({ horizontal: true, vertical: false });
    // Pure: the section it was given is untouched.
    expect(optical.activeRig).toEqual({ [ELGATO.fingerprint]: elgatoRig.rigName });
  });

  it('chooses the same rig again, adjustments and all, rather than storing another', () => {
    const first = withCameraAboveRig(empty(), LAPTOP);
    const key = opticalRigKey(LAPTOP.fingerprint, CAMERA_ABOVE_RIG_NAME);
    const adjusted: OpticalSettings = {
      ...first,
      // Another rig in force since, which the choice must replace.
      profiles: {
        ...first.profiles,
        [key]: { ...first.profiles[key]!, overrides: { fontSizePx: 40 } },
        [opticalRigKey(LAPTOP.fingerprint, 'Desk hood')]: {
          ...defaultOpticalProfile(),
          rigName: 'Desk hood',
        },
      },
      activeRig: { [LAPTOP.fingerprint]: 'Desk hood' },
    };
    const again = withCameraAboveRig(adjusted, LAPTOP);
    expect(Object.keys(again.profiles)).toHaveLength(2);
    expect(again.activeRig[LAPTOP.fingerprint]).toBe(CAMERA_ABOVE_RIG_NAME);
    expect(activeOpticalProfile(again, LAPTOP.fingerprint)?.overrides).toEqual({ fontSizePx: 40 });
  });

  it('keeps a camera-above rig somebody measured in the wizard', () => {
    const measured = {
      ...defaultOpticalProfile(),
      rigName: 'My desk webcam',
      lensPlacement: 'above' as const,
      viewingDistanceMm: 720,
      scale: { mmPerCssPx: 0.2, source: 'ruler' as const },
      completedSteps: ['distance' as const],
    };
    const optical: OpticalSettings = {
      profiles: { [opticalRigKey(LAPTOP.fingerprint, measured.rigName)]: measured },
      activeRig: { [LAPTOP.fingerprint]: measured.rigName },
      panelMirror: { [LAPTOP.fingerprint]: { horizontal: true, vertical: false } },
    };
    const next = withCameraAboveRig(optical, LAPTOP);
    expect(activeOpticalProfile(next, LAPTOP.fingerprint)).toEqual(
      expect.objectContaining({ viewingDistanceMm: 720, scale: measured.scale, completedSteps: ['distance'] }),
    );
    expect(Object.keys(next.profiles)).toHaveLength(1);
    expect(panelMirrorFor(next, LAPTOP.fingerprint).horizontal).toBe(false);
  });

  it('replaces a chosen rig whose camera is BELOW the panel', () => {
    const below = { ...defaultOpticalProfile(), rigName: 'Under the screen', lensPlacement: 'below' as const };
    const optical: OpticalSettings = {
      profiles: { [opticalRigKey(LAPTOP.fingerprint, below.rigName)]: below },
      activeRig: { [LAPTOP.fingerprint]: below.rigName },
      panelMirror: {},
    };
    const next = withCameraAboveRig(optical, LAPTOP);
    expect(activeOpticalProfile(next, LAPTOP.fingerprint)?.lensPlacement).toBe('above');
    // The other rig is kept, only no longer chosen.
    expect(next.profiles[opticalRigKey(LAPTOP.fingerprint, below.rigName)]).toBeDefined();
  });

  it('never overwrites a rig of another shape that happens to have the name', () => {
    const hood = {
      ...defaultOpticalProfile(),
      rigName: CAMERA_ABOVE_RIG_NAME,
      lensPlacement: 'in-panel' as const,
      viewingDistanceMm: 1500,
    };
    const second = { ...hood, rigName: `${CAMERA_ABOVE_RIG_NAME} 2` };
    const optical: OpticalSettings = {
      ...empty(),
      profiles: {
        [opticalRigKey(LAPTOP.fingerprint, CAMERA_ABOVE_RIG_NAME)]: hood,
        [opticalRigKey(LAPTOP.fingerprint, second.rigName)]: second,
      },
    };
    const next = withCameraAboveRig(optical, LAPTOP);
    expect(activeOpticalProfile(next, LAPTOP.fingerprint)?.rigName).toBe(
      `${CAMERA_ABOVE_RIG_NAME} 3`,
    );
    expect(activeOpticalProfile(next, LAPTOP.fingerprint)?.lensPlacement).toBe('above');
    expect(
      next.profiles[opticalRigKey(LAPTOP.fingerprint, CAMERA_ABOVE_RIG_NAME)]?.viewingDistanceMm,
    ).toBe(1500);
  });
});

describe('a prompter take on the panel afterwards', () => {
  it('reads under the camera at arm’s length, unmirrored', () => {
    const s = defaultAppSettings();
    s.stage.presentationMode = 'prompter';
    s.optical = withCameraAboveRig(
      { ...empty(), panelMirror: { [LAPTOP.fingerprint]: { horizontal: true, vertical: false } } },
      LAPTOP,
    );
    const stage = stageSettingsFromSettings(s, LAPTOP);
    expect(stage.opticalProfile?.lensPlacement).toBe('above');
    expect(stage.optics?.calibrated).toBe(true);
    // The reading line just under the lens: 5% of the safe area.
    expect(stage.readingBandCenterPercent).toBe(5);
    expect(stage.mirrorX).toBe(false);
    expect(stage.mirrorY).toBe(false);
  });

  it('keeps a diagonal typed in Settings for a panel discovery cannot size (#234)', () => {
    const unsized = { ...LAPTOP, physicalSizeMm: undefined, name: 'Mystery panel' };
    const typed = {
      ...defaultOpticalProfile(),
      rigName: 'Other display',
      scale: { mmPerCssPx: 0.21, source: 'diagonal' as const, diagonalMm: 381 },
      viewingDistanceMm: 1700,
    };
    const s = defaultAppSettings();
    s.stage.presentationMode = 'prompter';
    s.optical = withCameraAboveRig(
      {
        ...empty(),
        profiles: { [opticalRigKey(unsized.fingerprint, typed.rigName)]: typed },
        activeRig: { [unsized.fingerprint]: typed.rigName },
      },
      unsized,
    );
    const stage = stageSettingsFromSettings(s, unsized);
    expect(stage.opticalProfile?.lensPlacement).toBe('above');
    // The typed diagonal, over the panel as it is now (1512 x 982 CSS px) —
    // not the stored 0.21, which was worked out at another display scaling.
    expect(stage.opticalProfile?.scale?.source).toBe('diagonal');
    expect(stage.opticalProfile?.scale?.diagonalMm).toBe(381);
    expect(stage.opticalProfile?.scale?.mmPerCssPx).toBeCloseTo(381 / Math.hypot(1512, 982), 9);
    // The camera preset's own distance, not the hood's.
    expect(stage.opticalProfile?.viewingDistanceMm).not.toBe(1700);
    expect(stage.optics?.calibrated).toBe(true);
  });

  it('does not carry a ruler reading, which measured glass this arrangement lacks', () => {
    const ruler = {
      ...defaultOpticalProfile(),
      rigName: 'Desk hood',
      scale: { mmPerCssPx: 0.3, source: 'ruler' as const },
      viewingDistanceMm: 1500,
    };
    const next = withCameraAboveRig(
      {
        ...empty(),
        profiles: { [opticalRigKey(LAPTOP.fingerprint, ruler.rigName)]: ruler },
        activeRig: { [LAPTOP.fingerprint]: ruler.rigName },
      },
      LAPTOP,
    );
    expect(activeOpticalProfile(next, LAPTOP.fingerprint)?.scale?.source).toBe('display');
  });

  it('pins the reading line under the camera even when the panel cannot be sized', () => {
    const unsized = { ...LAPTOP, physicalSizeMm: undefined, name: 'Mystery panel' };
    const s = defaultAppSettings();
    s.optical = withCameraAboveRig(empty(), unsized);
    const stage = stageSettingsFromSettings(s, unsized);
    expect(stage.readingBandCenterPercent).toBe(5);
    expect(stage.optics?.calibrated).toBe(false);
    expect(stage.fontSizePx).toBeGreaterThan(0);
  });
});

describe('isCameraOffPanelProfile and isPrompterGlass', () => {
  it('tells a camera above or below the panel from one behind glass', () => {
    expect(isCameraOffPanelProfile(cameraAboveProfile(LAPTOP))).toBe(true);
    expect(isCameraOffPanelProfile({ ...defaultOpticalProfile(), lensPlacement: 'below' })).toBe(true);
    expect(isCameraOffPanelProfile(defaultOpticalProfile())).toBe(false);
    expect(isCameraOffPanelProfile({ ...defaultOpticalProfile(), lensPlacement: 'none' })).toBe(false);
    expect(isCameraOffPanelProfile(null)).toBe(false);
  });

  it('calls a panel glass only when its chosen rig is behind the picture AND it is mirrored', () => {
    const hood = { ...defaultOpticalProfile(), rigName: 'Studio hood' };
    const withHood = (mirrored: boolean): OpticalSettings => ({
      profiles: { [opticalRigKey(LAPTOP.fingerprint, hood.rigName)]: hood },
      activeRig: { [LAPTOP.fingerprint]: hood.rigName },
      panelMirror: { [LAPTOP.fingerprint]: { horizontal: false, vertical: mirrored } },
    });
    expect(isMirroredGlassRig(withHood(true), LAPTOP.fingerprint)).toBe(true);
    expect(isMirroredGlassRig(withHood(false), LAPTOP.fingerprint)).toBe(false);
    // Mirrored with no rig chosen: the mistake this choice exists to put right.
    expect(
      isMirroredGlassRig(
        { ...empty(), panelMirror: { [LAPTOP.fingerprint]: { horizontal: true, vertical: false } } },
        LAPTOP.fingerprint,
      ),
    ).toBe(false);
  });

  it('recognises the Elgato by its grid, and not a laptop', () => {
    expect(isPrompterGlass(ELGATO)).toBe(true);
    expect(isPrompterGlass(LAPTOP)).toBe(false);
  });
});

describe('the Present menu row', () => {
  it('is offered, unticked, beneath the two shapes when the caller can launch it', () => {
    const launch = vi.fn();
    const items = presentMenuItems('prompter', () => {}, launch);
    expect(items.map((i) => i.label)).toHaveLength(3);
    const row = items[2]!;
    expect(row.label).toBe(CAMERA_ABOVE_LABEL);
    // An action, never a default: no tick, so it is not drawn as a radio.
    expect('selected' in row).toBe(false);
    row.onselect();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('leaves the menu at its two shapes otherwise', () => {
    expect(presentMenuItems('reader', () => {})).toHaveLength(2);
  });
});
