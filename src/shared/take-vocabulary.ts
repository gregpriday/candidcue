/**
 * The words Speaking Glass uses for a take, in one place (CCUX-002).
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE RATHER THAN A STYLE NOTE
 * ---------------------------------------------------------------------------
 * The product has several legitimate but overlapping ideas — a session that is
 * running or ended, following that is on or off, a microphone that is open or
 * shut, a transport that can move text with no voice involved — and each was
 * named at the place it was rendered. So the same act had three names: the
 * control panel called it "Pause following", the stage dock called it "Follow
 * my voice", and the summary called the resulting take "Fixed speed". A
 * presenter mid-take had to work out that these were one concept.
 *
 * Three axes, and they are INDEPENDENT. That is the whole point of separating
 * them: a take can be running with the text held and the microphone listening,
 * and every combination of the three is reachable and meaningful.
 *
 *   Take      — running, paused, ended
 *   Movement  — follow voice, hold text, roll at pace, manual
 *   Microphone— listening, muted, unavailable
 *
 * The engine's internal vocabulary (decision codes, endpointing, transport
 * state) maps INTO these and never leaks out of diagnostics — see
 * `follow-language.ts`, which owns that boundary.
 */

/* ---------------------------------------------------------------------------
 * Axis A: the take itself
 * ------------------------------------------------------------------------- */

/**
 * Whether a presentation attempt is under way.
 *
 * The narrowest of the three axes and the one most often conflated with the
 * others: "Pause" was used for pausing this, for stopping the text moving, and
 * for closing the microphone, which are three decisions with three different
 * consequences.
 */
export type TakeState = 'running' | 'paused' | 'ended';

export const TAKE_STATE_LABELS: Record<TakeState, string> = {
  running: 'Running',
  paused: 'Paused',
  ended: 'Ended',
};

/* ---------------------------------------------------------------------------
 * Axis B: what is moving the text
 * ------------------------------------------------------------------------- */

/**
 * How the script is being moved, as the user thinks about it.
 *
 * Distinct from the session `mode` ('voice' | 'manual' | 'fixed'), which is
 * fixed when the take opens and recorded on the session row. Movement can
 * change mid-take — a voice take whose following is held is still a voice take.
 */
export type MovementMode = 'follow' | 'hold' | 'roll' | 'manual';

export const MOVEMENT_LABELS: Record<MovementMode, string> = {
  follow: 'Follow voice',
  hold: 'Hold text',
  roll: 'Roll at pace',
  manual: 'Manual',
};

/**
 * One line saying what the chosen movement mode actually does.
 *
 * "Hold text" is the one that has to earn its wording: it is the control a
 * presenter reaches for when they are about to go off script deliberately, and
 * the thing they most need to know is that the take is NOT ending and the
 * microphone is NOT closing.
 */
export const MOVEMENT_DETAIL: Record<MovementMode, string> = {
  follow: 'The text moves when Speaking Glass is sure it has found your place.',
  hold: 'The text stays where it is. The take keeps running and Speaking Glass keeps listening.',
  roll: 'The text moves at a set pace regardless of what you say.',
  manual: 'The text moves only when you move it.',
};

/* ---------------------------------------------------------------------------
 * Session mode — what a take was OPENED as
 * ------------------------------------------------------------------------- */

/** The persisted session mode, as stored on the session record. */
export type SessionMode = 'voice' | 'manual' | 'fixed';

/**
 * Session mode in the movement vocabulary.
 *
 * 'fixed' reads as "Roll at pace" rather than "Fixed speed" so the summary, the
 * settings readout and the live control all name one thing one way. The stored
 * value is untouched — this is a display mapping, not a migration.
 */
export const SESSION_MODE_LABELS: Record<SessionMode, string> = {
  voice: 'Follow voice',
  manual: 'Manual',
  fixed: 'Roll at pace',
};

export function sessionModeLabel(mode: string): string {
  return SESSION_MODE_LABELS[mode as SessionMode] ?? mode;
}

/* ---------------------------------------------------------------------------
 * Axis B actions — the buttons that change movement
 * ------------------------------------------------------------------------- */

/**
 * Action labels for the live controls.
 *
 * `setPlace` replaced "Re-find me here", which described the ENGINE's job
 * ("re-find") rather than the user's ("this is where I am"). The distinction
 * matters under pressure: a presenter who has lost their place is looking for
 * a control that asserts something, not one that requests a search.
 *
 * The sentence nudges lost "Nudge" for the same reason — "Nudge forward" does
 * not say how far, and the answer (exactly one sentence) is the only thing
 * anybody needs to know before pressing it.
 */
export const TAKE_ACTIONS = {
  hold: 'Hold text',
  follow: 'Follow voice',
  setPlace: 'Set my place',
  previousSentence: 'Previous sentence',
  nextSentence: 'Next sentence',
  endTake: 'End take',
} as const;

/**
 * The take's own name for itself, used by the menu, the shortcuts sheet, the
 * transport and the stage dock.
 *
 * "End Session" named the DATABASE ROW. What the presenter is ending is the
 * attempt they just made in front of a camera, and the command's own id has
 * said `session.end-take` all along.
 */
export const END_TAKE_LABEL = 'End Take';

/* ---------------------------------------------------------------------------
 * Practice — the same take, told that it is a rehearsal
 * ------------------------------------------------------------------------- */

/**
 * What a practice is, in one sentence, because every other name for it is
 * wrong.
 *
 * A practice is NOT a second kind of motion, a second renderer or a take with
 * the microphone switched off. It is an ordinary voice-following take, opened
 * in a window, that has been told it is a rehearsal — so it renders the whole
 * document rather than a performance projection of it, and it reports nothing
 * when it ends. Everything that makes following work is untouched, because
 * following your own voice IS the thing being practised.
 *
 * The spelling is the product's: British in prose ("practise" as the verb),
 * and `practice` as the identifier because it reads as the noun everywhere it
 * appears in code — a practice, the practice flag, `isPractice`.
 */
export const PRACTICE_LABEL = 'Practise';

/**
 * Ending one.
 *
 * "End take" is the wrong promise here in both halves: there is no take, and
 * "end" is the word for the thing that produces a report. A rehearsal is
 * finished, and nothing follows it.
 *
 * Sentence case, like `TAKE_ACTIONS.endTake` beside which it stands: it is a
 * button's label in the dock and in the host's confirmation, not a menu-bar
 * command.
 */
export const FINISH_PRACTICE_LABEL = 'Finish practice';

/**
 * What every confirmation over a rehearsal asks.
 *
 * There are three of them — the dock's anchored confirmation, Live's own
 * dialog and App's navigation guard — and a take reaches all three through
 * "End this take?". Leaving two of them saying that over a practice would put
 * the operator in front of an offer to end something they do not believe they
 * started, which is the whole reason the dock's copy changed.
 *
 * The BODY is the dock's, and the dialogs keep their own (see
 * `STOP_PRACTICE_CONFIRM_BODY` in `control/lib/app-lifecycle.ts`) for the same
 * reason a take's two bodies differ: the dock is a control on the glass and the
 * dialog is a question about leaving presentation mode.
 */
export const FINISH_PRACTICE_CONFIRM_TITLE = 'Finish practising?';

/**
 * The dock's body.
 *
 * "Your place in the script will be saved" answers a fear about losing a take.
 * A rehearsal does not create that fear; what somebody wants to know before
 * finishing one is that nothing is being written down about it. The second
 * sentence is true for the reason a practice writes an ordinary session row —
 * "From last ending" picks a rehearsal up exactly as it picks a take up.
 */
export const FINISH_PRACTICE_CONFIRM_BODY =
  'Nothing is reported. Your place in the script is kept.';

/* ---------------------------------------------------------------------------
 * Axis C: the microphone
 * ------------------------------------------------------------------------- */

export type MicrophoneState = 'listening' | 'muted' | 'unavailable';

export const MICROPHONE_LABELS: Record<MicrophoneState, string> = {
  listening: 'Listening',
  muted: 'Muted',
  unavailable: 'Unavailable',
};

/* ---------------------------------------------------------------------------
 * Nouns
 * ------------------------------------------------------------------------- */

/**
 * The product's nouns, so a component never has to guess between two of them.
 *
 * "Take" and "session" were used interchangeably and they are not the same: a
 * session is the record, a take is the attempt the presenter just made. The
 * end-of-take dialog is the place this mattered most — it was headed "Session
 * complete", which named the database row rather than the thing that just
 * happened in front of the camera.
 */
export const NOUNS = {
  take: 'take',
  Take: 'Take',
  script: 'script',
  Script: 'Script',
  /** Full-display mode, for glass or an external panel. */
  prompter: 'Teleprompter',
  /** An ordinary desktop window near the camera. */
  reader: 'Reading window',
  /** A named panel + glass + mirroring + optics combination. */
  rig: 'Rig',
} as const;
