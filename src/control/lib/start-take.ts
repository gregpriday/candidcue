/**
 * Press Present, turn this window into the teleprompter.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A SCREEN
 * ---------------------------------------------------------------------------
 * The display, the microphone, the tracking mode and the appearance are
 * choices a presenter makes once, so they live in Settings and Present does not
 * ask them again: a launch form that repeats one-time choices is skipped
 * without being read, which is the worst thing a gate can be, because the
 * moment it does block something the operator has no idea what it is talking
 * about.
 *
 * What is left is this: the ordered sequence that turns a script id into a
 * live take in the control window — filling the prompter panel, or as a
 * reading window. Present runs it and goes.
 *
 * There is deliberately no separate stage window in this path. This webview
 * owns microphone capture, transcript state and rendering; transcription and
 * alignment run in Rust, reached over IPC.
 */
import { get } from 'svelte/store';
import { inputsWithheld, matchRememberedMicrophone } from '../services/audio';
import { compileScript, type CompileOutput } from '../services/compiler';
import { describeError } from '../services/errors';
import {
  awaitViewportSettled,
  enterPresentation,
  exitPresentation,
  painted,
} from '../services/control-window';
import * as scriptsService from '../services/scripts';
import { endSessionRecord, startSessionRecord } from '../services/session-records';
import { snapToStart } from './take-start-point';
import * as stageService from '../services/stage';
import {
  buildStageEnvelope,
  resolveDocumentAssets,
  stageSettingsFromSettings,
} from '../services/stage-envelope';
import type { ScriptPart } from '../../shared/contracts';
import type { DisplayDescriptor } from '../services/stage-types';
import type { AppSettings, PresentationMode, ReaderFrame } from '../services/settings-types';
import { editor, saveNow } from '../stores/editor';
import { navigate } from '../stores/router';
import {
  clearSession,
  startLiveSession,
  stopSession,
  type TakePart,
} from '../stores/session';
import { coverIsUp, presentingPhase, setPresentingPhase } from '../stores/presenting';
import { loadSettings, patchSettings, settings } from '../stores/settings';
import { showToast } from '../stores/toasts';
import { isMirroredGlassRig, isPrompterGlass, withCameraAboveRig } from './camera-above-rig';
import { getVoiceFacade } from '../services/voice-facade';
import { preloadSpeechEngine } from '../services/stt/local';
import { writable } from 'svelte/store';

const startingStore = writable(false);

/**
 * True while a take is being opened. Present buttons read it so a second press
 * cannot start the same take twice — the sequence below is long enough to be
 * double-clicked through.
 */
export const takeStarting = { subscribe: startingStore.subscribe };

/**
 * The best GUESS at the display a take will be measured against, for the moment
 * before it is presented and the answer is known.
 *
 * ---------------------------------------------------------------------------
 * A GUESS, BECAUSE THE REAL ANSWER ARRIVES FROM RUST
 * ---------------------------------------------------------------------------
 * `set_control_presenting` reports the panel the window actually landed on
 * (`ControlPresentationState.displayFingerprint`), and `startTake` composes the
 * take's optics from THAT. This function is what stands in when there is no
 * such answer: plain-browser dev, where there are no monitors to name, and the
 * rig where the monitor cannot be identified.
 *
 * It is still worth getting right for those cases, and the rules below are the
 * ones that were correct when it was the only answer there was.
 *
 * It is NOT a description of where Present goes, and no screen should use it as
 * one: unpinned, Present fills the monitor the window is on, which this
 * deliberately steers away from. Welcome, Settings and the editor say where a
 * take opens through `resolvePrompterDisplay` (`lib/take-destination.ts`, #302);
 * Settings still aims previews, tests and calibration with this.
 *
 * ---------------------------------------------------------------------------
 * A PROMPTER CHOOSES A PANEL; A READING WINDOW IS ALREADY ON ONE
 * ---------------------------------------------------------------------------
 * For a prompter: a pinned fingerprint wins while that panel is connected.
 * Otherwise any display that is not the primary one, because on the rig this app
 * is for the primary display is the one with the operator's face pointed at the
 * control window, and putting the prompt window on top of it is not presenting.
 * With one display there is nothing to choose and it goes there.
 *
 * For a reading window every clause of that is wrong, and wrongly by default.
 * Reader mode presents THIS window where it already is (`windows/present.rs`
 * moves no geometry), so the panel that matters is the one the window is on —
 * and the prompter rule actively steers away from it, because a reader working
 * at their laptop with a calibrated external prompter attached would have their
 * type sized from the external panel's millimetres-per-pixel. That is not a
 * cosmetic mismatch: `mmPerCssPx` is the whole basis of the angular model, so
 * the text comes out confidently the wrong physical size.
 *
 * The primary display is the honest guess, and a much better one: it is where an
 * ordinary window sits unless somebody moved it. A pinned prompter fingerprint is
 * deliberately NOT consulted — it names the panel a prompter presents on, which
 * says nothing about where a reading window happens to be.
 *
 * KNOWN GAP: a reader who drags their window to another display MID-TAKE and
 * changes nothing else still keeps the opening panel's scale. Rust stops
 * forwarding window moves while presenting, so a bare drag mid-take raises no
 * display-change event. The two
 * moments Rust DOES answer are both covered — the opening, from
 * `enterPresentation`, and the ⌃⌘F switch, through `resolveLandedDisplay`
 * below.
 */
export function chooseStageDisplay(
  displays: DisplayDescriptor[],
  pinned: string | null,
  mode: PresentationMode = 'prompter',
): DisplayDescriptor | null {
  if (mode === 'reader') {
    return displays.find((d) => d.primary) ?? displays[0] ?? null;
  }
  if (pinned !== null) {
    const match = displays.find((d) => d.fingerprint === pinned);
    if (match) return match;
  }
  return displays.find((d) => !d.primary) ?? displays[0] ?? null;
}

/**
 * The panel a presentation reports it landed on, as a descriptor — or null when
 * nobody can name it.
 *
 * ---------------------------------------------------------------------------
 * FOR THE MID-TAKE SWITCH, WHICH GETS THE SAME ANSWER AND USED TO DROP IT
 * ---------------------------------------------------------------------------
 * Every arm of `set_control_presenting` reports the panel it applied its
 * geometry to, not just the opening one, and ⌃⌘F goes through that same
 * command. Both directions can change panels: switching to the prompter fills
 * whichever monitor the reading window had been dragged onto, and switching
 * back to a reader restores a frame that may live on a different panel again
 * (`windows/present.rs` says exactly that at the arm). Dropping the answer left
 * the take composed against the panel it OPENED on — for a reader who moved to
 * an external prompter that is `mmPerCssPx` from the wrong glass, which is
 * issue #116 in the middle of a take instead of at the start of one.
 *
 * Null means "no answer", never a guess. `chooseStageDisplay` is the right
 * fallback at the opening because there is nothing better to compose from;
 * mid-take there IS something better — the panel the take is already measured
 * against — so the caller keeps that rather than re-deriving a guess that can
 * be worse than the answer it already had.
 *
 * The enumeration happens here, at the moment the answer is matched, for the
 * reason `startTake` gives for enumerating late: a list taken earlier is a
 * topology from before the window moved.
 */
export async function resolveLandedDisplay(
  fingerprint: string | undefined,
): Promise<DisplayDescriptor | null> {
  if (fingerprint === undefined) return null;
  const displays = await stageService.listDisplays().catch(() => []);
  return displays.find((d) => d.fingerprint === fingerprint) ?? null;
}

/**
 * The stage appearance a take runs with, straight out of Settings.
 *
 * Re-exported from `services/stage-envelope`, where it moved when the session
 * store became its second caller (the in-session appearance sheet rebuilds the
 * take's settings through the same function). It is still named here because
 * this is where callers have always imported it from, and because composing the
 * settings a take opens with is what this module is about.
 */
export { stageSettingsFromSettings };

/**
 * Compile the script this take will read.
 *
 * Deliberately not the editor's compile: that one is debounced against typing
 * and carries whatever overrides the editor was last asked for. This is the one
 * the stage is built from, so it is run here, once, from the saved source.
 */
async function compileForTake(
  scriptId: string,
  source: string,
  readHeadings: boolean,
): Promise<CompiledTake> {
  const output = await compileScript(scriptId, source, { readHeadings });
  const blocking = output.diagnostics.find((d) => d.blocking);
  if (blocking) throw new Error(blocking.message);
  if (output.script === null) {
    // `script` is null only when the compile was superseded, which cannot
    // happen for a request made and awaited here — but a null slipping through
    // would reach the stage as an envelope with no document in it.
    throw new Error('Speaking Glass did not finish reading this script.');
  }
  return { ...output, script: output.script };
}

/** A compile that is known to have produced a document. */
type CompiledTake = CompileOutput & { script: NonNullable<CompileOutput['script']> };

/**
 * The device id the remembered microphone has RIGHT NOW, or undefined
 * for "follow the system default".
 *
 * The stored id is not enough on its own. Device ids are salted per origin and
 * session and change when hardware is replugged, so a take that pinned the
 * saved id verbatim would ask for a device that no longer answers to that name
 * — and land on the system default (a headset, as often as not) with only a
 * "the pinned device was busy" note to explain it. Enumerating here and
 * matching on the label as well is what makes "use my good microphone" hold
 * across a restart.
 *
 * Never fatal: a failed enumeration falls back to the stored id, which is what
 * this used to pass unconditionally.
 */
async function resolvePinnedMicrophone(s: AppSettings): Promise<string | undefined> {
  const pinned = s.audio.preferredDeviceId;
  // Older builds auto-pinned the browser's own `default` pseudo-device, which
  // is the system-default choice spelled a second way (as Settings reads it).
  if (s.audio.followSystemDefault || pinned === undefined || pinned === '' || pinned === 'default') {
    return undefined;
  }
  try {
    const devices = await getVoiceFacade().listMicrophones();
    const match = matchRememberedMicrophone(devices, {
      deviceId: s.audio.preferredDeviceId,
      label: s.audio.preferredDeviceLabel,
    });
    if (match) return match.deviceId;
    /*
     * The first take after every launch: the webview names no inputs until
     * this window has opened one, so nothing here can say whether the pin is
     * plugged in. Honour it. If the id has gone stale the take finds the
     * microphone by its name once it can see (`findPinnedMicrophone`), and says
     * so if it really is not connected.
     */
    if (inputsWithheld(devices)) return s.audio.preferredDeviceId;
    // Not plugged in. Presenting on the system default beats not presenting,
    // and it is said out loud for the same reason the wrong-display case above
    // is: a take that quietly runs on a different microphone is discovered from
    // the transcript, which is far too late.
    showToast(
      `${s.audio.preferredDeviceLabel ?? 'The microphone chosen in Settings'} is not connected, so this take is using the system default.`,
      'info',
    );
    return undefined;
  } catch {
    // Enumeration failed, so absence is not proven — honour the pin.
    return s.audio.preferredDeviceId;
  }
}

/**
 * The settings this take actually opens with, persisting an explicit choice on
 * the way through.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RETURNS SETTINGS AND NOT JUST A MODE
 * ---------------------------------------------------------------------------
 * It used to return the mode alone, and that was a bug with teeth. The mode is
 * read three times below — for the display, for the window, and for what the
 * session records — but it is read a FOURTH time inside
 * `stageSettingsFromSettings`, which decides from it whether the take gets a
 * reader's rig or a prompter's, and whether the picture is mirrored.
 *
 * Handing that function the pre-choice snapshot while handing the window the
 * chosen mode produced the worst possible pairing: choose "Present in a window"
 * from a prompter default and you got a reading window composed for glass —
 * prompter optics, and a horizontally mirrored script if the rig had mirroring
 * on. Returning one consistent object means there is no second copy of the
 * answer for anything downstream to disagree with.
 *
 * The write is awaited so the document matches what this take is about to do,
 * but a failure is deliberately not fatal: a settings document that would not
 * take the patch is a reason to present in the mode that was asked for anyway,
 * not a reason to refuse to present at all. `patchSettings` has already
 * reverted its optimistic update and told the operator by the time this
 * catches, so swallowing here does not swallow the report.
 */
async function resolveLaunchSettings(
  saved: AppSettings,
  requested: PresentationMode | undefined,
): Promise<AppSettings> {
  if (requested === undefined || requested === saved.stage.presentationMode) return saved;
  await patchSettings('stage', { presentationMode: requested }).catch(() => {});
  return { ...saved, stage: { ...saved.stage, presentationMode: requested } };
}

/**
 * The frame a reading window should come back at, or null to present in place.
 *
 * Three things have to hold. The take must be opening in reader mode — a
 * prompter fills a monitor and has no rectangle of its own. A frame must
 * actually have been stored. And "Restore windows" must be on.
 */
function restoreFrameFor(saved: AppSettings, mode: PresentationMode): ReaderFrame | null {
  if (mode !== 'reader') return null;
  if (!saved.general.restoreWindows) return null;
  return saved.stage.readerFrame;
}

/**
 * The optical section a take under the camera above this screen is composed
 * from (#238): the camera rig, stored for the panel the take landed on — or,
 * when it cannot be stored, the section as it stands.
 *
 * STORED OR NOT APPLIED. A mid-take recomposition (the appearance sheet, a
 * Settings change the running take follows) reads the SAVED section, so a rig
 * composed into the opening frame but never saved would be taken back at the
 * first slider drag: the mirror returning, the reading line dropping away from
 * the camera, in the middle of a take. So the take opens as a plain Present on
 * that panel would whenever the rig cannot be kept:
 *
 *  - the panel was not NAMED (`panel` is null): the rig and the cleared mirror
 *    belong to one physical screen, and a guess could be the glass;
 *  - the panel is glass — a recognised Elgato, or a panel whose chosen rig puts
 *    the camera behind a mirrored image. A camera cannot be above a screen it
 *    films through, so the window was on the wrong screen, and clearing that
 *    mirror would take it away from the glass for good;
 *  - the save failed. `patchSettings` has already rolled back and said so.
 *
 * The newest saved section is the base, and what a refused or unsaved take
 * composes from, so a rig saved since this take began is neither lost nor
 * contradicted by the first appearance change.
 */
async function chooseCameraAboveRig(
  s: AppSettings,
  panel: DisplayDescriptor | null,
): Promise<AppSettings['optical']> {
  const latest = get(settings)?.optical ?? s.optical;
  // Whatever is saved NOW, refused or not: recomposition mid-take reads that.
  const saved = (): AppSettings['optical'] => get(settings)?.optical ?? s.optical;
  if (panel === null) {
    showToast(
      'Speaking Glass could not tell which screen this is, so it was not set up for the camera above it. Present opened it as it would any other take.',
      'info',
    );
    return saved();
  }
  if (isPrompterGlass(panel) || isMirroredGlassRig(latest, panel.fingerprint)) {
    showToast(
      'This screen is a teleprompter, so it was left as it is. Move the Speaking Glass window to the screen with the camera above it and choose Camera above this screen again.',
      'info',
    );
    return saved();
  }
  const t = s.teleprompter;
  const seed = { intensity: t.textIntensity, readingCue: t.readingCue, bias: t.sizeBias };
  const next = withCameraAboveRig(latest, panel, seed);
  return patchSettings('optical', next).then(
    () => next,
    () => saved(),
  );
}

export interface StartTakeOptions {
  /**
   * Present in this shape, and REMEMBER it.
   *
   * ---------------------------------------------------------------------------
   * WHY AN EXPLICIT CHOICE STICKS WHEN THE MID-TAKE TOGGLE DOES NOT
   * ---------------------------------------------------------------------------
   * `session.ts` argues, correctly, that ⌃⌘F must not change what tomorrow's
   * take opens as: somebody who pops out to the full display to read one
   * difficult paragraph is making a decision about the paragraph, not about
   * their habits.
   *
   * This is the other kind of decision, and it is told apart by WHERE it was
   * made rather than by what it says. Choosing "Present in a window" from the
   * Present button is a statement about how this take should open, made at the
   * moment of opening it — the same gesture PowerPoint's "Set Up Slide Show"
   * and OBS's projector preference persist. A choice that had to be re-made
   * every single time is how the app came to feel like it was forgetting
   * things: the launch mode lived only in Settings, three levels from the
   * button, so the only reachable control was the transient one.
   *
   * Absent means "whatever Settings says".
   */
  presentationMode?: PresentationMode;
  /**
   * Where to begin, as a raw token index.
   *
   * Absent means the beginning. With a `part`
   * that resolves, it is confined to that part; see there.
   *
   * SNAPPED HERE rather than by the caller, and that is deliberate: the caret
   * position, an outline node and a previous take's ending are three different
   * kinds of number, and every one of them can land mid-sentence. Doing it once
   * on the way in means no entry point can forget, and the aligner can never be
   * handed an anchor inside half a clause.
   */
  startTokenIndex?: number;
  /**
   * The source `startTokenIndex` was counted in, when it came from somewhere
   * other than this compile (#448).
   *
   * "From last ending" is a previous take's token offset, valid only against
   * the source that take was read from. The menu offers it only while the
   * editor's compile matches, but the script can still change between choosing
   * the row and this compile — a held launch waiting on the readiness sheet is
   * the long version of that. A mismatch here refuses the take rather than
   * open it on whichever sentence now sits at that offset.
   */
  expectedSourceHash?: string;
  /**
   * This is a rehearsal, not a take.
   *
   * -------------------------------------------------------------------------
   * WHAT IT DOES *NOT* CHANGE, WHICH IS ALMOST EVERYTHING
   * -------------------------------------------------------------------------
   * The microphone opens, the recogniser loads, the aligner runs and the script
   * follows the voice — because reading the script aloud and having it follow
   * IS what somebody is practising. A rehearsal with the following switched off
   * would be a different feature that rehearses nothing.
   *
   * Four things follow from the flag, and they are the whole of it:
   *
   *   1. The window. A practice OPENS as `'reader'`, and the mode is FORCED
   *      rather than resolved — see below. It is where a practice starts, not
   *      where it must stay: the take's own "Switch to teleprompter" moves a
   *      running practice onto the glass at the size and line breaks the
   *      recording will use, and it is still a practice there. Opening on the
   *      display instead was considered and left alone (#241): rehearsing at a
   *      desk is the common case, and the one-step switch already covers the
   *      rest without a second launch row for it.
   *   2. The document. The stage renders it as a rehearsal rather than as a
   *      performance projection, so a reference table stays a table instead of
   *      becoming the words REFER TO TABLE. `performance-view.ts` has said this
   *      was the intended distinction since it was written.
   *   3. The ending. Nothing is reported: `stopSession` produces no summary, so
   *      the practice ends by putting the editor back rather than by opening a
   *      card about a performance nobody gave.
   *   4. The resume point. A practice's session row is an ordinary voice
   *      session, but it is closed WITHOUT an ending (#241), so "From last
   *      ending" — "Picks up where the last take stopped" — goes on meaning the
   *      last recording. It used to pick a rehearsal up as if it were one:
   *      record part two, practise part three, come back to record, and the
   *      resume point was wherever the rehearsal had stopped. A rehearsal is
   *      not where the footage left off, so it does not count as an ending.
   *
   * The flag lives in the control-side session store and nowhere else, which
   * is also why it needs no migration: the row says what it always said, minus
   * the one number a rehearsal must not supply.
   *
   * A practice CAN carry a `part` (#241). It bounds nothing, as for a take, and
   * since nothing is reported at the end it is only ever a label: which part is
   * being rehearsed, on the glass, and when its end has been reached.
   */
  practice?: boolean;
  /**
   * A teleprompter take under the camera above this screen (#238).
   *
   * The take fills the screen the window is on — the pinned panel is NOT
   * asked for, since the camera is above this one — and, once Rust has said
   * which panel that is, the camera rig is chosen for it and its mirror
   * cleared (`withCameraAboveRig`). Stored against the panel, so the next plain
   * Present finds it there whenever it falls back to this screen, and finds
   * the pinned prompter's own rig and mirror whenever it is plugged in.
   *
   * Always a teleprompter take, and the saved default is left as it is: this
   * is an action, not a shape somebody chose to work in, so a reading-window
   * default stays one. `presentationMode` is ignored alongside it. Ignored
   * itself for a practice, which always opens in a window.
   */
  cameraAboveScreen?: boolean;
  /**
   * The part of the script this take is recording.
   *
   * -------------------------------------------------------------------------
   * IT BOUNDS THE TAKE WITHOUT BOUNDING THE DOCUMENT
   * -------------------------------------------------------------------------
   * The compiled script handed to the stage and the token array handed to the
   * alignment engine are UNCHANGED — the whole script, exactly as an unbounded
   * take gets it. Nothing is truncated, hidden or filtered.
   *
   * What the part adds is an answer to "what am I recording". From it come
   * three things and no others: the
   * part's name beside the timer, a "you have reached the end of it" once the
   * confirmed position gets there, and an offer on the summary to record the
   * next one.
   *
   * Slicing the document instead was the other candidate and it is the wrong
   * trade. Every index in this system is document-absolute — snapshots, the
   * stage's viewport hint, `set_alignment_position`, the session row's start and
   * end — so a sliced engine would need an offset conversion threaded through
   * all of them, and `align/mod.rs` is emphatic that there is exactly ONE
   * conversion in the system and it lives there. It would also make reading past
   * a boundary impossible rather than merely unintended, which is a promise the
   * engine's position estimate is not accurate enough to keep.
   *
   * ONLY THE ID IS RESOLVED. The span, the name and the position are re-resolved
   * against the compile this take actually runs on — see the lookup in
   * `startTake` — so a caller cannot hand in a part measured against a document
   * that has since been edited. The type says so rather than a comment saying
   * so: anything that knows a part's identity can launch it, which is what lets
   * the summary dialog offer the next part without holding a compiler type.
   */
  part?: TakePartRequest;
}

/** A part to bound a take to: its identity, and how much of it. */
export interface TakePartRequest {
  id: string;
  /**
   * Record ALL of it: open at the part's own start, re-measured against this
   * compile, whatever `startTokenIndex` says. A part row and the summary's
   * "record part N" set it. "From here" does not — its token is where the
   * presenter is pointing, and a take begun part way into part three is a take
   * of part three that starts where the cursor was.
   *
   * WHY A FLAG, when "no token" could have meant the same thing: a whole-part
   * launch still carries its token, as the place to open if the part cannot be
   * found at all. A marker part's identity includes its source offset, so any
   * edit above the marker re-identifies it, and without the token that ordinary
   * case would open at the top of the script. And a token alone cannot say it
   * means the part's start: after an edit that moves the part earlier, its old
   * start can lie inside the new span, where it looks exactly like a cursor.
   */
  whole?: boolean;
}

/**
 * Open a take for a script and route to Live. Resolves true when the take is
 * running.
 *
 * Every failure path tries to leave nothing behind: no window left
 * presenting, no unfinished session row, no microphone held by a session that
 * does not exist. Restoring the window and closing the row are best-effort —
 * a failure there is logged and the cover still drops.
 */
export async function startTake(
  scriptId: string,
  options: StartTakeOptions = {},
): Promise<boolean> {
  if (get(startingStore)) return false;
  /*
   * NOT WHILE ANOTHER TRANSITION OWNS THE COVER.
   *
   * `startingStore` stops a second START; this stops a start racing a FINISH,
   * which is a different collision with the same consequence. Both ends of a
   * transition write `presentingPhase` from a `finally`, last writer wins, and
   * there is no owner token — so a take begun while a teardown is still
   * unwinding gets its `opening` overwritten by the other one's `off`. That is
   * an app presenting with no cover, or covered with nothing to present.
   *
   * It became reachable when a take started ending on the EDITOR. The window
   * between the route swap and the cover coming down is short — one paint — but
   * the screen underneath now has a Present button and answers the Present
   * shortcut, where the console it replaced had neither. The App navigation
   * guard opens the same hole from the other side: it raises its own cover and
   * then awaits a paint before stopping the session, and `endTake` refuses on
   * this same condition for that reason.
   */
  if (coverIsUp(get(presentingPhase))) return false;
  startingStore.set(true);

  /*
   * Opened before anything can fail, so `abandon` always has the id it needs.
   * Rust assigns it (`start_session` is the only writer of the session
   * generation, and control adopts both) — see the note on `startSessionRecord`
   * below for what skipping it used to break.
   */
  let sessionId = '';

  try {
    /*
     * The take reads what is on disk, so flush the editor first —
     * and then check that the flush actually landed.
     *
     * `saveNow()` reports a conflict or a failed write through store state and
     * resolves normally either way, so awaiting it proves nothing on its own.
     * Presenting through an unsaved conflict means the stage shows the older
     * text while the editor shows the newer, and Rust's pre-session revision
     * snapshot records a revision that does not match the compile the
     * aligner was built from. The remedy is on the Editor screen, so say so and
     * stop rather than present something the operator did not write.
     */
    await saveNow().catch(() => {});
    const editorState = get(editor);
    if (editorState.scriptId === scriptId && editorState.saveState === 'conflict') {
      throw new Error(
        'This script changed outside Speaking Glass. Resolve that in the editor before presenting.',
      );
    }
    if (editorState.scriptId === scriptId && editorState.saveState === 'error') {
      throw new Error(
        `The latest edits could not be saved, so the stage would show older text. ${
          editorState.lastError ?? ''
        }`.trim(),
      );
    }
    const doc = await scriptsService.getScript(scriptId);
    const loaded = await loadSettings(true).catch(() => get(settings));
    /*
     * One snapshot, resolved once, and everything below reads the take's
     * settings from it — including `stageSettingsFromSettings`, which composes
     * the rig and the mirror from the same field. See `resolveLaunchSettings`.
     */
    /*
     * A PRACTICE NEVER TAKES THE DISPLAY, AND NEVER CHANGES THE DEFAULT.
     *
     * `resolveLaunchSettings` persists an explicit mode, because choosing
     * "Present in a window" from the Present button is a statement about how
     * this operator works. A practice is not that statement: it is in a window
     * because rehearsing at a desk is what a practice IS, and somebody who
     * rehearses before every take would otherwise find their real takes had
     * quietly stopped filling the display. So the mode is forced here, past the
     * resolver, and the saved default is left exactly where it was.
     */
    // A take under the camera is forced to the prompter the same way, and for
    // the same reason leaves the saved default alone: it is an action, not a
    // shape somebody chose to work in. See `cameraAboveScreen`.
    const cameraAbove = options.cameraAboveScreen === true && !options.practice;
    const s =
      options.practice || cameraAbove
        ? await resolveLaunchSettings(loaded, undefined)
        : await resolveLaunchSettings(loaded, options.presentationMode);
    const presentationMode: PresentationMode = options.practice
      ? 'reader'
      : cameraAbove
        ? 'prompter'
        : s.stage.presentationMode;
    /*
     * Start loading the recogniser now, while the rest of the take is built
     * (#257).
     *
     * A cold load is over a second — up to five — and the voice pipeline is
     * the last thing this function starts, so the compile, the window taking
     * the display and the viewport settling are all time the load can run in
     * rather than time the presenter spends talking ahead of it. The pipeline
     * holds what it hears until the load finishes either way; this is what
     * keeps that wait short.
     *
     * Here rather than at the top: this is the first point the take's own
     * settings are known, and a manual or fixed take never starts a recogniser
     * and has no business making the machine hold one. Not awaited, and a
     * failure is not reported here — the pipeline's own `start_transcription`
     * surfaces the same error where it can be acted on.
     */
    if (s.general.defaultSessionMode === 'voice') void preloadSpeechEngine().catch(() => {});
    const compiled = await compileForTake(scriptId, doc.source, s.general.readHeadings);

    if (
      options.expectedSourceHash !== undefined &&
      compiled.script.sourceHash !== options.expectedSourceHash
    ) {
      showToast(
        'The script has changed since that take ended, so where it stopped is no longer known. Choose where to start again.',
        'info',
      );
      return false;
    }

    /*
     * A script with no words in it is not a take.
     *
     * Deliberately NOT a compiler diagnostic and not an error: an empty script
     * is the ordinary, correct state of one somebody has just made, and the
     * compiler is right to call it clean. It is simply nothing to follow, and
     * every part of this sequence would report success over it — `startAlignment`
     * no-ops on a zero-token script, so the session goes live, the microphone
     * opens, the recogniser loads, the window fills the monitor, and the glass
     * then holds still for as long as the operator leaves it there with nothing
     * anywhere saying why.
     *
     * Here rather than on the Present button because every entry point — the
     * editor, both Library paths, the retake on Live — arrives through this one
     * function, so a guard on the button is a guard on none of the others. The
     * compiler is what is asked, rather than the source text, because whitespace,
     * comments and unread headings all look like content and none of them are
     * words the presenter will say.
     */
    if (compiled.spokenWordCount <= 0) {
      showToast('There is nothing to present yet — this script has no words in it.', 'info');
      return false;
    }

    /*
     * Open the session record FIRST.
     *
     * `start_session` is the only path to `AppCoordinator::begin_session`,
     * which is the only writer of the Rust-side session generation. Skipping it
     * left the coordinator at generation 0 while control stamped every stage
     * payload with a hard-coded 1, so `validate_stage_payload_header` rejected
     * the whole stage stream and no session could start at all in a packaged
     * build. Rust assigns, control adopts.
     */
    /*
     * Which part this take is recording, and which one follows it.
     *
     * Resolved against THIS compile, the same one the stage is built from. A
     * part identified against an older compile could name a span that has since
     * moved, and the take would report having recorded a piece of a document
     * that no longer exists.
     *
     * The requested part is matched by id rather than trusted wholesale: the
     * caller's copy came from whatever the editor had compiled when the menu
     * was drawn, and a script edited between opening the menu and choosing a
     * row is an ordinary thing to do. When it no longer exists the take simply
     * runs unbounded, as a take launched without a part does.
     */
    /*
     * A practice resolves its part exactly as a take does (#241). It used to
     * be stripped here, on the grounds that a rehearsal reports nothing and so
     * "you reached the end of part three" would be a claim nothing acts on. The
     * claim turned out to be the useful half: the person rehearsing the part
     * about to be filmed wants the glass to say which part it is and when its
     * end has gone by. The summary card and its "record the next part" offer
     * stay withheld, because `stopSession` withholds the whole summary.
     */
    const compiledParts = compiled.parts;
    const takePart = options.part
      ? reduceToTakePart(
          compiledParts.find((p) => p.id === options.part!.id) ?? null,
          compiledParts.length,
        )
      : null;
    const takeNextPart = reduceToTakePart(
      takePart === null
        ? null
        : (compiledParts.find((p) => p.ordinal === takePart.ordinal + 1) ?? null),
      compiledParts.length,
    );

    /*
     * A part that was asked for and is not there any more is SAID, not swallowed.
     *
     * The take still opens — refusing would strand somebody in front of a camera
     * over an edit they may have made on purpose — but "record part three" and
     * "read from here to the end of the script" are different operations, and
     * degrading silently from one to the other is the kind of quiet substitution
     * that gets noticed only in the footage. This happens when a break is renamed
     * or deleted while the launch menu or the take summary is still open.
     */
    if (options.part && takePart === null) {
      showToast(
        options.practice
          ? 'That part is no longer in the script, so the practice runs without one.'
          : 'That part is no longer in the script, so the take will run to the end.',
        'info',
      );
    }

    /*
     * The start point, snapped to something a presenter can be handed.
     *
     * Done after the compile because it needs the sentences and the outline —
     * and it must be the SAME compile the stage is built from, or the token
     * index would be resolved against a document the take is not going to
     * show.
     *
     * A RESOLVED PART CONFINES THE TOKEN THAT CAME WITH IT. Both
     * arrive from the same menu row, but only the part was re-measured against
     * this compile: the caller's token index was read off whatever the editor
     * had compiled when the row was drawn. Edit the script between opening the
     * menu and choosing the row and the two can disagree — and taking a token
     * the part no longer contains would open the take outside the very part it
     * is bounded to, then report on a part it did not start in. So the caret's
     * token is honoured only inside the part, and the part's own start stands
     * in for it everywhere else, including when no token came at all.
     *
     * That is deliberately not "the part always wins", which is what this used
     * to be: it served the part rows and swallowed the caret, so "From here"
     * six paragraphs into a section opened at the section's first sentence.
     * The part rows and the summary still get the re-measured start, because
     * they say `whole` — see `TakePartRequest` for why their token cannot.
     */
    const requestedToken =
      takePart === null
        ? (options.startTokenIndex ?? 0)
        : options.part?.whole !== true &&
            options.startTokenIndex !== undefined &&
            Number.isFinite(options.startTokenIndex) &&
            options.startTokenIndex >= takePart.startTokenIndex &&
            options.startTokenIndex <= takePart.endTokenIndex
          ? options.startTokenIndex
          : takePart.startTokenIndex;
    const snapped = snapToStart(requestedToken, {
      sentences: compiled.sentences,
      outline: compiled.outline,
      totalTokens: compiled.spokenWordCount,
    });
    // Snapping only moves backwards, and a part starts on a sentence, so this
    // cannot fire on compiler output. It is the invariant the bound relies on:
    // a take never begins before the part it is reporting on.
    const startPoint =
      takePart !== null && snapped.tokenIndex < takePart.startTokenIndex
        ? { ...snapped, tokenIndex: takePart.startTokenIndex }
        : snapped;

    const record = await startSessionRecord({
      scriptId,
      scriptSourceHash: compiled.script.sourceHash,
      mode: s.general.defaultSessionMode,
      startTokenIndex: startPoint.tokenIndex,
      compileHash: compiled.script.sourceHash,
    });
    sessionId = record.id;

    const assets = await resolveDocumentAssets(compiled.script);
    const micDeviceId = await resolvePinnedMicrophone(s);

    /*
     * ------------------------------------------------------------------------
     * THE WINDOW CHANGES SHAPE BEFORE THE STAGE EXISTS, NOT AFTER
     * ------------------------------------------------------------------------
     * This used to be one line at the very END of the sequence: navigate to
     * Live, mount the stage, and only then ask the window to go full screen.
     * Both of the things that made a take open badly follow from that order.
     *
     * The visible one: the presenter watched the script appear at the bottom of
     * the glass with a white bar above it. Native full screen on macOS animates
     * over about half a second, and for the length of that animation the
     * webview's painted surface is the old, smaller one — AppKit fills the rest
     * with the window's background. Nothing rendered INSIDE the page can cover
     * a region the page has not been laid out into, which is why the opening
     * plate in `StageApp` never touched this. `services/control-window.ts` has
     * the full account.
     *
     * The wasteful one: `vw`/`vh` are line-map layout inputs (ScriptLayer's
     * `layoutInputs`). A stage that mounts at the editor's window size measures
     * its whole document there, then has that map invalidated by the resize and
     * measures it again — two `awaitLayoutStable` waits, two font settles, for
     * one opening. Presenting first means the map is built once, at the size it
     * will be read at.
     *
     * So the order is: cover, prove the cover is on screen, move the window,
     * wait for the viewport to actually be the new size, and only then let the
     * session go live and the stage mount. Every step waits on the one before
     * it — the cover in particular, because raising a cover and moving the
     * window in the same frame is the same bug with a different first frame.
     */
    setPresentingPhase('opening');
    await painted();
    /*
     * In reader mode this moves no geometry at all, so the two waits around it
     * cost a handful of frames rather than a window animation — and the ordering
     * argument above still holds for the parts that DO change: the background
     * colour, the chrome, and the line map being measured at the size it will be
     * read at rather than at whatever the editor left behind.
     */
    const presentation = await enterPresentation(
      presentationMode,
      restoreFrameFor(s, presentationMode),
      // The pinned panel, for a prompter to fill. Rust falls back to the
      // monitor the window is on when nothing is pinned or the pin is
      // unplugged, and reports whichever it chose — see below. A take under
      // the camera above this screen asks for no panel, so it gets that
      // fallback: the screen the window is on.
      cameraAbove ? null : s.stage.displayFingerprint,
    );
    await awaitViewportSettled(presentation);

    /*
     * ------------------------------------------------------------------------
     * THE TAKE IS MEASURED AGAINST THE PANEL IT IS ACTUALLY ON
     * ------------------------------------------------------------------------
     * Composed HERE, after presenting, because that is the first moment anybody
     * knows which panel that is. Presenting asks for the pinned panel but fills
     * the monitor this window is on when the pin is absent or unplugged
     * (`windows/present.rs`), so a take composed before the move could be sized
     * from a fingerprint naming a panel it does not land on. That is not
     * cosmetic: `mmPerCssPx` is the whole basis of the angular model, so an
     * operator with a disconnected external prompter still pinned who pressed
     * Present at their laptop would read type laid out for the external
     * panel's millimetres.
     *
     * Doing this late costs no LAYOUT work, which is what the ordering argument
     * above is about: `buildStageEnvelope` assembles data, the stage has not
     * mounted, `startLiveSession` has not run, and there is no line map to
     * invalidate. It is not literally free — building the render document is
     * proportional to the script — but that work now happens behind the cover
     * rather than over the editor, which is the right side of the seam for it.
     *
     * The enumeration is here rather than beside the compile FOR THIS REASON:
     * it is the panel list the answer is matched against, so taking it any
     * earlier would be matching a fingerprint resolved now against a topology
     * read before the assets, the microphone, the cover and the window move. A
     * display unplugged across that gap would drop the take back to the guess
     * for no reason other than when the list was taken.
     *
     * `chooseStageDisplay` is the fallback rather than the rule now: Rust omits
     * the fingerprint in plain-browser dev and on a rig whose monitor cannot be
     * identified. Falling back to it is a GUESS and can be the wrong panel —
     * but it is the guess that shipped before any of this existed, so it is
     * never worse than what it replaced.
     */
    const displays = await stageService.listDisplays().catch(() => []);
    const reported = displays.find((d) => d.fingerprint === presentation.displayFingerprint) ?? null;
    /*
     * A take under the camera writes a rig against the panel it lands on, so
     * it needs a panel somebody NAMED, not a guess: Rust's answer, or failing
     * that the monitor Rust says the window is on now that it has moved. Its
     * last-resort guess is the primary display rather than the prompter rule,
     * which would aim at the pinned glass this take deliberately did not ask
     * for — and a guess gets a plain take, never the camera rig.
     */
    const named =
      reported ?? (cameraAbove ? await stageService.currentWindowDisplay().catch(() => null) : null);
    const landed =
      named ??
      (cameraAbove
        ? chooseStageDisplay(displays, null, 'reader')
        : chooseStageDisplay(displays, s.stage.displayFingerprint, presentationMode));
    /*
     * COMPOSED AGAINST THE MODE THIS TAKE IS OPENING IN, not the saved one.
     *
     * `stageSettingsFromSettings` branches on `stage.presentationMode` to pick
     * the optical profile: a reader synthesises its own desk rig, a prompter
     * resolves the calibrated or automatic one for the glass and carries the
     * mirroring with it. For an ordinary take the two agree — `resolveLaunchSettings`
     * has already put an explicit choice into `s` — but a PRACTICE forces the
     * window past that resolver on purpose, so `s` still says whatever Settings
     * says. Composing from it would open the operator who presents to glass
     * every day a reading window sized and mirrored for a teleprompter: the
     * exact failure the forced mode exists to prevent, arriving by the one door
     * it did not close.
     *
     * The same override, written the same way, is in `recomposeStageSettings`
     * in the session store — which is why the fault repaired itself the moment
     * anybody touched an appearance slider, and why it had to be fixed here
     * rather than there.
     */
    const composedFrom: AppSettings = {
      ...s,
      ...(cameraAbove ? { optical: await chooseCameraAboveRig(s, named) } : {}),
      stage: { ...s.stage, presentationMode },
    };
    const stageSettings = stageSettingsFromSettings(composedFrom, landed);
    const stageEnvelope = buildStageEnvelope({
      script: compiled.script,
      sessionId,
      sessionGeneration: record.sessionGeneration,
      stageGeneration: 0,
      stageSettings,
      assets,
      following: s.following,
      // The glass opens HERE, at the snapped start point.
      initialTokenIndex: startPoint.tokenIndex,
    });

    // No separate stage window: the stage renders in this webview and reads the
    // session through its props. Transcription and alignment run in Rust.
    startLiveSession({
      scriptId,
      scriptTitle: doc.title,
      mode: s.general.defaultSessionMode,
      displayLabel: 'This window',
      outline: compiled.outline,
      sentences: compiled.sentences,
      totalTokens: Math.max(compiled.spokenWordCount, 1),
      startTokenIndex: startPoint.tokenIndex,
      part: takePart,
      nextPart: takeNextPart,
      sessionId,
      compiled: compiled.script,
      sessionGeneration: record.sessionGeneration,
      stageSettings,
      stageEnvelope,
      /*
       * Both halves of what the appearance was composed FROM, so the session
       * can compose it again mid-take.
       *
       * The sheet in presentation mode changes one field and rebuilds the whole
       * `StageSettings` rather than patching the one it changed. That is not
       * ceremony: `readingBandHalfHeightPercent` is derived from size and line
       * height, and a rig resolves all four from a measured distance — so a
       * patched size with a stale band half-height is a corridor computed
       * against type that is no longer there.
       */
      teleprompter: s.teleprompter,
      presentationMode,
      ...(options.practice ? { practice: true } : {}),
      ...(cameraAbove ? { cameraAboveScreen: true } : {}),
      // The panel the take was measured against, so the mid-take appearance
      // sheet recomposes against the same one it opened with.
      stageDisplay: landed,
      transcription: {
        model: s.speech.transcriptionModel,
        language: s.speech.language,
      },
      following: s.following,
      // "Follow system default" means exactly that: no pinned device id, so the
      // pipeline opens (and keeps following) whatever the system input is.
      ...(micDeviceId === undefined ? {} : { micDeviceId }),
      ...(micDeviceId === undefined || s.audio.preferredDeviceLabel === undefined
        ? {}
        : { micDeviceLabel: s.audio.preferredDeviceLabel }),
      audioProcessing: {
        echoCancellation: s.audio.echoCancellation,
        noiseSuppression: s.audio.noiseSuppression,
        autoGainControl: s.audio.autoGainControl,
      },
    });
    const arrived = await navigate({ name: 'live', sessionId, scriptId });
    if (!arrived) {
      // A guard vetoed the move. The session is already live behind this
      // screen — tear it down rather than leave the microphone, the worker and
      // the recogniser running under whatever page is still showing.
      await abandonTake(sessionId);
      showToast('Could not open the Live screen, so the take was stopped.', 'danger');
      return false;
    }

    /*
     * Hand the glass from this cover to the stage's own plate.
     *
     * `navigate` resolving means the route store changed, not that Svelte has
     * rendered `StageApp` — let alone that the browser has painted it. Dropping
     * the cover here would show whatever the editor left behind for a frame,
     * which is a worse artifact than the one being fixed because it is the
     * WRONG SCREEN rather than a blank one.
     *
     * After this the stage is uncovered but not unprotected: `StageApp`'s
     * opening plate starts mounted and stays up until `ScriptLayer` reports the
     * script placed, which covers that interval.
     */
    await painted();
    setPresentingPhase('on');
    return true;
  } catch (err) {
    await abandonTake(sessionId);
    showToast(`Could not start the take. ${describeError(err)}`, 'danger');
    return false;
  } finally {
    startingStore.set(false);
  }
}

/**
 * Undo a partially-started take and every resource it already acquired.
 *
 * Including the window itself. A take can fail after the window is already
 * borderless and monitor-sized — the compile is behind us by then, but the
 * session record, the microphone and the navigation are not — and a failure
 * that left the window like that would strand the operator full-screen with no
 * titlebar, looking at the editor and a toast. `exitPresentation` is planned as
 * a no-op in Rust when nothing was ever presented, so this is unconditional.
 *
 * The cover comes down in a `finally` for the same reason it does in Live's
 * `leavePresentation`: it is opaque and covers the whole window, so leaving the
 * phase at `opening` because the teardown itself threw would replace a failed
 * take with an app the operator cannot see. This is the error path — it is
 * exactly where the teardown is most likely to hit a second fault.
 */
/**
 * A compiler {@link ScriptPart} as the session store holds it.
 *
 * Reduced rather than passed whole so the store carries no field it does not
 * read — `origin` in particular is an authoring detail (marker or heading) that
 * belongs to the launch menu's copy, not to the record of a reading.
 */
function reduceToTakePart(part: ScriptPart | null, totalParts: number): TakePart | null {
  if (part === null) return null;
  return {
    id: part.id,
    label: part.label,
    ordinal: part.ordinal,
    totalParts,
    startTokenIndex: part.startTokenIndex,
    endTokenIndex: part.endTokenIndex,
  };
}

async function abandonTake(sessionId: string): Promise<void> {
  try {
    stopSession();
    clearSession();
    await exitPresentation().catch(() => {});
    // The record may have been opened before the failure. Closing it twice is
    // harmless (it rewrites `ended_at`); leaving it open is not — an unfinished
    // row is indistinguishable from a crash and would be closed at next launch.
    if (sessionId) await endSessionRecord(sessionId).catch(() => {});
  } finally {
    setPresentingPhase('off');
  }
}
