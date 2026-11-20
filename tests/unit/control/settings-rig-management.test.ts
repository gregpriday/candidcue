/**
 * Sizing a panel and managing its rigs from Settings (#234).
 *
 * Settings › Prompter display does three things the calibration wizard used to
 * be the only way to do: give a panel nobody can size a diagonal, keep a second
 * named rig on one panel, and stop using a rig without deleting it. Each is a
 * write to the same per-panel rig store a take reads through
 * `prompterOpticalProfile`, so these tests follow every write all the way to
 * the stage settings a take opens with — and pin that a rig the wizard saved,
 * ruler scale and all, comes out of all of it resolving exactly as before.
 */
import { describe, expect, it } from 'vitest';
import {
  prompterOpticalProfile,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import {
  activeOpticalProfile,
  defaultAppSettings,
  opticalRigKey,
  opticalRigsForDisplay,
  READER_RIG_NAME,
  rigNameProblem,
  withOpticalProfile,
  withPanelDiagonal,
  withPanelMirror,
  withoutActiveOpticalRig,
  type AppSettings,
  type OpticalSettings,
} from '../../../src/control/services/settings-types';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import { defaultOpticalProfile, type OpticalProfile } from '../../../src/shared/contracts/optical';
import { AUTOMATIC_RIG_NAME, discoverProfile } from '../../../src/shared/optical-discovery';
import { resolveStageGeometry } from '../../../src/shared/optical-resolve';
import { inchesToMm } from '../../../src/shared/optics';

function display(over: Partial<DisplayDescriptor> & { fingerprint: string }): DisplayDescriptor {
  return {
    id: 'display-1',
    name: 'Teleprompter Display',
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 1920, height: 1080 },
    scaleFactor: 1,
    logicalSize: { width: 1920, height: 1080 },
    primary: false,
    topologyHash: 'top-test',
    ...over,
  };
}

/** No recognisable name and no reported millimetres: discovery cannot size it. */
const unknown = display({ fingerprint: 'dsp-unknown' });

/** An iPad over Sidecar, which the name match recognises and cannot size. */
const ipad = display({
  name: 'Greg’s iPad Pro',
  fingerprint: 'dsp-ipad',
  physicalSize: { width: 2388, height: 1668 },
  scaleFactor: 2,
  logicalSize: { width: 1194, height: 834 },
});

const elgato = display({
  name: 'Elgato Prompter',
  fingerprint: 'dsp-elgato',
  physicalSize: { width: 1024, height: 600 },
  logicalSize: { width: 1024, height: 600 },
});

function viewportOf(d: DisplayDescriptor) {
  return { widthPx: d.logicalSize.width, heightPx: d.logicalSize.height };
}

function prompterSettings(optical?: OpticalSettings): AppSettings {
  const s = defaultAppSettings();
  return {
    ...s,
    stage: { ...s.stage, presentationMode: 'prompter' },
    ...(optical ? { optical } : {}),
  };
}

/** What Settings shows, and stores, for a panel with no rig applied. */
function proposal(d: DisplayDescriptor): OpticalProfile {
  return discoverProfile(d, null).profile;
}

/** A rig as the wizard saved it: a scale measured with a ruler against the glass. */
const rulerRig: OpticalProfile = {
  ...defaultOpticalProfile(),
  rigName: 'Desk hood',
  hardwareKind: 'elgato-prompter',
  scale: { mmPerCssPx: 0.1937, source: 'ruler' },
  viewingDistanceMm: 1500,
  safeArea: { top: 0.04, right: 0.02, bottom: 0.06, left: 0.02 },
  lens: { x: 0.5, y: 0.31 },
  bias: 0.35,
  overrides: { fontSizePx: 48 },
  completedSteps: ['hardware', 'safe-area', 'orientation', 'lens', 'distance', 'text-size'],
};

describe('a typed panel diagonal', () => {
  it('sizes a panel discovery could not, so the next take is sized by distance', () => {
    // Before: the flat fallback, with no optics on the stage at all.
    expect(prompterOpticalProfile(defaultAppSettings().optical, unknown)).toBeNull();
    expect(stageSettingsFromSettings(prompterSettings(), unknown).optics).toBeUndefined();

    const base = proposal(unknown);
    expect(base.scale).toBeNull();
    expect(base.viewingDistanceMm).toBeNull();
    const sized = withPanelDiagonal(base, viewportOf(unknown), 24);
    expect(sized).not.toBeNull();
    const optical = withOpticalProfile(defaultAppSettings().optical, unknown.fingerprint, sized!);

    const stage = stageSettingsFromSettings(prompterSettings(optical), unknown);
    expect(stage.opticalProfile?.rigName).toBe(base.rigName);
    expect(stage.optics?.calibrated).toBe(true);
    expect(stage.optics?.viewingDistanceMm).toBe(sized!.viewingDistanceMm);
    expect(stage.optics?.mmPerCssPx).toBeCloseTo(inchesToMm(24) / Math.hypot(1920, 1080), 9);
    // The type on the glass is the angular answer for that rig, not the fallback.
    const resolved = resolveStageGeometry({ profile: sized!, viewport: viewportOf(unknown) });
    expect(stage.optics?.bodyFontSizePx).toBe(resolved.optics.bodyFontSizePx);
    expect(stage.fontSizePx).toBe(Math.round(resolved.optics.bodyFontSizePx));
    expect(stage.fontSizePx).not.toBe(prompterSettings().teleprompter.fontSizePx);
    // And it is sized BY DISTANCE: stand further back, read larger type.
    const further = withOpticalProfile(optical, unknown.fingerprint, {
      ...sized!,
      viewingDistanceMm: sized!.viewingDistanceMm! * 1.5,
    });
    expect(stageSettingsFromSettings(prompterSettings(further), unknown).optics!.bodyFontSizePx).toBeGreaterThan(
      stage.optics!.bodyFontSizePx,
    );
  });

  it('records where the size came from', () => {
    const sized = withPanelDiagonal(proposal(unknown), viewportOf(unknown), 24)!;
    expect(sized.scale?.source).toBe('diagonal');
    expect(sized.scale?.diagonalMm).toBeCloseTo(inchesToMm(24), 9);
  });

  it('starts an unrecognised panel at the distance discovery assumes for its size', () => {
    // 4.5 diagonals: a 24-inch monitor is read from about 2.7 m.
    const sized = withPanelDiagonal(proposal(unknown), viewportOf(unknown), 24)!;
    expect(sized.viewingDistanceMm).toBe(Math.round(inchesToMm(24) * 4.5));
  });

  it('sizes an iPad over Sidecar from its logical, not its device, pixels', () => {
    expect(prompterOpticalProfile(defaultAppSettings().optical, ipad)).toBeNull();
    const base = proposal(ipad);
    expect(base.hardwareKind).toBe('ipad-sidecar');
    const sized = withPanelDiagonal(base, viewportOf(ipad), 11)!;
    expect(sized.scale?.mmPerCssPx).toBeCloseTo(inchesToMm(11) / Math.hypot(1194, 834), 9);
    // The iPad's own starting distance, not the generic scaled guess.
    expect(sized.viewingDistanceMm).toBe(1000);
  });

  it('keeps a distance somebody already set, and everything else they chose', () => {
    const corrected = withPanelDiagonal(rulerRig, viewportOf(elgato), 9)!;
    expect(corrected.viewingDistanceMm).toBe(1500);
    expect(corrected.overrides).toEqual({ fontSizePx: 48 });
    expect(corrected.safeArea).toEqual(rulerRig.safeArea);
    expect(corrected.lens).toEqual(rulerRig.lens);
    expect(corrected.completedSteps).toEqual(rulerRig.completedSteps);
    expect(corrected.rigName).toBe('Desk hood');
  });

  it('refuses a diagonal no panel has, or a panel it cannot measure', () => {
    const base = proposal(unknown);
    expect(withPanelDiagonal(base, viewportOf(unknown), 0)).toBeNull();
    expect(withPanelDiagonal(base, viewportOf(unknown), Number.NaN)).toBeNull();
    expect(withPanelDiagonal(base, viewportOf(unknown), -24)).toBeNull();
    // 2,400 inches is a typo, not a stadium screen.
    expect(withPanelDiagonal(base, viewportOf(unknown), 2400)).toBeNull();
    expect(withPanelDiagonal(base, { widthPx: 0, heightPx: 1080 }, 24)).toBeNull();
  });
});

describe('a second named rig on one panel', () => {
  it('copies the rig in force under the new name and chooses it', () => {
    let optical = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, rulerRig);
    expect(rigNameProblem(optical, elgato.fingerprint, 'Standing')).toBeNull();
    optical = withOpticalProfile(optical, elgato.fingerprint, { ...rulerRig, rigName: 'Standing' });

    const names = opticalRigsForDisplay(optical, elgato.fingerprint).map((e) => e.profile.rigName);
    expect(names).toEqual(['Standing', 'Desk hood']);
    const active = activeOpticalProfile(optical, elgato.fingerprint)!;
    expect(active).toEqual({ ...rulerRig, rigName: 'Standing' });
    // The original is untouched by the copy.
    expect(optical.profiles[opticalRigKey(elgato.fingerprint, 'Desk hood')]).toEqual(rulerRig);
  });

  it('refuses an empty name, a reserved one, and one this panel already has', () => {
    const optical = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, rulerRig);
    expect(rigNameProblem(optical, elgato.fingerprint, '   ')).toBe('empty');
    expect(rigNameProblem(optical, elgato.fingerprint, AUTOMATIC_RIG_NAME)).toBe('reserved');
    expect(rigNameProblem(optical, elgato.fingerprint, 'automatic')).toBe('reserved');
    expect(rigNameProblem(optical, elgato.fingerprint, READER_RIG_NAME)).toBe('reserved');
    expect(rigNameProblem(optical, elgato.fingerprint, 'Desk hood')).toBe('duplicate');
    // Two rigs a list cannot tell apart are a duplicate too.
    expect(rigNameProblem(optical, elgato.fingerprint, '  desk HOOD ')).toBe('duplicate');
  });

  it('judges a name only against this panel’s rigs', () => {
    const optical = withOpticalProfile(defaultAppSettings().optical, 'dsp-other', rulerRig);
    expect(rigNameProblem(optical, elgato.fingerprint, 'Desk hood')).toBeNull();
  });
});

describe('switching a panel back to automatic sizing', () => {
  it('stops using the rig without deleting any, and the rig can be chosen again', () => {
    let optical = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, rulerRig);
    optical = withOpticalProfile(optical, elgato.fingerprint, { ...rulerRig, rigName: 'Standing' });
    optical = withoutActiveOpticalRig(optical, elgato.fingerprint);

    expect(activeOpticalProfile(optical, elgato.fingerprint)).toBeNull();
    expect(prompterOpticalProfile(optical, elgato)?.rigName).toBe(AUTOMATIC_RIG_NAME);
    const listed = opticalRigsForDisplay(optical, elgato.fingerprint);
    expect(listed.map((e) => e.profile.rigName)).toEqual(['Desk hood', 'Standing']);
    expect(listed.every((e) => !e.active)).toBe(true);

    optical = withOpticalProfile(optical, elgato.fingerprint, listed[0]!.profile);
    expect(activeOpticalProfile(optical, elgato.fingerprint)).toEqual(rulerRig);
  });

  it('leaves every other panel, the reading rig and the mirroring alone', () => {
    let optical = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, rulerRig);
    optical = withOpticalProfile(optical, 'dsp-other', { ...rulerRig, rigName: 'Other' });
    optical = withOpticalProfile(optical, '', { ...rulerRig, rigName: READER_RIG_NAME });
    optical = withPanelMirror(optical, elgato.fingerprint, { horizontal: true, vertical: false });

    const after = withoutActiveOpticalRig(optical, elgato.fingerprint);
    expect(after.profiles).toEqual(optical.profiles);
    expect(after.panelMirror).toEqual(optical.panelMirror);
    expect(after.activeRig).toEqual({ 'dsp-other': 'Other', '': READER_RIG_NAME });
  });

  it('falls back to the flat layout on a panel that cannot be sized automatically', () => {
    const sized = withPanelDiagonal(proposal(unknown), viewportOf(unknown), 24)!;
    let optical = withOpticalProfile(defaultAppSettings().optical, unknown.fingerprint, sized);
    optical = withoutActiveOpticalRig(optical, unknown.fingerprint);
    expect(stageSettingsFromSettings(prompterSettings(optical), unknown).optics).toBeUndefined();
    expect(opticalRigsForDisplay(optical, unknown.fingerprint)).toHaveLength(1);
  });
});

describe('a rig the wizard saved', () => {
  /**
   * The wizard is being retired and its rigs are not migrated, so the one
   * guarantee that matters is that nothing Settings now does to a panel moves
   * a stored rig's geometry — a ruler scale above all, which no new rig can
   * measure again.
   */
  it('resolves to the same take geometry after every new rig management write', () => {
    // No pinned font size, so the ruler scale is what decides the body size.
    const wizardRig: OpticalProfile = { ...rulerRig, overrides: {} };
    const viewport = viewportOf(elgato);
    const before = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, wizardRig);
    const geometryBefore = resolveStageGeometry({
      profile: prompterOpticalProfile(before, elgato)!,
      viewport,
    });
    const stageBefore = stageSettingsFromSettings(prompterSettings(before), elgato);

    // A sibling rig, corrected by diagonal; the panel switched to automatic;
    // then the wizard's rig chosen again.
    let optical = withOpticalProfile(before, elgato.fingerprint, { ...wizardRig, rigName: 'Standing' });
    const standing = activeOpticalProfile(optical, elgato.fingerprint)!;
    optical = withOpticalProfile(optical, elgato.fingerprint, withPanelDiagonal(standing, viewport, 10)!);
    // The correction landed on the sibling, and only there.
    expect(activeOpticalProfile(optical, elgato.fingerprint)!.scale?.source).toBe('diagonal');
    expect(resolveStageGeometry({ profile: prompterOpticalProfile(optical, elgato)!, viewport })).not.toEqual(
      geometryBefore,
    );
    optical = withoutActiveOpticalRig(optical, elgato.fingerprint);
    const stored = opticalRigsForDisplay(optical, elgato.fingerprint).find(
      (e) => e.profile.rigName === 'Desk hood',
    )!;
    optical = withOpticalProfile(optical, elgato.fingerprint, stored.profile);

    const after = activeOpticalProfile(optical, elgato.fingerprint)!;
    expect(after).toEqual(wizardRig);
    expect(after.scale).toEqual({ mmPerCssPx: 0.1937, source: 'ruler' });
    expect(resolveStageGeometry({ profile: prompterOpticalProfile(optical, elgato)!, viewport })).toEqual(
      geometryBefore,
    );
    expect(stageSettingsFromSettings(prompterSettings(optical), elgato)).toEqual(stageBefore);
  });
});
