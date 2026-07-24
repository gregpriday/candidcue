/**
 * Display profile service contract and selection logic (spec §52, §46.6).
 *
 * The service exists; the UI that would call it lives in Preflight, which is
 * owned elsewhere in this pass. These tests pin the wire shape and the pure
 * logic so the remaining change there is a wiring change, not a design one.
 *
 * MOCK CAVEAT: `saveDisplayProfile` has an `invokeOrMock` fallback for
 * browser dev. Every assertion below either stubs `ipc` and inspects the real
 * payload, or exercises a pure function — none is satisfied by the fallback.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/stage-command-payloads.json';
import type { StageSettings } from '../../../src/shared/contracts';
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
});

describe('projecting a saved profile back onto the Preflight controls', () => {
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
      background: '#050505',
    });
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
    expect(profiles.buildDisplayProfile('X', 'dsp-1', stage, undefined, 'keep-me').id).toBe(
      'keep-me',
    );
    expect(profiles.buildDisplayProfile('X', 'dsp-1', stage).id).toBeUndefined();
  });
});
