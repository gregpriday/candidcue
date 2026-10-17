/**
 * The reader preference: one reader-wide choice of size, spacing, measure,
 * intensity and cue, kept apart from every prompter rig.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * A reading window always runs a profile, and that profile used to be the
 * desk-reading preset and nothing else — so a window ran bias 0.4, intensity
 * 'standard' and cue 'ticks' whatever anybody had chosen, and the controls that
 * looked as though they changed it changed the prompter's fallback instead.
 *
 * The preference is stored as one profile under a key no panel owns, because
 * Rust keeps the `profiles` map as opaque JSON and would drop a new top-level
 * optical field. These tests hold the three things that storage choice could
 * get wrong: it must round-trip, it must never be listed or adopted as a rig,
 * and laying it over the reading rig must change a reading window and nothing
 * a prompter runs.
 *
 * Assertions stop at the PROFILE and the composed `StageSettings`. How the
 * resolver turns `overrides.characters` into a column is the resolver's to
 * test, and is being changed elsewhere.
 */
import { describe, expect, it } from 'vitest';
import {
  activeOpticalProfile,
  defaultAppSettings,
  normalizeOpticalProfile,
  opticalRigKey,
  opticalRigsForDisplay,
  readerOpticalProfile,
  readerPreferenceEquals,
  readerPreferenceFrom,
  readerPreferenceReplacement,
  READER_PREFERENCE_KEY,
  READER_RIG_NAME,
  withOpticalProfile,
  withReaderPreference,
  type AppSettings,
  type OpticalSettings,
} from '../../../src/control/services/settings-types';
import { stageSettingsFromSettings } from '../../../src/control/services/stage-envelope';
import {
  readerCharactersFor,
  readerLineWidthFor,
  stepReaderFontSize,
} from '../../../src/control/lib/stage-appearance';
import { defaultOpticalProfile, type OpticalProfile } from '../../../src/shared/contracts';
import { AUTOMATIC_RIG_NAME } from '../../../src/shared/optical-discovery';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';

const FINGERPRINT = 'panel-1';
const empty = (): OpticalSettings => ({ profiles: {}, activeRig: {}, panelMirror: {} });

/** A 16" MacBook Pro at default scaling. */
const DISPLAY: DisplayDescriptor = {
  id: 'display-1',
  name: 'Built-in Display',
  primary: true,
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 3456, height: 2234 },
  logicalSize: { width: 1728, height: 1117 },
  scaleFactor: 2,
  fingerprint: FINGERPRINT,
  topologyHash: 'topology-1',
};

function glassRig(overrides: Partial<OpticalProfile> = {}): OpticalProfile {
  return {
    ...defaultOpticalProfile(),
    rigName: 'Studio hood',
    scale: { mmPerCssPx: 0.2, source: 'model' },
    viewingDistanceMm: 2500,
    flips: { horizontal: true, vertical: false },
    ...overrides,
  };
}

function settingsWith(
  optical: OpticalSettings,
  mode: 'prompter' | 'reader',
  teleprompter: Partial<AppSettings['teleprompter']> = {},
): AppSettings {
  const base = defaultAppSettings();
  return {
    ...base,
    stage: { ...base.stage, presentationMode: mode },
    teleprompter: { ...base.teleprompter, ...teleprompter },
    optical,
  };
}

/* ------------------------------------------------------------------ storage */

describe('storing the reader preference', () => {
  it('reads nothing when nothing was ever chosen', () => {
    expect(readerPreferenceFrom(empty())).toEqual({});
  });

  it('round-trips every field it was given, and only those', () => {
    const chosen = {
      fontSizePx: 34,
      lineHeight: 1.5,
      characters: 55,
      intensity: 'soft' as const,
      readingCue: 'wash' as const,
    };
    expect(readerPreferenceFrom(withReaderPreference(empty(), chosen))).toEqual(chosen);
    // Absent stays absent: a size alone must not freeze a default intensity
    // beside it, or Settings' intensity would stop reaching the window.
    expect(readerPreferenceFrom(withReaderPreference(empty(), { fontSizePx: 34 }))).toEqual({
      fontSizePx: 34,
    });
  });

  it('keeps intensity and cue independent of each other', () => {
    /*
     * A profile always carries both, so their values cannot say whether
     * anybody chose them. Choosing a cue must not quietly choose an intensity.
     */
    const cueOnly = withReaderPreference(empty(), { readingCue: 'none' });
    expect(readerPreferenceFrom(cueOnly)).toEqual({ readingCue: 'none' });
    const intensityOnly = withReaderPreference(empty(), { intensity: 'strong' });
    expect(readerPreferenceFrom(intensityOnly)).toEqual({ intensity: 'strong' });
  });

  it('stores a complete profile, so the store keeps it on the way back in', () => {
    // `opticalFromStored` drops any entry that does not normalize.
    const optical = withReaderPreference(empty(), { fontSizePx: 34, readingCue: 'wash' });
    const stored = optical.profiles[READER_PREFERENCE_KEY];
    expect(normalizeOpticalProfile(stored)).toEqual(stored);
    expect(stored?.lensPlacement).toBe('none');
    expect(stored?.flips).toEqual({ horizontal: false, vertical: false });
  });

  it('clears a field with null and leaves an absent one alone', () => {
    const start = withReaderPreference(empty(), { fontSizePx: 34, characters: 75 });
    const next = withReaderPreference(start, { characters: null, lineHeight: 1.6 });
    expect(readerPreferenceFrom(next)).toEqual({ fontSizePx: 34, lineHeight: 1.6 });
  });

  it('removes the entry once nothing is left in it', () => {
    // "Never touched" and "put everything back" are the same document.
    const start = withReaderPreference(empty(), { fontSizePx: 34 });
    const cleared = withReaderPreference(start, { fontSizePx: null });
    expect(cleared.profiles).toEqual({});
  });

  it('holds values inside their ranges on the way in', () => {
    const optical = withReaderPreference(empty(), {
      fontSizePx: 400,
      lineHeight: 3,
      characters: 5,
    });
    expect(readerPreferenceFrom(optical)).toEqual({ fontSizePx: 96, lineHeight: 1.8, characters: 30 });
    expect(
      readerPreferenceFrom(withReaderPreference(empty(), { fontSizePx: 4, characters: 400 })),
    ).toEqual({ fontSizePx: 20, characters: 90 });
  });

  it('repairs a malformed stored preference on the way out', () => {
    // A hand-edited store must not hand a reading window 4 px type.
    const carrier = {
      ...defaultOpticalProfile(),
      rigName: READER_RIG_NAME,
      lensPlacement: 'none' as const,
      overrides: { fontSizePx: 4, lineHeight: 9 },
    };
    const optical: OpticalSettings = {
      ...empty(),
      profiles: { [READER_PREFERENCE_KEY]: carrier },
    };
    expect(readerPreferenceFrom(optical)).toEqual({ fontSizePx: 20, lineHeight: 1.8 });
  });

  it('lets a chosen measure win over a stored reading rig’s column pin', () => {
    // The resolver ranks an explicit `columnCh` above a character count, so a
    // stored rig carrying one would otherwise make Narrower and Wider inert.
    const storedRig = {
      ...defaultOpticalProfile(),
      rigName: READER_RIG_NAME,
      lensPlacement: 'none' as const,
      overrides: { columnCh: 30, fontSizePx: 40 },
    };
    const rigged: OpticalSettings = {
      ...empty(),
      profiles: { [opticalRigKey(FINGERPRINT, READER_RIG_NAME)]: storedRig },
    };
    expect(readerOpticalProfile(rigged, FINGERPRINT).overrides.columnCh).toBe(30);
    const wider = withReaderPreference(rigged, { characters: 75 });
    const composed = readerOpticalProfile(wider, FINGERPRINT);
    expect(composed.overrides.characters).toBe(75);
    expect(composed.overrides.columnCh).toBeUndefined();
    // Only the composition drops it: the stored rig is untouched.
    expect(wider.profiles[opticalRigKey(FINGERPRINT, READER_RIG_NAME)]).toEqual(storedRig);
  });

  it('drops a choice that is not one of the offered values', () => {
    const optical = withReaderPreference(empty(), {
      intensity: 'blinding' as never,
      readingCue: 'laser' as never,
      fontSizePx: Number.NaN,
    });
    expect(readerPreferenceFrom(optical)).toEqual({});
  });

  it('leaves every rig, choice and mirror exactly where it was', () => {
    const rigged = {
      ...withOpticalProfile(empty(), FINGERPRINT, glassRig()),
      panelMirror: { [FINGERPRINT]: { horizontal: true, vertical: false } },
    };
    const next = withReaderPreference(rigged, { fontSizePx: 34 });
    expect(next.activeRig).toEqual(rigged.activeRig);
    expect(next.panelMirror).toEqual(rigged.panelMirror);
    expect(next.profiles[opticalRigKey(FINGERPRINT, 'Studio hood')]).toEqual(
      rigged.profiles[opticalRigKey(FINGERPRINT, 'Studio hood')],
    );
  });
});

/* ------------------------------------------------------ never a rig of a panel */

describe('the stored preference is never a rig', () => {
  const optical = withReaderPreference(withOpticalProfile(empty(), FINGERPRINT, glassRig()), {
    fontSizePx: 34,
  });

  it('is not listed in any panel’s rig picker', () => {
    expect(opticalRigsForDisplay(optical, FINGERPRINT).map((r) => r.profile.rigName)).toEqual([
      'Studio hood',
    ]);
    expect(opticalRigsForDisplay(optical, '')).toEqual([]);
    expect(opticalRigsForDisplay(optical, null)).toEqual([]);
  });

  it('is not adopted as any panel’s prompter rig', () => {
    // Only the panel that chose a rig has one in force.
    expect(Object.keys(optical.activeRig)).toEqual([FINGERPRINT]);
    expect(activeOpticalProfile(optical, '')).toBeNull();
    expect(activeOpticalProfile(optical, FINGERPRINT)?.rigName).toBe('Studio hood');
  });

  it('is not adopted as a panel’s stored reading rig either', () => {
    /*
     * A reading rig is stored per panel; the preference lives under no panel.
     * So the rig a reading window runs is the one it would have run anyway,
     * with only the preference's overrides on top.
     */
    const without = withOpticalProfile(empty(), FINGERPRINT, glassRig());
    const { overrides, ...rest } = readerOpticalProfile(optical, FINGERPRINT);
    const { overrides: untouched, ...expected } = readerOpticalProfile(without, FINGERPRINT);
    expect(rest).toEqual(expected);
    expect(untouched).toEqual({});
    expect(overrides).toEqual({ fontSizePx: 34 });
  });
});

/* ----------------------------------------------- laid over the reading rig */

describe('the reading rig, with the preference over it', () => {
  it('carries size, spacing and measure as overrides', () => {
    const optical = withReaderPreference(empty(), {
      fontSizePx: 34,
      lineHeight: 1.5,
      characters: 55,
    });
    expect(readerOpticalProfile(optical, FINGERPRINT).overrides).toEqual({
      fontSizePx: 34,
      lineHeight: 1.5,
      characters: 55,
    });
  });

  it('keeps borrowing the panel’s scale live, rather than freezing it', () => {
    /*
     * The preference is a separate entry, so the derived profile still reads
     * whatever rig the panel has NOW. A scale recalibrated after the preference
     * was saved has to reach the reading window.
     */
    const withPreference = withReaderPreference(empty(), { fontSizePx: 34 });
    const first = withOpticalProfile(withPreference, FINGERPRINT, glassRig());
    expect(readerOpticalProfile(first, FINGERPRINT).scale?.mmPerCssPx).toBe(0.2);
    const recalibrated = withOpticalProfile(
      withPreference,
      FINGERPRINT,
      glassRig({ scale: { mmPerCssPx: 0.25, source: 'diagonal' } }),
    );
    expect(readerOpticalProfile(recalibrated, FINGERPRINT).scale?.mmPerCssPx).toBe(0.25);
  });

  it('starts a derived profile from the seed, and lets the preference outrank it', () => {
    const seed = { intensity: 'strong' as const, readingCue: 'wash' as const };
    const seeded = readerOpticalProfile(empty(), FINGERPRINT, seed);
    expect(seeded.intensity).toBe('strong');
    expect(seeded.readingCue).toBe('wash');

    const chosen = withReaderPreference(empty(), { intensity: 'soft' });
    const profile = readerOpticalProfile(chosen, FINGERPRINT, seed);
    expect(profile.intensity).toBe('soft');
    // The cue was never chosen, so the seed still decides it.
    expect(profile.readingCue).toBe('wash');
  });

  it('lets a stored reading rig keep its own calibrated choice over the seed', () => {
    const stored: OpticalProfile = {
      ...defaultOpticalProfile(),
      rigName: READER_RIG_NAME,
      lensPlacement: 'none',
      viewingDistanceMm: 700,
      intensity: 'soft',
      readingCue: 'none',
    };
    const optical: OpticalSettings = {
      ...empty(),
      profiles: { [opticalRigKey(FINGERPRINT, READER_RIG_NAME)]: stored },
    };
    const seed = { intensity: 'strong' as const, readingCue: 'wash' as const };
    expect(readerOpticalProfile(optical, FINGERPRINT, seed).intensity).toBe('soft');
    expect(readerOpticalProfile(optical, FINGERPRINT, seed).readingCue).toBe('none');
    // ...and the reader preference still outranks the rig.
    const chosen = withReaderPreference(optical, { intensity: 'strong', fontSizePx: 40 });
    const profile = readerOpticalProfile(chosen, FINGERPRINT, seed);
    expect(profile.intensity).toBe('strong');
    expect(profile.viewingDistanceMm).toBe(700);
    expect(profile.overrides.fontSizePx).toBe(40);
  });
});

/* -------------------------------------------------- what a take is composed */

describe('what a reading window is sent', () => {
  it('honours Settings › Teleprompter intensity and cue', () => {
    /*
     * The control looked live and was ignored: `buildStageSettings` takes both
     * off the profile, and the reading profile never heard of them.
     */
    const reader = stageSettingsFromSettings(
      settingsWith(empty(), 'reader', { textIntensity: 'strong', readingCue: 'wash' }),
      DISPLAY,
    );
    expect(reader.textIntensity).toBe('strong');
    expect(reader.readingCue).toBe('wash');
  });

  it('changes nothing for somebody who never touched either', () => {
    const reader = stageSettingsFromSettings(settingsWith(empty(), 'reader'), DISPLAY);
    expect(reader.textIntensity).toBe('standard');
    expect(reader.readingCue).toBe('ticks');
    expect(reader.opticalProfile?.overrides).toEqual({});
  });

  it('carries the preference to the stage, in the profile it re-resolves from', () => {
    const optical = withReaderPreference(empty(), {
      fontSizePx: 40,
      lineHeight: 1.6,
      characters: 55,
      intensity: 'soft',
    });
    const reader = stageSettingsFromSettings(
      settingsWith(optical, 'reader', { textIntensity: 'strong' }),
      DISPLAY,
    );
    expect(reader.opticalProfile?.overrides).toEqual({
      fontSizePx: 40,
      lineHeight: 1.6,
      characters: 55,
    });
    // Size and spacing are honoured by control's own resolve too, so the flat
    // twins — and the sheet that reads them — agree with the stage.
    expect(reader.fontSizePx).toBe(40);
    expect(reader.lineHeight).toBe(1.6);
    expect(reader.textIntensity).toBe('soft');
  });

  it('does not take the prompter’s size bias', () => {
    // Shared by every automatically sized prompter display, and not a reader's.
    const reader = stageSettingsFromSettings(
      settingsWith(empty(), 'reader', { sizeBias: 0.9 }),
      DISPLAY,
    );
    expect(reader.opticalProfile?.bias).toBe(defaultOpticalProfile().bias);
  });

  it('leaves a prompter take exactly as it was, automatic or calibrated', () => {
    const everything = {
      fontSizePx: 40,
      lineHeight: 1.6,
      characters: 55,
      intensity: 'soft' as const,
      readingCue: 'none' as const,
    };
    const rigged = withOpticalProfile(empty(), FINGERPRINT, glassRig());
    for (const optical of [empty(), rigged]) {
      const preferred = withReaderPreference(optical, everything);
      expect(stageSettingsFromSettings(settingsWith(preferred, 'prompter'), DISPLAY)).toEqual(
        stageSettingsFromSettings(settingsWith(optical, 'prompter'), DISPLAY),
      );
    }
  });

  /*
   * The guard above runs on a display that reports no millimetres, so its
   * empty-optical case is the uncalibrated prompter, not the automatic one. A
   * panel that reports its own size is what builds the automatic profile, and
   * that is the prompter most people actually run — so it gets its own guard,
   * with the fixture's premise asserted before the behaviour is.
   */
  it('leaves an automatically sized prompter take exactly as it was', () => {
    const measured: DisplayDescriptor = {
      ...DISPLAY,
      name: 'Studio Display',
      physicalSizeMm: { width: 597, height: 336 },
      physicalSize: { width: 5120, height: 2880 },
      logicalSize: { width: 2560, height: 1440 },
    };
    const before = stageSettingsFromSettings(settingsWith(empty(), 'prompter'), measured);
    expect(before.opticalProfile?.rigName, 'the fixture must build the automatic profile').toBe(
      AUTOMATIC_RIG_NAME,
    );
    expect(before.readingContext).toBeUndefined();
    const preferred = withReaderPreference(empty(), {
      fontSizePx: 40,
      lineHeight: 1.6,
      characters: 55,
      intensity: 'soft',
      readingCue: 'none',
    });
    expect(stageSettingsFromSettings(settingsWith(preferred, 'prompter'), measured)).toEqual(before);
  });
});

/* ------------------------------------------------------------- the helpers */

describe('the helpers the sheet uses', () => {
  it('replaces a preference exactly, clearing what the new one lacks', () => {
    const start = withReaderPreference(empty(), { fontSizePx: 40, characters: 75 });
    const replaced = withReaderPreference(start, readerPreferenceReplacement({ lineHeight: 1.4 }));
    expect(readerPreferenceFrom(replaced)).toEqual({ lineHeight: 1.4 });
  });

  it('compares line height within half a step', () => {
    expect(readerPreferenceEquals({ lineHeight: 1.33 }, { lineHeight: 1.3300000000000003 })).toBe(
      true,
    );
    expect(readerPreferenceEquals({ lineHeight: 1.33 }, {})).toBe(false);
    expect(readerPreferenceEquals({ fontSizePx: 30 }, { fontSizePx: 32 })).toBe(false);
  });

  it('maps the three line widths to a measure and back', () => {
    expect(readerCharactersFor('narrower')).toBe(55);
    expect(readerCharactersFor('standard')).toBeNull();
    expect(readerCharactersFor('wider')).toBe(75);
    expect(readerLineWidthFor(null)).toBe('standard');
    expect(readerLineWidthFor(55)).toBe('narrower');
    expect(readerLineWidthFor(75)).toBe('wider');
  });

  it('steps a reading window’s size inside the reader’s range', () => {
    expect(stepReaderFontSize(30, 2)).toBe(32);
    expect(stepReaderFontSize(95, 2)).toBe(96);
    expect(stepReaderFontSize(21, -2)).toBe(20);
  });
});
