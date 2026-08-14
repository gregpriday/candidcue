/**
 * "Did CandidCue do its job?" — answered in one sentence (CCUX-006).
 *
 * The end-of-take dialog listed nineteen measurements and stated no conclusion.
 * Each row earns its place, several were added because a specific failure had
 * been invisible without them, and together they answer a question the
 * presenter did not ask. Somebody walking back from a camera is choosing
 * between five actions, and to choose they need to know whether they were heard
 * and whether the stage followed.
 *
 * The tests below are mostly about the cases where the honest answer is NOT the
 * obvious one: a take too short to judge, a manual take with no microphone to
 * report on, and a reconnect that explains a poor following share rather than
 * competing with it.
 */
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_HEALTH_LABELS,
  resolveTakeOutcome,
  type TakeOutcomeInput,
} from '../../../src/control/lib/take-outcome';

function take(over: Partial<TakeOutcomeInput> = {}): TakeOutcomeInput {
  return {
    mode: 'voice',
    wordsHeard: 400,
    wordsInFlight: 0,
    followingShare: 0.95,
    reconnects: 0,
    manualJumps: 0,
    durationSeconds: 180,
    endingLocation: 'Call to action',
    ...over,
  };
}

describe('resolveTakeOutcome', () => {
  it('says plainly when it worked, and names where you stopped', () => {
    const outcome = resolveTakeOutcome(take());
    expect(outcome.health).toBe('steady');
    expect(outcome.tone).toBe('good');
    expect(outcome.detail).toContain('Call to action');
    // Nothing to do about a take that went fine.
    expect(outcome.suggestion).toBeNull();
  });

  /* ------------------------------------------------------------------ *
   * The cases where the obvious answer is wrong
   * ------------------------------------------------------------------ */

  it('does not accuse the microphone over a take that barely ran', () => {
    // Ending a take two seconds in produces "no words heard" truthfully and
    // means nothing. Telling somebody to go and test their hardware because of
    // it is the standing false alarm this codebase keeps warning about.
    const outcome = resolveTakeOutcome(take({ wordsHeard: 0, durationSeconds: 2 }));
    expect(outcome.headline).not.toMatch(/nothing was transcribed/i);
    expect(outcome.suggestion).toBeNull();
    expect(outcome.tone).not.toBe('attention');
  });

  it('does say so when a real take heard nothing', () => {
    const outcome = resolveTakeOutcome(take({ wordsHeard: 0, durationSeconds: 120 }));
    expect(outcome.headline).toBe('Nothing was transcribed');
    expect(outcome.health).toBe('no_speech');
    expect(outcome.suggestion).toMatch(/microphone/i);
    // And it must reassure: the script is untouched. A presenter who thinks
    // they lost work behaves very differently from one who knows they did not.
    expect(outcome.detail).toMatch(/nothing was lost|as you left it/i);
  });

  it('counts an unfinished utterance as having been heard', () => {
    /*
     * `wordsHeard` is finals only, and the summary is taken before the last
     * utterance closes. A presenter who read continuously for fourteen seconds
     * can finish with every word still in flight — and telling them nothing was
     * transcribed, while the stage visibly followed them, is the contradiction
     * `wordsInFlight` exists to resolve.
     */
    const outcome = resolveTakeOutcome(take({ wordsHeard: 0, wordsInFlight: 40 }));
    expect(outcome.health).not.toBe('no_speech');
  });

  it('reports a manual take as finished, not as a following failure', () => {
    // There was no microphone. "Nothing was transcribed" would report the
    // absence of a subsystem this take never started.
    const outcome = resolveTakeOutcome(take({ mode: 'manual', wordsHeard: 0, followingShare: null }));
    expect(outcome.tone).toBe('neutral');
    expect(outcome.headline).not.toMatch(/transcrib/i);
    expect(outcome.detail).toContain('Call to action');
  });

  it('names a dropped connection ahead of the following share it explains', () => {
    // A reconnect CAUSES a poor share. Reporting "following needed help" would
    // send the presenter to rewrite a script that was never the problem.
    const outcome = resolveTakeOutcome(take({ reconnects: 2, followingShare: 0.3 }));
    expect(outcome.headline).toMatch(/connection/i);
    expect(outcome.detail).toContain('2 interruptions');
    // The band underneath still reports what actually happened.
    expect(outcome.health).toBe('frequent_help');
  });

  it('counts one interruption in the singular', () => {
    const outcome = resolveTakeOutcome(take({ reconnects: 1, followingShare: 0.9 }));
    expect(outcome.detail).toContain('an interruption');
    expect(outcome.detail).not.toContain('1 interruptions');
  });

  it('separates heard-but-never-tracked from held', () => {
    // Words arrived and no position was ever reported. That is not holding —
    // holding is a decision the engine makes — and it has a different remedy.
    const outcome = resolveTakeOutcome(take({ followingShare: null }));
    expect(outcome.health).toBe('no_tracking');
    expect(outcome.suggestion).toMatch(/support bundle|present again/i);
  });

  it('explains frequent holding without blaming the presenter', () => {
    const outcome = resolveTakeOutcome(take({ followingShare: 0.2 }));
    expect(outcome.health).toBe('frequent_help');
    // The causes are ordinary and are named as ordinary.
    expect(outcome.detail).toMatch(/ad-libs|repeated wording/i);
    expect(outcome.suggestion).toMatch(/nothing is broken/i);
  });

  /* ------------------------------------------------------------------ *
   * The boundary it must not cross
   * ------------------------------------------------------------------ */

  it('never judges the delivery', () => {
    /*
     * CandidCue can say whether it heard and whether it followed. It cannot
     * tell whether a take was good, and the two analysis lanes that would bear
     * on that are documented as incomplete. An outcome that praised a take
     * would be inventing a measurement.
     */
    const banned = /\b(great|excellent|good take|well done|confident|engaging|professional|nice work)\b/i;
    const shares = [null, 0, 0.2, 0.5, 0.85, 1];
    for (const followingShare of shares) {
      for (const reconnects of [0, 1, 3]) {
        for (const wordsHeard of [0, 5, 900]) {
          const outcome = resolveTakeOutcome(take({ followingShare, reconnects, wordsHeard }));
          const text = `${outcome.headline} ${outcome.detail} ${outcome.suggestion ?? ''}`;
          expect(text, `judged the delivery: ${text}`).not.toMatch(banned);
        }
      }
    }
  });

  it('produces a labelled band for every outcome it can return', () => {
    const shares = [null, 0, 0.39, 0.4, 0.79, 0.8, 1];
    for (const followingShare of shares) {
      for (const mode of ['voice', 'manual', 'fixed'] as const) {
        for (const wordsHeard of [0, 200]) {
          const outcome = resolveTakeOutcome(take({ followingShare, mode, wordsHeard }));
          expect(FOLLOW_HEALTH_LABELS[outcome.health], `unlabelled band for ${outcome.health}`).toBeTruthy();
          expect(outcome.headline.length).toBeGreaterThan(0);
          expect(outcome.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('puts the band boundaries where the copy claims they are', () => {
    expect(resolveTakeOutcome(take({ followingShare: 0.39 })).health).toBe('frequent_help');
    expect(resolveTakeOutcome(take({ followingShare: 0.4 })).health).toBe('occasional_holds');
    expect(resolveTakeOutcome(take({ followingShare: 0.79 })).health).toBe('occasional_holds');
    expect(resolveTakeOutcome(take({ followingShare: 0.8 })).health).toBe('steady');
  });
});
