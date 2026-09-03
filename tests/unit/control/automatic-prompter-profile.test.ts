/**
 * Automatic sizing: a prompter take on a panel nobody has calibrated is sized
 * from the panel, not from a flat 64px.
 *
 * The three answers `prompterOpticalProfile` can give are pinned here in
 * order of precedence — a chosen rig, then the automatic profile, then nothing
 * — because the order is the whole design: measurements beat a table, a table
 * beats a guess, and a guess must still say it is one.
 */
import { describe, expect, it } from 'vitest';
import {
  prompterOpticalProfile,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import {
  defaultAppSettings,
  withOpticalProfile,
  type AppSettings,
} from '../../../src/control/services/settings-types';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import { defaultOpticalProfile } from '../../../src/shared/contracts/optical';
import { AUTOMATIC_RIG_NAME } from '../../../src/shared/optical-discovery';
import { UNCALIBRATED_FONT_SIZE_PX } from '../../../src/shared/optical-resolve';

function display(over: Partial<DisplayDescriptor> & { fingerprint: string }): DisplayDescriptor {
  return {
    id: 'display-1',
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 1024, height: 600 },
    scaleFactor: 1,
    logicalSize: { width: 1024, height: 600 },
    primary: false,
    topologyHash: 'top-test',
    ...over,
  };
}

const elgato = display({ name: 'Elgato Prompter', fingerprint: 'dsp-elgato' });

/** An ordinary monitor: no recognisable name, but it reports its EDID size. */
const monitor = display({
  name: 'DELL U2720Q',
  fingerprint: 'dsp-dell',
  physicalSize: { width: 3840, height: 2160 },
  scaleFactor: 2,
  logicalSize: { width: 1920, height: 1080 },
  physicalSizeMm: { width: 597, height: 336 },
});

/** The same monitor through an adapter that reports no size at all. */
const mute = display({
  name: 'DELL U2720Q',
  fingerprint: 'dsp-dell-mute',
  physicalSize: { width: 3840, height: 2160 },
  scaleFactor: 2,
  logicalSize: { width: 1920, height: 1080 },
});

function prompterSettings(): AppSettings {
  const s = defaultAppSettings();
  return { ...s, stage: { ...s.stage, presentationMode: 'prompter' } };
}

describe('prompterOpticalProfile', () => {
  it('builds the automatic profile for a recognised panel with no chosen rig', () => {
    const profile = prompterOpticalProfile(defaultAppSettings().optical, elgato);
    expect(profile?.rigName).toBe(AUTOMATIC_RIG_NAME);
    expect(profile?.hardwareKind).toBe('elgato-prompter');
    expect(profile?.viewingDistanceMm).toBe(1200);
  });

  it('builds one for an ordinary monitor from the size it reports', () => {
    const profile = prompterOpticalProfile(defaultAppSettings().optical, monitor);
    expect(profile?.rigName).toBe(AUTOMATIC_RIG_NAME);
    expect(profile?.scale?.source).toBe('display');
    expect(profile?.viewingDistanceMm).toBeGreaterThan(0);
  });

  it('gives a chosen rig precedence over the automatic one', () => {
    const rig = {
      ...defaultOpticalProfile(),
      rigName: 'Boom arm',
      scale: { mmPerCssPx: 0.21, source: 'ruler' as const },
      viewingDistanceMm: 1650,
    };
    const optical = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, rig);
    const profile = prompterOpticalProfile(optical, elgato);
    expect(profile?.rigName).toBe('Boom arm');
    expect(profile?.viewingDistanceMm).toBe(1650);
  });

  it('does not adopt a rig that is stored but not chosen', () => {
    const rig = { ...defaultOpticalProfile(), rigName: 'Boom arm', viewingDistanceMm: 1650 };
    const chosen = withOpticalProfile(defaultAppSettings().optical, elgato.fingerprint, rig);
    // Forget the choice, keep the rig.
    const optical = { ...chosen, activeRig: {} };
    expect(prompterOpticalProfile(optical, elgato)?.rigName).toBe(AUTOMATIC_RIG_NAME);
  });

  it('answers nothing for a panel it cannot size, and for no panel', () => {
    expect(prompterOpticalProfile(defaultAppSettings().optical, mute)).toBeNull();
    expect(prompterOpticalProfile(defaultAppSettings().optical, null)).toBeNull();
    expect(prompterOpticalProfile(defaultAppSettings().optical, undefined)).toBeNull();
  });
});

describe('stageSettingsFromSettings on an unrigged panel', () => {
  it('sizes a prompter take on the Elgato from its optics rather than the flat default', () => {
    const settings = stageSettingsFromSettings(prompterSettings(), elgato);
    expect(settings.optics).toBeDefined();
    expect(settings.optics?.calibrated).toBe(true);
    expect(settings.optics?.mmPerCssPx).toBeGreaterThan(0);
    expect(settings.optics?.viewingDistanceMm).toBe(1200);
    expect(settings.opticalProfile?.rigName).toBe(AUTOMATIC_RIG_NAME);
    // The flat fields are the resolved values, so old and new readers agree.
    expect(settings.fontSizePx).toBe(Math.round(settings.optics?.bodyFontSizePx ?? 0));
    expect(settings.fontSizePx).not.toBe(UNCALIBRATED_FONT_SIZE_PX);
  });

  it('sizes an ordinary monitor from the millimetres it reports', () => {
    const settings = stageSettingsFromSettings(prompterSettings(), monitor);
    expect(settings.optics?.calibrated).toBe(true);
    expect(settings.opticalProfile?.scale?.source).toBe('display');
  });

  it('keeps the honest uncalibrated layout for a panel it cannot size', () => {
    const settings = stageSettingsFromSettings(prompterSettings(), mute);
    expect(settings.optics).toBeUndefined();
    expect(settings.opticalProfile).toBeUndefined();
    expect(settings.fontSizePx).toBe(prompterSettings().teleprompter.fontSizePx);
  });

  it('keeps the intensity and reading cue the presenter chose', () => {
    const s = prompterSettings();
    const soft = {
      ...s,
      teleprompter: { ...s.teleprompter, textIntensity: 'soft' as const, readingCue: 'wash' as const },
    };
    const settings = stageSettingsFromSettings(soft, elgato);
    expect(settings.opticalProfile?.rigName).toBe(AUTOMATIC_RIG_NAME);
    expect(settings.textIntensity).toBe('soft');
    expect(settings.readingCue).toBe('wash');
  });

  it('still takes the mirror from Settings, as every rig does', () => {
    const s = prompterSettings();
    const mirrored = { ...s, teleprompter: { ...s.teleprompter, mirrorX: true } };
    expect(stageSettingsFromSettings(mirrored, elgato).mirrorX).toBe(true);
    expect(stageSettingsFromSettings(s, elgato).mirrorX).toBe(false);
  });

  it('produces different type for different glass, which is the point', () => {
    const small = stageSettingsFromSettings(prompterSettings(), elgato);
    const large = stageSettingsFromSettings(prompterSettings(), monitor);
    expect(small.optics?.bodyFontSizePx).not.toBe(large.optics?.bodyFontSizePx);
    // Both land at a readable angular size for their assumed distance.
    for (const settings of [small, large]) {
      expect(settings.optics?.bodyArcminutes ?? 0).toBeGreaterThanOrEqual(16);
    }
  });

  it('leaves reader mode on its own rig, untouched by automatic sizing', () => {
    const s = prompterSettings();
    const reader = { ...s, stage: { ...s.stage, presentationMode: 'reader' as const } };
    const settings = stageSettingsFromSettings(reader, elgato);
    expect(settings.readingContext).toBe('reader');
    expect(settings.opticalProfile?.rigName).not.toBe(AUTOMATIC_RIG_NAME);
  });
});
