/**
 * "Did Speaking Glass do its job?" — answered in one sentence (CCUX-006).
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
  describeSetAside,
  FOLLOW_HEALTH_LABELS,
  resolveTakeOutcome,
  type TakeOutcomeInput,
} from '../../../src/control/lib/take-outcome';
import type { FollowingTime } from '../../../src/control/stores/session';

function take(over: Partial<TakeOutcomeInput> = {}): TakeOutcomeInput {
  return {
    mode: 'voice',
    wordsHeard: 400,
    wordsInFlight: 0,
    followingShare: 0.95,
    reconnects: 0,
    manualJumps: 0,
    durationSeconds: 180,
    ...over,
  };
}

/** How a pass divided up; following on throughout unless told otherwise. */
function time(over: Partial<FollowingTime> = {}): FollowingTime {
  return { onSeconds: 180, pausedSeconds: 0, offSeconds: 0, autoScrollSeconds: 0, ...over };
}

/**
 * Every shape of pass the sweeps below must cover: no timing at all (a caller
 * that predates #287), following on throughout, a long pause around steady
 * following, and following barely on at all.
 */
const TIMES: Array<FollowingTime | undefined> = [
  undefined,
  time(),
  time({ onSeconds: 30, pausedSeconds: 60 }),
  time({ onSeconds: 0, autoScrollSeconds: 90 }),
  time({ onSeconds: 2, pausedSeconds: 30, offSeconds: 20, autoScrollSeconds: 40 }),
];

describe('resolveTakeOutcome', () => {
  it('says plainly when it worked', () => {
    const outcome = resolveTakeOutcome(take());
    expect(outcome.health).toBe('steady');
    expect(outcome.tone).toBe('good');
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

  it('blames the refusal, not the microphone, when the OS said no (#303)', () => {
    // Long or short, a refused take heard nothing because nothing listened —
    // "test or change the microphone" sent the presenter to working hardware.
    for (const durationSeconds of [2, 120]) {
      const outcome = resolveTakeOutcome(
        take({ wordsHeard: 0, durationSeconds, microphoneRefused: true }),
      );
      expect(outcome.headline).toBe('Speaking Glass could not use the microphone');
      expect(outcome.suggestion).toMatch(/System Settings/);
      expect(outcome.suggestion).not.toMatch(/test or change/i);
      expect(outcome.health).toBe('no_tracking');
    }
  });

  it('says who refused in the platform’s own words', () => {
    // Named, not read from the host: this suite runs as a Mac everywhere.
    const refused = take({ wordsHeard: 0, durationSeconds: 120, microphoneRefused: true });
    const windows = resolveTakeOutcome(refused, 'windows');
    expect(windows.detail).toMatch(/^Windows did not allow Speaking Glass/);
    expect(windows.suggestion).toContain('Windows Settings → Privacy & security → Microphone');
    const linux = resolveTakeOutcome(refused, 'linux');
    expect(linux.detail).toMatch(/^This computer did not allow Speaking Glass/);
    expect(linux.suggestion).toContain('your system settings');
    for (const outcome of [windows, linux]) {
      expect(`${outcome.detail} ${outcome.suggestion}`).not.toMatch(/\bMac\b|System Settings/);
      expect(outcome.headline).toBe('Speaking Glass could not use the microphone');
    }
  });

  it('reports what WAS heard when the refusal came later in the take', () => {
    // A take that heard words, then had a resume refused, followed for part of
    // its length; the refusal must not hide that.
    const outcome = resolveTakeOutcome(take({ microphoneRefused: true }));
    expect(outcome.headline).not.toBe('Speaking Glass could not use the microphone');
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

  it('claims nothing about what moved the script on a non-voice take', () => {
    /*
     * "You moved the script yourself" is false of a fixed-pace take, and
     * "the script rolled at your set pace" is false of a fixed take nobody ever
     * started rolling — `autoScroll.running` begins false and the transport
     * starts it. So it says only what is known.
     */
    for (const mode of ['manual', 'fixed'] as const) {
      const outcome = resolveTakeOutcome(take({ mode, wordsHeard: 0, followingShare: null }));
      expect(outcome.detail).not.toMatch(/you moved the script/i);
      expect(outcome.detail).not.toMatch(/rolled at your set pace/i);
    }
  });

  it('does not blame the microphone for a take that had no model', () => {
    /*
     * Readiness deliberately lets a take start with no speech model — it still
     * rolls and can be driven by hand. Reporting "nothing was transcribed, test
     * your microphone" afterwards sends that presenter to debug hardware that
     * was never involved.
     */
    const outcome = resolveTakeOutcome(
      take({ wordsHeard: 0, durationSeconds: 200, voiceFollowingAvailable: false }),
    );
    expect(outcome.headline).toBe('Take finished without voice following');
    expect(outcome.health).toBe('no_tracking');
    expect(outcome.detail).not.toMatch(/microphone/i);
    expect(outcome.suggestion).not.toMatch(/microphone/i);
    expect(outcome.tone).not.toBe('attention');
  });

  it('points a take that had no model at Settings → Speech, whatever refused it', () => {
    /*
     * #286. The same take is reached by three refusals — not installed, files
     * missing, failed to load — and "Install a language" fits only the first:
     * a model that will not load may already be installed, or be a bundled
     * copy with nothing to install. The screen that answers all three is
     * Settings → Speech, so that is what the summary names.
     */
    const outcome = resolveTakeOutcome(
      take({ wordsHeard: 0, durationSeconds: 200, voiceFollowingAvailable: false }),
    );
    expect(outcome.suggestion).toContain('Settings → Speech');
    expect(outcome.suggestion).not.toMatch(/install a language/i);
  });

  it('reports a missing model even on a take too short to judge the microphone', () => {
    // The refusal is known the moment the take starts; it does not need five
    // seconds of silence to be true, and "too short to tell" would hide it.
    const outcome = resolveTakeOutcome(
      take({ wordsHeard: 0, durationSeconds: 2, voiceFollowingAvailable: false }),
    );
    expect(outcome.headline).toBe('Take finished without voice following');
  });

  it('keeps the microphone advice for a take whose recogniser ran and heard nothing', () => {
    // The other half of #286: only a refused model changes the answer. A model
    // that loaded and still heard silence is exactly what the advice is for.
    const outcome = resolveTakeOutcome(
      take({ wordsHeard: 0, durationSeconds: 200, voiceFollowingAvailable: true }),
    );
    expect(outcome.headline).toBe('Nothing was transcribed');
    expect(outcome.suggestion).toMatch(/microphone/i);
  });

  it('ignores voice availability on a take that never followed voice', () => {
    for (const mode of ['manual', 'fixed'] as const) {
      const outcome = resolveTakeOutcome(
        take({ mode, wordsHeard: 0, followingShare: null, voiceFollowingAvailable: false }),
      );
      expect(outcome.headline).toBe('Voice following was off');
    }
  });

  it('does not claim the stage stayed still when the operator moved it', () => {
    const outcome = resolveTakeOutcome(take({ wordsHeard: 0, durationSeconds: 120, manualJumps: 2 }));
    expect(outcome.detail).not.toMatch(/stayed where it was/i);
    expect(outcome.detail).toContain('2 moves');
  });

  it('never claims a whole take it did not follow', () => {
    // 0.8 opens the steady band; saying "for the whole take" of a measured 80%
    // is a claim the number underneath contradicts.
    expect(resolveTakeOutcome(take({ followingShare: 0.8 })).detail).not.toMatch(/whole take/i);
    // 0.98 is not the whole take either — 2% of it was not followed.
    expect(resolveTakeOutcome(take({ followingShare: 0.98 })).detail).not.toMatch(/whole take/i);
    expect(resolveTakeOutcome(take({ followingShare: 1 })).detail).toMatch(/whole take/i);
    // Nor all of thirty seconds of a ninety-second take (#287).
    const paused = resolveTakeOutcome(
      take({ followingShare: 1, followingTime: time({ onSeconds: 30, pausedSeconds: 60 }) }),
    );
    expect(paused.detail).not.toMatch(/whole take/i);
  });

  it('does not contradict the detail rows in the middle band', () => {
    /*
     * Under 50% as displayed, the technical rows say "the stage spent most of
     * it holding".
     * The card previously said "it followed most of the take" from 0.4 up, so
     * one dialog made two statements that cannot both be true.
     */
    const outcome = resolveTakeOutcome(take({ followingShare: 0.45 }));
    expect(outcome.detail).not.toMatch(/most of the take/i);
  });

  it('reports a manual take as finished, not as a following failure', () => {
    // There was no microphone. "Nothing was transcribed" would report the
    // absence of a subsystem this take never started.
    const outcome = resolveTakeOutcome(take({ mode: 'manual', wordsHeard: 0, followingShare: null }));
    expect(outcome.tone).toBe('neutral');
    expect(outcome.headline).not.toMatch(/transcrib/i);
  });

  it('names interrupted voice following ahead of the following share it explains', () => {
    // A reconnect CAUSES a poor share. Reporting "following needed help" would
    // send the presenter to rewrite a script that was never the problem.
    const outcome = resolveTakeOutcome(take({ reconnects: 2, followingShare: 0.3 }));
    expect(outcome.headline).toBe('Voice following was interrupted');
    // The recogniser is on this machine: no connection, cable or link to blame.
    expect(`${outcome.headline} ${outcome.suggestion}`).not.toMatch(/connection|cable|wireless/i);
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
     * Speaking Glass can say whether it heard and whether it followed. It cannot
     * tell whether a take was good, because nothing in it analyses delivery.
     * An outcome that praised a take would be inventing a measurement.
     */
    const banned = /\b(great|excellent|good take|well done|confident|engaging|professional|nice work)\b/i;
    const shares = [null, 0, 0.2, 0.5, 0.85, 1];
    for (const followingShare of shares) {
      for (const reconnects of [0, 1, 3]) {
        for (const wordsHeard of [0, 5, 900]) {
          // Every mode and both duration branches, so `Take ended early`,
          // manual and fixed outcomes are covered too — the first version of
          // this test reached only long voice takes.
          for (const mode of ['voice', 'manual', 'fixed'] as const) {
            for (const durationSeconds of [2, 180]) {
              for (const manualJumps of [0, 3]) {
                for (const followingTime of TIMES) {
                  const outcome = resolveTakeOutcome(
                    take({
                      followingShare,
                      reconnects,
                      wordsHeard,
                      mode,
                      durationSeconds,
                      manualJumps,
                      followingTime,
                    }),
                  );
                  const text = `${outcome.headline} ${outcome.detail} ${outcome.suggestion ?? ''}`;
                  expect(text, `judged the delivery: ${text}`).not.toMatch(banned);
                }
              }
            }
          }
        }
      }
    }
  });

  it('produces a labelled band for every outcome it can return', () => {
    const shares = [null, 0, 0.39, 0.4, 0.79, 0.8, 1];
    for (const followingShare of shares) {
      for (const mode of ['voice', 'manual', 'fixed'] as const) {
        for (const wordsHeard of [0, 200]) {
          for (const followingTime of TIMES) {
            const outcome = resolveTakeOutcome(take({ followingShare, mode, wordsHeard, followingTime }));
            expect(FOLLOW_HEALTH_LABELS[outcome.health], `unlabelled band for ${outcome.health}`).toBeTruthy();
            expect(outcome.headline.length).toBeGreaterThan(0);
            expect(outcome.detail.length).toBeGreaterThan(0);
          }
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

/**
 * #287 — following is judged on the time it was asked to run.
 *
 * The share used to divide by the whole take, so every second the presenter
 * took following away — Space, the follow switch, auto-scroll — was booked as
 * following failing. A minute's pause read "Following needed help", a take
 * rolled from the first line read "did not track", and both sent the presenter
 * looking for a fault in a microphone or a script that had none.
 */
describe('resolveTakeOutcome — time the presenter set following aside (#287)', () => {
  /** Everything an outcome says, for asserting what it must never say. */
  const said = (input: TakeOutcomeInput) => {
    const outcome = resolveTakeOutcome(input);
    return `${outcome.headline} ${outcome.detail} ${outcome.suggestion ?? ''}`;
  };

  it('judges a paused take on the following it was given', () => {
    // The issue's take: 20 s followed, a 60 s Space pause, 10 s more.
    const outcome = resolveTakeOutcome(
      take({ followingShare: 1, followingTime: time({ onSeconds: 30, pausedSeconds: 60 }) }),
    );
    expect(outcome.health).toBe('steady');
    expect(outcome.tone).toBe('good');
    expect(outcome.headline).toBe('Speaking Glass stayed with you');
    expect(outcome.detail).toContain('the time following was on');
    expect(outcome.detail).toContain('Not counted: 1:00 paused.');
    expect(outcome.suggestion).toBeNull();
  });

  it('still says following needed help when it held while it was on', () => {
    // The verdict the issue asks to keep: following on, and holding.
    const outcome = resolveTakeOutcome(
      take({ followingShare: 0.2, followingTime: time({ onSeconds: 30, pausedSeconds: 60 }) }),
    );
    expect(outcome.headline).toBe('Following needed help');
    expect(outcome.health).toBe('frequent_help');
    expect(outcome.detail).toContain('much of the time following was on');
    expect(outcome.detail).toContain('Not counted: 1:00 paused.');
  });

  it('says a take auto-scroll carried was auto-scroll, whatever the share came back as', () => {
    /*
     * A roll from the first line keeps every snapshot away, so the share is
     * null; started part way, the opening anchor is one snapshot and the share
     * is a small number. Neither is a tracking fault, and both are the same
     * take.
     */
    for (const followingShare of [null, 0, 0.05]) {
      for (const onSeconds of [0, 1.5]) {
        const input = take({
          followingShare,
          followingTime: time({ onSeconds, autoScrollSeconds: 90 }),
        });
        const outcome = resolveTakeOutcome(input);
        expect(outcome.headline).toBe('This take used auto-scroll');
        expect(outcome.health).toBe('not_assessed');
        expect(outcome.tone).toBe('neutral');
        expect(outcome.suggestion).toBeNull();
        expect(said(input)).not.toMatch(/did not track|support bundle|microphone|ad-libs/i);
      }
    }
  });

  it('names the reason the presenter set following aside for longest', () => {
    const headline = (over: Partial<FollowingTime>) =>
      resolveTakeOutcome(take({ followingShare: null, followingTime: time({ onSeconds: 1, ...over }) }))
        .headline;
    expect(headline({ pausedSeconds: 60 })).toBe('This take was paused');
    expect(headline({ offSeconds: 60 })).toBe('Following was switched off');
    expect(headline({ autoScrollSeconds: 60 })).toBe('This take used auto-scroll');
    expect(headline({ pausedSeconds: 10, offSeconds: 50, autoScrollSeconds: 20 })).toBe(
      'Following was switched off',
    );
  });

  it('judges a take whose following was on for five seconds', () => {
    const at = (onSeconds: number) =>
      resolveTakeOutcome(
        take({ followingShare: 0.2, followingTime: time({ onSeconds, pausedSeconds: 60 }) }),
      ).health;
    expect(at(4.9)).toBe('not_assessed');
    expect(at(5)).toBe('frequent_help');
  });

  it('does not tell a presenter who paused through a take to test the microphone', () => {
    // Space and a hard pause stop the microphone reaching the recogniser, so
    // nothing was heard because nothing was sent.
    const input = take({
      wordsHeard: 0,
      followingShare: null,
      durationSeconds: 90,
      listenedSeconds: 2,
      followingTime: time({ onSeconds: 2, pausedSeconds: 88 }),
    });
    const outcome = resolveTakeOutcome(input);
    expect(outcome.headline).toBe('This take was paused');
    expect(outcome.tone).toBe('neutral');
    expect(said(input)).not.toMatch(/microphone|nothing was transcribed/i);
  });

  it('still reports silence under a roll, without saying the stage stood still', () => {
    // A roll leaves listening running, so a minute of it with nothing heard
    // is exactly what the microphone advice is for.
    const input = take({
      wordsHeard: 0,
      followingShare: null,
      durationSeconds: 90,
      listenedSeconds: 90,
      followingTime: time({ onSeconds: 5, autoScrollSeconds: 85 }),
    });
    const outcome = resolveTakeOutcome(input);
    expect(outcome.headline).toBe('Nothing was transcribed');
    expect(outcome.suggestion).toMatch(/microphone/i);
    expect(outcome.detail).toMatch(/auto-scroll/);
    expect(outcome.detail).not.toMatch(/stayed where it was|only thing that moved/i);
    expect(outcome.detail).toMatch(/nothing was lost/i);
  });

  it('still reports silence while following was switched off', () => {
    const outcome = resolveTakeOutcome(
      take({
        wordsHeard: 0,
        followingShare: null,
        durationSeconds: 90,
        listenedSeconds: 90,
        followingTime: time({ onSeconds: 0, offSeconds: 90 }),
      }),
    );
    expect(outcome.headline).toBe('Nothing was transcribed');
  });

  it('asks whether anything was heard of the listening the whole session did', () => {
    /*
     * Words are counted across the session and the pass's pause is not, and
     * `durationSeconds` is whole wall-clock seconds. Setting one against the
     * other got both directions wrong.
     */
    const silent = (listenedSeconds: number, pausedSeconds: number) =>
      resolveTakeOutcome(
        take({
          wordsHeard: 0,
          followingShare: null,
          durationSeconds: 80,
          listenedSeconds,
          followingTime: time({ onSeconds: 80 - pausedSeconds - 0.01, pausedSeconds }),
        }),
      ).headline;
    // Paused from the start, retaken while paused: the session never listened,
    // though the last pass's pause is only the last twenty seconds of it.
    expect(silent(0, 20)).toBe('This take was paused');
    // A silent first pass, then a retake paused to the end: the minute of
    // silence before it is still a minute of silence.
    expect(silent(60, 20)).toBe('Nothing was transcribed');
    // Five and a half seconds listened is past the threshold, whatever the
    // floored clock says.
    expect(
      resolveTakeOutcome(
        take({
          wordsHeard: 0,
          followingShare: null,
          durationSeconds: 35,
          listenedSeconds: 5.5,
          followingTime: time({ onSeconds: 5.5, pausedSeconds: 30.2 }),
        }),
      ).headline,
    ).toBe('Nothing was transcribed');
  });

  it('never says how the take finished, only what happened in it', () => {
    // Resumed before the stop: the take did not finish paused.
    for (const outcome of [
      resolveTakeOutcome(take({ followingShare: 0, followingTime: time({ onSeconds: 3, pausedSeconds: 60 }) })),
      resolveTakeOutcome(take({ followingShare: null, followingTime: time({ onSeconds: 0, autoScrollSeconds: 60 }) })),
    ]) {
      expect(outcome.headline).not.toMatch(/finished (while|on|with)|mostly/i);
    }
  });

  it('does not blame an interruption nobody was being followed through', () => {
    const outcome = resolveTakeOutcome(
      take({ reconnects: 1, followingShare: 0, followingTime: time({ onSeconds: 2, pausedSeconds: 60 }) }),
    );
    expect(outcome.health).toBe('not_assessed');
    // With following on long enough to have been interrupted, it still is.
    expect(
      resolveTakeOutcome(
        take({ reconnects: 1, followingShare: 0.5, followingTime: time({ onSeconds: 30, pausedSeconds: 60 }) }),
      ).headline,
    ).toBe('Voice following was interrupted');
  });

  it('still reports a take that was on and never tracked, without claiming the stage stood still', () => {
    const outcome = resolveTakeOutcome(
      take({ followingShare: null, followingTime: time({ onSeconds: 30, autoScrollSeconds: 60 }) }),
    );
    expect(outcome.headline).toBe('Speaking Glass heard you, but did not track');
    expect(outcome.detail).not.toMatch(/did not move on its own/);
  });

  it('leaves the answers for a missing model and a non-voice take alone', () => {
    const aside = time({ onSeconds: 0, autoScrollSeconds: 90 });
    expect(
      resolveTakeOutcome(take({ voiceFollowingAvailable: false, followingTime: aside })).headline,
    ).toBe('Take finished without voice following');
    expect(resolveTakeOutcome(take({ mode: 'fixed', followingTime: aside })).headline).toBe('Voice following was off');
  });

  it('gives a take with nothing set aside the answers it always had', () => {
    for (const followingShare of [null, 0.2, 0.5, 0.9, 1]) {
      expect(resolveTakeOutcome(take({ followingShare, followingTime: time() }))).toEqual(
        resolveTakeOutcome(take({ followingShare })),
      );
    }
    // A short take that set nothing aside is still just short.
    expect(
      resolveTakeOutcome(
        take({ wordsHeard: 0, durationSeconds: 2, followingTime: time({ onSeconds: 2 }) }),
      ).headline,
    ).toBe('Take ended early');
  });
});

describe('describeSetAside', () => {
  it('names every reason, in the presenter’s units', () => {
    expect(describeSetAside(time({ pausedSeconds: 60 }))).toBe('1:00 paused');
    expect(describeSetAside(time({ pausedSeconds: 60, autoScrollSeconds: 30 }))).toBe(
      '1:00 paused and 0:30 on auto-scroll',
    );
    expect(describeSetAside(time({ pausedSeconds: 60, offSeconds: 20.4, autoScrollSeconds: 45 }))).toBe(
      '1:00 paused, 0:20 with following off and 0:45 on auto-scroll',
    );
  });

  it('says nothing about time that does not round to a second', () => {
    expect(describeSetAside(time())).toBeNull();
    expect(describeSetAside(time({ pausedSeconds: 0.4 }))).toBeNull();
  });
});
