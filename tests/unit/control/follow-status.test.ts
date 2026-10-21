/**
 * The status line a presenter reads mid-take (CCUX-001, CCUX-018).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS ACTUALLY GUARDING
 * ---------------------------------------------------------------------------
 * "I cannot hear you" and "I can hear you and those words are not in the
 * script" used to share the sentence "Holding your place". They have opposite
 * remedies — one is a microphone problem no amount of re-reading fixes, the
 * other is not a problem at all — and a presenter given one sentence for both
 * will check the microphone, because that is the failure they can imagine.
 *
 * Most of the tests below are about ORDER rather than wording, because these
 * conditions overlap constantly on a real take and the first version of this
 * resolver got three of the overlaps wrong:
 *
 *  - it read the store's broad `followingPaused` as a decision, but that flag
 *    is ALSO raised automatically on device loss, so a dead microphone reported
 *    "Text held — Speaking Glass is still listening": false in both halves;
 *  - it answered "Ready to follow" before looking at the microphone, and a dead
 *    microphone produces no motion frames, so the panel would have said "ready"
 *    for the entire take;
 *  - it called the text stationary while auto-scroll was rolling it, because
 *    starting auto-scroll deliberately raises that same pause flag.
 *
 * Each of those has a test here so they cannot come back quietly.
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
    heldByUser: false,
    rollingAtPace: false,
    receivingFrames: true,
    voiceInput: true,
    micState: 'live',
    inputDeviceLost: false,
    heardAnything: true,
    ...over,
  };
}

const whole = (s: { line: string; detail: string | null }): string => `${s.line} ${s.detail ?? ''}`;

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
    const deaf = followStatus(
      healthy({ state: 'holding', micState: 'disconnected', inputDeviceLost: true }),
    );
    const offScript = followStatus(healthy({ state: 'holding', decision: 'holdOffScript' }));

    expect(deaf.line).not.toBe(offScript.line);
    expect(whole(deaf)).toMatch(/microphone/i);
    // The off-script case must NOT mention the microphone, anywhere, or it
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

  it('offers the input picker only for a fault the picker can fix', () => {
    // Both leave micState 'disconnected'. Only a lost DEVICE is curable by
    // choosing another one; telling somebody to switch microphone because the
    // recogniser died is an instruction they cannot follow.
    const device = followStatus(healthy({ micState: 'disconnected', inputDeviceLost: true }));
    expect(device.detail).toMatch(/another input/i);

    const transport = followStatus(healthy({ micState: 'disconnected', inputDeviceLost: false }));
    expect(transport.detail).not.toMatch(/another input/i);
    expect(
      transport.detail,
      'it must say what it is NOT, or they will go and unplug things',
    ).toMatch(/not the microphone/i);
  });

  it('names a refused microphone as a refusal, with neither other remedy (#303)', () => {
    // A refusal leaves micState 'disconnected' with no device lost. Before
    // #303 it reached the recogniser branch — "This is not the microphone" —
    // which is exactly backwards; and offering another input cannot answer it.
    const refused = followStatus(
      healthy({ micState: 'disconnected', inputDeviceLost: false, microphoneRefused: true }),
    );
    expect(refused.line).toBe('Microphone not allowed');
    expect(refused.detail).toMatch(/System Settings/);
    expect(refused.detail).not.toMatch(/another input/i);
    expect(refused.detail).not.toMatch(/not the microphone/i);
    expect(refused.tone).toBe('warning');
  });

  it('names the platform’s own settings for a refusal', () => {
    // Named, not read from the host: this suite runs as a Mac everywhere.
    const input = healthy({ micState: 'disconnected', inputDeviceLost: false, microphoneRefused: true });
    expect(followStatus(input, 'windows').detail).toMatch(
      /Allow apps to use the microphone in Windows Settings, then choose Try again\.$/,
    );
    expect(followStatus(input, 'linux').detail).toMatch(
      /Allow Speaking Glass in your system settings, then choose Try again\.$/,
    );
    // The line itself is not the platform's to change.
    expect(followStatus(input, 'windows').line).toBe('Microphone not allowed');
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

  it('tells a muted microphone from a disconnected one', () => {
    const muted = followStatus(healthy({ micState: 'muted' }));
    expect(muted.line).toBe('Microphone muted');
    // Muting is something the operator did. Not a fault, not coloured as one.
    expect(muted.tone).toBe('neutral');
  });

  /* ------------------------------------------------------------------ *
   * Ordering. Every one of these is a bug the first version had.
   * ------------------------------------------------------------------ */

  it('never calls the text stationary while it is rolling', () => {
    /*
     * Starting auto-scroll in a voice take deliberately raises the pause flag —
     * following really is off — while the text moves down the glass. "The text
     * stays where it is" in front of a presenter watching it move is the kind
     * of wrong that costs the whole readout its credibility.
     */
    const status = followStatus(healthy({ rollingAtPace: true, heldByUser: true }));
    expect(status.line).toBe('Rolling at pace');
    expect(whole(status)).not.toMatch(/stays where it is/i);
  });

  it('reports a real input fault instead of an automatic hold', () => {
    /*
     * Device loss sets the store's broad `followingPaused` itself. Reading that
     * as a decision produced "Text held — the take is still running and
     * Speaking Glass is still listening" over a microphone that had gone. Only
     * `heldByUser` may produce that sentence.
     */
    const status = followStatus(
      healthy({ heldByUser: false, micState: 'disconnected', inputDeviceLost: true }),
    );
    expect(status.line).toBe('Microphone disconnected');
    expect(whole(status)).not.toMatch(/still listening/i);
  });

  it('still names the fault when the operator had also held the text', () => {
    // They chose to hold; they did not choose to lose the microphone, and they
    // need to know that before they resume.
    const status = followStatus(
      healthy({ heldByUser: true, micState: 'disconnected', inputDeviceLost: true }),
    );
    expect(status.line).toBe('Microphone disconnected');
  });

  it('claims listening only when something is', () => {
    const held = followStatus(healthy({ heldByUser: true }));
    expect(held.line).toBe('Text held');
    expect(held.detail).toMatch(/still listening/i);
  });

  it('diagnoses the microphone before waiting for a frame', () => {
    /*
     * THE ORDERING BUG THAT DEFEATED THE WHOLE FEATURE.
     *
     * A dead microphone produces no transcript, so the aligner publishes no
     * snapshot, so `receivingFrames` stays false forever. A resolver that
     * answered "Ready to follow" on that condition first would sit there saying
     * "ready" for the entire take — precisely the silence CCUX-018 exists to
     * break.
     */
    const status = followStatus(
      healthy({ receivingFrames: false, micState: 'disconnected', inputDeviceLost: true }),
    );
    expect(status.line).toBe('Microphone disconnected');
  });

  it('promises no listening on a take that has no microphone', () => {
    const status = followStatus(healthy({ voiceInput: false, heardAnything: false }));
    expect(status.detail).toMatch(/nothing is listening/i);
    // "Check the microphone" over a take that opened without one is an
    // instruction to fix something that is not broken.
    expect(whole(status)).not.toMatch(/check the microphone/i);
  });

  it('holds a paused manual take at paused rather than calling it manual', () => {
    expect(followStatus(healthy({ voiceInput: false, state: 'paused' })).line).toMatch(/paused/i);
  });

  it('reports readiness, not state, before the first frame', () => {
    // There is no tracking state yet. Reporting `searching` here would claim
    // the engine is doing something it has not started.
    const status = followStatus(
      healthy({ receivingFrames: false, state: 'searching', heardAnything: false }),
    );
    expect(status.line).toBe('Ready to follow');
  });

  it('does not tell somebody already speaking to start speaking', () => {
    /*
     * Transcript text and alignment snapshots travel on separate paths, so a
     * partial can land before the first snapshot. "Ready to follow — start
     * speaking" at that moment reads as the app not hearing them, which is the
     * opposite of what is happening.
     */
    const status = followStatus(healthy({ receivingFrames: false, heardAnything: true }));
    expect(status.line).toMatch(/heard you/i);
    expect(`${status.line} ${status.detail}`).not.toMatch(/start speaking/i);
  });

  it('names a dead microphone even while the text is rolling', () => {
    /*
     * Rolling was checked first, so that the text was never called stationary
     * while it moved. True, and it made a lost device invisible here for as
     * long as the roll was armed. Both facts fit in one status.
     */
    const status = followStatus(
      healthy({ rollingAtPace: true, micState: 'disconnected', inputDeviceLost: true }),
    );
    expect(status.line).toBe('Microphone disconnected');
    // ...and it still must not claim the text has stopped.
    expect(status.detail).toMatch(/still rolling/i);
    expect(status.detail).not.toMatch(/holding where you left it/i);
  });

  /* ------------------------------------------------------------------ *
   * CCUX-001: no decision code can reach this surface
   * ------------------------------------------------------------------ */

  it('never renders an engine decision code, in any reachable combination', () => {
    const codes = Object.keys(FOLLOW_DECISION_LABELS) as Array<keyof typeof FOLLOW_DECISION_LABELS>;
    expect(codes.length).toBeGreaterThan(5);

    const leaked: string[] = [];
    for (const decision of codes) {
      for (const held of [true, false]) {
        for (const frames of [true, false]) {
          for (const mic of ['live', 'muted', 'disconnected'] as const) {
            for (const rolling of [true, false]) {
              const status = followStatus(
                healthy({
                  decision,
                  heldByUser: held,
                  receivingFrames: frames,
                  micState: mic,
                  rollingAtPace: rolling,
                }),
              );
              /*
               * Case-insensitive, because `describeMovement` renders these same
               * labels lowercased into its headline — so a copy-paste of that
               * phrasing onto this surface is the realistic regression, not a
               * verbatim capitalised one.
               */
              const text = whole(status).toLowerCase();
              if (text.includes(FOLLOW_DECISION_LABELS[decision].toLowerCase())) {
                leaked.push(decision);
              }
            }
          }
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
