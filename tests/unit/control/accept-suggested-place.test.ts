/*
 * Accepting the off-screen suggestion: one deliberate move, and only when the
 * suggestion still describes this take.
 *
 * The stage offers the place the engine refused (`holdOffScreen`); pressing
 * "Read from there" asks control to put the aligner there. A press that outlived
 * its take, named a place outside the script, arrived after following had
 * already found the reader again, or was overtaken by a deliberate reposition
 * must move nothing.
 *
 * Each guard is shown to bite from a press that is otherwise honoured, so none
 * of them can pass on the strength of another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  acceptSuggestedPlace,
  clearSession,
  session,
  startLiveSession,
  suggestedPlaceRefusal,
} from '../../../src/control/stores/session';
import { buildStageEnvelope, stageSettingsFromSettings } from '../../../src/control/services/stage-envelope';
import { defaultAppSettings } from '../../../src/control/services/settings-types';
import type { CompiledScript } from '../../../src/shared/contracts';

/** A press the session would honour: change one field to test one guard. */
const HONOURED = {
  active: true,
  sessionGeneration: 3,
  suggestionGeneration: 3,
  token: 120,
  scriptWordCount: 200,
  following: false,
  offeredAtMs: 5_000,
  lastRepositionAtMs: 1_000,
};

describe('which presses are honoured', () => {
  it('honours a current offer for this take', () => {
    expect(suggestedPlaceRefusal(HONOURED)).toBeNull();
    // Never repositioned is the starting state of every take.
    expect(
      suggestedPlaceRefusal({ ...HONOURED, lastRepositionAtMs: Number.NEGATIVE_INFINITY }),
    ).toBeNull();
  });

  it('refuses once the take is over', () => {
    expect(suggestedPlaceRefusal({ ...HONOURED, active: false })).toBe('inactive');
  });

  it('refuses a suggestion that belonged to another take', () => {
    expect(suggestedPlaceRefusal({ ...HONOURED, suggestionGeneration: 2 })).toBe('another-take');
  });

  it('refuses a place that is not a word of this script once rounded', () => {
    expect(suggestedPlaceRefusal({ ...HONOURED, token: -1 })).toBe('outside-script');
    expect(suggestedPlaceRefusal({ ...HONOURED, token: 200 })).toBe('outside-script');
    // Under the bound before rounding, at it after: the move would be to 200.
    expect(suggestedPlaceRefusal({ ...HONOURED, token: 199.6 })).toBe('outside-script');
    expect(suggestedPlaceRefusal({ ...HONOURED, token: Number.NaN })).toBe('outside-script');
    expect(suggestedPlaceRefusal({ ...HONOURED, token: 199.4 })).toBeNull();
  });

  it('refuses once following has found the reader again', () => {
    expect(suggestedPlaceRefusal({ ...HONOURED, following: true })).toBe('found-again');
  });

  it('refuses an offer a deliberate reposition overtook', () => {
    expect(suggestedPlaceRefusal({ ...HONOURED, lastRepositionAtMs: 5_000 })).toBe('overtaken');
    expect(suggestedPlaceRefusal({ ...HONOURED, lastRepositionAtMs: 6_000 })).toBe('overtaken');
  });
});

/* -------------------------------------------------- wired into the session */

const SETTINGS = defaultAppSettings();

const SCRIPT = {
  scriptId: 'script-1',
  sourceHash: 'hash-1',
  title: 'Launch video',
  blocks: [],
  cues: [],
  outline: [],
  sentences: [],
  spokenTokens: [],
  assets: [],
  navigationTargets: [],
  diagnostics: [],
} as unknown as CompiledScript;

function start(sessionGeneration: number): void {
  const stageSettings = stageSettingsFromSettings(SETTINGS);
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'manual',
    displayLabel: 'This window',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionGeneration,
    stageSettings,
    stageEnvelope: buildStageEnvelope({
      script: SCRIPT,
      sessionId: 'session-1',
      sessionGeneration,
      stageGeneration: 0,
      stageSettings,
      assets: {},
      following: SETTINGS.following,
    }),
    teleprompter: SETTINGS.teleprompter,
    presentationMode: 'reader',
  });
}

const jumps = () => get(session).counts.jumps;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
});

describe('the session reads its own state into the guard', () => {
  /*
   * The take opens on a synthetic "following" snapshot, so the session
   * refuses here for the reason it should: nobody is lost. (The honoured
   * path — a holding take, one press, exactly one move — runs through the real
   * driver in `tests/e2e/browser/reader-recovery.spec.ts`.)
   */
  it('reads the follower: a take that is following refuses', () => {
    start(3);
    expect(get(session).snapshot?.state).toBe('following');
    const before = jumps();
    expect(acceptSuggestedPlace(120, 3, Date.now())).toBe(false);
    expect(jumps()).toBe(before);
  });

  it('reads the take: nothing moves once it is over', () => {
    start(3);
    clearSession();
    expect(acceptSuggestedPlace(120, 3, Date.now())).toBe(false);
  });
});
