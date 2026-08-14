/**
 * The status line a presenter reads mid-take (CCUX-001, CCUX-018).
 *
 * Two properties are under test and only one of them is about wording.
 *
 * The first is that "I cannot hear you" and "I can hear you and those words
 * are not in the script" are DIFFERENT states. They used to share the sentence
 * "Holding your place", and they have opposite remedies: one is a microphone
 * problem no amount of re-reading fixes, the other is not a problem at all and
 * is fixed by reading the next line on the glass. A presenter given one sentence
 * for both will check the microphone, because that is the failure they can
 * imagine.
 *
 * The second is the ordering. These conditions overlap constantly on a real
 * take — a deliberate hold with a dead microphone is perfectly reachable — so
 * the resolver has to have an opinion about which one to report, and that
 * opinion is what these tests pin down.
 */
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_DECISION_LABELS,
  followStatus,
  type FollowStatusInput,
} from '../../../src/control/lib/follow-language';

/** A healthy voice take, mid-follow. Each test varies one thing. */
function healthy(over: Partial<FollowStatusInput> = {}): FollowStatusInput {
  return {
    state: 'following',
    decision: 'localConfirmed',
    followingPaused: false,
    receivingFrames: true,
    voiceInput: true,
    micState: 'live',
    heardAnything: true,
    ...over,
  };
}

describe('followStatus', () => {
  it('says it is following when it is', () => {
    const status = followStatus(healthy());
    expect(status.line).toBe('Following');
    expect(status.tone).toBe('success');
  });

  /* ------------------------------------------------------------------ *
   * CCUX-018: signal and matching are different faults
   * ------------------------------------------------------------------ */

  it('distinguishes hearing nothing from hearing something off script', () => {
    const deaf = followStatus(healthy({ state: 'holding', micState: 'disconnected' }));
    const offScript = followStatus(healthy({ state: 'holding', decision: 'holdOffScript' }));

    const whole = (s: { line: string; detail: string | null }) => `${s.line} ${s.detail ?? ''}`;

    expect(deaf.line).not.toBe(offScript.line);
    // The no-signal case must point at the input, since nothing the presenter
    // says will change it.
    expect(whole(deaf)).toMatch(/microphone/i);
    // The off-script case must NOT, anywhere in the line or the detail, or it
    // sends them hunting a fault that is not there while the take runs.
    expect(whole(offScript)).not.toMatch(/microphone/i);
    expect(offScript.detail).toMatch(/can hear you/i);
  });

  it('does not treat an ordinary ad-lib as a warning', () => {
    // Holding because the words are not in the script is the engine working
    // correctly. Colouring it as a fault trains presenters to panic at the
    // exact moment the system is being careful on their behalf.
    expect(followStatus(healthy({ state: 'holding', decision: 'holdOffScript' })).tone).toBe(
      'neutral',
    );
  });

  it('reports nothing-heard-yet without calling it a fault', () => {
    /*
     * At the top of every take this is simply true — the presenter has not
     * started. A warning tone here would fire on every single take before its
     * first word, which is the fastest way to teach somebody to ignore the
     * indicator that matters.
     */
    const status = followStatus(healthy({ heardAnything: false }));
    expect(status.line).toBe('Listening — nothing heard yet');
    expect(status.tone).not.toBe('warning');
  });

  it('names a disconnected microphone and offers a way out', () => {
    const status = followStatus(healthy({ micState: 'disconnected' }));
    expect(status.line).toBe('Microphone disconnected');
    expect(status.detail).toMatch(/holding/i);
    expect(status.detail, 'a fault must carry its remedy').toMatch(/another input/i);
  });

  it('tells a muted microphone from a disconnected one', () => {
    const muted = followStatus(healthy({ micState: 'muted' }));
    expect(muted.line).toBe('Microphone muted');
    // Muting is something the operator did. It is not a fault and must not be
    // coloured as one.
    expect(muted.tone).toBe('neutral');
  });

  /* ------------------------------------------------------------------ *
   * Ordering, where the conditions overlap
   * ------------------------------------------------------------------ */

  it('reports a deliberate hold ahead of any diagnosis', () => {
    // Somebody who pressed Hold text is not to be told their microphone is
    // broken — they made a decision and the app is doing what they asked.
    const status = followStatus(
      healthy({ followingPaused: true, micState: 'disconnected', decision: 'holdOffScript' }),
    );
    expect(status.line).toBe('Text held');
    expect(status.detail).toMatch(/still listening/i);
  });

  it('promises no listening on a take that has no microphone', () => {
    const status = followStatus(healthy({ voiceInput: false, heardAnything: false }));
    expect(status.detail).toMatch(/nothing is listening/i);
    // "Check that the right microphone is selected" over a take that opened
    // without one is an instruction to fix something that is not broken.
    expect(status.detail).not.toMatch(/check that/i);
  });

  it('holds a paused manual take at paused rather than calling it manual', () => {
    const status = followStatus(healthy({ voiceInput: false, state: 'paused' }));
    expect(status.line).toMatch(/paused/i);
  });

  it('reports readiness, not state, before the first frame', () => {
    // There is no tracking state yet. Reporting `searching` here would claim
    // the engine is doing something it has not started.
    const status = followStatus(healthy({ receivingFrames: false, state: 'searching' }));
    expect(status.line).toBe('Ready to follow');
  });

  it('prefers the input fault over off-script', () => {
    // You cannot be off script if the microphone is gone, so the pair is not
    // symmetric and the resolver must not report the weaker claim.
    const status = followStatus(
      healthy({ micState: 'disconnected', decision: 'holdOffScript', state: 'holding' }),
    );
    expect(status.line).toBe('Microphone disconnected');
  });

  /* ------------------------------------------------------------------ *
   * CCUX-001: no decision code can reach this surface
   * ------------------------------------------------------------------ */

  it('never renders an engine decision code, whatever the decision', () => {
    const codes = Object.keys(FOLLOW_DECISION_LABELS) as Array<keyof typeof FOLLOW_DECISION_LABELS>;
    expect(codes.length).toBeGreaterThan(5);

    const leaked: string[] = [];
    for (const decision of codes) {
      for (const paused of [true, false]) {
        for (const frames of [true, false]) {
          const status = followStatus(healthy({ decision, followingPaused: paused, receivingFrames: frames }));
          const text = `${status.line} ${status.detail ?? ''}`;
          /*
           * The diagnostics label verbatim, which is the actual regression:
           * "Relocated", "Possible jump — gathering evidence". Substring rather
           * than equality because it was rendered inside a row, not alone.
           */
          if (text.includes(FOLLOW_DECISION_LABELS[decision])) leaked.push(decision);
        }
      }
    }
    expect(
      leaked,
      'A decision code reached the presenter-facing status line. These names describe the ' +
        'engine’s internal reasoning and are re-tuned freely; the four behaviour states are ' +
        'the promise. Diagnostics is the place for them.',
    ).toEqual([]);
  });
});
