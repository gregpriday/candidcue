/**
 * Per-rig optical profiles, and the store they live in.
 *
 * They used to live only in the localStorage overlay, which the 1.0 readiness
 * review named directly: clearing WebView storage erased every calibrated rig,
 * the writes swallowed all errors, and the `display_profiles` table that
 * described itself as the durable backstop had no callers at all. A rig is
 * user-created data produced by physically measuring a room — the most
 * expensive thing in this document to lose, and the least reproducible.
 *
 * Rust owns them now, in the revisioned settings document, so they are
 * transactional, survive a cleared browser store, and are included in an
 * export. What remains local is presentation and per-machine capture state.
 *
 * The service half runs against a fake `ipcInvoke` and a real in-memory
 * localStorage, so both halves of the adapter are genuinely exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultOpticalProfile, type OpticalProfile } from '../../../src/shared/contracts';
import {
  activeOpticalProfile,
  normalizeOpticalProfile,
  opticalRigKey,
  opticalRigsForDisplay,
  withOpticalProfile,
  withoutOpticalProfile,
  type OpticalSettings,
} from '../../../src/control/services/settings-types';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const document = {
    revision: 4,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 800,
        revisionIntervalMinutes: 10,
        wordsPerMinuteEstimate: 150,
        analyticsEnabled: false,
        saveTranscript: 'off',
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 140,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 2,
        stageAcknowledgement: 'flash',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
      },
      commands: { wakePhrase: 'CandidCue', wakeMode: 'strict' },
    },
  };
  return {
    calls,
    document,
    /** Make `update_settings` reject, to test the write ORDER. */
    failUpdate: false,
    invoke: async (command: string, args?: unknown) => {
      calls.push({ command, args });
      if (command === 'update_settings' && ipc.failUpdate) {
        throw new Error('revision conflict');
      }
      return document;
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});

const OVERLAY_KEY = 'candidcue.settings-overlay.v1';
const settings = await import('../../../src/control/services/settings');

function rig(overrides: Partial<OpticalProfile> = {}): OpticalProfile {
  return {
    ...defaultOpticalProfile(),
    rigName: 'Desk hood',
    hardwareKind: 'elgato-prompter',
    scale: { mmPerCssPx: 0.19, source: 'model', diagonalMm: 228.6 },
    viewingDistanceMm: 1200,
    completedSteps: ['hardware', 'distance'],
    ...overrides,
  };
}

const EMPTY: OpticalSettings = { profiles: {}, activeRig: {} };

/**
 * The `optical` section of the Rust document under test.
 *
 * A getter/setter pair rather than a plain object, because the harness's
 * `invoke` returns the same document instance every call — so a test that
 * wants Rust to hold rigs has to mutate that instance, not replace it.
 */
const rustSettings = {
  set optical(value: unknown) {
    if (value === undefined) delete (ipc.document.value as Record<string, unknown>)['optical'];
    else (ipc.document.value as Record<string, unknown>)['optical'] = value;
  },
  get optical(): unknown {
    return (ipc.document.value as Record<string, unknown>)['optical'];
  },
};

beforeEach(() => {
  ipc.calls.length = 0;
  store.clear();
  rustSettings.optical = undefined;
  /* The "Rust already owns this" latch is module state and only moves one way,
     so a case that saw a migrated document would silently disable the migration
     for every case after it. */
  settings.resetMigrationStateForTesting();
});

describe('one panel, several mounting arrangements', () => {
  /**
   * The reason this is a keyed map rather than a field on `teleprompter`. The
   * same Elgato on the desk and on the boom arm share one
   * `displayFingerprint`, and a single-valued field would let the second
   * silently overwrite the first — the one thing a calibration store cannot
   * afford, because nobody re-measures a distance they believe is saved.
   */
  it('keeps both rigs for one fingerprint and remembers which is in force', () => {
    let optical = withOpticalProfile(EMPTY, 'dsp-1', rig({ rigName: 'Desk hood' }));
    optical = withOpticalProfile(optical, 'dsp-1', rig({ rigName: 'Boom arm', viewingDistanceMm: 2100 }));

    expect(opticalRigsForDisplay(optical, 'dsp-1').map((e) => e.profile.rigName).sort()).toEqual([
      'Boom arm',
      'Desk hood',
    ]);
    expect(activeOpticalProfile(optical, 'dsp-1')!.rigName).toBe('Boom arm');
    expect(activeOpticalProfile(optical, 'dsp-1')!.viewingDistanceMm).toBe(2100);
  });

  it('re-calibrating a rig replaces it rather than adding a near-duplicate', () => {
    let optical = withOpticalProfile(EMPTY, 'dsp-1', rig({ viewingDistanceMm: 1200 }));
    optical = withOpticalProfile(optical, 'dsp-1', rig({ viewingDistanceMm: 1500 }));
    expect(opticalRigsForDisplay(optical, 'dsp-1')).toHaveLength(1);
    expect(activeOpticalProfile(optical, 'dsp-1')!.viewingDistanceMm).toBe(1500);
  });

  it('never lets one panel’s rig answer for another', () => {
    const optical = withOpticalProfile(EMPTY, 'dsp-1', rig());
    expect(activeOpticalProfile(optical, 'dsp-2')).toBeNull();
    expect(activeOpticalProfile(optical, null)).toBeNull();
    expect(opticalRigsForDisplay(optical, 'dsp-2')).toEqual([]);
  });

  /**
   * A profile that exists but has not been chosen is not adopted. Picking up a
   * stale arrangement is how the stage ends up sized for a distance the
   * presenter is no longer standing at — the failure the whole optical layer
   * exists to prevent.
   */
  it('requires a rig to be chosen, not merely to exist', () => {
    const optical = withOpticalProfile(EMPTY, 'dsp-1', rig());
    const orphaned: OpticalSettings = { profiles: optical.profiles, activeRig: {} };
    expect(opticalRigsForDisplay(orphaned, 'dsp-1')).toHaveLength(1);
    expect(activeOpticalProfile(orphaned, 'dsp-1')).toBeNull();
  });

  it('forgetting the active rig leaves the panel uncalibrated, not half-calibrated', () => {
    let optical = withOpticalProfile(EMPTY, 'dsp-1', rig({ rigName: 'Desk hood' }));
    optical = withoutOpticalProfile(optical, 'dsp-1', 'Desk hood');
    expect(optical.profiles).toEqual({});
    expect(activeOpticalProfile(optical, 'dsp-1')).toBeNull();
  });

  /**
   * The store round-trips through `normalizeOpticalProfile`, which trims the
   * name. Keying on the untrimmed form leaves the stored profile and its own
   * key disagreeing, and the disagreement only shows up where it does damage:
   * the take resolves the rig (same untrimmed key) while the picker reports
   * nothing in force (trimmed name), so the operator is told they are running
   * uncalibrated on a panel that is running their calibration.
   */
  it('agrees with itself about a rig whose name was typed with stray spaces', () => {
    const optical = withOpticalProfile(EMPTY, 'dsp-1', rig({ rigName: '  Desk hood  ' }));

    expect(activeOpticalProfile(optical, 'dsp-1')!.rigName).toBe('Desk hood');
    const listed = opticalRigsForDisplay(optical, 'dsp-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.active).toBe(true);
    // And the name the picker offers back is the one removal is keyed on.
    expect(withoutOpticalProfile(optical, 'dsp-1', listed[0]!.profile.rigName).profiles).toEqual({});
  });

  it('cannot confuse a rig named with the key separator for a different panel', () => {
    // `Desk::boom` on panel `dsp` and `boom` on a panel whose fingerprint ends
    // in `Desk` are different arrangements; a naive join makes them one key.
    expect(opticalRigKey('dsp', 'Desk::boom')).not.toBe(opticalRigKey('dsp::Desk', 'boom'));
  });
});

describe('a stored profile is validated before the resolver walks it', () => {
  /**
   * `resolveStageGeometry` reads `profile.safeArea.top` and `profile.lens.x`
   * without guarding the objects, and it is right not to — it is handed a typed
   * profile. This is where that type stops being a promise: `loadOverlay`
   * checks that a SECTION is a plain object and deliberately leaves its fields
   * alone, so a truncated write would otherwise throw a `TypeError` while
   * building an envelope, failing the take rather than the setting.
   */
  it('fills the scalars a partial document is missing', () => {
    const normalized = normalizeOpticalProfile({ schemaVersion: 1, rigName: 'Half-written' });
    expect(normalized).not.toBeNull();
    expect(normalized!.lens).toEqual(defaultOpticalProfile().lens);
    expect(normalized!.safeArea).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(normalized!.framing).toBe('head-and-shoulders');
    // A profile stored before `lensPlacement` existed reads as in-panel, which
    // is the only placement a beamsplitter/hood rig has ever meant.
    expect(normalized!.lensPlacement).toBe('in-panel');
  });

  /**
   * A desk/lid webcam sits outside the safe rectangle entirely, so `lens.y`
   * cannot describe it — `lensPlacement` is the additive discriminator that
   * says so. Anything the store did not recognise falls back to the in-panel
   * default rather than being guessed at, same as every other enum here.
   */
  it('accepts a valid off-panel placement and rejects a bogus one', () => {
    const above = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Desk webcam',
      lensPlacement: 'above',
    });
    expect(above!.lensPlacement).toBe('above');

    const below = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Desk webcam',
      lensPlacement: 'below',
    });
    expect(below!.lensPlacement).toBe('below');

    const bogus = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Desk webcam',
      lensPlacement: 'sideways',
    });
    expect(bogus!.lensPlacement).toBe('in-panel');
  });

  it('refuses a document that is not a v1 profile at all', () => {
    expect(normalizeOpticalProfile(null)).toBeNull();
    expect(normalizeOpticalProfile('a string')).toBeNull();
    expect(normalizeOpticalProfile([])).toBeNull();
    expect(normalizeOpticalProfile({ schemaVersion: 2, rigName: 'Future' })).toBeNull();
    // An unnamed rig cannot be keyed, so it cannot be stored or picked.
    expect(normalizeOpticalProfile({ schemaVersion: 1, rigName: '  ' })).toBeNull();
  });

  /**
   * Null, not zero. These fields mean "not measured yet", and a zero scale
   * propagates to an infinite font size while a zero distance would let an
   * uncalibrated rig claim a measurement nobody took.
   */
  it('treats an unusable scale or distance as unmeasured', () => {
    const normalized = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Bad numbers',
      scale: { mmPerCssPx: 0, source: 'ruler' },
      viewingDistanceMm: -50,
      bias: 'lots',
    });
    expect(normalized!.scale).toBeNull();
    expect(normalized!.viewingDistanceMm).toBeNull();
    expect(normalized!.bias).toBe(defaultOpticalProfile().bias);
  });

  /**
   * The wizard decides what it still has to ask by what is missing from this
   * list, so a name it does not recognise is a step it can neither show as done
   * nor offer. Accepting any string would have let a hand-edited store put an
   * entry there that no screen can ever act on.
   */
  it('keeps only calibration steps it recognises', () => {
    const normalized = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Odd steps',
      completedSteps: ['distance', 'teleportation', 7, 'hardware'],
    });
    expect(normalized!.completedSteps).toEqual(['hardware', 'distance']);
  });

  /**
   * `ResolvedOptics.overriddenFields` is what a UI reads to mark a control "set
   * by you" and offer a reset to automatic, so an entry under a name no control
   * owns is an override nobody can find and nobody can undo. Numbers a person
   * could have typed survive; everything else is not an override, it is debris.
   */
  it('keeps only overrides a control can hand back', () => {
    const normalized = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Pinned rig',
      overrides: {
        fontSizePx: 84,
        letterSpacingEm: -0.01,
        lineHeight: Number.NaN,
        columnCh: 'wide',
        glowRadius: 12,
      },
    });
    expect(normalized!.overrides).toEqual({ fontSizePx: 84, letterSpacingEm: -0.01 });
  });

  it('keeps a scale it can actually use, with its provenance', () => {
    const normalized = normalizeOpticalProfile({
      schemaVersion: 1,
      rigName: 'Ruler rig',
      scale: { mmPerCssPx: 0.21, source: 'ruler' },
    });
    // Provenance matters: a ruler measures the finished optical path, including
    // a beamsplitter that magnifies, while a model lookup describes the panel.
    expect(normalized!.scale).toEqual({ mmPerCssPx: 0.21, source: 'ruler' });
  });
});

describe('Rust is the authority for calibrated rigs', () => {
  /*
   * The optical section used to live ONLY in the localStorage overlay, and the
   * tests that used to sit here asserted exactly that — "survives a reload,
   * because nothing else stores it" and "sends nothing to Rust, which has no
   * home for it". Both were accurate descriptions of the defect the 1.0
   * readiness review named: clearing WebView storage erased every calibrated
   * rig, and a `display_profiles` table that described itself as the durable
   * backstop had no callers at all.
   *
   * A rig is user-created data produced by physically measuring a room. It is
   * the most expensive thing in this document to lose and the least
   * reproducible: a presentation mode somebody loses is one menu click, a
   * viewing distance is a tape measure and a room.
   */
  it('sends the rigs to Rust, where clearing the browser store cannot reach them', async () => {
    const optical = withOpticalProfile(EMPTY, 'dsp-1', rig());
    await settings.updateSettings(4, { optical });

    const update = ipc.calls.find((c) => c.command === 'update_settings');
    expect(update, 'a calibration must reach the persisted document').toBeDefined();
    const patch = (update?.args as { patch?: Record<string, unknown> })?.patch;
    expect(patch?.['optical']).toMatchObject({
      profiles: optical.profiles,
      activeRig: optical.activeRig,
      // The authority marker travels with every write. See below.
      migrated: true,
    });
  });

  it('does not keep a copy in the overlay to contradict it later', async () => {
    /*
     * A cached copy outliving the document is how a rig somebody deleted comes
     * back. `following`, `speech` and now `optical` are Rust-owned in both
     * directions for exactly this reason.
     */
    await settings.updateSettings(4, { optical: withOpticalProfile(EMPTY, 'dsp-1', rig()) });
    const stored = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored['optical'], 'the overlay must not shadow the document').toBeUndefined();
  });

  it('reads the rigs back from Rust, not from the overlay', async () => {
    const key = opticalRigKey('dsp-1', 'Desk hood');
    rustSettings.optical = {
      migrated: true,
      profiles: { [key]: rig() },
      activeRig: { 'dsp-1': 'Desk hood' },
    };
    // A conflicting overlay copy from before the move must lose.
    store.set(
      OVERLAY_KEY,
      JSON.stringify({ optical: { profiles: {}, activeRig: {} } }),
    );

    const loaded = await settings.getSettings();
    expect(activeOpticalProfile(loaded.optical, 'dsp-1')).toEqual(rig());
  });

  it('writes an overlay-only calibration through to Rust exactly once', async () => {
    /*
     * The migration, and the half that is easy to omit. Reading the overlay as
     * a fallback keeps an upgrading user's rig on screen — and leaves Rust
     * holding nothing, so the measurement still dies the day the browser store
     * is cleared. That is the failure the move exists to end, so the read
     * records what it found and the store writes it through.
     */
    const key = opticalRigKey('dsp-1', 'Desk hood');
    rustSettings.optical = undefined;
    store.set(
      OVERLAY_KEY,
      JSON.stringify({
        optical: { profiles: { [key]: rig() }, activeRig: { 'dsp-1': 'Desk hood' } },
      }),
    );

    const loaded = await settings.getSettings();
    expect(
      activeOpticalProfile(loaded.optical, 'dsp-1'),
      'the rig must still be usable during the upgrade',
    ).toEqual(rig());
    expect(
      settings.pendingOpticalAdoption(),
      'and it must be flagged for writing through, not merely read',
    ).not.toBeNull();

    // Once Rust has taken ownership, there is nothing left to adopt.
    rustSettings.optical = {
      migrated: true,
      profiles: { [key]: rig() },
      activeRig: { 'dsp-1': 'Desk hood' },
    };
    await settings.getSettings();
    expect(settings.pendingOpticalAdoption()).toBeNull();
  });

  it('does not resurrect a rig the user deleted after the migration', async () => {
    /*
     * The defect a verification pass found in the first version of this move.
     *
     * Authority was decided by "does Rust hold any profiles?". So:
     *
     *   1. the legacy overlay rig is adopted into Rust;
     *   2. the stale overlay copy is left behind, because `applyOverlayPatch`
     *      skips `optical` and nothing else ever removes it;
     *   3. the user deletes their last calibration;
     *   4. Rust's map is now empty, which read as "not migrated yet";
     *   5. the overlay became authoritative again and the deleted rig came
     *      back — and was re-adopted.
     *
     * A calibration returning from the dead is worse than one that was never
     * saved: the picker offers a measurement of a room the presenter has left.
     * An explicit `migrated` marker is what makes an EMPTY document a real
     * answer.
     */
    const key = opticalRigKey('dsp-1', 'Desk hood');
    // A legacy overlay copy that was never cleaned up.
    store.set(
      OVERLAY_KEY,
      JSON.stringify({
        optical: { profiles: { [key]: rig() }, activeRig: { 'dsp-1': 'Desk hood' } },
      }),
    );
    // Rust has taken ownership and holds nothing — the user deleted their last rig.
    rustSettings.optical = { migrated: true, profiles: {}, activeRig: {} };

    const loaded = await settings.getSettings();
    expect(loaded.optical.profiles, 'a deleted rig must stay deleted').toEqual({});
    expect(
      settings.pendingOpticalAdoption(),
      'and an owned document must never be re-migrated from the stale copy',
    ).toBeNull();
  });

  it('clears the legacy overlay copy once, and only after the write lands', async () => {
    /*
     * Ordering. The legacy copy has to OUTLIVE the write that adopts it — if
     * that write fails, the fallback the user is relying on must still be
     * there — and it has to be gone once the write lands, or it sits as a
     * second answer waiting for the first to look absent.
     */
    const key = opticalRigKey('dsp-1', 'Desk hood');
    store.set(
      OVERLAY_KEY,
      JSON.stringify({
        optical: { profiles: { [key]: rig() }, activeRig: { 'dsp-1': 'Desk hood' } },
      }),
    );

    /*
     * The read alone must not touch it — the store only calls
     * `forgetOverlayOptical` after the durable write succeeds, and a read that
     * cleaned up eagerly would destroy the fallback the moment anything went
     * wrong afterwards.
     */
    await settings.getSettings();
    const afterRead = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as Record<string, unknown>;
    expect(afterRead['optical'], 'a read must never remove the fallback').toBeDefined();

    // And the explicit cleanup, which the store calls only on success, does.
    settings.forgetOverlayOptical();
    const afterSuccess = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as Record<string, unknown>;
    expect(afterSuccess['optical']).toBeUndefined();
  });

  it('drops a stored rig the resolver would refuse, and the choice of it', async () => {
    // A hand-edited or truncated store. Loading must not throw — this runs
    // before the first route is chosen, so a throw here takes the window down
    // with no way to reach the screen that could clear it.
    store.set(
      OVERLAY_KEY,
      JSON.stringify({
        optical: {
          profiles: { [opticalRigKey('dsp-1', 'Desk hood')]: { rigName: 'Desk hood' } },
          activeRig: { 'dsp-1': 'Desk hood' },
        },
      }),
    );

    const loaded = await settings.getSettings();
    expect(loaded.optical.profiles).toEqual({});
    // A rig picker listing a calibration the resolver would refuse is worse
    // than an empty one: the presenter believes a distance is saved.
    expect(loaded.optical.activeRig).toEqual({});
    expect(activeOpticalProfile(loaded.optical, 'dsp-1')).toBeNull();
  });

  it('starts uncalibrated rather than guessing at a rig', async () => {
    const loaded = await settings.getSettings();
    expect(loaded.optical).toEqual({ profiles: {}, activeRig: {} });
  });
});

describe('the properties the 1.0 readiness review asked for', () => {
  it('a cleared WebView store does not erase a calibrated rig', async () => {
    /*
     * The acceptance criterion, stated as a test. This is what was NOT true:
     * every measured viewing distance and lens placement lived in
     * localStorage, so a storage clear — by the OS under pressure, or by a
     * user clicking something that says "website data" — took the room
     * measurement with it.
     */
    const key = opticalRigKey('dsp-1', 'Desk hood');
    rustSettings.optical = {
      migrated: true,
      profiles: { [key]: rig() },
      activeRig: { 'dsp-1': 'Desk hood' },
    };

    store.clear(); // the whole WebView store, gone

    const loaded = await settings.getSettings();
    expect(activeOpticalProfile(loaded.optical, 'dsp-1')).toEqual(rig());
  });

  it('a settings write that Rust rejects leaves nothing behind in the overlay', async () => {
    /*
     * The transaction-order defect. `applyOverlayPatch` used to run BEFORE the
     * Rust update, so a rejected write left the store reverted and the overlay
     * holding the value anyway — and on a later launch that stale overlay
     * could override the Rust-owned document. The screen showed a setting that
     * had failed to save, and kept showing it.
     */
    ipc.failUpdate = true;
    try {
      await expect(
        settings.updateSettings(4, { teleprompter: { mirrorX: true } as never }),
      ).rejects.toThrow();

      const stored = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as Record<string, unknown>;
      expect(
        stored['teleprompter'],
        'a rejected write must not leave the value in the local overlay',
      ).toBeUndefined();
    } finally {
      ipc.failUpdate = false;
    }
  });
});
