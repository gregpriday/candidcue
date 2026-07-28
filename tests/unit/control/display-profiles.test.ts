/**
 * Display profile service contract and selection logic (spec §52, §46.6).
 *
 * A row is now the durable record of what a panel last ran with, written by
 * `lib/start-take.ts` and carrying the `opticalProfile` a calibration produced.
 * These tests pin the wire shape, the selection logic, and the projection back
 * out — which is the path a cleared localStorage overlay recovers through.
 *
 * MOCK CAVEAT: `saveDisplayProfile` has an `invokeOrMock` fallback for
 * browser dev. Every assertion below either stubs `ipc` and inspects the real
 * payload, or exercises a pure function — none is satisfied by the fallback.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/stage-command-payloads.json';
import { defaultOpticalProfile } from '../../../src/shared/contracts';
import type { ResolvedOptics, StageSettings } from '../../../src/shared/contracts';
import type { DisplayProfileRecord } from '../../../src/control/services/display-profiles';

const calls: { command: string; payload: unknown }[] = [];
let nextResult: unknown = null;

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  invokeOrMock: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return nextResult;
  },
  BackendUnavailableError: class extends Error {},
}));

const profiles = await import('../../../src/control/services/display-profiles');

const stage: StageSettings = fixture.save_display_profile.profile.stage as StageSettings;

function record(overrides: Partial<DisplayProfileRecord> = {}): DisplayProfileRecord {
  return { ...(fixture.expectedSavedProfile as DisplayProfileRecord), ...overrides };
}

describe('display profile IPC payloads', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = fixture.expectedSavedProfile;
  });

  /**
   * Rust takes `profile: DisplayProfile`, so the payload is `{ profile }` —
   * not the profile's fields at the top level, which would deserialize to a
   * missing argument.
   */
  it('save_display_profile nests the profile under `profile`', async () => {
    await profiles.saveDisplayProfile({
      name: 'Teleprompter Display',
      displayFingerprint: 'dsp-mock-prompter',
      stage,
    });
    expect(calls[0]!.command).toBe('save_display_profile');
    expect(calls[0]!.payload).toEqual(fixture.save_display_profile);
  });

  it('omits id on create so Rust mints one, and never sends updatedAt', async () => {
    await profiles.saveDisplayProfile({ name: 'Stage', displayFingerprint: 'dsp', stage });
    const sent = (calls[0]!.payload as { profile: Record<string, unknown> }).profile;
    expect(Object.keys(sent)).not.toContain('id');
    expect(Object.keys(sent)).not.toContain('updatedAt');
  });

  it('sends the id back when updating an existing profile', async () => {
    await profiles.saveDisplayProfile({ id: 'abc', name: 'Stage', stage });
    const sent = (calls[0]!.payload as { profile: { id?: string } }).profile;
    expect(sent.id).toBe('abc');
  });

  it('list_display_profiles takes no arguments', async () => {
    nextResult = [fixture.expectedSavedProfile];
    const list = await profiles.listDisplayProfiles();
    expect(calls[0]!.command).toBe('list_display_profiles');
    expect(calls[0]!.payload).toBeUndefined();
    expect(list[0]!.id).toBe(fixture.expectedSavedProfile.id);
  });

  /**
   * The three rejections are Rust's (windows::save_display_profile). Checking
   * them here means a bad profile never becomes a round trip that fails with
   * a backend error the user cannot act on.
   */
  it('refuses the profiles Rust would reject, without calling it', async () => {
    const rejected = fixture.rejectedProfiles;
    await expect(
      profiles.saveDisplayProfile({ name: rejected.emptyName.name, stage }),
    ).rejects.toThrow(/needs a name/);
    await expect(
      profiles.saveDisplayProfile({
        name: 'Stage',
        stage: rejected.wrongSchemaVersion.stage as unknown as StageSettings,
      }),
    ).rejects.toThrow(/schema version/);
    await expect(
      profiles.saveDisplayProfile({
        name: 'Stage',
        stage: rejected.stageNotAnObject.stage as unknown as StageSettings,
      }),
    ).rejects.toThrow(/must be an object/);
    expect(calls).toHaveLength(0);
  });

  it('trims the name so the stored row and the UI agree', async () => {
    await profiles.saveDisplayProfile({ name: '  Stage  ', stage });
    const sent = (calls[0]!.payload as { profile: { name: string } }).profile;
    expect(sent.name).toBe('Stage');
  });
});

describe('choosing the profile for a display', () => {
  /**
   * Fingerprint is panel identity and survives rearranging or rescaling
   * displays; `topologyHash` does not. Matching on anything else is how a
   * profile ends up applied to the wrong monitor.
   */
  it('matches on display fingerprint only', () => {
    const list = [
      record({ id: 'a', displayFingerprint: 'dsp-1' }),
      record({ id: 'b', displayFingerprint: 'dsp-2' }),
    ];
    expect(profiles.profileForDisplay(list, 'dsp-2')!.id).toBe('b');
    expect(profiles.profileForDisplay(list, 'dsp-3')).toBeNull();
    expect(profiles.profileForDisplay(list, null)).toBeNull();
  });

  it('never auto-applies a profile with no fingerprint', () => {
    const list = [record({ id: 'general', displayFingerprint: undefined })];
    expect(profiles.profileForDisplay(list, 'dsp-1')).toBeNull();
  });

  it('prefers the most recently updated match', () => {
    const list = [
      record({ id: 'old', displayFingerprint: 'dsp-1', updatedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'new', displayFingerprint: 'dsp-1', updatedAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(profiles.profileForDisplay(list, 'dsp-1')!.id).toBe('new');
  });

  /**
   * One panel, several mounting arrangements. The desk hood and the boom arm
   * share a fingerprint, so a picker that could only ever see the newest row
   * would make the other arrangement unrecoverable the moment somebody moved
   * the hardware back.
   */
  it('returns every rig saved for the panel, newest first', () => {
    const list = [
      record({ id: 'boom', displayFingerprint: 'dsp-1', updatedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'other-panel', displayFingerprint: 'dsp-2', updatedAt: '2026-07-02T00:00:00Z' }),
      record({ id: 'desk', displayFingerprint: 'dsp-1', updatedAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(profiles.profilesForDisplay(list, 'dsp-1').map((p) => p.id)).toEqual(['desk', 'boom']);
    expect(profiles.profilesForDisplay(list, 'dsp-3')).toEqual([]);
    expect(profiles.profilesForDisplay(list, null)).toEqual([]);
  });

  it('agrees with the single-profile default it backs', () => {
    const list = [
      record({ id: 'boom', displayFingerprint: 'dsp-1', updatedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'desk', displayFingerprint: 'dsp-1', updatedAt: '2026-07-01T00:00:00Z' }),
    ];
    expect(profiles.profileForDisplay(list, 'dsp-1')).toBe(profiles.profilesForDisplay(list, 'dsp-1')[0]);
  });

  it('does not reorder the caller’s array in place', () => {
    // The list comes straight out of `listDisplayProfiles`, which the caller may
    // hold on to; sorting it under them is the kind of shared-state bug that
    // shows up three screens away.
    const list = [
      record({ id: 'boom', displayFingerprint: 'dsp-1', updatedAt: '2026-01-01T00:00:00Z' }),
      record({ id: 'desk', displayFingerprint: 'dsp-1', updatedAt: '2026-07-01T00:00:00Z' }),
    ];
    profiles.profilesForDisplay(list, 'dsp-1');
    expect(list.map((p) => p.id)).toEqual(['boom', 'desk']);
  });
});

describe('projecting a saved profile back onto the calibration controls', () => {
  it('recovers every appearance control the user can change', () => {
    const overrides = profiles.applyProfileToStageOverrides(stage);
    expect(overrides).toEqual({
      fontFamilyId: 'humanist-sans',
      fontSizePx: 72,
      lineHeight: 1.3,
      columnWidthPercent: 64,
      readingBandCenterPercent: 42,
      mirrorX: true,
      mirrorY: false,
      pastDimming: true,
      phraseHighlight: true,
      // The fixture predates the optical layer, which is the state every row
      // written before this change is in: it gets the uncalibrated defaults
      // rather than a missing field every caller would have to test for.
      textIntensity: 'standard',
      readingCue: 'ticks',
    });
  });

  /**
   * `background` is deliberately NOT recovered.
   *
   * The stage hard-codes its field colour in `src/styles/stage.css`, so the
   * saved value never described anything that could be seen — the two-option
   * menu that wrote it rendered identically on both options. Handing it back
   * would keep a dead control looking answerable, which is the failure this
   * whole pass is about.
   */
  it('does not hand back the background the stage never read', () => {
    expect(profiles.applyProfileToStageOverrides(stage)).not.toHaveProperty('background');
  });

  /**
   * The reason a §52 row is worth writing at all. The calibration lives in the
   * localStorage overlay, which "Clear cache" wipes; the row is what lets the
   * calibration screen hand back an arrangement somebody measured instead of a
   * set of pixel sizes somebody would have to reverse-engineer.
   */
  it('round-trips the optical block a calibrated take saved', () => {
    const opticalProfile = { ...defaultOpticalProfile(), rigName: 'Boom arm', bias: 0.75 };
    const optics: ResolvedOptics = {
      schemaVersion: 1,
      safeArea: { top: 0.05, right: 0, bottom: 0.05, left: 0 },
      opticalCenterX: 0.5,
      readingBandY: 0.38,
      deadZoneLines: 0.84,
      topFadeLines: 1.25,
      bottomFadeLines: 0.75,
      futureReserveLines: 3,
      sentenceMicrogapLines: 0.2,
      columnCh: 30,
      secondaryMinPx: 28,
      bodyFontSizePx: 58,
      calibrated: true,
      metricsMeasured: false,
      mmPerCssPx: 0.12,
      viewingDistanceMm: 1400,
      bodyArcminutes: 24,
      charactersPerLine: 34,
      fitVerdict: 'ok',
      fitAdvice: '',
      lineHeight: 1.3,
      fontWeight: 500,
      letterSpacingEm: 0,
      paragraphSpacingEm: 0.7,
      pastOpacity: 0.42,
      futureOpacity: 0.92,
      overriddenFields: [],
    };
    const calibrated: StageSettings = {
      ...stage,
      optics,
      opticalProfile,
      textIntensity: 'strong',
      readingCue: 'wash',
    };

    const overrides = profiles.applyProfileToStageOverrides(calibrated);
    // The INPUT is what makes the row recoverable — a rig name, a distance, a
    // lens position — not the pixel sizes it happened to resolve to.
    expect(overrides.opticalProfile).toEqual(opticalProfile);
    expect(overrides.optics).toEqual(optics);
    expect(overrides.textIntensity).toBe('strong');
    expect(overrides.readingCue).toBe('wash');
  });

  /**
   * `buildStageSettings` encodes the two booleans as opacities. Round-tripping
   * them through the encoding is the part that can silently invert.
   */
  it('round-trips the boolean appearance toggles through their encodings', () => {
    const dimmingOff: StageSettings = { ...stage, pastOpacity: 0.92 };
    const highlightOff: StageSettings = { ...stage, currentUnderlayOpacity: 0 };
    expect(profiles.applyProfileToStageOverrides(dimmingOff).pastDimming).toBe(false);
    expect(profiles.applyProfileToStageOverrides(highlightOff).phraseHighlight).toBe(false);
    expect(profiles.applyProfileToStageOverrides(stage).pastDimming).toBe(true);
    expect(profiles.applyProfileToStageOverrides(stage).phraseHighlight).toBe(true);
  });

  it('names a new profile after the display, falling back to a usable label', () => {
    expect(profiles.buildDisplayProfile('Studio Monitor', 'dsp-1', stage).name).toBe(
      'Studio Monitor',
    );
    expect(profiles.buildDisplayProfile('   ', 'dsp-1', stage).name).toBe('Stage display');
    expect(profiles.buildDisplayProfile('X', 'dsp-1', stage, 'keep-me').id).toBe(
      'keep-me',
    );
    expect(profiles.buildDisplayProfile('X', 'dsp-1', stage).id).toBeUndefined();
  });
});
