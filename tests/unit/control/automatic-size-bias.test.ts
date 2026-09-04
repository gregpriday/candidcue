/**
 * The size/measure bias, on a panel nobody calibrated.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS ABOUT
 * ---------------------------------------------------------------------------
 * On a fixed panel, type size and reading measure are one control, not two:
 * bigger type is fewer characters per line. `optics.ts` builds the whole width
 * system around that trade and gives it a single slider — "more text on screen"
 * at 0, "larger, easier text" at 1.
 *
 * The slider reached a rig somebody had calibrated. It did not reach the
 * AUTOMATIC profile, which is what a recognised panel actually prompts with, and
 * which is rebuilt from scratch on every take precisely so it can never go
 * stale — leaving it nowhere to keep a preference. So a presenter on a 9-inch
 * Prompter who wanted a wider line had exactly one route to it: edit a control
 * on the Settings panel, which STORES a rig, freezing discovery's *estimated*
 * 1.2 m into a saved calibration. They gave up automatic sizing to ask a
 * question about type.
 *
 * These are the numbers from the panel that prompted the change: a 9-inch
 * Elgato Prompter at 1024x600, the automatic profile, the real resolver.
 */
import { describe, expect, it } from 'vitest';
import { stageSettingsFromSettings } from '../../../src/control/services/stage-envelope';
import {
  defaultAppSettings,
  opticalRigKey,
} from '../../../src/control/services/settings-types';
import { defaultOpticalProfile } from '../../../src/shared/contracts';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import { AUTOMATIC_RIG_NAME } from '../../../src/shared/optical-discovery';
import { ANGULAR_SOFT_FLOOR_ARCMIN } from '../../../src/shared/optics';

/** The panel this change came from: a 9-inch Prompter, landed on and recognised. */
function prompter9(): DisplayDescriptor {
  return {
    id: 'display-2',
    name: 'Elgato Prompter',
    primary: false,
    physicalPosition: { x: 1728, y: 0 },
    physicalSize: { width: 1024, height: 600 },
    logicalSize: { width: 1024, height: 600 },
    scaleFactor: 1,
    fingerprint: 'elgato-9-fingerprint',
    topologyHash: 'topology-1',
  };
}

function settingsWithBias(sizeBias: number) {
  const base = defaultAppSettings();
  return { ...base, teleprompter: { ...base.teleprompter, sizeBias } };
}

/** What a take on this panel would actually put on the glass. */
function opticsFor(sizeBias: number) {
  const settings = stageSettingsFromSettings(settingsWithBias(sizeBias), prompter9());
  const optics = settings.optics;
  expect(optics, 'a recognised Prompter must resolve an optical block').toBeDefined();
  return optics!;
}

describe('the size bias on an automatic panel', () => {
  it('reaches the glass without storing a rig', () => {
    /*
     * The whole point. Both takes run on the automatic profile — no rig is
     * stored, none is chosen — and they put measurably different amounts of the
     * script on the same panel.
     */
    const wide = opticsFor(0);
    const large = opticsFor(1);

    expect(wide.charactersPerLine).not.toBeNull();
    expect(large.charactersPerLine).not.toBeNull();
    expect(wide.charactersPerLine!).toBeGreaterThan(large.charactersPerLine! + 5);
    expect(wide.bodyFontSizePx).toBeLessThan(large.bodyFontSizePx);
  });

  it('buys about five more characters a line than the default, on the panel it came from', () => {
    /*
     * Pinned as a RANGE, not a number: the exact figure moves with the DIN
     * fallback metrics and the angular ladder, and pinning it exactly would
     * turn an unrelated tuning change into a failure here. What must not move
     * is that the control is worth reaching for — a line that holds a third
     * more of the sentence is the difference the presenter reported.
     */
    const shipped = opticsFor(defaultOpticalProfile().bias).charactersPerLine!;
    const wide = opticsFor(0).charactersPerLine!;

    expect(shipped).toBeGreaterThan(29);
    expect(shipped).toBeLessThan(34);
    expect(wide).toBeGreaterThan(34);
    expect(wide - shipped).toBeGreaterThan(4);
  });

  it('never trades legibility for width past the point the model refuses', () => {
    /*
     * The bias is a preference, and a preference must not be able to walk the
     * type under the floor the vision-science evidence puts it at. The bottom of
     * the ladder is a PRESET (`compact`, 20'), comfortably above the 18' soft
     * floor — so the widest line this control can ask for is still one the app
     * is willing to call readable.
     */
    const wide = opticsFor(0);
    expect(wide.bodyArcminutes).not.toBeNull();
    expect(wide.bodyArcminutes!).toBeGreaterThanOrEqual(ANGULAR_SOFT_FLOOR_ARCMIN);
  });

  it('leaves the shipped default exactly where it was', () => {
    /*
     * Nobody who does not touch the slider may notice this change. The loose
     * default is the same value a fresh profile carries, so the automatic
     * profile resolves to what it always did.
     */
    const untouched = stageSettingsFromSettings(defaultAppSettings(), prompter9()).optics!;
    const explicit = opticsFor(defaultOpticalProfile().bias);
    expect(untouched.bodyFontSizePx).toBe(explicit.bodyFontSizePx);
    expect(untouched.charactersPerLine).toBe(explicit.charactersPerLine);
  });

  it('is still the automatic profile, not a rig in its clothing', () => {
    const settings = stageSettingsFromSettings(settingsWithBias(0), prompter9());
    /*
     * The appearance sheet and the take summary tell automatic from calibrated
     * by this name, and the wizard refuses it — so a seeded preference must not
     * be able to make a take claim it was measured.
     */
    expect(settings.opticalProfile?.rigName).toBe(AUTOMATIC_RIG_NAME);
  });
});

describe('a calibrated rig is not overruled by a loose preference', () => {
  it('keeps the bias somebody chose at the glass', () => {
    /*
     * The rule the optical layer is built on: a measurement beats a guess, and
     * a rig's own `bias` was chosen standing at that rig. A stored, CHOSEN rig
     * therefore ignores the loose value entirely — otherwise a preference set
     * for a 9-inch panel would quietly resize a calibrated 15.6-inch one.
     */
    const display = prompter9();
    const rigName = 'Desk hood';
    const profile = {
      ...defaultOpticalProfile(),
      rigName,
      hardwareKind: 'elgato-prompter' as const,
      scale: {
        mmPerCssPx: (9 * 25.4) / Math.hypot(1024, 600),
        source: 'ruler' as const,
        diagonalMm: 9 * 25.4,
      },
      viewingDistanceMm: 1200,
      bias: 1,
    };
    const base = defaultAppSettings();
    const settings = {
      ...base,
      teleprompter: { ...base.teleprompter, sizeBias: 0 },
      optical: {
        profiles: { [opticalRigKey(display.fingerprint, rigName)]: profile },
        activeRig: { [display.fingerprint]: rigName },
      },
    };

    const resolved = stageSettingsFromSettings(settings, display);
    expect(resolved.opticalProfile?.rigName).toBe(rigName);
    // The rig's own 1, not the loose 0: large type, few characters.
    const wideOnAutomatic = opticsFor(0).charactersPerLine!;
    expect(resolved.optics!.charactersPerLine!).toBeLessThan(wideOnAutomatic - 5);
  });
});
