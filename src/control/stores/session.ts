/**
 * Live session store (spec §15, §45.2 RealtimeStore/TrackingStore facade for
 * the Live screen). Owns session identity, the alignment feed, the realtime
 * voice pipeline, §15.3 pause semantics, the elapsed clock, the transcript
 * tail, and the F.17 summary.
 *
 * Note what this store no longer does: it does not carry motion to the stage.
 * The alignment engine publishes snapshots to the stage directly from Rust, so
 * control is out of the motion path entirely and receives its own copy purely
 * to report on. A take summary built here can therefore never disagree with
 * what the presenter saw — both are derived from the same published snapshots.
 */
import { derived, get, writable } from 'svelte/store';
import type {
  CompiledScript,
  OutlineNode,
  SentenceUnit,
  StageAutoScrollPayload,
  StageSessionEnvelope,
  StageSettings,
  TranscriptionConfig,
} from '../../shared/contracts';
import type { AlignmentSnapshot, StageVoicePillPayload } from '../../shared/contracts';
import {
  initialVoicePillState,
  reduceVoicePillLevel,
  reduceVoicePillText,
  tickVoicePill,
  voicePillView,
  type VoicePillState,
} from '../services/audio/voice-pill';
import {
  DEFAULT_STAGE_APPEARANCE,
  panelMirrorFor,
  type FollowingSettings,
  type PanelMirror,
  type PresentationMode,
  type SessionMode,
} from '../services/settings-types';
import type { DisplayDescriptor } from '../services/stage-types';
import { isRigResolvedStage, stageSettingsFromSettings } from '../services/stage-envelope';
import {
  clampStageAppearance,
  readStageAppearance,
  typeCeilingPx,
  type StageAppearance,
  type TeleprompterSettings,
} from '../lib/stage-appearance';
import { createTrackingDriver, newSessionId, type TrackingDriver } from '../services/session';
import { VoiceSessionPipeline } from '../services/voice-session';
import { isTauriRuntime } from '../services/ipc';
import { describeError, errorCode } from '../services/errors';
import { trace } from '../services/audio-trace';
import * as stageService from '../services/stage';
import { monotonicNowMs } from '../services/stage-acks';
import { FIRST_TAKE_PASS_ORDINAL, takePassIdFor } from '../../shared/take-pass';
import type { MediaStreamLike } from '../services/audio';
import {
  appendSessionTranscript,
  endSessionRecord,
  recordSessionTake,
  type TakeCheckpointInput,
} from '../services/session-records';
import {
  AUTO_SCROLL_DEFAULT_WPM,
  AUTO_SCROLL_MAX_WPM,
  AUTO_SCROLL_MIN_WPM,
  clampAutoScrollWpm,
} from '../../stage/renderer/autoscroll';
import { defaultFollowingSettings } from '../lib/follow-profiles';
import { configureFollowActions, smoothFollow } from './smooth-follow';
import { getSettingsSnapshot, onSettingsCommitted, patchSettings } from './settings';
import { clearConditionToasts, dismissToastByKey, showToast } from './toasts';

/**
 * Lost audio is worth interrupting for — words were said and will never be
 * followed, and unlike a hold there is no status line that can express it
 * after the fact. Keyed so a stalling connection reports once rather than
 * once per stall, and cleared with the take.
 */
const TOAST_AUDIO_DROPPED = 'audio-dropped';
/**
 * §28.2: the take is running on an input the operator did not choose.
 *
 * A CONDITION, not an event, so it is keyed: it stands until the operator
 * picks a different input or the take ends. It used to be an ordinary `info`
 * toast, which meant it expired on the four-second default — a notice whose
 * entire body is an instruction ("pick another input") that removed itself
 * before the instruction could be carried out.
 */
const TOAST_INPUT_FELL_BACK = 'input-fell-back';
import { compiled as compiledStore } from './compiled';
import { saveNow } from './editor';

export type PauseKind = 'none' | 'listening' | 'hard';

export interface SessionCounts {
  jumps: number;
  retakes: number;
  reconnects: number;
}

export interface SessionSummary {
  durationSeconds: number;
  mode: SessionMode;
  sectionsReached: number;
  retakes: number;
  reconnects: number;
  endingLocation: string;
  /**
   * §36.2. Was hard-coded `false` because nothing ever opened a session record,
   * so no transcript could be saved under any setting. It now reports what Rust
   * decided at session start.
   */
  /**
   * `true` only when retention was on AND every write landed.
   *
   * It used to be `transcriptRetained` — the setting, not the outcome — so a
   * take whose appends failed reported "Saved" over a transcript with a hole
   * in it. The summary is where somebody finds out; reporting the intention
   * there makes the failure invisible for good.
   */
  transcriptSaved: boolean;
  /** Retention was on and something did not make it. */
  transcriptPartial: boolean;
  /**
   * Times the operator JUMPED the script — sentence steps and outline moves.
   *
   * Named for what `counts.jumps` actually counts, which is narrower than
   * "everything the operator did by hand": a wheel scroll on the stage is
   * deliberately not counted (the tracker re-acquires around it and no
   * correction was requested), and restarting a paragraph books a retake
   * instead. Calling it "manual corrections" would have promised a total that
   * this number is not.
   *
   * Already counted and already persisted onto the session record as
   * `manualCorrectionCount`; it simply was never shown to the person doing the
   * jumping. It is the plainest measure of how hard following worked — a take
   * that needed no help and one that needed eleven are the same take by every
   * other number on this summary.
   */
  manualJumps: number;
  /**
   * Share of the take the engine spent following, 0–1, or null when it saw no
   * snapshots at all. See `takeFollowingShare`.
   */
  followingShare: number | null;
  /**
   * Words the recogniser FINALISED this take. Zero means nothing was heard.
   *
   * Finals only, and the summary is taken before `endTurn` closes the last
   * utterance — so on a continuous read this undercounts, sometimes badly.
   * `wordsInFlight` carries what was still open, which is the difference
   * between "the microphone failed" and "you had not stopped talking".
   */
  wordsHeard: number;
  /** Words in the utterance still open when the take ended. */
  wordsInFlight: number;
  /** How far the cursor actually got, in script words. */
  wordsFollowed: number;
  /** Script length, so `wordsFollowed` has something to be a fraction of. */
  scriptWords: number;
  /**
   * False when this voice take never had a recogniser, because the speech
   * model was refused when the take tried to start it.
   *
   * Without this a take started past a missing model was indistinguishable
   * from a working recogniser that heard silence, and the summary sent the
   * presenter to test a microphone that had opened normally. Only the three
   * model refusals make it false, and a recogniser that connected at any point
   * in the take keeps it true: the summary then reports on what was heard.
   */
  voiceFollowingAvailable: boolean;
  /**
   * Where this take stopped, and the start of the section it stopped in
   * (CCUX-008, CCUX-016).
   *
   * Both carried on the summary rather than re-read from the session row,
   * because the summary is what "Present again from here" is offered on and a
   * round trip to SQLite to answer a question the store just computed would be
   * a second source of truth for the same number.
   *
   * `sectionStartTokenIndex` is null when the take ended before any heading —
   * "retry this section" then means the same thing as "from the beginning", and
   * the action is hidden rather than offered twice.
   */
  endTokenIndex: number;
  sectionStartTokenIndex: number | null;
  /**
   * The part this take was recording, and whether the presenter read to the end
   * of it (§parts).
   *
   * `part` is null for a take that was not bounded to one — every take before
   * §parts, and every "from the beginning" launch since. `partComplete` is then
   * false, and both the "reached the end" line and the "record the next part"
   * action are hidden rather than answered about a part that does not exist.
   *
   * `nextPart` is carried alongside rather than looked up from the compiled
   * script, because the summary outlives the compile the take ran on: the
   * editor behind this dialog can be recompiling already, and a part list read
   * a moment later could be a different division of a different document.
   */
  part: TakePart | null;
  partComplete: boolean;
  nextPart: TakePart | null;
}

/**
 * The part a take is bounded to (§parts).
 *
 * A reduced {@link ScriptPart} — identity, name, position and span, and nothing
 * derived. The session store must not carry a second opinion about how a script
 * divides; it carries which piece of one division this take was given.
 */
export interface TakePart {
  id: string;
  label: string;
  ordinal: number;
  totalParts: number;
  startTokenIndex: number;
  endTokenIndex: number;
}

export interface SessionState {
  active: boolean;
  sessionId: string | null;
  scriptId: string | null;
  scriptTitle: string;
  mode: SessionMode;
  /**
   * This take is a rehearsal (§practice).
   *
   * Beside `mode` rather than inside it, because it is a different question.
   * `mode` says how the script MOVES — a practice follows a voice exactly as a
   * take does, and the two are indistinguishable from the aligner's side. This
   * says what the reading is FOR, which is what decides whether the whole
   * document is on the glass and whether anything is reported at the end.
   *
   * Not persisted. The session row a practice writes is an ordinary voice
   * session, deliberately — see `practice` in `StartTakeOptions`.
   */
  practice: boolean;
  /**
   * The part this take is recording, or null for an unbounded one (§parts).
   *
   * ADVISORY. It does not truncate the document, gate the recogniser or stop
   * the take — the engine is still given the whole script and the presenter can
   * read straight past the boundary. See `ScriptPart` for why enforcing it
   * would be worse than not having it: the engine's position is an estimate
   * that runs slightly ahead on a confident phrase, and a take that ended
   * itself on that estimate would cut people off mid-sentence.
   *
   * Not persisted, for the same reason `practice` is not: the session row
   * records where a take started and stopped, which is a fact about the
   * reading. Which part it was aimed at is a fact about the launch.
   */
  part: TakePart | null;
  /**
   * The part after {@link SessionState.part}, or null when this is the last one
   * (§parts).
   *
   * Resolved at LAUNCH, from the same compile the take is running on, and then
   * carried. The alternative is to look it up when the summary asks — but by
   * then the editor behind the dialog may already have recompiled, and the next
   * part of a document that has since been edited is not the next part of the
   * one that was just read.
   */
  nextPart: TakePart | null;
  /**
   * The presenter has read to the end of the part (§parts).
   *
   * LATCHED. It is set the first time the confirmed position reaches the part's
   * last token and never cleared while the take runs — the aligner can and does
   * step backwards (a retake, a re-read, a correction after a lookalike hold),
   * and a badge that appeared and vanished as the estimate wobbled around the
   * boundary would be noise at exactly the moment somebody is deciding whether
   * to stop.
   */
  partComplete: boolean;
  displayLabel: string;
  startedAtMs: number;
  elapsedSeconds: number;
  /** False until the user (or a voice command) starts prompting (§9.1). */
  prompting: boolean;
  paused: PauseKind;
  stageBlanked: boolean;
  /**
   * §27. Whether the Coaching Rail's contents are shown. Toggled by the control
   * UI or the "show me my stats" voice command. Hiding never reflows the script
   * (§7.1): the band stays reserved, only the contents fade. `false` when
   * coaching mode is `off`, because there is no rail to show.
   */
  coachRailVisible: boolean;
  /** §6. Whether coaching is running at all this take (mode !== 'off'). */
  coachingActive: boolean;
  voiceFollow: boolean;
  /**
   * §48. Following is off because somebody switched it off — the dock's own
   * control, the transport checkbox, or the Live panel's button.
   *
   * Narrower than `!voiceFollow`, which also goes false for an automatic hold
   * when the transcript stops being trustworthy. Only this one reaches the
   * stage, because only this one is a mode the presenter chose; the other is a
   * fault, and the glass already has honest words for a fault.
   */
  followPausedByUser: boolean;
  connection: 'connected' | 'reconnecting' | 'offline';
  micState: 'live' | 'muted' | 'disconnected';
  /**
   * §28.2/§28.6: the INPUT is the thing that failed — unplugged, silent, or
   * refused — as opposed to the realtime transport dying, which also leaves
   * `micState` at 'disconnected'. Only this one is fixable by choosing another
   * device, so it is what gates the Live screen's input picker. Offering a
   * microphone switch as the cure for a rejected API key would be the same
   * unfollowable-instruction defect in a new place.
   */
  inputDeviceLost: boolean;
  /**
   * §28.2 — the take is capturing, but not from the input that was asked for.
   *
   * Distinct from `inputDeviceLost`, and the distinction is the point: nothing
   * failed here. The chosen device was busy, the system default was opened
   * instead, and the take is running normally on audio the operator did not
   * choose. `micState` stays 'live' because it IS live — flagging this as a
   * fault would be the false accusation §28.6 exists to avoid.
   *
   * It is a separate flag because it must still OFFER THE PICKER. The notice
   * for this condition says "pick another input", and until this existed the
   * picker was gated on `inputDeviceLost` alone — so the one instruction the
   * app gave had no control behind it, which is the same unfollowable-
   * instruction defect §115 was filed about.
   */
  usingFallbackInput: boolean;
  /**
   * False while the recogniser cannot run because the speech model was refused
   * (`isSpeechModelUnavailable`), which is not a microphone fault.
   *
   * The refusal still leaves `micState` at 'disconnected' — there is no capture
   * — but a status bar reading that as "Mic lost" blamed hardware that had
   * opened normally. This is what lets it say what actually failed. A
   * recogniser that connects later in the take sets it back.
   */
  voiceFollowingAvailable: boolean;
  snapshot: AlignmentSnapshot | null;
  transcriptTail: string[];
  /**
   * Whether the recogniser has produced ANY words since this take began.
   *
   * Latched: it goes true on the first transcript line and never goes back
   * within a take. `transcriptTail` cannot answer this — it holds the last four
   * lines and is emptied outright by mid-take transcript recovery, so a take
   * that heard a thousand words and then reconnected would read as one that had
   * heard nothing.
   *
   * It exists because the follow panel had no honest way to tell "you have not
   * started speaking" from "your microphone is dead", and the transcript feed's
   * status could not help: a voice take reports `live` from the instant it
   * opens, which says a feed was requested and nothing about what came back.
   */
  heardAnything: boolean;
  /**
   * The take moved to a different panel after it opened (CCUX-010).
   *
   * Null while the take is on the panel it was measured against. Non-null names
   * the panel it is on NOW, and is a statement about typography rather than a
   * failure: the optics — millimetres per CSS pixel, safe area, column width —
   * were resolved once at the opening, and a take cannot re-resolve them
   * without rebuilding the stage document underneath the presenter.
   *
   * `start-take.ts` has recorded this as a known gap for as long as the reader
   * has existed: "a reader who drags their window to another display MID-TAKE
   * and changes nothing else still keeps the opening panel's scale". Silently
   * keeping it is the part that is hard to understand, so now it says so.
   */
  displayChangedTo: string | null;
  /** Exact stage instrument payload, rendered locally in single-window mode. */
  voicePill: StageVoicePillPayload | null;
  /** The full production stage document rendered inside the control webview. */
  stageEnvelope: StageSessionEnvelope | null;
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  counts: SessionCounts;
  summary: SessionSummary | null;
  blocksSeen: string[];
  stageFontSizePx: number;
  /**
   * What the stage is prompting at RIGHT NOW, for the in-session sheet to open
   * on.
   *
   * The saved settings would be the wrong source: `+`/`-` and a voice command
   * already move the size mid-take, so a sheet seeded from the document would
   * show a number the glass disagrees with — and the first slider touched would
   * snap the type back to it.
   */
  stageAppearance: StageAppearance;
  /**
   * §17.2: a saved rig decided this take's appearance, so none of it is the
   * in-session sheet's to set — see `isRigResolvedStage`.
   */
  stageRigResolved: boolean;
  /**
   * Whether this take is on the full display or in a reading window.
   *
   * On the state rather than read from Settings at each use site, because the
   * mid-take toggle means those two answers differ — see `takePresentationMode`
   * — and a dock button reading the saved value would offer to switch to the
   * mode it is already in.
   */
  stagePresentationMode: PresentationMode;
  /** The take's size ceiling, fixed at its opening size — see `takeFontCeilingPx`. */
  stageFontCeilingPx: number;
  /**
   * The fixed-pace transport (§autoscroll): the fallback for a take that voice
   * following cannot carry.
   *
   * Held whole rather than as two fields because it is one instruction and the
   * stage receives it as one — and because a pace is only meaningful beside the
   * flag that says whether anything is using it. `wordsPerMinute` survives a
   * stop so resuming returns to the speed the operator dialled in, which is the
   * whole reason the flag and the pace are not the same number.
   */
  autoScroll: StageAutoScrollPayload;
}

const initial: SessionState = {
  active: false,
  sessionId: null,
  scriptId: null,
  scriptTitle: '',
  mode: 'voice',
  practice: false,
  part: null,
  nextPart: null,
  partComplete: false,
  displayLabel: '',
  startedAtMs: 0,
  elapsedSeconds: 0,
  prompting: false,
  paused: 'none',
  stageBlanked: false,
  coachRailVisible: false,
  coachingActive: false,
  voiceFollow: true,
  followPausedByUser: false,
  connection: 'connected',
  micState: 'live',
  inputDeviceLost: false,
  usingFallbackInput: false,
  voiceFollowingAvailable: true,
  snapshot: null,
  transcriptTail: [],
  heardAnything: false,
  displayChangedTo: null,
  voicePill: null,
  stageEnvelope: null,
  outline: [],
  sentences: [],
  counts: { jumps: 0, retakes: 0, reconnects: 0 },
  summary: null,
  blocksSeen: [],
  stageFontSizePx: DEFAULT_STAGE_APPEARANCE.fontSizePx,
  stageAppearance: {
    textIntensity: 'standard',
    fontSizePx: DEFAULT_STAGE_APPEARANCE.fontSizePx,
    lineHeight: DEFAULT_STAGE_APPEARANCE.lineHeight,
    columnWidthPercent: DEFAULT_STAGE_APPEARANCE.columnWidthPercent,
    readingBandCenterPercent: DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
  },
  stageRigResolved: false,
  // Matches `defaultAppSettings`, and matches what every take did before reader
  // mode existed. A take overwrites it at `startLiveSession`.
  stagePresentationMode: 'prompter',
  stageFontCeilingPx: typeCeilingPx(DEFAULT_STAGE_APPEARANCE.fontSizePx),
  autoScroll: { running: false, wordsPerMinute: AUTO_SCROLL_DEFAULT_WPM },
};

const state = writable<SessionState>({ ...initial });
export const session = { subscribe: state.subscribe };

let driver: TrackingDriver | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let pipeline: VoiceSessionPipeline | null = null;
let compiledScript: CompiledScript | null = null;
/**
 * How many times this take has been told its chosen input was busy.
 *
 * A counter and not a boolean because `switchMicrophone` needs to know whether
 * a fallback happened DURING its own attempt, which a flag it also has to clear
 * cannot express.
 */
let inputFallbackCount = 0;
/**
 * The Rust coordinator's session generation for this take.
 *
 * C1: this used to default to a hard-coded 1 while nothing ever invoked
 * `start_session`, so the coordinator stayed at its `Default` of 0 and
 * `validate_stage_payload_header` dropped every snapshot control published.
 * Rust assigns it now (`AppCoordinator::begin_session`) and control adopts
 * whatever it is handed — 0 means "no session record", which is only ever true
 * in browser dev.
 */
let sessionGeneration = 0;
let stageSettings: StageSettings | null = null;
/**
 * The saved teleprompter section this take was composed from, plus whatever the
 * in-session sheet has changed since.
 *
 * Held per-take rather than read back off the settings store on every keystroke
 * because those are two different documents by design: the sheet's OK button is
 * what promotes a take's appearance into the saved one, and until it is pressed
 * a presenter who nudged the type up mid-sentence must not have that follow
 * them into tomorrow's take. Null outside a take.
 */
let takeTeleprompter: TeleprompterSettings | null = null;
/**
 * The presentation mode THIS take is running, which is not always the saved one.
 *
 * Held per-take for exactly the reason `takeTeleprompter` is: the mid-take
 * toggle (⌃⌘F) is a decision about the take in front of you, not a change to
 * what tomorrow's take opens as. Somebody who pops out to the full display to
 * read one difficult paragraph must not find every future take opening
 * full-screen because of it.
 *
 * It has to be its own field rather than read back off the settings store on
 * every rebuild, because `applyStageAppearance` recomposes through
 * `getSettingsSnapshot()` — so a take toggled to reader mode would have the
 * SAVED mode reapplied by the next nudge of any unrelated slider, quietly
 * putting the prompter's narrow measure and its mirror back mid-sentence.
 *
 * Null outside a take.
 */
let takePresentationMode: PresentationMode | null = null;
/**
 * The panel this take's geometry was resolved against (§52), or null when the
 * displays could not be enumerated. Kept because a rebuild without it silently
 * demotes a calibrated rig to the uncalibrated layout — the type would jump the
 * first time somebody touched a slider, on the one screen where a jump is most
 * expensive.
 *
 * Not frozen at the opening: `adoptPresentationMode` moves it when a mid-take
 * mode switch lands the window on a different monitor, which is the one moment
 * besides the opening that Rust can name the panel.
 */
let stageDisplay: DisplayDescriptor | null = null;
/**
 * The take's own mirroring, when the operator has flipped it from the Session
 * menu — or null, which means "whatever the panel it is on is saved as".
 *
 * Mirroring belongs to the PANEL (`optical.panelMirror`, #206), so the take
 * normally just follows the saved answer for `stageDisplay`. A live flip is a
 * decision about the take in front of you, held here for exactly the reason
 * `takeTeleprompter` holds a nudge: it must not follow the operator into
 * tomorrow's take. It is dropped when the take moves to another panel, whose
 * glass is not the one that was flipped, and when the panel's saved answer
 * changes, so a switch thrown in Settings mid-take still reaches the glass.
 *
 * Null outside a take.
 */
let takeMirror: PanelMirror | null = null;
/**
 * The size ceiling for THIS take, fixed when it opened.
 *
 * `typeCeilingPx` follows the value it is given so a hand-set 400px is not
 * clamped down to the ordinary 320 the moment a panel shows it. Recomputing it
 * per change turns that into a one-way ratchet: a take opened at 400 and nudged
 * down to 350 could never get back up, and Cancel — which is just another
 * request, for the value the sheet opened on — was clamped to the new lower
 * ceiling and left the take where it was. Frozen at the take's opening size,
 * the range the operator was offered is the range they keep.
 */
let takeFontCeilingPx = typeCeilingPx(DEFAULT_STAGE_APPEARANCE.fontSizePx);
let stopSidecarFeed: (() => void) | null = null;

/**
 * §60 low transcript confidence.
 *
 * The realtime session is billed for `requestLogprobs: true` and the per-token
 * confidences derived from them already widen the semantic filter's measurement
 * variance — so following really does get vaguer while the recogniser struggles.
 * Until now nothing told the presenter why: `TranscriptFeedStatus` has always
 * had a `'low_confidence'` member and `deriveNotices` has always rendered it,
 * and nothing ever produced it.
 *
 * Take-scoped, like every other per-session detector here. The thresholds and
 * the hysteresis live in the watcher; see that module for why they are what they
 * are.
 */

/* ---------------------------------------------------------------------------
 * §36.3 take history
 *
 * The §36.1 session record has always been able to say "four takes happened"
 * and nothing about any of them: `retake_count` is a scalar, `sectionsReached`
 * was a single number folded into `metrics_json` at the end, and
 * `addTakeMarker` — the handler for the "mark this" voice command — incremented
 * a counter and stored no marker at all.
 *
 * This is the per-take detail on top: when each pass ran, where it started and
 * stopped, which sections it traversed, and where the presenter marked a
 * checkpoint. It reuses the sections the store was ALREADY accumulating
 * (`blocksSeen`) and is keyed by the review lane's own `takePassId`, so the two
 * are one history rather than two.
 * ------------------------------------------------------------------------- */

/** The take currently being performed. Null outside a session. */
interface ActiveTake {
  /** 1-based; a retake opens the next one and never rewrites this one. */
  passOrdinal: number;
  /** `${sessionId}:${passOrdinal}` — the review lane's take-pass identity. */
  takePassId: string;
  startedAtIso: string;
  /** Monotonic, so a clock step cannot invent or erase a take's duration. */
  startedAtMs: number;
  startTokenIndex: number;
  /** Authored block ids in the order this pass first reached them. */
  sections: string[];
  checkpoints: TakeCheckpointInput[];
  /**
   * §36.3 automatic retake transitions — the engine deciding the presenter went
   * back and re-read. Distinct from a MANUAL retake, which opens a new pass and
   * so is a row of its own rather than a counter.
   */
  automaticRetakes: number;
  /**
   * Accepted relocations — a skipped section or a jump the engine caught up to.
   * Counted apart from retakes because they say opposite things about a take:
   * a retake is the presenter redoing something, a relocation is the engine
   * finding them somewhere else.
   */
  relocations: number;
  /**
   * §36.3 unique coverage: the furthest the CONFIRMED anchor ever reached.
   *
   * A high-water mark rather than the last position, which is what makes this
   * honest — jumping to the closing line does not retroactively cover the
   * middle, and going back for a retake does not un-cover what was already
   * read.
   */
  maxConfirmedToken: number;
  /** §36.3 availability: milliseconds spent in `following`. */
  followingMs: number;
  /** Wall time of the previous snapshot, for accumulating `followingMs`. */
  lastSnapshotAtMs: number | null;
  lastState: AlignmentSnapshot['state'] | null;
  /** §36.3 confidence summary, accumulated rather than sampled. */
  confidenceSum: number;
  confidenceSamples: number;
}

let activeTake: ActiveTake | null = null;

/**
 * §36.3's own words: "within the current live session, keep an IN-MEMORY take
 * history ... this powers 'restart this take' and can be discarded at Stop".
 *
 * So the list is held here for the session's own use, and each pass is ALSO
 * written through to `session_takes` as it closes. The persistence is the part
 * the spec does not require and the review screen does: a take history that only
 * exists until Stop cannot answer "how did the third take go" ten minutes later,
 * which is the one moment anybody wants to know.
 */
let sessionTakes: ActiveTake[] = [];

/**
 * Checkpoints per take. These are deliberate operator actions — a spoken "mark
 * this", a paragraph restart, an outline jump — so two hundred inside a single
 * pass is already far past anything real. The cap keeps the row bounded; the
 * EARLIEST are kept because this is a history, and a history that loses its
 * beginning is not one.
 */
const MAX_TAKE_CHECKPOINTS = 200;

/* Session record (§36.1) + transcript retention (§36.2). */
interface PendingTranscriptItem {
  /** The realtime item id, so the command channel can re-label it. */
  itemId: string;
  receivedAtMs: number;
  commitSequence: number;
  providerItemId?: string;
  audioStartMs?: number;
  audioEndMs?: number;
  transcript: string;
  disposition: 'script' | 'command' | 'discarded';
}
/** Fixed at session start by Rust; false means "never persist a word". */
let transcriptRetained = false;
/**
 * Which take's transcript buffer the module currently holds.
 *
 * Bumped when a take starts and again when one is torn down, so an append that
 * rejects can tell whether the buffer it wants to put items back into is still
 * the one they came from. The session id is NOT enough: `stopSession` leaves
 * the id in the state while the take is over, so a late rejection compared
 * equal and re-queued into a buffer whose flush timer had already been
 * stopped — items that would never be retried, under a toast promising that
 * they would be.
 */
let transcriptEpoch = 0;
let transcriptBuffer: PendingTranscriptItem[] = [];
/**
 * Words the recogniser returned this take (§36 summary).
 *
 * The end-of-take summary reported duration, sections, retakes and cost —
 * every one of which reads the same whether the microphone was working or the
 * take was nine seconds of silence. There was nothing in it that answered "did
 * it hear me", which is the first thing anyone wants to know and the only one
 * that distinguishes a working session from a broken one.
 */
let wordsHeard = 0;
/** Script length in spoken words, so progress has a denominator. */
let scriptWordCount = 0;

/** Whitespace-separated words, which is what "words" means to a presenter. */
function countSpokenWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
let transcriptFlushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Polls the panel the presenting window is on (CCUX-010).
 *
 * POLLED, and it has to be. Rust already watches the display TOPOLOGY and emits
 * on plug/unplug/rearrange, but dragging a window between two monitors that
 * were both already there changes no topology at all — there is no event in
 * this app for "the window moved". Two seconds is slow enough to cost nothing
 * and fast enough that the presenter is told before they have read a paragraph
 * at the wrong size.
 */
let displayWatchTimer: ReturnType<typeof setInterval> | null = null;
const DISPLAY_WATCH_INTERVAL_MS = 2000;
/**
 * How often the buffered transcript is written.
 *
 * Purely batching now. There used to be a four-second settle delay as well,
 * because the command router decided a beat later whether a finalized item was
 * script or a command phrase, and `INSERT OR IGNORE` on
 * `UNIQUE(session_id, commit_sequence)` means the first write of a commit is
 * the one that sticks. With no command channel every item is script the moment
 * it arrives, so there is nothing left to wait for.
 */
const TRANSCRIPT_FLUSH_INTERVAL_MS = 15000;


export interface StartSessionInput {
  scriptId: string;
  scriptTitle: string;
  mode: SessionMode;
  displayLabel: string;
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  totalTokens: number;
  /**
   * Where this take begins, already snapped to a readable unit (CCUX-014).
   *
   * Absent means the beginning, which is what every take got before start
   * points existed. The SNAPPING is the caller's job and must already have
   * happened: `lib/take-start-point.ts` owns it, so an arbitrary caret offset
   * can never reach the aligner as an anchor inside half a clause.
   */
  startTokenIndex?: number;
  /** Integration inputs — optional so the store degrades in browser dev. */
  sessionId?: string;
  compiled?: CompiledScript | null;
  /**
   * §22. The stored revision the compiled document was produced from.
   *
   * A `CompiledScript` carries `scriptId` and `sourceHash` but no revision
   * number, and the persisted take row has a `scriptRevision` field
   * that the review lane compares against the script's own to decide whether an
   * annotation still points at the text it was written about
   * (`shared/coaching/review/script-annotations.ts`). It has to be handed down.
   */
  scriptRevision?: number;
  /** From `start_session` — the Rust coordinator assigns it, control adopts. */
  sessionGeneration?: number;
  /**
   * §36.2: whether the session row was opened with transcript retention on.
   * Fixed at session start in Rust and never re-derived here — a session
   * started with retention off must not start keeping text mid-take because
   * the user flipped a setting.
   */
  transcriptRetained?: boolean;
  stageSettings?: StageSettings | null;
  stageEnvelope?: StageSessionEnvelope | null;
  /**
   * The saved teleprompter section `stageSettings` was composed from, so the
   * in-session sheet can compose it again. Omitted — a preview, a test — falls
   * back to the settings snapshot, which is what the caller would have used.
   */
  teleprompter?: TeleprompterSettings;
  /**
   * The mode `startTake` actually presented the window in.
   *
   * Passed rather than read back off Settings so the store records what happened
   * instead of re-deriving it: the two can differ by the width of one `await` if
   * somebody changes the setting while a take is opening, and the window is the
   * thing that is right.
   */
  presentationMode?: PresentationMode;
  /** §practice. A rehearsal: the whole document, and no report at the end. */
  practice?: boolean;
  /** §parts. The part this take is recording; absent means the whole script. */
  part?: TakePart | null;
  /** §parts. The part after it, so the summary can offer to record it next. */
  nextPart?: TakePart | null;
  /** The panel the geometry was resolved against; see `stageDisplay`. */
  stageDisplay?: DisplayDescriptor | null;
  transcription?: TranscriptionConfig;
  micDeviceId?: string;
  /** §28.3 capture processing (Settings → Audio / Preflight → Advanced). */
  audioProcessing?: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  /**
   * §28.4 local voice-detection sensitivity (0–1, 0.5 = A.6 defaults). Omitted
   * means "read the saved setting", which is what production does — the value
   * is only ever passed explicitly by a preview or a test.
   */
  vadSensitivity?: number;
  /** §47 follow settings for this session; defaults to the saved settings. */
  following?: FollowingSettings;
}

/**
 * Was the recogniser refused because of the speech model itself?
 *
 * Exactly these three, and not every `STT_MODEL_` code: download, cancel and
 * removal failures share the prefix and describe a Settings action, not a take
 * that could not start. Spelled out so each code stays grep-able against
 * `src/shared/contracts/errors.ts`.
 */
function isSpeechModelUnavailable(code: string | null): boolean {
  return (
    code === 'STT_MODEL_NOT_INSTALLED' ||
    code === 'STT_MODEL_MISSING' ||
    code === 'STT_MODEL_LOAD_FAILED'
  );
}

export function startLiveSession(input: StartSessionInput): string {
  stopInternals();
  const sessionId = input.sessionId ?? newSessionId();
  compiledScript = input.compiled ?? null;
  inputFallbackCount = 0;
  sessionGeneration = input.sessionGeneration ?? 0;
  transcriptRetained = input.transcriptRetained === true;
  transcriptBuffer = [];
  transcriptEpoch += 1;
  wordsHeard = 0;
  scriptWordCount = input.totalTokens;
  stageSettings = input.stageSettings ?? null;
  stageDisplay = input.stageDisplay ?? null;
  takeTeleprompter = input.teleprompter ?? currentTeleprompterSettings();
  // The panel's own mirroring until somebody flips it — see `takeMirror`.
  takeMirror = null;
  // The take adopts the saved mode at its opening and owns it from then on.
  // `startTake` has already presented the window in this mode, so this is
  // recording what happened rather than deciding it.
  takePresentationMode = input.presentationMode ?? getSettingsSnapshot().stage.presentationMode;
  takeFontCeilingPx = typeCeilingPx(
    stageSettings?.fontSizePx ?? takeTeleprompter.fontSizePx,
  );
  resetTranscriptCounters();
  // §60: evidence never crosses a take boundary. A fresh watcher is cheaper and
  // more obviously correct than resetting one, and it is the same lifetime as
  // every other take-scoped detector in this store.
  /*
   * Where this take begins (CCUX-014). Clamped, because a caller handing an
   * index past the end of the script would anchor the aligner outside the
   * token array it was given.
   */
  const startTokenIndex = Math.max(
    0,
    Math.min(Math.round(input.startTokenIndex ?? 0), Math.max(0, input.totalTokens - 1)),
  );

  // §36.3: the session's first take opens with it, on a fresh history.
  sessionTakes = [];
  beginTake(sessionId, 1, startTokenIndex);

  // Smooth-following store (§50.1): user-visible following state + §48 actions.
  const following = input.following ?? currentFollowingSettings();
  smoothFollow.beginSession(sessionId, following);
  configureFollowActions(followActions);
  smoothFollow.reportTranscriptStatus(input.mode === 'voice' ? 'live' : 'idle');

  state.set({
    ...initial,
    active: true,
    sessionId,
    scriptId: input.scriptId,
    scriptTitle: input.scriptTitle,
    mode: input.mode,
    practice: input.practice ?? false,
    part: input.part ?? null,
    nextPart: input.nextPart ?? null,
    partComplete: false,
    displayLabel: input.displayLabel,
    startedAtMs: Date.now(),
    voiceFollow: input.mode === 'voice',
    outline: input.outline,
    sentences: input.sentences,
    stageFontSizePx: stageSettings?.fontSizePx ?? DEFAULT_STAGE_APPEARANCE.fontSizePx,
    stageEnvelope: input.stageEnvelope ?? null,
    stageAppearance: liveStageAppearance(),
    stageRigResolved: isRigResolvedStage(stageSettings),
    stagePresentationMode: takePresentationMode ?? 'prompter',
    stageFontCeilingPx: takeFontCeilingPx,
    /*
     * The saved pace, and finally something that reads it.
     *
     * `fixedSpeedWpm` has been persisted through Rust and offered in Settings
     * since before there was any motion path to spend it on — a setting with a
     * writer and no reader, which is the defect the Settings screen keeps
     * calling out in its own copy. This is the reader.
     */
    autoScroll: {
      running: false,
      wordsPerMinute: clampAutoScrollWpm(takeTeleprompter.fixedSpeedWpm),
    },
  });

  // Voice mode without a Tauri runtime has no realtime feed — keep the
  // animated mock driver so browser dev stays demonstrable.
  // Voice mode without a Tauri runtime has no Rust to align in — keep the
  // animated mock driver so browser dev stays demonstrable.
  const useRealDriver = Boolean(input.compiled) && (isTauriRuntime() || input.mode !== 'voice');
  driver = createTrackingDriver({
    sessionId,
    scriptId: input.scriptId,
    sentences: input.compiled?.sentences ?? input.sentences,
    totalTokens: input.totalTokens,
    compiled: useRealDriver ? (input.compiled ?? null) : null,
    sessionGeneration,
    onSnapshot: handleSnapshot,
    onTranscript(line) {
      pushTranscriptLine(line);
    },
  });

  /*
   * Starting a take IS starting to prompt.
   *
   * The worker driver pauses the aligner the instant it is built — §9.1, "hold
   * position until the user explicitly starts prompting" — and a paused engine
   * discards every transcript event before it looks at a token. Nothing on the
   * take path ever resumed it. Only the `Start` button in the Live transport
   * bar did, and a presenter who has just pressed `Present`, watched the stage
   * open and begun speaking has no reason to believe a second, differently
   * named button stands between them and a teleprompter that follows.
   *
   * What that cost: the microphone recorded, the provider transcribed, the
   * ledger filled, "Words heard: 26" counted up — and every one of those words
   * was dropped on the floor. "0 of 26 words (0%)", four takes running, with a
   * summary card that showed the evidence and the result side by side and no
   * hint of what sat between them.
   *
   * The explicit start survives as `Pause`, which is the control a presenter
   * actually reaches for. `Present` is the start.
   */
  startPrompting();

  /*
   * ANCHOR THE ALIGNER WHERE THE TAKE ACTUALLY BEGINS (CCUX-014).
   *
   * Without this the engine opens its search at token 0 while the glass shows
   * a section six minutes down, so the first sentence the presenter reads is
   * matched against the top of the script — and the most likely outcome is a
   * confident relocation BACKWARDS to a similar-sounding opening.
   *
   * `moveToToken` is "I am here", which is the correct assertion: the presenter
   * chose this line and is about to read it. It resets evidence continuity in
   * the engine, so nothing from before the anchor can drag the cursor back.
   *
   * Guarded, so a take from the beginning issues no command at all and its
   * behaviour is bit-identical to what it was before start points existed.
   */
  if (startTokenIndex > 0) driver?.moveToToken(startTokenIndex);

  // Voice pipeline: realtime transcription + command routing (§29, §33).
  if (input.mode === 'voice' && input.compiled && isTauriRuntime()) {
    // Before the pipeline, so the first level frame it produces has somewhere
    // to land and the pill is on the stage while the device is being acquired.
    // The epoch is captured here and checked in every callback below: a
    // superseded pipeline is torn down asynchronously and can still deliver.
    const pillEpoch = startVoicePill();
    pipeline = new VoiceSessionPipeline({
      sessionId,
      sessionGeneration,
      compiled: input.compiled,
      ...(input.transcription?.language !== undefined
        ? { language: input.transcription.language }
        : {}),
      ...(input.transcription?.model !== undefined ? { modelId: input.transcription.model } : {}),
      deviceId: input.micDeviceId,
      audioProcessing: input.audioProcessing,
      // §28.4: the slider had no reader at all. The saved value is the default
      // so every caller of `startLiveSession` gets it, not only Preflight.
      vadSensitivity: input.vadSensitivity ?? currentVadSensitivity(),
      // §29.2 steps 1–2, enforced by the controller that specifies them rather
      // than by whichever screen happened to run first.
      startSequence: buildStartSequenceGate(input),
      // §29.2 step 9, the half that lives above the pipeline.
      onResetTranscriptState: () => {
        state.update((s) => ({ ...s, transcriptTail: [] }));
        resetTranscriptCounters();
      },
      /*
       * The pill's waveform, from the ONE capture the take already owns (§5.3).
       * A second `getUserMedia` for an indicator would contend with the take's
       * own stream — see `services/audio/ownership.ts` for what that costs.
       */
      onLevel: (snapshot) => {
        if (voicePill === null || pillEpoch !== voicePillEpoch) return;
        voicePill = reduceVoicePillLevel(voicePill, snapshot, snapshot.generatedAtMs);
      },
      /*
       * The device is about to be asked for. The pill's "no audio" window runs
       * from HERE rather than from the take's first instant, because everything
       * before this line — the §29.2 gate, the permission check, the socket
       * subscription — is time in which no capture has been attempted, and a
       * cross that means "we have not asked yet" is a lie about the microphone.
       */
      onCaptureAttempt: () => {
        if (voicePill === null || pillEpoch !== voicePillEpoch) return;
        voicePill = { ...voicePill, startedAtMs: monotonicNowMs(), lastFrameAtMs: null };
      },
      onTranscriptText: (text, final) => {
        // Words coming back is the only evidence that the whole chain works,
        // and it is what turns the pill's dot into a tick. Epoch-checked: a
        // late partial from a superseded transport must not certify this take.
        if (voicePill !== null && pillEpoch === voicePillEpoch) {
          voicePill = reduceVoicePillText(voicePill, text);
        }
        /*
         * "Something has been heard this take", latched here and nowhere else.
         *
         * PARTIALS COUNT. Rust aligns on partials and publishes snapshots from
         * them, so the script is often already following while the first long
         * utterance is still open — and a latch that waited for a final put
         * "nothing heard yet, check the microphone" over a take the presenter
         * could watch working. It is the same contradiction `wordsInFlight`
         * exists to fix on the summary, in a different place.
         *
         * Epoch-checked for the same reason the pill above is: a shutdown
         * deliberately lets the last utterance finalise, and `transportGeneration`
         * is cleared during close, so a late line from the previous take can
         * still arrive. Certifying THIS take with the last one's audio would be
         * the worst possible direction for this flag to be wrong in.
         */
        if (pillEpoch === voicePillEpoch && text.trim() !== '') {
          /*
           * A LATE PARTIAL FROM THE PREVIOUS PASS MAY CERTIFY THIS ONE, AND
           * THAT IS THE RIGHT DIRECTION TO BE WRONG IN.
           *
           * `restartParagraph` clears the latch and the pipeline stays open, so
           * a partial still in flight from before the restart can arrive after
           * it. There is an epoch guard here for the PIPELINE, but there is
           * genuinely no signal on this callback that distinguishes "audio from
           * a moment ago" from "audio from now" — and an epoch compared inside
           * the synchronous update it was captured beside cannot differ, which
           * is what the first attempt at this did.
           *
           * So it is left alone deliberately. What this flag answers is "can
           * CandidCue hear you", and a partial that arrived one second ago is
           * evidence that it can. The failure that matters is the other one: a
           * take reporting "nothing heard yet — check the microphone" over a
           * working microphone would send somebody to unplug hardware mid-take.
           * Being briefly too optimistic costs nothing; being wrongly pessimistic
           * costs a take.
           */
          state.update((st) => (st.heardAnything ? st : { ...st, heardAnything: true }));
        }
        /*
         * The open utterance counts too — as an ESTIMATE, separately.
         *
         * `wordsHeard` totals finals only, and the summary is snapshotted
         * before `endTurn` gets the last one back: Rust's stop returns
         * immediately and finalises in the background for up to 2.5 s. So a
         * presenter who reads for fourteen seconds without a long enough pause
         * to close an utterance is told "Words heard: 11" for a passage the
         * recogniser heard in full, and reasonably concludes the microphone is
         * failing. The display, which follows PARTIAL evidence, moves the whole
         * time — and the two facts flatly contradict each other on one card.
         *
         * Kept as its own number rather than folded into `wordsHeard`: a
         * partial is a restatement and may be revised or withdrawn, so adding
         * it to a total of committed words would make that total wrong in the
         * other direction. This is "and this much more was in flight".
         */
        if (!final) {
          wordsInFlight = countSpokenWords(text);
        }
        if (final) {
          wordsInFlight = 0;
          // §36 "did it hear me". Counted here rather than from the retained
          // transcript, because retention is a SETTING and the question this
          // answers — was anything transcribed at all — has to be answerable
          // with retention off, which is the default.
          wordsHeard += countSpokenWords(text);
        }
      },
      /*
       * Audio that never reached the recogniser. Surfaced rather than counted
       * silently: dropped frames and a presenter who said nothing are
       * indistinguishable downstream, and "words heard: 0" with no explanation
       * is the exact failure this app has shipped twice.
       */
      onAudioDropped: (frames) => {
        showToast(
          `The connection stalled and ${frames} ${frames === 1 ? 'moment' : 'moments'} of audio ` +
            'did not reach the transcriber. Anything said in that gap will not be followed.',
          'danger',
          { key: TOAST_AUDIO_DROPPED },
        );
      },
      // §36.2: finalized text only, never audio. Buffered here and written
      // through `append_session_transcript`, which Rust refuses outright when
      // the session was opened with retention off.
      onTranscriptItem: (item) => bufferTranscriptItem(item),
      onTranscriptLine: (line) => pushTranscriptLine(line),
      onConnectionState: (connection) => {
        /*
         * A superseded pipeline may not speak for the current take.
         *
         * `stopInternals` does not await `pipeline.stop()`, and stopping is
         * what drives a pipeline to `offline` — so take A's teardown lands
         * after take B has connected and hands B a connection state belonging
         * to a session that no longer exists. On the Live screen that is a
         * status pill lying; on the stage it is a permanent "Not connected"
         * cross over a take that is working perfectly, because the pill reads
         * this same field.
         */
        if (pillEpoch !== voicePillEpoch) return;
        state.update((s) => {
          /*
           * A reconnect is a connection RE-established, not the first one.
           *
           * The store initialises `connection: 'connected'` — an optimistic
           * placeholder, since nothing has connected yet — and the pipeline
           * announces `reconnecting` on its way to opening the very first
           * socket. That transition satisfied the test below, so EVERY healthy
           * take reported exactly one reconnect, from its first second, having
           * lost nothing.
           *
           * It cost more than a wrong number. "Reconnects: 1" appeared on every
           * summary of a take that was not working and was read, repeatedly, as
           * evidence of a transport dropping mid-session — sending two people
           * hunting a fault that had never happened while the real one sat
           * elsewhere on the same card. A diagnostic that cries wolf on every
           * healthy run is worse than no diagnostic.
           *
           * So it counts only a return to `reconnecting` AFTER something has
           * actually connected. A genuine mid-take reconnect still reads 1.
           */
          const reconnects =
            connection === 'reconnecting' && s.connection === 'connected' && everConnected
              ? s.counts.reconnects + 1
              : s.counts.reconnects;
          return {
            ...s,
            connection,
            counts: { ...s.counts, reconnects },
            // A recogniser that connected is the evidence the model loaded —
            // a resume after installing it mid-take, say. Nothing else clears
            // a refusal: a resume that merely resolves may not have restarted
            // anything.
            voiceFollowingAvailable: connection === 'connected' ? true : s.voiceFollowingAvailable,
          };
        });
        if (connection === 'connected') everConnected = true;
        // §59: an interrupted transcript is a first-class degraded state.
        smoothFollow.reportTranscriptStatus(
          connection === 'connected' ? 'live' : 'interrupted',
          connection === 'offline' ? 'The transcription connection is offline.' : null,
        );
      },
      // H5: transcription is untrustworthy — stop following visibly rather
      // than letting the stage drift on stale or absent speech.
      onFollowingHold: (held, reason) => {
        trace('hold', `${held ? 'held' : 'released'} — ${reason ?? 'none'}`);
        // Not deliberate: this is the transcript going untrustworthy, not the
        // presenter switching following off. The stage hears about the fault
        // through the hold ladder and the audio readout, which word it as the
        // fault it is.
        smoothFollow.setFollowingPaused(held, false);
        /*
         * No toast. A hold is a STATE, and the Live status line already reports
         * it — "Reconnecting — position held", "Microphone disconnected —
         * position held" — accurately and with no history.
         *
         * A notification was the wrong instrument twice over. During a take the
         * presenter is looking at the stage, full screen, with the control
         * window behind it: the toast is invisible exactly when it is relevant.
         * And because `danger` toasts never expire, an ordinary take — a few
         * pauses between sentences, one transport blip — delivered the whole
         * stack at once afterwards, describing a microphone no longer in use,
         * on the summary screen of a take that had scored 96%.
         *
         * The stage's transcript bar is the live instrument now; the status
         * line is the durable one. Neither accumulates.
         */
      },
      // H5: a dead input is not a provider problem; the user must act.
      onInputDeviceLost: (code) => {
        // §12.7: device loss outranks every acoustic reading on the mic tile.
        state.update((s) => ({ ...s, micState: 'disconnected', inputDeviceLost: true }));
        /*
         * The pill takes only the HARD half of this signal.
         *
         * `MIC_NO_SIGNAL` is the §28.6 detector reporting five seconds without
         * signal, which a presenter collecting their thoughts in a treated room
         * produces several times a take. The status bar can afford to call that
         * a disconnected input; a cross on the stage saying "No audio" cannot —
         * it is the microphone check's false accusation with a longer fuse.
         */
        if (code !== 'MIC_NO_SIGNAL' && pillEpoch === voicePillEpoch) {
          voicePillDeviceLost = true;
        }
        // §28.2/§28.6: the remedy named here is one the Live screen can
        // actually perform — `switchMicrophone` below drives the transport's
        // track replacement, and the take controls grow an input picker while
        // `micState` is 'disconnected'.
        /*
         * No toast: `micState: 'disconnected'` is what the take controls
         * render, and they grow the input picker that fixes it. The toast said
         * the same thing in a form that expired never and appeared behind the
         * stage.
         *
         * §115: that used to be a promise nothing kept. The picker lived in the
         * Live status bar, which renders only when NO take is running, so the
         * one state it exists for — a microphone dying mid-take — was the one
         * state it could not be reached in. It is now in the take-controls
         * drawer, which is mounted for the duration of the take, and the
         * attention dot on its tab is what points at it.
         */
      },
      /*
       * §28.6: the input came back on its own — the mic was replugged, or the
       * track unmuted. "Reconnect it and we resume" is a promise the product
       * has to keep without being asked twice, so the pills clear themselves.
       */
      /*
       * §28.2: the chosen device was busy and the system default was opened
       * instead. Said out loud, once: a take running on the built-in
       * microphone when the user selected an interface is a take whose audio
       * is not what they think it is, and the status bar's input picker is
       * where they change it.
       */
      onInputFellBackToDefault: () => {
        /*
         * The epoch guard its neighbours already have. A pipeline that has been
         * superseded can still report a fallback it was in the middle of when
         * the take ended — and this callback both toasts (unexpiring) and writes
         * state, so an unguarded one hangs the previous take's notice over the
         * summary, or over the next take's opening.
         */
        if (pillEpoch !== voicePillEpoch) return;
        // Counted so an in-flight `switchMicrophone` can tell whether the
        // device IT asked for was the one that fell back — see below.
        inputFallbackCount += 1;
        /*
         * Keyed and unexpiring. This notice's whole body is an instruction, and
         * on the `info` default it removed itself after four seconds — long
         * enough to be seen, nowhere near long enough to be acted on, and the
         * take it describes runs for minutes. Keyed rather than `danger`
         * because nothing is broken: audio is being captured and the take is
         * fine, it is simply not the input that was asked for. `danger` would
         * be the accusation the product is careful not to make (§28.6), so this
         * stays calm and stays put. `clearConditionToasts` retires it with the
         * take; a successful switch retires it immediately.
         */
        showToast(
          'The microphone you chose was busy, so CandidCue is using the system default input. ' +
            'Pick another input in the take controls if that is wrong.',
          'info',
          { key: TOAST_INPUT_FELL_BACK, durationMs: 0 },
        );
        // And the control that answers it. Without this the notice names a
        // picker that the take-controls drawer would not render, because the
        // picker's condition is `inputDeviceLost` and nothing was lost.
        state.update((s) => ({ ...s, usingFallbackInput: true }));
      },
      onInputRestored: () => {
        if (pillEpoch === voicePillEpoch) voicePillDeviceLost = false;
        const before = get(state);
        if (!before.inputDeviceLost) return;
        state.update((s) => ({
          ...s,
          inputDeviceLost: false,
          // Only undo the loss this flag recorded; a transport that is also
          // down keeps its own honest 'disconnected'.
          micState: s.micState === 'disconnected' ? 'live' : s.micState,
        }));
        // Nothing to announce: the status line goes back to normal on its own,
        // and "the microphone is back" answers a warning we no longer give.
      },
      // H1: a session-level provider failure must never leave a green UI.
      onSessionFailure: (code, fatal) => {
        state.update((s) => ({
          ...s,
          connection: fatal ? 'offline' : 'reconnecting',
          micState: fatal ? 'disconnected' : s.micState,
        }));
        // §44.12 / E.7: the code is an internal contract. `describeError`
        // turns it into authored copy that says what happened and what to do;
        // the raw code goes to Settings → Diagnostics, not to the toast.
        showToast(
          `${fatal ? 'Voice following stopped.' : 'Voice following interrupted.'} ${describeError(code)}`,
          'danger',
        );
      },
      // M3: a soft pause keeps the mic and the billing meter live.
      onPauseWarning: (msRemaining) => {
        showToast(
          `Still paused — voice will disconnect in ${Math.round(msRemaining / 60_000)} min.`,
          'info',
        );
      },
    });
    void pipeline.start().catch((err) => {
      /*
       * A take that has been superseded may not report on the one that
       * replaced it. Its start can still be in flight — the microphone retry
       * alone spends up to 1.75 s — and when it finally rejects, everything
       * below would be about a session that no longer exists: the current
       * take marked offline, a danger toast, and a cross on its voice pill,
       * all for a failure that happened to a take the operator already ended.
       */
      if (pillEpoch !== voicePillEpoch) {
        trace('start-superseded', 'a replaced take failed to start; not reported');
        return;
      }
      /*
       * `SESSION_STOPPED` is not a failure, it is this app tearing the take
       * down while its start was still in flight — a second `startLiveSession`,
       * a stop, a navigation guard. Reporting it as one produced the worst
       * possible message: "Voice tracking is unavailable. Something went wrong
       * and CandidCue has no specific advice for it", which is both alarming
       * and, for a session that no longer exists, addressed to nobody. The
       * trace still records it; the presenter is not told about the internals
       * of a take they already ended.
       */
      const code = errorCode(err);
      if (code === 'SESSION_STOPPED') {
        trace('start-abandoned', 'the session was stopped while voice was starting');
        return;
      }
      /*
       * A start that failed on the MICROPHONE must say so on the pill.
       *
       * Without this the take goes `connection: 'offline'` a moment later and
       * the pill reports "Not connected" — pointing at the network for a
       * failure that was the input device, which is the one thing the
       * presenter could have fixed. The no-capture window would eventually
       * reach the same conclusion, several seconds late and after they had
       * already gone looking at their wifi.
       */
      const micFailure = code !== null && code.startsWith('MIC_');
      if (micFailure) voicePillDeviceLost = true;
      /*
       * `micState` too, not just the connection.
       *
       * A start that rejected never opened a capture — whatever it failed on,
       * there is no microphone in this take. It stayed at its initial 'live'
       * and the status bar reported "Mic live" over a session with no input at
       * all, which is the same never-show-a-confident-state-you-do-not-have
       * defect the manual-mode pills were fixed for.
       *
       * `inputDeviceLost` is narrower on purpose: it is what offers the §28.2
       * mid-session input picker, and a picker is only an answer when the
       * DEVICE is what failed. Swapping microphones cannot fix a refused
       * credential, and offering it there is the same unfollowable instruction
       * as advice pointing at a control that does not exist.
       *
       * And a refused speech model is recorded as exactly that. The microphone
       * opened, the recogniser was turned away, and nothing about the input is
       * at fault — so the status bar must not read "Mic lost" and the summary
       * must not send the presenter to test it (#286).
       */
      const modelUnavailable = isSpeechModelUnavailable(code);
      state.update((s) => ({
        ...s,
        connection: 'offline',
        micState: 'disconnected',
        inputDeviceLost: micFailure || s.inputDeviceLost,
        voiceFollowingAvailable: modelUnavailable ? false : s.voiceFollowingAvailable,
      }));
      showToast(`Voice tracking is unavailable. ${describeError(err)}`, 'danger');
    });
  }

  clock = setInterval(() => {
    state.update((s) => {
      if (!s.active) return s;
      const elapsedSeconds = Math.floor((Date.now() - s.startedAtMs) / 1000);
      return { ...s, elapsedSeconds };
    });
  }, 1000);

  /*
   * Watch for the take being dragged onto another panel.
   *
   * Only when the take knows which panel it opened on: with no baseline there
   * is nothing to compare against, and "the display changed" from an unknown
   * starting point would be a guess dressed as a fact.
   */
  if (stageDisplay !== null) {
    const watchedSession = sessionId;
    displayWatchTimer = setInterval(() => {
      /*
       * The baseline is read EACH TICK, not captured.
       *
       * `stageDisplay` is rewritten when the take switches presentation mode
       * mid-take (`adoptPresentationMode` recomposes the geometry against the
       * panel it landed on). A captured fingerprint would keep comparing
       * against the panel the take OPENED on, so a deliberate ⌃⌘F onto the
       * prompter would raise "this window moved" and tell the presenter to end
       * a take that had just correctly re-measured itself.
       */
      const baseline = stageDisplay?.fingerprint ?? null;
      if (baseline === null) return;
      void stageService.currentWindowDisplay()
        .then((now) => {
          if (now === null) return;
          state.update((st) => {
            /*
             * Identity, not just liveness. `clearInterval` cannot cancel a
             * probe that is already in flight, and the next take can begin
             * before it resolves — so without this an old take's answer could
             * write a display-change notice onto a new one.
             */
            if (!st.active || st.sessionId !== watchedSession) return st;
            const changed =
              now.fingerprint === baseline ? null : (now.name ?? '').trim() || 'another display';
            return st.displayChangedTo === changed ? st : { ...st, displayChangedTo: changed };
          });
        })
        // A failed probe is not evidence of anything. Keeping the last answer
        // is right: the alternative is a notice that blinks with the IPC.
        .catch(() => {});
    }, DISPLAY_WATCH_INTERVAL_MS);
  }

  // §36.2: incremental retention, so a crash mid-take costs at most one
  // interval rather than the whole transcript.
  if (transcriptRetained) {
    transcriptFlushTimer = setInterval(() => {
      flushTranscript(sessionId, false);
    }, TRANSCRIPT_FLUSH_INTERVAL_MS);
  }

  return sessionId;
}

/* ---------------------------------------------------------------------------
 * §29.2 start sequence, steps 1–3
 * ------------------------------------------------------------------------- */

/**
 * A precondition of the start sequence was not met. Thrown out of the gate,
 * caught by `RealtimeSessionController.start`, which tears the attempt down and
 * rethrows — so the transport is never subscribed and nothing billable begins.
 */
export class StartSequenceError extends Error {
  constructor(
    readonly step: 'script_save' | 'compile',
    message: string,
  ) {
    super(message);
    this.name = 'StartSequenceError';
  }
}

/**
 * Build the §29.2 steps 1–2 gate for this take.
 *
 * These steps were being performed in `Preflight.svelte` before
 * `startLiveSession` was ever called, which made the ordering true by accident.
 * The accident is the defect: the controller re-runs its whole start sequence on
 * every resume-after-sleep and every recovery from a hard pause, long after
 * Preflight is gone, and any future caller — a retake, a restored session, a
 * second entry point — inherits nothing.
 *
 * So each step is expressed as the CHECK it really is. Step 1 flushes, which is
 * a no-op when there is nothing pending. Step 2 asks whether the compile is
 * current, and refuses the start when it is not. Running them a second time
 * therefore costs nothing on the happy path and is the only thing standing
 * between a future caller and a take that starts against a stale script.
 *
 * Step 3, the stage's hydration ack, has no counterpart: the stage renders in
 * this webview, so there is no second window to wait for.
 */
function buildStartSequenceGate(input: StartSessionInput): {
  flushScriptSave(): Promise<void>;
  ensureCompiled(): Promise<void>;
} {
  return {
    async flushScriptSave(): Promise<void> {
      // Idempotent: `saveNow` returns immediately when nothing is dirty, and it
      // flushes any debounced compile on the way through.
      await saveNow();
    },

    async ensureCompiled(): Promise<void> {
      const compiledScript = input.compiled ?? null;
      if (compiledScript === null) {
        throw new StartSequenceError(
          'compile',
          'CandidCue has not finished reading this script, so the take cannot start.',
        );
      }
      const store = get(compiledStore);
      // An idle store means nobody has compiled through it this run — a test,
      // or a caller with its own compiler. The supplied script is then the only
      // authority and it has already been checked.
      if (store.status === 'idle') return;
      /*
       * A store holding a DIFFERENT script says nothing about this one.
       *
       * The editor populates this store and never clears it on the way out, so
       * after editing script A and presenting script B the store still held A.
       * Every check below then ran B's take against A's compile: A's stale
       * error, A's blocking diagnostics, and — always, since two scripts never
       * hash alike — A's source hash, which failed B with "the script changed
       * after the session was prepared". B had compiled cleanly and its stage
       * was already up; only voice tracking died, and the advice it gave named
       * a screen that no longer exists.
       *
       * This gate is a stale-EDITOR guard. It has standing over the script it
       * is looking at and none over any other.
       */
      if (store.scriptId !== null && store.scriptId !== compiledScript.scriptId) return;
      if (store.status === 'error') {
        throw new StartSequenceError('compile', store.error ?? 'CandidCue could not read this script.');
      }
      const blocking = (store.result?.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.blocking || diagnostic.severity === 'error',
      );
      if (blocking.length > 0) {
        throw new StartSequenceError(
          'compile',
          `The script has ${blocking.length === 1 ? 'a problem' : `${blocking.length} problems`} that must be fixed first: ${blocking[0]?.message ?? ''}`,
        );
      }
      // §45.3: a compile that has moved on since this session was assembled
      // means the stage is prompting text the aligner was not built from.
      if (
        store.status === 'ready' &&
        store.result !== null &&
        store.result.sourceHash !== compiledScript.sourceHash
      ) {
        throw new StartSequenceError(
          'compile',
          'The script changed after this take was prepared. Stop and press Present again.',
        );
      }
    },
  };
}

/* ---------------------------------------------------------------------------
 * Semantic sidecar (companion §36–§40)
 * ------------------------------------------------------------------------- */

/**
 * Which authored block a token position falls in.
 *
 * Derived rather than reported: the engine states where the reader is, and
 * block identity is a property of the compiled document. Resolving it here
 * means the take history keeps answering "which sections did this pass reach"
 * without the engine having to know what a section is.
 */
function blockIdForToken(token: number): string | null {
  const compiled = compiledScript;
  if (!compiled) return null;
  const at = Math.round(token);
  let best: string | null = null;
  for (const sentence of compiled.sentences) {
    if (sentence.startTokenIndex <= at) best = sentence.blockId;
    else break;
  }
  return best;
}

/**
 * One alignment snapshot, as control sees it.
 *
 * ---------------------------------------------------------------------------
 * THE TAKE SUMMARY IS BUILT FROM PROGRESSION, NOT FROM A FINAL POSITION
 * ---------------------------------------------------------------------------
 * "Followed N of M words" read off the last snapshot is a number that flatters
 * every take: a presenter who lost the thread at word 30, jumped to the end and
 * read the closing line scores 100%. What is honest is what accumulates here —
 * how far the CONFIRMED anchor actually advanced, how much time was spent
 * genuinely following, and how many recoveries the engine had to make. Those
 * are three different facts and the summary reports them as three.
 */
function handleSnapshot(snapshot: AlignmentSnapshot): void {
  const nowMs = monotonicNowMs();
  const blockId = blockIdForToken(snapshot.confirmedToken);
  if (activeTake !== null) {
    // §36.3 sections traversed, per take. `blocksSeen` below is the same fact
    // for the whole session and has only ever been read as a count; this is
    // the per-pass list, which is what makes "take 2 never reached the close"
    // sayable.
    if (blockId && !activeTake.sections.includes(blockId)) {
      activeTake.sections.push(blockId);
    }
    // §36.3 unique coverage: the high-water mark of the conservative anchor.
    // `confirmed` is monotone except across an accepted retake or a manual
    // move, and taking the maximum is what makes a retake cost nothing it
    // already earned while still refusing to credit a jump to the end.
    if (snapshot.confirmedToken > activeTake.maxConfirmedToken) {
      activeTake.maxConfirmedToken = snapshot.confirmedToken;
    }
    if (Number.isFinite(snapshot.confidence)) {
      activeTake.confidenceSum += snapshot.confidence;
      activeTake.confidenceSamples += 1;
    }
    /*
     * §36.3 availability: time spent in `following`, accumulated between
     * snapshots. Measured rather than inferred from a state count, because
     * snapshots arrive on transcript events and a long confident passage
     * produces no more of them than a stuttering one.
     *
     * THE GAP IS CAPPED, and that cap is what makes the number honest.
     *
     * An interval is classified entirely by the state of the snapshot that
     * OPENED it, so a gap of any length is credited to whatever was true when it
     * began. That is fine at the cadence snapshots actually arrive at, and badly
     * wrong for the gaps that are not cadence at all: following gets paused for
     * ten minutes of auto-scroll, or the socket drops, and the next snapshot to
     * arrive silently books the whole silence as time spent following. The
     * summary then reports its healthiest number for the take that did least.
     *
     * So an interval longer than a gap the feed could plausibly produce is not
     * evidence of anything and is credited to nothing. Time is never invented
     * either way: uncredited time still counts in the denominator, which is
     * exactly what "not following then" should look like.
     */
    if (
      activeTake.lastSnapshotAtMs !== null &&
      activeTake.lastState === 'following' &&
      nowMs - activeTake.lastSnapshotAtMs <= FOLLOWING_CREDIT_MAX_GAP_MS
    ) {
      activeTake.followingMs += nowMs - activeTake.lastSnapshotAtMs;
    }
    activeTake.lastSnapshotAtMs = nowMs;
    activeTake.lastState = snapshot.state;
    // §36.3 recovery events, from the decision codes that describe one: the
    // engine concluded the presenter went back and re-read, or relocated. A
    // manual retake opens a new pass instead, so the two are never conflated.
    if (snapshot.decision === 'retakeAccepted') activeTake.automaticRetakes += 1;
    if (
      snapshot.decision === 'relocationAccepted' ||
      snapshot.decision === 'jumpForwardAccepted'
    ) {
      activeTake.relocations += 1;
    }
  }

  state.update((s) => ({
    ...s,
    snapshot,
    /*
     * §parts: the presenter has read to the end of the part they launched.
     *
     * Read off `confirmedToken` rather than the provisional or observed
     * frontier, deliberately. The frontier LEADS — it is allowed to, because
     * shading can be taken back — and "you have finished this part" is a
     * conclusion, not a shade. Drawing it from a reversible signal would
     * announce the end of a part on a fuzzy match the engine then withdrew.
     *
     * A MANUAL ANCHOR IS NOT EVIDENCE OF READING, and excluding it is not a
     * refinement — without it the flag is simply wrong twice over:
     *
     *   - every take bounded to a part OPENS with one. `startTake` hands the
     *     engine the part's first token through `moveToToken`, Rust publishes
     *     that position as a snapshot, and a short part — a one-sentence
     *     interstitial, the last part of a script that ends on a line —
     *     satisfied `>= endTokenIndex` from the anchor alone. It was reported
     *     read to the end before a word was said;
     *   - operating the transport past the boundary claimed the same thing.
     *     Stepping forward through the script is how somebody SKIPS a passage,
     *     and calling that "read to the end" is the one reading of it that is
     *     certainly false.
     *
     * Latched: once true it stays true for the rest of the take. See
     * `partComplete`.
     */
    partComplete:
      s.partComplete ||
      (s.part !== null &&
        snapshot.decision !== 'manualAnchor' &&
        Math.floor(snapshot.confirmedToken) >= s.part.endTokenIndex),
    blocksSeen:
      blockId && !s.blocksSeen.includes(blockId) ? [...s.blocksSeen, blockId] : s.blocksSeen,
  }));
  smoothFollow.ingestSnapshot(snapshot);
}

/**
 * Has a socket ever reached `connected` this take?
 *
 * The store's initial `connection: 'connected'` is a placeholder, not a fact,
 * so "was connected, is now reconnecting" cannot be read off the state alone.
 */
let everConnected = false;
/** Words in the utterance still open when the take ended. See `wordsHeard`. */
let wordsInFlight = 0;

/** Per-take transcript bookkeeping, cleared with the take and by recovery. */
function resetTranscriptCounters(): void {
  everConnected = false;
  wordsInFlight = 0;
}

/* ---------------------------------------------------------------------------
 * The voice pill (§29.2, and what replaced the microphone check)
 * ------------------------------------------------------------------------- */

/**
 * How often the stage is told what the pill thinks.
 *
 * A TIMER rather than a per-frame publish, and the reason is the whole point of
 * the pill: the failure worth catching is the one where level frames stop
 * arriving — the device pulled, the graph dead, another process holding the
 * input — and a publisher driven by frames would fall silent during exactly
 * that failure, leaving the last healthy-looking reading frozen on the stage.
 */
const VOICE_PILL_INTERVAL_MS = 100;

let voicePill: VoicePillState | null = null;
let voicePillTimer: ReturnType<typeof setInterval> | null = null;
/**
 * The DEVICE is gone — as opposed to the room being quiet.
 *
 * Kept here rather than read off `state.inputDeviceLost`, which is also raised
 * by `SilentInputDetector` after five seconds without signal. The pill must
 * never treat silence as a fault: a presenter thinking for five seconds in a
 * quiet room is the ordinary case, and answering it with a cross is the exact
 * behaviour the microphone check was deleted for.
 */
let voicePillDeviceLost = false;
/**
 * Which take the pill belongs to.
 *
 * Pipeline teardown is asynchronous — `stopInternals` does not await
 * `pipeline.stop()` — so a superseded pipeline can still deliver a level frame
 * or a late partial after the next take has started. Without this, take A's
 * microphone would animate take B's waveform, and a stale partial could put a
 * tick on a session that has transcribed nothing.
 */
let voicePillEpoch = 0;


/** Begin a take's pill. Torn down by `stopInternals` on every path out. */
function startVoicePill(): number {
  voicePillEpoch += 1;
  voicePillDeviceLost = false;
  if (!isTauriRuntime()) return voicePillEpoch;
  voicePill = initialVoicePillState(monotonicNowMs());
  voicePillTimer ??= setInterval(publishVoicePill, VOICE_PILL_INTERVAL_MS);
  return voicePillEpoch;
}

function stopVoicePill(): void {
  voicePillEpoch += 1;
  if (voicePillTimer) clearInterval(voicePillTimer);
  voicePillTimer = null;
  voicePill = null;
  voicePillDeviceLost = false;
}

/**
 * Restart the evidence at a take boundary (§15.2 retake, §36.3 pass).
 *
 * Only when a pill is already running: a retake in manual mode has no capture
 * to report on, and starting one there would put a permanent "Listening" on a
 * stage that is not listening to anything.
 */
function resetVoicePill(): void {
  if (voicePill === null) return;
  voicePillDeviceLost = false;
  voicePill = initialVoicePillState(monotonicNowMs());
}

/**
 * Resolve the pill and hand it to the stage, which reads `voicePill` off this
 * store through its `voicePill` prop.
 *
 * The conditions come from the session state rather than from a second set of
 * detectors: `inputDeviceLost` is §28.6's finding, already made by the pipeline
 * on the same level frames, and a pause is a pause. Re-deriving either here
 * would give the stage a chance to disagree with the Live screen about the same
 * microphone.
 */
function publishVoicePill(): void {
  if (voicePill === null) return;
  const s = get(state);
  if (!s.sessionId) return;

  const nowMs = monotonicNowMs();
  voicePill = tickVoicePill(
    voicePill,
    {
      deviceLost: voicePillDeviceLost,
      // 'reconnecting' is deliberately not a fault: it is usually over in a
      // second, and the Live status line already says so.
      transportOffline: s.connection === 'offline',
      suspended: s.paused !== 'none',
    },
    nowMs,
  );
  const view = voicePillView(voicePill);
  const payload: StageVoicePillPayload = {
    // The generation of the envelope the pill is drawn beside.
    stageGeneration: s.stageEnvelope?.stageGeneration ?? 0,
    reading: view.reading,
    levels: view.levels,
    label: view.label,
    visible: view.visible,
    sentAtMs: Date.now(),
  };
  state.update((current) => ({ ...current, voicePill: payload }));
}

/** Snapshot token positions are fractional; persisted indexes are not. */
function roundToken(token: number | undefined): number | undefined {
  return token === undefined || !Number.isFinite(token) ? undefined : Math.round(token);
}

/**
 * §36.3 "unique coverage", the honest form.
 *
 * The furthest the CONFIRMED anchor reached in this pass, not the position it
 * finished at. Reporting the final position would score a take that lost the
 * thread and jumped to the closing line as complete — which is precisely the
 * summary that made the old numbers untrustworthy.
 */
function takeWordsFollowed(): number {
  if (activeTake === null) return 0;
  /*
   * How far this PASS got, not where its cursor ended up in the document.
   *
   * `maxConfirmedToken` is an absolute index and starts at the pass's own start
   * token, so a take that opened at token 500 and then followed nothing at all
   * reported "500 of 900 words followed" — a take that never heard a word
   * looking like one that read more than half the script. Subtracting the start
   * makes it the distance travelled, which is what the summary claims it is.
   */
  return Math.max(0, Math.round(activeTake.maxConfirmedToken - activeTake.startTokenIndex));
}

/**
 * The furthest ABSOLUTE token this pass reached — a position, not a distance.
 *
 * Split out from `takeWordsFollowed` when start points arrived, because the two
 * numbers stopped being the same the moment a take could open anywhere but
 * zero. This one answers "where did it get to" and is what the session row's
 * ending index and the retake's section are resolved from; the other answers
 * "how far did it travel" and is what the summary shows.
 */
function takeEndToken(): number {
  if (activeTake === null) return 0;
  return Math.max(0, Math.round(activeTake.maxConfirmedToken));
}

/* ---------------------------------------------------------------------------
 * §36.3 take history — lifecycle
 * ------------------------------------------------------------------------- */

/** Open a take pass. `startLiveSession` opens the first; a retake opens the next. */
function beginTake(sessionId: string, passOrdinal: number, startTokenIndex: number): void {
  activeTake = {
    passOrdinal,
    // The same scheme the coaching subsystem stamps on its own take passes, so
    // a review report and a take row for the same pass carry one identifier.
    takePassId: takePassIdFor(sessionId, passOrdinal),
    startedAtIso: new Date().toISOString(),
    startedAtMs: monotonicNowMs(),
    startTokenIndex,
    sections: [],
    checkpoints: [],
    automaticRetakes: 0,
    relocations: 0,
    maxConfirmedToken: startTokenIndex,
    followingMs: 0,
    lastSnapshotAtMs: null,
    lastState: null,
    confidenceSum: 0,
    confidenceSamples: 0,
  };
  sessionTakes.push(activeTake);
}

/**
 * §36.3 in-memory take history for this session, oldest pass first. The open
 * take is the last entry. Empty outside a session — it is discarded at Stop, as
 * the spec says, while the persisted rows outlive it.
 */
export function takeHistory(): ReadonlyArray<{
  passOrdinal: number;
  takePassId: string;
  startedAtIso: string;
  startTokenIndex: number;
  sections: readonly string[];
  checkpoints: readonly TakeCheckpointInput[];
  automaticRetakes: number;
  /** Mean alignment confidence over the pass; null when it saw no snapshots. */
  confidenceMean: number | null;
  /** True for the pass currently being performed. */
  open: boolean;
}> {
  return sessionTakes.map((take) => ({
    passOrdinal: take.passOrdinal,
    takePassId: take.takePassId,
    startedAtIso: take.startedAtIso,
    startTokenIndex: take.startTokenIndex,
    sections: take.sections,
    checkpoints: take.checkpoints,
    automaticRetakes: take.automaticRetakes,
    confidenceMean: takeConfidenceMean(take),
    open: take === activeTake,
  }));
}

/**
 * The longest gap between snapshots that still counts as continuous following.
 *
 * Measured cadence has finals landing 1.2–1.7 s apart and partials about every
 * second, so four seconds is several times the ordinary interval — comfortably
 * past a breath, a swallowed word, or a sentence the recogniser lost the tail
 * of. Beyond it the feed is not quiet, it is absent, and the stage itself stops
 * claiming to follow not long after (`DEFAULT_SNAPSHOT_STALE_MS`).
 */
const FOLLOWING_CREDIT_MAX_GAP_MS = 4000;

/**
 * How much of the take the engine was actually following, 0–1.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BELONGS ON THE SUMMARY
 * ---------------------------------------------------------------------------
 * The summary could already say how long the take ran, how many words came back
 * and how far the cursor got — and none of those answer the question somebody
 * actually has when they walk back from the camera, which is whether the thing
 * followed them. A take can transcribe a thousand words and spend half its
 * length holding; the word counts look identical either way.
 *
 * `followingMs` has been accumulated on every snapshot since §36.3 shipped and
 * read by nothing. It is measured between snapshots rather than counted from
 * states on purpose (see `handleSnapshot`): snapshots arrive on transcript
 * events, so a confident passage produces no more of them than a stuttering one
 * and counting would report the stuttering take as the healthier of the two.
 *
 * Null rather than zero when the pass saw no snapshots at all. Those are
 * different takes — one followed nothing, the other never got the chance — and
 * "0% followed" over a take whose microphone never opened is an accusation
 * pointed at the wrong thing.
 */
function takeFollowingShare(): number | null {
  const take = activeTake;
  if (take === null || take.lastSnapshotAtMs === null) return null;
  const elapsedMs = monotonicNowMs() - take.startedAtMs;
  if (!(elapsedMs > 0)) return null;
  return Math.min(1, Math.max(0, take.followingMs / elapsedMs));
}

/** §36.3 confidence summary. Null, never 0, when the pass saw no snapshots. */
function takeConfidenceMean(take: ActiveTake): number | null {
  if (take.confidenceSamples === 0) return null;
  return take.confidenceSum / take.confidenceSamples;
}

/**
 * Note a position worth returning to. Times are measured from the START OF THE
 * TAKE on the monotonic clock: a checkpoint at "02:14 into take 3" survives an
 * NTP step, and a wall-clock timestamp would not.
 */
function noteCheckpoint(kind: TakeCheckpointInput['kind']): void {
  const take = activeTake;
  if (take === null) return;
  if (take.checkpoints.length >= MAX_TAKE_CHECKPOINTS) return;
  const snapshot = get(state).snapshot;
  const tokenIndex = Math.round(snapshot?.confirmedToken ?? take.startTokenIndex);
  const blockId = blockIdForToken(tokenIndex);
  take.checkpoints.push({
    atMs: Math.max(0, Math.round(monotonicNowMs() - take.startedAtMs)),
    tokenIndex,
    kind,
    // "Where did I skip to" is half of what a take history is for, and a token
    // index alone does not answer it in a form anybody reads.
    ...(blockId ? { blockId } : {}),
  });
}

/**
 * Close the open take and persist it. Best-effort by construction: a take
 * history that cannot be written must never interrupt a take or block a stop.
 */
function finishTake(sessionId: string | null, endTokenIndex: number | undefined): void {
  const take = activeTake;
  activeTake = null;
  if (take === null || sessionId === null) return;
  const durationMs = Math.max(0, Math.round(monotonicNowMs() - take.startedAtMs));
  const confidenceMean = takeConfidenceMean(take);
  void trackPersistence(recordSessionTake(sessionId, {
    takePassId: take.takePassId,
    passOrdinal: take.passOrdinal,
    startedAt: take.startedAtIso,
    endedAt: new Date().toISOString(),
    durationMs,
    startTokenIndex: take.startTokenIndex,
    ...(endTokenIndex === undefined ? {} : { endTokenIndex }),
    sections: [...take.sections],
    checkpoints: [...take.checkpoints],
    automaticRetakes: take.automaticRetakes,
    ...(confidenceMean === null ? {} : { confidenceMean }),
  })).catch(() => {
    // §36.3 is history, not state. Losing a row costs a line in the review
    // screen; failing the stop path would cost the take.
  });
}

function pushTranscriptLine(line: string): void {
  state.update((s) => ({
    ...s,
    transcriptTail: [...s.transcriptTail, line].slice(-4),
    /*
     * Also latched here, for the mock driver.
     *
     * The real pipeline latches in `onTranscriptText`, which sees partials and
     * is epoch-guarded — the better signal, and the one that matters on a
     * packaged build. But browser dev and the mock voice driver never construct
     * that pipeline and reach the store only through this function, so without
     * this line the follow panel would sit at "nothing heard yet" for every
     * take anybody runs in a browser.
     */
    heardAnything: s.heardAnything || line.trim() !== '',
  }));
}

/* ---------------------------------------------------------------------------
 * Transcript retention (§36.2)
 *
 * Off by default and decided ONCE, in Rust, at session start: `start_session`
 * reads `general.saveTranscript` and stamps `transcript_retained` on the row,
 * and `append_session_transcript` refuses items for a row that says false. This
 * side must therefore never buffer text it was not told to keep — the point is
 * that a user who turned retention off has no transcript in memory either.
 * ------------------------------------------------------------------------- */

function bufferTranscriptItem(item: {
  itemId: string;
  commitSequence: number;
  audioStartMs?: number;
  audioEndMs?: number;
  transcript: string;
}): void {
  if (!transcriptRetained) return;
  const text = item.transcript.trim();
  if (text.length === 0) return;
  transcriptBuffer.push({
    itemId: item.itemId,
    receivedAtMs: Date.now(),
    commitSequence: item.commitSequence,
    providerItemId: item.itemId,
    audioStartMs: item.audioStartMs,
    audioEndMs: item.audioEndMs,
    transcript: text,
    disposition: 'script',
  });
}

/**
 * Has a retained-transcript write failed during this take?
 *
 * Sticky for the length of the session. A single failure means the transcript
 * on disk has a hole in it, and that stays true however many later writes
 * succeed — so the take summary has to say "partially saved" rather than
 * reporting retention as a boolean the settings screen set.
 */
let transcriptRetentionDegraded = false;


/**
 * Persistence that has been STARTED but not yet acknowledged.
 *
 * Every durable write a take makes — the retained transcript tail, the take
 * row, the session row — is issued with `void promise.catch(...)` so that a
 * slow database can never stall the live loop. That is right during a take and
 * wrong at the moment the process is about to exit: the close/quit handshake
 * was reporting "the take was finished" while those writes were still in
 * flight, and Rust would then exit out from under them.
 *
 * So every one of them is registered here, and
 * {@link awaitPendingPersistence} is what the shutdown sequence awaits. The
 * next launch can close an orphaned session row, but it cannot reconstruct a
 * lost transcript or take.
 */
const pendingPersistence = new Set<Promise<unknown>>();

/** Register a fire-and-forget write so shutdown can wait for it. */
function trackPersistence<T>(promise: Promise<T>): Promise<T> {
  pendingPersistence.add(promise);
  void promise.finally(() => pendingPersistence.delete(promise)).catch(() => {});
  return promise;
}

/**
 * Wait for every durable write a take started.
 *
 * Settles rather than rejects: a write that failed is a failure the take
 * already reported, and re-throwing here would abandon the shutdown steps
 * after this one. What matters is that the process does not exit while the
 * write is still on the wire.
 */
export async function awaitPendingPersistence(): Promise<void> {
  // A write can start another (the take row closes, then the session row), so
  // drain until the set is empty rather than snapshotting it once.
  while (pendingPersistence.size > 0) {
    await Promise.allSettled([...pendingPersistence]);
  }
}

/**
 * Write out everything buffered so far. `force` is retained on the signature
 * because the call sites read better for it, but every item is now ready the
 * moment it arrives — see {@link TRANSCRIPT_FLUSH_INTERVAL_MS}.
 */
function flushTranscript(sessionId: string, force: boolean): void {
  void force;
  if (!transcriptRetained || transcriptBuffer.length === 0) return;
  const ready = transcriptBuffer;
  transcriptBuffer = [];
  const epoch = transcriptEpoch;

  void trackPersistence(
    appendSessionTranscript(
      sessionId,
      ready.map((item) => ({
        commitSequence: item.commitSequence,
        providerItemId: item.providerItemId,
        audioStartMs: item.audioStartMs,
        audioEndMs: item.audioEndMs,
        transcript: item.transcript,
        disposition: item.disposition,
      })),
    ),
  ).catch(() => {
    /*
     * The items go back in the buffer, they are not dropped — but ONLY if the
     * buffer still belongs to the session they came from.
     *
     * They used to be gone outright: the buffer was cleared before the write
     * was acknowledged, so a failed append lost exactly those items and
     * nothing said so. The first fix re-queued them into the GLOBAL buffer,
     * which is worse in one specific way: `stopSession` clears that buffer,
     * and a rejection arriving after the next take had started would insert
     * one session's transcript into another's — and it would then be written
     * under the wrong session id.
     *
     * The second fix compared `state.sessionId`, and that is not the same
     * question. `stopSession` leaves the id in place while the take is over
     * and the flush timer is stopped, so a rejection landing in that window
     * still looked like "the same take": the items went back into a buffer
     * nothing would ever drain, the toast promised a retry that could not
     * happen, and the sticky degraded flag survived into the NEXT take's
     * summary. `transcriptEpoch` answers the question actually being asked —
     * is this still the buffer these items came from — and it changes on
     * teardown as well as on start.
     *
     * A rejection that arrives too late to retry is REPORTED rather than
     * silently re-homed: the presenter is told, in words that say the section
     * is missing rather than that CandidCue is still trying.
     *
     * Re-queued at the FRONT, so ordering survives. `commitSequence` is unique
     * per session and Rust inserts with `INSERT OR IGNORE`, so retrying an
     * item that did land is a no-op rather than a second row.
     */
    const stillTheSameTake = transcriptEpoch === epoch;
    if (stillTheSameTake) {
      // Sticky for the take, and ONLY for the take it belongs to: setting it
      // unconditionally marked the next take's summary "partly saved" for a
      // write that failed before it started.
      transcriptRetentionDegraded = true;
      transcriptBuffer = [...ready, ...transcriptBuffer];
    } else if (transcriptEpoch === epoch + 1) {
      /*
       * The take is over and its summary is on screen saying the transcript was
       * saved — because at the moment that was computed, this write had not
       * failed yet. `stopSession` issues the final append and reads the flags
       * synchronously, so the last write of every take settles after the answer
       * about it has been given.
       *
       * So correct the answer where it is. The summary lives in the store and
       * the dialog renders it, so this reaches the screen the presenter is
       * looking at rather than only the toast beside it.
       *
       * `epoch + 1` and not merely "different": teardown bumps once, and a new
       * take bumps again. One step means the take that just ended, which is the
       * take whose summary is being shown; two or more means somebody has moved
       * on and this is no longer their business.
       */
      state.update((s) =>
        s.summary
          ? {
              ...s,
              summary: { ...s.summary, transcriptSaved: false, transcriptPartial: true },
            }
          : s,
      );
    }
    /*
     * A PRACTICE IS NOT PROMISED A SUMMARY (§practice).
     *
     * The correction above is already a no-op for one — it patches `s.summary`,
     * which a practice never has — but the toast went on to promise that the
     * summary "will say if any of it is missing", and for a rehearsal no such
     * card ever opens. That is the same false promise the exit confirmations
     * were changed to stop making, arriving somewhere the eye does not look for
     * it, and it points the operator at a screen they will never see.
     *
     * Read live, which is the only place this branch runs: `stillTheSameTake`
     * means the session is still the one that issued the write, so the flag is
     * the running session's own.
     */
    const practising = stillTheSameTake && get(state).practice;
    showToast(
      stillTheSameTake
        ? practising
          ? 'CandidCue could not save part of the transcript for this practice. It will ' +
            'keep trying.'
          : 'CandidCue could not save part of the transcript for this take. It will keep ' +
            'trying, and the take summary will say if any of it is missing.'
        : 'CandidCue could not save the last part of the transcript for the take that ' +
            'just ended. That section is missing from the saved transcript.',
      'danger',
    );
  });
}

/* ---------------------------------------------------------------------------
 * Smooth-following actions (companion §48) — the store owns the state, this
 * store owns the effects.
 * ------------------------------------------------------------------------- */

/**
 * §28.4. The saved local voice-detection sensitivity, or the neutral midpoint
 * when settings are unavailable (browser dev, tests). Never an extreme: an
 * unreadable setting must not silently become the most aggressive VAD on offer.
 */
function currentVadSensitivity(): number {
  try {
    const value = getSettingsSnapshot().audio?.vadSensitivity;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
  } catch {
    return 0.5;
  }
}

function currentFollowingSettings(): FollowingSettings {
  try {
    return getSettingsSnapshot().following ?? defaultFollowingSettings();
  } catch {
    return defaultFollowingSettings();
  }
}

/*
 * A `REACQUIRE_WINDOW_TOKENS` constant used to live here — ±150 atoms around
 * the engine's own `observedToken`, handed to the aligner as a search prior.
 *
 * Two things were wrong with computing it here. The centre was the engine's
 * current answer, which is the position the presenter is disputing; and the
 * control window does not know what is on the glass. The STAGE reports its
 * viewport over `stage://viewport-hint` and Rust already holds it, so the
 * reacquisition uses that and this passes no range at all.
 */

const followActions = {
  nudge(deltaSentences: number): void {
    moveSentences(deltaSentences);
  },
  /**
   * "Re-find me here" (§48): reopen the search around what is on screen.
   *
   * This used to be `driver.moveToToken(snapshot.confirmedToken)` behind a TODO
   * asking for exactly what is here now. Two things were wrong with it, and the
   * second is the one that mattered.
   *
   * It seeded the engine with the engine's OWN current answer, so a presenter
   * pressing "re-find me" asked it to look precisely where it was already
   * looking — the one place it is demonstrably not finding them.
   *
   * And `moveToToken` is "I am here": it asserts a position at high confidence
   * and returns the engine to `following`, so the display moved off an
   * assertion the presenter had just disputed, before any evidence arrived to
   * support it. A reacquisition holds instead, which is the safe direction for
   * a follower that must never run ahead.
   *
   * The search prior is the STAGE's own viewport, which Rust already holds
   * from `stage://viewport-hint` — the tokens actually on the glass. Nothing
   * is computed here: the control window does not know what the reader can
   * see, and the engine's own position is the thing being disputed.
   */
  reAnchor(): void {
    driver?.reacquire();
    noteReposition();
    showToast('Re-finding your place', 'info', { durationMs: 1600 });
  },
  acceptCandidate(candidate: { tokenIndex: number }): void {
    driver?.moveToToken(candidate.tokenIndex);
    noteReposition();
  },
  /**
   * Pausing following is not pausing the session (§15.3, §48): transcription
   * stays connected and voice commands keep working — only automatic movement
   * stops.
   */
  setFollowingPaused(paused: boolean, deliberate = true): void {
    // The follow store owns the "an automatic release may not overrule a
    // deliberate pause" rule, because it is the one funnel every road into
    // pausing goes through and its own state has to agree with the outcome.
    trace('follow-pause', paused ? 'paused by the follow store' : 'resumed by the follow store');
    if (paused) driver?.pause();
    else driver?.resume();
    state.update((s) => ({
      ...s,
      voiceFollow: !paused,
      /*
       * Only a decision reaches the glass. An automatic hold stops following
       * too, and saying "Following off" over it would tell the presenter they
       * had switched something off when what actually happened is that the
       * transcript stopped being trustworthy.
       *
       * And it has to reach the glass, which reads it through the stage's
       * `followPaused` prop. Stopping the driver stops the snapshots, which the
       * stage could only notice as an ABSENCE — indistinguishable from a
       * presenter who has gone quiet until its 15 s staleness window expires,
       * and for those fifteen seconds the script would keep drifting forward
       * after the switch was flipped to stop it.
       */
      ...(deliberate ? { followPausedByUser: paused } : {}),
    }));
  },
  /**
   * §62 recovery. Re-issuing the current stage settings ASKS the stage to
   * measure its line map again. It does not force a relayout, and the two
   * limits below are why.
   *
   * It re-issues `stageEnvelope` at the SAME stage generation, the identity kick
   * `applyStageAppearance` already uses to wake the embedded stage's own
   * envelope-diff effect. Minted from the CURRENT settings rather than a
   * patch: recovery is "run this again", not a change of values.
   *
   * Which is exactly what caps it. Unchanged values produce an identical
   * fingerprint, so `sameLayout()` in src/stage/renderer/ScriptLayer.svelte
   * classifies the rebuild coverage-only: `layoutGeneration` does not bump, the
   * §33 semantic re-anchor never runs, and `MAP_REBUILD_THROTTLE_MS` (250 ms)
   * returns before measuring at all if a windowed-render coverage build
   * happened inside the last 250 ms. A stuck map that layout has since settled
   * under is still recovered, because the pass re-measures; a map the declared
   * inputs say is fine gets no stronger answer than that.
   *
   * And the only caller cannot be reached during a take. It is
   * `smoothFollow.requestLayoutRebuild()`, raised from the `rebuild_layout`
   * action on the §62 `invalid_line_map` notice, which `FollowStatePanel`
   * renders — and that panel sits in the `{:else}` arm of
   * `{#if $session.active}` in src/control/routes/Live.svelte, i.e. the arm
   * that is NOT shown while a session is running. So this half of the recovery
   * is pre-positioned for when the panel becomes reachable, not something a
   * presenter can press mid-take today.
   */
  rebuildStageLayout(): void {
    state.update((s) =>
      s.stageEnvelope === null || !stageSettings
        ? s
        : { ...s, stageEnvelope: { ...s.stageEnvelope, stageSettings: { ...stageSettings } } },
    );
    showToast('Asked the stage to rebuild its layout', 'info');
  },
};

/**
 * "Which panel is display 2?" — answered on the panels themselves.
 *
 * A numbered, always-on-top, click-through card on every connected display
 * (`identify.html`, spec §52.4), raised from Session › Identify Displays.
 */
export async function identifyStageDisplays(): Promise<void> {
  try {
    await stageService.identifyDisplays();
  } catch (err) {
    showToast(`Could not number the displays. ${describeError(err)}`, 'danger');
  }
}

/* ---------------------------------------------------------------------------
 * Transport actions (§15.3)
 * ------------------------------------------------------------------------- */

/** Start (or restart) prompting — the stage begins following. */
export function startPrompting(): void {
  const s = get(state);
  if (!s.active || s.prompting) return;
  trace('prompting', 'start');
  state.update((prev) => ({ ...prev, prompting: true, paused: 'none' }));
  driver?.start();
}

/** Listening pause — transcription stays connected (§15.3). */
export function pauseListening(): void {
  trace('pause', 'listening pause (user)');
  state.update((s) => ({ ...s, paused: 'listening' }));
  driver?.pause();
  pipeline?.softPause();
}

/** Hard pause — the realtime connection closes; voice cannot resume (§15.3). */
export function hardPause(): void {
  // 'muted' is the deliberate-pause label; 'disconnected' means something
  // broke. A hard pause is a choice, so it must not read as a failure.
  trace('pause', 'hard pause (user)');
  state.update((s) => ({ ...s, paused: 'hard', micState: 'muted' }));
  driver?.pause();
  void pipeline?.hardPause().catch((err) => {
    showToast(`Could not pause cleanly. ${describeError(err)}`, 'danger');
  });
}

/**
 * H3: resume must NOT optimistically claim the microphone is live.
 *
 * The old version flipped `micState` to 'live' and cleared the pause before
 * awaiting anything, then swallowed the rejection — so a resume that failed
 * (and after a hard pause it always did, on an invalid `idle -> resume`
 * transition) left the UI showing a live microphone over a dead session, which
 * is the single worst outcome this product has. The UI now follows the
 * session, never leads it.
 */
export function resumeSession(): void {
  const s0 = get(state);
  if (!s0.active) return;
  state.update((s) => ({ ...s, connection: 'reconnecting' }));
  driver?.resume();
  if (!pipeline) {
    // Manual/mock mode: there is no session to negotiate.
    state.update((s) => ({ ...s, paused: 'none', micState: 'live', connection: 'connected' }));
    return;
  }
  const resuming = pipeline;
  void pipeline
    .resume()
    .then(() => {
      state.update((s) => ({ ...s, paused: 'none', micState: 'live', connection: 'connected' }));
    })
    .catch((err) => {
      /*
       * `resume()` re-runs `start()` after a hard pause, so the model can be
       * refused here too. Recorded only while this is still the take's own
       * pipeline: a late refusal from a replaced one may not mark the take
       * that followed it.
       */
      const modelUnavailable = resuming === pipeline && isSpeechModelUnavailable(errorCode(err));
      // Stay paused and say so. Silence here is what made the failure invisible.
      state.update((s) => ({
        ...s,
        paused: s.paused === 'none' ? 'listening' : s.paused,
        micState: 'disconnected',
        connection: 'offline',
        voiceFollowingAvailable: modelUnavailable ? false : s.voiceFollowingAvailable,
      }));
      showToast(`Could not resume voice following. ${describeError(err)}`, 'danger');
    });
}

/**
 * §28.2 — is a mid-session input change possible right now?
 *
 * False in manual/fixed takes and in browser dev, where there is no transport
 * to replace a track on. The Live screen uses this to decide whether to offer
 * the picker at all: an affordance that cannot work is worse than none.
 */
export function canSwitchMicrophone(): boolean {
  return pipeline !== null;
}

/**
 * §28.2 mid-session microphone switch — the recovery for `MIC_DEVICE_LOST`.
 *
 * The transport has always been able to replace its sender track without a
 * renegotiation; nothing in production ever called it, so the device-lost
 * toast pointed at a control that did not exist. This is that call site.
 *
 * Resolves `true` when the take is following the new input again. On failure
 * the session is left exactly as it was — still held, still saying so — and
 * the reason is shown, because a switch that silently does nothing is the
 * worst possible answer to "my microphone died".
 */
export async function switchMicrophone(deviceId: string, label?: string): Promise<boolean> {
  if (!pipeline || deviceId === '') return false;
  /*
   * The take this switch belongs to, for the same reason `togglePresentationMode`
   * captures one: replacing a sender track is a round trip, and the take can end
   * — or be replaced by "Present again" — while it is in flight. Reporting
   * "voice following has resumed" onto a session that has since stopped, or
   * worse, clearing the NEW take's `inputDeviceLost` because the OLD take's
   * switch finally landed, would be a health claim about a microphone nobody is
   * using. Both the pipeline identity and the session id are checked: a fresh
   * take builds a new pipeline, and a stopped one has none.
   */
  const forPipeline = pipeline;
  const forSession = get(state).sessionId;
  // Where the fallback counter stood before this attempt. If it moves, THIS
  // switch is what fell back.
  const fallbacksBefore = inputFallbackCount;
  try {
    await pipeline.switchMicrophone(deviceId);
  } catch (err) {
    if (pipeline === forPipeline) {
      showToast(`Could not switch to that microphone. ${describeError(err)}`, 'danger');
    }
    return false;
  }
  if (pipeline !== forPipeline || get(state).sessionId !== forSession) return false;
  /*
   * A RESOLVED SWITCH IS NOT NECESSARILY THE DEVICE THAT WAS ASKED FOR.
   *
   * The pipeline falls back to the system default when the chosen input is
   * busy, and reports it through `onInputFellBackToDefault` rather than by
   * rejecting. Treating that as success was the same unfollowable-instruction
   * defect one level up: it cleared the fallback flag, took the picker away and
   * announced that following had resumed — for a device the operator had
   * chosen, been refused, and not been told about. Worse, it would then persist
   * that device as the remembered preference for every future take.
   *
   * So the audio state is updated either way (capture IS live, and the take was
   * held on a dead input a moment ago), but a fallback keeps its notice, keeps
   * the picker, and is not remembered or celebrated.
   */
  const fellBack = inputFallbackCount !== fallbacksBefore;
  state.update((s) => ({
    ...s,
    micState: 'live',
    inputDeviceLost: false,
    usingFallbackInput: fellBack,
  }));
  if (fellBack) return false;
  // The input is the operator's choice again, so the "we picked one for you"
  // notice has nothing left to report.
  dismissToastByKey(TOAST_INPUT_FELL_BACK);
  // §28.1: remember the choice, so the next take opens the input that worked
  // rather than the one that just vanished. The label goes with it — the id
  // alone does not survive a restart (see `matchRememberedMicrophone`).
  void patchSettings('audio', {
    followSystemDefault: false,
    preferredDeviceId: deviceId,
    ...(label === undefined ? {} : { preferredDeviceLabel: label }),
  }).catch(() => {
    /* a remembered preference is a convenience, never a gate */
  });
  showToast('Microphone switched. Voice following has resumed.', 'success');
  return true;
}

export function togglePlayPause(): void {
  const s = get(state);
  if (!s.active) return;
  if (!s.prompting) startPrompting();
  else if (s.paused === 'none') pauseListening();
  else resumeSession();
}

export function moveSentences(delta: number): void {
  driver?.moveSentences(delta);
  noteReposition();
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

/**
 * Absolute move to a token (§15.1 outline navigation). `moveSentences` is a
 * RELATIVE move and needs a cursor, so it cannot express "put me here" before
 * the first snapshot exists — which is every moment before Start.
 */
export function goToToken(tokenIndex: number): void {
  if (!get(state).active) return;
  driver?.moveToToken(Math.max(0, tokenIndex));
  noteReposition();
  // §36.3: an outline jump is a position the operator deliberately went to, and
  // "where did I skip to" is half of what a take history is for.
  noteCheckpoint('manual');
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

/**
 * §16.9. The presenter scrolled the stage somewhere else; put the tracker
 * there too.
 *
 * The gap this closes is the oldest one in the manual-scroll path. A wheel
 * gesture moved the DOCUMENT and told the aligner nothing, so the cursor stayed
 * where it was and the next sentence the presenter spoke was matched against a
 * place they had left — which either dragged the script back at the profile's
 * full forward speed, or held it in the wrong place for however long the
 * aligner took to relocate on evidence alone. The arrow keys never had this
 * problem: they travel as `manual_step`, and every one of them re-seeds the
 * cursor.
 *
 * NO CHECKPOINT, and that is the difference from `goToToken`. An outline jump
 * is an operator deciding to be somewhere and is worth a mark in the take
 * history; scrolling is how a presenter reads, and a history with a checkpoint
 * per wheel gesture is a history nobody can find the real jumps in. The
 * correction still COUNTS — `manualCorrectionCount` in the summary is a measure
 * of how much hand-holding the take needed, and this is exactly that.
 *
 * The stage decides whether a gesture was a move at all; by the time one
 * arrives here the question has been answered (see `manual_scroll`).
 */
export function anchorManualScroll(tokenIndex: number, atMs?: number): void {
  if (!get(state).active) return;
  if (!Number.isFinite(tokenIndex)) return;
  /*
   * A report the take has already moved past is not a report, it is a rewind.
   *
   * The gesture settles 200 ms after the presenter stops scrolling, and an
   * operator can restart the paragraph, jump the outline, or step a sentence
   * inside that window — all of which put the aligner somewhere deliberately.
   * The stale gesture then landed on top of it and dragged the cursor back to
   * where the presenter had been BEFORE the restart, undoing the one action
   * somebody had just taken on purpose.
   */
  if (typeof atMs === 'number' && Number.isFinite(atMs) && atMs <= lastRepositionAtMs) {
    trace('manual-scroll', 'anchor dropped: a deliberate reposition overtook it');
    return;
  }
  driver?.moveToToken(Math.max(0, Math.round(tokenIndex)));
  noteReposition();
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

/**
 * When the aligner was last put somewhere on purpose, wall clock.
 *
 * Read by `anchorManualScroll` to drop a wheel report that a deliberate
 * reposition has overtaken. Module state rather than store state because
 * nothing renders it — it is a race guard, not a fact about the take.
 */
let lastRepositionAtMs = Number.NEGATIVE_INFINITY;

function noteReposition(): void {
  lastRepositionAtMs = Date.now();
}

/**
 * §15.2 retake. This is also the §36.3 take boundary: the pass that was being
 * performed is over, and the next one starts here. Closing it first means the
 * completed take is written with its own times, sections and checkpoints rather
 * than being merged into whatever follows.
 */
export function restartParagraph(): void {
  driver?.restartParagraph();
  noteReposition();
  const before = get(state);
  // §36.3: a new pass proves itself again. The evidence that the last one was
  // heard says nothing about this one, and the pill coming back is how the
  // presenter knows the retake is being picked up.
  resetVoicePill();
  /*
   * And the follow panel's copy of the same fact, for the same reason.
   *
   * This function calls itself a take boundary and behaves like one — it closes
   * a pass and opens another — so a retake that begins already "heard" would
   * carry the previous pass's evidence into a pass that has produced none. The
   * pill and this flag answer the same question on two surfaces and must not
   * disagree about it.
   */
  state.update((s) => (s.heardAnything ? { ...s, heardAnything: false } : s));
  noteCheckpoint('paragraph_start');
  finishTake(before.sessionId, roundToken(before.snapshot?.confirmedToken));
  if (before.sessionId !== null) {
    const passOrdinal = before.counts.retakes + 2;
    beginTake(before.sessionId, passOrdinal, roundToken(before.snapshot?.confirmedToken) ?? 0);
  }
  state.update((s) => ({ ...s, counts: { ...s.counts, retakes: s.counts.retakes + 1 } }));
}

/** "Mark this" (§36.3) — drop a checkpoint at the current position. */
export function addTakeMarker(): void {
  noteCheckpoint('take');
}

/**
 * "Blank the screen" (§16.6) — from the Live transport or the voice command.
 *
 * WHAT THE USER DECIDES, AND WHAT THEY DO NOT.
 *
 * Blanking hides the SCRIPT; that is what the word means and it is not
 * configurable. The stage reads `stageBlanked` through its `blanked` prop.
 */
export function toggleBlankStage(): void {
  state.update((prev) => ({ ...prev, stageBlanked: !prev.stageBlanked }));
}

/**
 * The transport's "Voice follow" switch and the Live "Pause following" button
 * are the same decision (§48), so both route through the follow store and stay
 * in sync.
 */
export function toggleVoiceFollow(): void {
  /*
   * Toggles the presenter's own switch, NOT `voiceFollow`.
   *
   * `voiceFollow` also goes false for an automatic hold, and toggling off that
   * made the control do the opposite of what it says: with a transcription
   * hold in force the switch still (correctly) reads ON, and clicking it to
   * turn following off computed "currently off, so resume" — the one click
   * that could restart a script mid-fault, from the control whose whole job is
   * stopping it.
   */
  smoothFollow.setFollowingPaused(!get(state).followPausedByUser);
}

/* ---------------------------------------------------------------------------
 * The fixed-pace transport
 *
 * What this is FOR: the takes voice following cannot carry. No speech key
 * entered, no network, a room loud enough that finals stop arriving, a language
 * the recogniser handles badly. In every one of those the stage holds still and
 * is right to — but "holds still" was the whole of the answer, and a presenter
 * standing at a camera with a script that will not move has no recourse they can
 * reach.
 *
 * It is deliberately NOT a second way to prompt. Running it pauses following,
 * and stopping it resumes following, because the alternative is two things
 * moving the same document with different ideas about where the presenter is —
 * and the one that is wrong would be invisible until it had already carried
 * somebody off their line.
 * ------------------------------------------------------------------------- */

/**
 * What the operator ASKED for. `autoScrollLive` is what the stage is told.
 *
 * They are not the same thing and keeping them apart is the whole of how the
 * transport interacts with the transport controls: `state.autoScroll.running`
 * survives a pause so that resuming picks the script back up where it was, and
 * a presenter who paused a take does not have to remember to re-arm it.
 */
function publishAutoScroll(next: StageAutoScrollPayload): void {
  state.update((s) => ({ ...s, autoScroll: next }));
}

/**
 * Did the transport pause voice following, or was it already paused?
 *
 * The transport gives back only what it took — see `toggleAutoScroll`. Module
 * scope rather than session state because it is bookkeeping about a decision,
 * not something any view renders, and it is cleared with the take.
 */
let autoScrollPausedFollowing = false;

/**
 * The transport as the stage should actually run it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DERIVED AND NOT JUST THE FLAG
 * ---------------------------------------------------------------------------
 * Pause has to stop the script. In a voice take it does so by itself — the
 * driver stops, no snapshots arrive, and the engine holds — but a fixed-pace
 * transport has no such feedback: it rolls because a pace says so, and it would
 * go on rolling straight through a pause, a hard pause and the end of the take.
 * The stage cannot notice on its own either: it reads this store through its
 * `autoScroll` prop and rolls whenever it says so.
 *
 * So the gate lives here, where all four facts are already known, rather than
 * being bolted onto each of the five places that write `paused`. Anything that
 * pauses, hard-pauses, un-prompts or ends a take stops the script by
 * construction, including paths written later that have never heard of this.
 */
export const autoScrollLive = derived(
  state,
  (s): StageAutoScrollPayload => ({
    running: s.autoScroll.running && s.active && s.prompting && s.paused === 'none',
    wordsPerMinute: s.autoScroll.wordsPerMinute,
  }),
);

/**
 * Start or stop rolling the script at a fixed pace.
 *
 * Starting pauses voice following through the follow store rather than by
 * reaching past it, so the Live panel, the timeline and the notices all say the
 * same thing about why the document is moving without a voice behind it.
 */
export function toggleAutoScroll(): void {
  const s = get(state);
  if (!s.active) return;
  const running = !s.autoScroll.running;
  publishAutoScroll({ ...s.autoScroll, running });

  /*
   * Following is only resumed by whoever paused it.
   *
   * The obvious version — "stopping the transport resumes following" — hands
   * the script back to an aligner the OPERATOR had deliberately paused before
   * any of this started, which is a decision of theirs being quietly undone by
   * an unrelated key. So the transport remembers whether the pause was its
   * doing, and gives back only what it took.
   *
   * The guards also keep the follow timeline honest: `setFollowingPaused`
   * writes an entry every time it is called, and calling it for a take that was
   * already paused would fill the operator's history with pauses that never
   * happened.
   */
  if (running) {
    autoScrollPausedFollowing = s.voiceFollow;
    if (s.voiceFollow) smoothFollow.setFollowingPaused(true);
  } else {
    const restore = autoScrollPausedFollowing;
    autoScrollPausedFollowing = false;
    if (restore && !s.voiceFollow) smoothFollow.setFollowingPaused(false);
  }

  showToast(
    running
      ? `Auto-scroll on — ${s.autoScroll.wordsPerMinute} wpm`
      : 'Auto-scroll off — following your voice again',
    'info',
    { durationMs: 1800 },
  );
}

/**
 * Change the pace, in words per minute.
 *
 * Works whether or not the transport is running: dialling a speed in before
 * starting is the ordinary way somebody sets one, and a control that only
 * responded while the script was already moving would have to be found in a
 * hurry, mid-take, by somebody reading.
 */
export function nudgeAutoScrollWpm(deltaWpm: number): void {
  const s = get(state);
  if (!s.active) return;
  const wordsPerMinute = clampAutoScrollWpm(s.autoScroll.wordsPerMinute + deltaWpm);
  if (wordsPerMinute === s.autoScroll.wordsPerMinute) {
    /*
     * At the end of the range, and that has to be said.
     *
     * Returning in silence makes a key at its limit indistinguishable from a
     * key that did not register, and the operator presses it harder. Naming the
     * limit answers the actual question in one glance.
     */
    showToast(
      `Auto-scroll ${wordsPerMinute} wpm — ${
        wordsPerMinute >= AUTO_SCROLL_MAX_WPM ? 'fastest' : 'slowest'
      }`,
      'info',
      { durationMs: 1200 },
    );
    return;
  }
  publishAutoScroll({ ...s.autoScroll, wordsPerMinute });
  /*
   * A pace key with no feedback at all reads as a key that did not register,
   * and the operator presses it again. The toast is what reports it, exactly as
   * it does for the take marker and the mirror.
   */
  showToast(`Auto-scroll ${wordsPerMinute} wpm`, 'info', { durationMs: 1200 });
}

/**
 * The stage ran out of script.
 *
 * Stands the transport down and gives back the pause it took, on the same rule
 * as stopping it by hand. The alternative — leaving following paused because
 * reaching the end is no evidence the microphone recovered — is true as far as
 * it goes, and it strands the take in a state nothing announces and no key
 * obviously clears. Resuming is the safer of the two: a paused aligner that is
 * handed the document back holds until it has evidence, so the worst case is
 * that nothing happens, which is also the likeliest one.
 */
export function autoScrollReachedEnd(): void {
  const s = get(state);
  if (!s.autoScroll.running) return;
  publishAutoScroll({ ...s.autoScroll, running: false });
  // The pause is still given back — the transport took it and is done with it —
  // but nothing here claims the microphone started working. See the note above.
  const restore = autoScrollPausedFollowing;
  autoScrollPausedFollowing = false;
  if (restore && !s.voiceFollow) smoothFollow.setFollowingPaused(false);
  showToast('Auto-scroll reached the end of the script', 'info', { durationMs: 2400 });
}

/** The offered pace range, for the controls that present it. */
export const AUTO_SCROLL_WPM_RANGE = { min: AUTO_SCROLL_MIN_WPM, max: AUTO_SCROLL_MAX_WPM };

/* ---------------------------------------------------------------------------
 * Stage appearance quick-controls (Live screen + voice commands)
 * ------------------------------------------------------------------------- */

/** The saved teleprompter section, or its defaults where settings cannot be read. */
function currentTeleprompterSettings(): TeleprompterSettings {
  return getSettingsSnapshot().teleprompter;
}

/**
 * What the stage is prompting at now, as the sheet's controls describe it.
 *
 * Read off the RENDERED settings, falling back to the section they were
 * composed from. The two differ on a rig-resolved take, where the geometry was
 * worked out from a measured distance and the saved values were never consulted
 * — and a readout that claims to say what is on the glass has to show the
 * numbers that are on the glass.
 *
 * NOT clamped, deliberately. Clamping a READ to the ranges the sliders offer is
 * how a readout starts lying: a rig may legitimately resolve a line height of
 * 2.0 or a column narrower than 40%, and the sheet would have shown 1.80 beside
 * type that is plainly not at 1.80. Requests are clamped, on the way in, where
 * a value out of range is a mistake rather than a measurement.
 */
function liveStageAppearance(): StageAppearance {
  const source = stageSettings ?? takeTeleprompter ?? currentTeleprompterSettings();
  return readStageAppearance(source);
}

/**
 * Change how the running take looks, now.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE THING IS REBUILT
 * ---------------------------------------------------------------------------
 * Every caller here used to patch the one field it cared about straight onto
 * the live `StageSettings`. That is wrong in a way nothing on the glass
 * announces: `readingBandHalfHeightPercent` is derived from size AND line
 * height, so a patched `fontSizePx` left the reading corridor sized for type
 * that is no longer there — the band the presenter aligns to their lens quietly
 * stops matching the text inside it. Recomposing through
 * `stageSettingsFromSettings` is the same path a take opens with, so a stage
 * adjusted mid-take and a stage started with those numbers are identical.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ENVELOPE IS REWRITTEN TOO
 * ---------------------------------------------------------------------------
 * Presentation is one webview now (§62): the stage renderer is mounted inside
 * this window and hydrates from `stageEnvelope`, not from the cross-window
 * directive bus. A settings directive on its own reached nothing, which is why
 * `+`/`-` and Cmd+Shift+M once appeared to do nothing at all. The envelope is
 * re-issued at the SAME stage generation, which `stageReducer` treats as a
 * refresh in place: phase, alignment and the compiled document all survive it.
 *
 * Returns the appearance the stage is now running, which is not always the one
 * asked for — a rig-resolved take works its geometry out for itself (§17.2).
 */
export function applyStageAppearance(patch: Partial<TeleprompterSettings>): StageAppearance {
  const base = takeTeleprompter ?? currentTeleprompterSettings();
  /*
   * A rig-resolved take with no panel to resolve against cannot be recomposed.
   *
   * `stageSettingsFromSettings` needs the display to find the profile and to
   * size type against its viewport; without it the rebuild silently produces
   * the UNCALIBRATED layout, so the first nudge of any control — even one as
   * unrelated as the mirror — would demote a measured rig to a guess, mid-take,
   * with nothing on the glass to say it happened. Production always carries the
   * display (calibration is keyed by the panel's fingerprint, so a take with no
   * display resolves no profile in the first place); this is the guard for a
   * caller that hand-built its settings.
   */
  if (stageSettings?.optics && stageDisplay === null) return liveStageAppearance();

  /*
   * Clamped HERE, not at the controls.
   *
   * The sliders already draw the right ranges, but they are not the only
   * caller: `+`/`-` and the voice commands hand in a delta, and a step past the
   * end used to land on the glass unclamped — the readout said one size and the
   * stage prompted at another, which on the one screen with no second opinion
   * is the worst way for a control to be wrong.
   */
  const merged = { ...base, ...patch };
  takeTeleprompter = { ...merged, ...clampStageAppearance(merged, takeFontCeilingPx) };
  return recomposeStageSettings();
}

/**
 * Let a change made in Settings reach the take that is already running.
 *
 * ---------------------------------------------------------------------------
 * THE SETTINGS WINDOW IS THE ONLY CONTROL SURFACE LEFT ON THE DESK
 * ---------------------------------------------------------------------------
 * In single-window presentation this window IS the prompter, filling the glass
 * on the other display. The in-session sheet lives inside it, which puts every
 * appearance control on the panel the presenter is reading from — fine for a
 * nudge with `+`/`-`, and no use at all for sitting at the desk monitor and
 * dragging the text size until it reads right through the lens. Settings is
 * its own window on the desk, and its sliders write the document; without this
 * those writes reached the store here and stopped, honoured by the NEXT take
 * and ignored by the one on the glass.
 *
 * So each document COMMITTED while a take is running is diffed against the one
 * committed before it, and the stage fields that changed are applied to the
 * take through `applyStageAppearance` — the same path the sheet and the voice
 * commands use, so the corridor is re-derived and the clamp still holds. Only
 * the fields that CHANGED, on purpose: the take may carry nudges of its own
 * that the saved document does not know about, and replacing the whole section
 * would snap those back. A change to the optical rigs recomposes too, with no
 * field patch, because the rig is read from the snapshot at every rebuild —
 * compared by value, since every read rebuilds the section and an identity
 * check would call an unrelated save a rig change.
 *
 * Commits, not the store. The store also shows this window's optimistic
 * values and their rollbacks, and a rollback is the old numbers coming back —
 * which a follower cannot tell from somebody setting them. The sheet's Done
 * button is the case that matters: it promotes the take's appearance into the
 * saved document, and if that write is refused the store rolls back while the
 * take is meant to keep its look. When it succeeds, the commit arrives as a
 * diff whose values the take already holds — a rebuild to the same numbers.
 *
 * Not every teleprompter field is a stage field. `fixedSpeedWpm` is the
 * transport's pace, read once at the take's opening; it is routed to the
 * transport here so a pace changed in Settings applies to the roll in
 * progress. The rest — what a take does at its end, whether the pointer hides
 * — are for the next take and are left alone.
 *
 * Installed by the shell rather than at module scope: the Settings window has
 * its own copy of this store with no take in it, and the unit suites that mock
 * the settings store do not all provide the hook.
 */
export function installLiveSettingsFollow(): () => void {
  let previous = getSettingsSnapshot();
  return onSettingsCommitted((next) => {
    const last = previous;
    previous = next;
    if (!get(state).active) return;
    const patch: Partial<TeleprompterSettings> = {};
    for (const key of LIVE_STAGE_FIELDS) {
      if (!Object.is(next.teleprompter[key], last.teleprompter[key])) {
        (patch as Record<string, unknown>)[key] = next.teleprompter[key];
      }
    }
    /*
     * A change to THIS panel's saved mirroring replaces a live flip, the same
     * way a slider moved in Settings replaces a nudge of the same field. A
     * change to another panel's leaves it alone — it says nothing about the
     * glass this take is on. Either way the rebuild below is what applies it,
     * since the mirror map is part of the optical section.
     */
    const panel = stageDisplay?.fingerprint ?? null;
    if (!samePanelMirror(panelMirrorFor(next.optical, panel), panelMirrorFor(last.optical, panel))) {
      takeMirror = null;
    }
    const rigChanged = JSON.stringify(next.optical) !== JSON.stringify(last.optical);
    if (Object.keys(patch).length > 0 || rigChanged) applyStageAppearance(patch);

    const pace = next.teleprompter.fixedSpeedWpm;
    if (!Object.is(pace, last.teleprompter.fixedSpeedWpm)) {
      const s = get(state);
      publishAutoScroll({ ...s.autoScroll, wordsPerMinute: clampAutoScrollWpm(pace) });
    }
  });
}

/**
 * The teleprompter fields the stage is composed from — the ones
 * `stageSettingsFromSettings` reads. A change to any other field is not a
 * change to the glass.
 */
const LIVE_STAGE_FIELDS: ReadonlyArray<keyof TeleprompterSettings> = [
  'fontFamilyId',
  'fontSizePx',
  'lineHeight',
  // No mirror axes: mirroring is per panel and lives in `optical` (#206), which
  // the follower compares as a whole below.
  'columnWidthPercent',
  'readingBandCenterPercent',
  'phraseHighlight',
  'pastDimming',
  'semanticLineBreaks',
  'textIntensity',
  'stageMode',
  'readingCue',
  // Seeded into the automatic profile by `stageSettingsFromSettings`, exactly
  // as the two above it are, so a change to it is a change to the glass. On a
  // take running a calibrated rig the recomposition is a no-op, because the
  // rig's own bias wins.
  'sizeBias',
];

/**
 * Rebuild the live `StageSettings` from this take's own overrides.
 *
 * Factored out of `applyStageAppearance` when the presentation mode became the
 * second thing a take can hold against the saved settings. Both callers have to
 * compose the SAME way — that is the whole reason a mid-take change and the next
 * take's opening frame agree — and two copies of this is how they stop agreeing.
 */
function samePanelMirror(a: PanelMirror, b: PanelMirror): boolean {
  return a.horizontal === b.horizontal && a.vertical === b.vertical;
}

/**
 * The mirroring this take is running: its own live flip, or what its glass is
 * showing now.
 *
 * The RENDERED axes rather than a fresh read of the panel's saved answer. The
 * two differ when Settings changed the mirror while the take was opening —
 * `startTake` composed from its snapshot, and the follower is not installed on
 * a take that is not active yet — and the menu checkmark and the toggle have
 * to describe the glass, or the first press of the shortcut changes nothing
 * the operator can see. Callers deal with reader mode, where the rendered axes
 * are forced off.
 */
function takeMirrorAxes(): PanelMirror {
  if (takeMirror) return takeMirror;
  if (stageSettings) return { horizontal: stageSettings.mirrorX, vertical: stageSettings.mirrorY };
  return panelMirrorFor(getSettingsSnapshot().optical, stageDisplay?.fingerprint);
}

function recomposeStageSettings(): StageAppearance {
  const rebuilt = stageSettingsFromSettings(
    {
      ...getSettingsSnapshot(),
      ...(takeTeleprompter ? { teleprompter: takeTeleprompter } : {}),
      /*
       * The TAKE's mode, over the saved one.
       *
       * Without this every rebuild would reapply whatever Settings says, so a
       * take toggled to a reading window would snap back to the prompter's
       * measure and mirror the first time somebody touched a slider — see the
       * note on `takePresentationMode`.
       */
      ...(takePresentationMode
        ? {
            stage: {
              ...getSettingsSnapshot().stage,
              presentationMode: takePresentationMode,
            },
          }
        : {}),
    },
    stageDisplay,
    // Null leaves it to the panel's saved answer, read off the same snapshot.
    takeMirror,
  );
  stageSettings = rebuilt;
  const appearance = liveStageAppearance();
  state.update((s) => ({
    ...s,
    stageFontSizePx: rebuilt.fontSizePx,
    stageAppearance: appearance,
    stageRigResolved: isRigResolvedStage(rebuilt),
    stagePresentationMode: takePresentationMode ?? s.stagePresentationMode,
    stageEnvelope:
      s.stageEnvelope === null ? null : { ...s.stageEnvelope, stageSettings: rebuilt },
  }));
  return appearance;
}

/**
 * Switch this take between the prompter and a reading window.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW MOVES FIRST, THEN THE GEOMETRY
 * ---------------------------------------------------------------------------
 * Rust owns the window and this owns the document, and the order between them is
 * not arbitrary. Reader mode's geometry is resolved against the window's own
 * viewport (`ScriptLayer`'s `readerOptics`), so recomposing before the window
 * has changed shape resolves the new mode against the old size — one wrong
 * layout, measured, mapped, and then invalidated a frame later by the resize
 * that was always coming. Exactly the two-measurement waste `startTake`'s
 * opening sequence exists to avoid, in the middle of a take instead of at its
 * start.
 *
 * The caller does the window half, because it also owns the cover; this is the
 * document half and it is called after `awaitViewportSettled`.
 *
 * ---------------------------------------------------------------------------
 * AND THE PANEL, BECAUSE A SWITCH CAN CHANGE IT
 * ---------------------------------------------------------------------------
 * `landed` is the display `set_control_presenting` reports the new shape was
 * applied to, resolved by the caller through `resolveLandedDisplay`. It is not
 * decoration on the mode: switching to the prompter fills whichever monitor the
 * reading window had been dragged onto, and switching back to a reader restores
 * a frame that may live on a different panel again — so recomposing against the
 * panel the take OPENED on is issue #116 all over again, in the middle of a
 * take. `mmPerCssPx` is the whole basis of the angular model, so that is type at
 * a confidently wrong physical size rather than a near miss.
 *
 * Omitted or null means "nobody could name it" — plain-browser dev, or a monitor
 * that cannot be identified — and the take keeps the panel it already has. That
 * is strictly better than re-guessing: the existing panel is an answer that was
 * once true, and a guess is not.
 *
 * Returns the mode now in force, which is the one asked for unless there is no
 * take to change.
 */
export function adoptPresentationMode(
  mode: PresentationMode,
  landed?: DisplayDescriptor | null,
): PresentationMode {
  // Not `mode`: nothing was adopted, so answering with the request would report a
  // state the store is not in.
  if (!get(state).active) return livePresentationMode();
  const nextDisplay = landed ?? stageDisplay;
  // The panel is half of what the geometry is composed from, so "nothing
  // changed" has to account for it — a switch that lands on another monitor
  // still has to recompose even if the mode somehow came back the same.
  const movedPanel = nextDisplay?.fingerprint !== stageDisplay?.fingerprint;
  if (takePresentationMode === mode && !movedPanel) return mode;
  takePresentationMode = mode;
  stageDisplay = nextDisplay;
  // A flip was made at the glass the take WAS on. The panel it has landed on
  // has its own answer, and carrying the flip across is #206 mid-take.
  if (movedPanel) takeMirror = null;
  /*
   * The mode is recorded even when the geometry cannot be recomposed.
   *
   * `applyStageAppearance` refuses outright in this case, and it is right to:
   * nothing asked it to change, so declining leaves the take exactly as it was.
   * This is not that — the WINDOW has already changed shape by the time control
   * gets here, so refusing would leave the dock's toggle and `stagePresentationMode`
   * describing a window that no longer exists.
   *
   * So the mode is adopted and only the recompose is skipped. The reason to skip
   * it is the one stated on the sibling guard: a rebuild with no panel silently
   * produces the UNCALIBRATED layout, which would demote a measured rig to a
   * guess mid-take with nothing on the glass to say so. Unreachable in production
   * for the same reason it is there — a take with optics necessarily had a
   * display, because calibration is keyed by the panel's fingerprint.
   */
  if (stageSettings?.optics && stageDisplay === null) {
    state.update((s) => ({ ...s, stagePresentationMode: mode }));
    return mode;
  }
  recomposeStageSettings();
  return mode;
}

/** The mode this take is running, for the dock's toggle and the shortcut. */
export function livePresentationMode(): PresentationMode {
  return takePresentationMode ?? getSettingsSnapshot().stage.presentationMode;
}

/**
 * Is the take's script mirrored horizontally right now?
 *
 * Read by the native Session menu so its "Mirror Stage" checkmark reports the
 * state rather than merely offering the verb. It answers what is RENDERED: the
 * take's live flip or its panel's saved mirroring (#206), and never mirrored in
 * a reading window, which is what the glass actually shows.
 */
export function liveMirrorX(): boolean {
  if (livePresentationMode() === 'reader') return false;
  return takeMirrorAxes().horizontal;
}

/**
 * The saved teleprompter section this take is currently running, for the sheet
 * to persist when the operator presses OK.
 */
export function takeTeleprompterSettings(): TeleprompterSettings {
  return takeTeleprompter ?? currentTeleprompterSettings();
}

export function adjustStageFontSize(deltaPx: number): number {
  const current = get(state).stageAppearance.fontSizePx;
  // Clamped by `clampStageAppearance`, which is the same ceiling the sliders
  // draw against. It used to stop at 160px — below what this product's own
  // hardware asks for, and a different limit from the one Settings offered.
  return applyStageAppearance({ fontSizePx: current + deltaPx }).fontSizePx;
}

/**
 * Flip this take's mirroring on one axis, for this take only.
 *
 * Returns the horizontal mirroring now on the glass, or null when nothing was
 * flipped: a reading window is never mirrored, so a flip there would be an
 * invisible change waiting to surprise the operator when they switch back to
 * the prompter — and a rig-resolved take with no panel cannot be recomposed at
 * all (see `applyStageAppearance`).
 *
 * Not saved. The panel's mirroring is set in Settings, beside the display it
 * belongs to; this is the quick "it reads backwards" fix for the take in
 * front of you, and like every other in-take change it ends with the take.
 */
export function toggleStageMirror(axis: 'x' | 'y' = 'x'): boolean | null {
  if (!get(state).active || livePresentationMode() === 'reader') return null;
  if (stageSettings?.optics && stageDisplay === null) return null;
  const current = takeMirrorAxes();
  takeMirror =
    axis === 'x'
      ? { ...current, horizontal: !current.horizontal }
      : { ...current, vertical: !current.vertical };
  // §7.5: the rail inherits the same mirror boundary as the script, so it must
  // learn the new mirror state too — it flips through its own snapshot, not the
  // stage transform, because it is inside the mirror plane but the boundary is
  // decided on the control side. The rebuild re-issues both.
  applyStageAppearance({});
  return takeMirror.horizontal;
}

function jumpSection(delta: number): boolean {
  const s = get(state);
  const flat: OutlineNode[] = [];
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(s.outline);
  if (flat.length === 0) return false;
  const token = roundToken(s.snapshot?.confirmedToken) ?? 0;
  let currentIndex = -1;
  flat.forEach((n, i) => {
    if (n.startTokenIndex <= token) currentIndex = i;
  });
  const target = flat[Math.max(0, Math.min(flat.length - 1, currentIndex + delta))];
  if (!target) return false;
  driver?.moveToToken(target.startTokenIndex);
  state.update((prev) => ({ ...prev, counts: { ...prev.counts, jumps: prev.counts.jumps + 1 } }));
  return true;
}

/* ---------------------------------------------------------------------------
 * Stop / teardown
 * ------------------------------------------------------------------------- */

/**
 * Running realtime cost estimate (§35). ONE source for the Live status-bar
 * popover and the F.17 summary: they used to compute it differently and
 * disagreed by an order of magnitude for the same take.
 *
/** Stop the session and produce the F.17 summary. */
export function stopSession(): SessionSummary {
  const s = get(state);
  // A stop with nothing running must not manufacture an end-of-session
  // summary — Live opens the F.17 dialog on `!active && summary !== null`.
  if (!s.active) {
    stopInternals();
    return s.summary ?? emptySummary(s);
  }
  const summary: SessionSummary = {
    durationSeconds: s.elapsedSeconds,
    mode: s.mode,
    sectionsReached: s.blocksSeen.length,
    retakes: s.counts.retakes,
    reconnects: s.counts.reconnects,
    endingLocation: locateEnding(s),
    endTokenIndex: roundToken(s.snapshot?.confirmedToken) ?? takeEndToken(),
    sectionStartTokenIndex: sectionStartFor(s, roundToken(s.snapshot?.confirmedToken) ?? takeEndToken()),
    part: s.part,
    partComplete: s.partComplete,
    nextPart: s.nextPart,
    /*
     * The OUTCOME, not the setting. A write that failed is re-queued and
     * retried, so `transcriptBuffer` still holding items at the end of a take
     * means some of it never landed.
     */
    // Filled in after the final flush below — the tail has not been written
    // yet at this point, so judging it here would report on the wrong moment.
    transcriptSaved: false,
    transcriptPartial: false,
    manualJumps: s.counts.jumps,
    followingShare: takeFollowingShare(),
    wordsHeard,
    wordsFollowed: takeWordsFollowed(),
    scriptWords: scriptWordCount,
    wordsInFlight,
    /*
     * "Never had a recogniser", not "has none right now". A take that connected
     * and was later refused on a resume DID follow for part of its length, and
     * telling it otherwise would hide what it heard.
     */
    voiceFollowingAvailable: s.voiceFollowingAvailable || everConnected,
  };
  // §36.2 + §36.1: write the retained tail and close the record BEFORE the
  // teardown resets `transcriptRetained`. `stopInternals` is what runs on every
  // abnormal path too, so the ordering here is the only thing that guarantees
  // the last few seconds of a take are not silently dropped.
  if (s.sessionId) {
    flushTranscript(s.sessionId, true);
    /*
     * The OUTCOME, judged after the final flush has been issued.
     *
     * `transcriptSaved` used to be `transcriptRetained` — the SETTING, not
     * what happened — so a take whose appends failed reported "Saved" over a
     * transcript with a hole in it, on the one screen where anybody would ever
     * find out. A failed write is now re-queued rather than dropped, so items
     * still in the buffer here are items that never landed.
     *
     * `transcriptRetentionDegraded` is sticky for the session: one failure
     * means the transcript is incomplete, and that stays true however many
     * later writes succeed.
     */
    summary.transcriptSaved =
      transcriptRetained && !transcriptRetentionDegraded && transcriptBuffer.length === 0;
    summary.transcriptPartial =
      transcriptRetained && (transcriptRetentionDegraded || transcriptBuffer.length > 0);
    /*
     * The tail append issued two lines up has not settled yet, so a failure in
     * THAT write cannot reach the two flags above at this moment — and making
     * `stopSession` async to wait for it is a larger change than it looks: it
     * is called from a navigation guard, a shortcut and the shutdown sequence,
     * and two of those cannot await.
     *
     * So the correction comes to the summary instead of the summary waiting
     * for it: `flushTranscript`'s catch patches this object in the store when
     * the write that fails belongs to the take that just ended. The dialog
     * renders from the store, so a summary that said "Saved" a moment ago
     * changes to "Partly saved" in front of the presenter.
     */
    // §36.3: close the take that was running. Before the session row is closed,
    // so a listener reading the history the moment the session ends sees the
    // last take rather than a session with one pass missing.
    /*
     * Where the session ended. The conservative anchor when there is one, and
     * the take's own high-water mark otherwise — a session that ran and ended
     * has an end position even if alignment never produced a snapshot, and
     * reporting `undefined` there would make "did it follow anything" and "was
     * there a session at all" the same answer.
     */
    const endTokenIndex = roundToken(s.snapshot?.confirmedToken) ?? takeEndToken();
    finishTake(s.sessionId, endTokenIndex);
    void trackPersistence(endSessionRecord(s.sessionId, {
      endTokenIndex,
      commandCount: 0,
      retakeCount: s.counts.retakes,
      reconnectCount: s.counts.reconnects,
      manualCorrectionCount: s.counts.jumps,
      metrics: {
        sectionsReached: s.blocksSeen.length,
        durationSeconds: s.elapsedSeconds,
        endingLocation: summary.endingLocation,
      },
    })).catch(() => {
      // A session that cannot be closed is closed at next launch instead
      // (`sessions::close_orphaned_sessions`); never block the stop path.
    });
  }
  stopInternals();
  smoothFollow.endSession();
  /*
   * A PRACTICE REPORTS NOTHING.
   *
   * Live opens the F.17 card on `!active && summary !== null`, so withholding
   * the summary from the store is the whole of "no report" — there is no second
   * place to suppress and no dialog to teach about rehearsals.
   *
   * The summary is still BUILT and still returned to the caller, and both halves
   * of that matter. It is built because everything above this line also closes
   * the session row, flushes the transcript tail and reports the ending location
   * to Rust, and a rehearsal is a real reading whose ending is a real place in
   * the script — "From last ending" is offered on it. It is returned because
   * `stopSession`'s contract is to hand back what it measured, and a caller that
   * asked for the numbers is not the surface being kept quiet.
   *
   * What is withheld is only the CARD: a rehearsal ends by putting the editor
   * back, which is where somebody who has just practised a paragraph wants to
   * be, rather than by opening a report on a performance nobody gave.
   */
  state.update((prev) => ({
    ...prev,
    active: false,
    prompting: false,
    summary: s.practice ? null : summary,
  }));
  return summary;
}

export function clearSession(): void {
  // §36.1: clearing a session that is still running would drop its record on
  // the floor — the row would stay open until the next launch closed it as if
  // the app had crashed. Every caller today stops first; this makes that
  // ordering a property of the store rather than a convention.
  if (get(state).active) stopSession();
  stopInternals();
  smoothFollow.reset();
  state.set({ ...initial });
}

/** Shape-complete zero summary for a stop that had no session to stop. */
function emptySummary(s: SessionState): SessionSummary {
  return {
    endTokenIndex: 0,
    sectionStartTokenIndex: null,
    part: null,
    partComplete: false,
    nextPart: null,
    durationSeconds: 0,
    mode: s.mode,
    sectionsReached: 0,
    retakes: 0,
    reconnects: 0,
    endingLocation: 'Beginning',
    transcriptSaved: false,
    transcriptPartial: false,
    manualJumps: 0,
    followingShare: null,
    wordsHeard: 0,
    wordsFollowed: 0,
    scriptWords: scriptWordCount,
    wordsInFlight: 0,
    voiceFollowingAvailable: true,
  };
}

/**
 * The first token of the section containing `token`, or null when it is above
 * the first heading.
 *
 * Null rather than zero on purpose: zero would make "Retry last section"
 * indistinguishable from "Present again", so the caller can hide the action
 * instead of offering the same thing twice.
 */
function sectionStartFor(s: SessionState, token: number): number | null {
  const flat: OutlineNode[] = [];
  const walk = (nodes: OutlineNode[]): void => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(s.outline);
  const section = [...flat].reverse().find((n) => n.startTokenIndex <= token);
  if (!section || section.startTokenIndex <= 0) return null;
  return section.startTokenIndex;
}

function locateEnding(s: SessionState): string {
  const snapshot = s.snapshot;
  if (!snapshot) return 'Beginning';
  const flat: OutlineNode[] = [];
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(s.outline);
  const section = [...flat]
    .reverse()
    .find((n) => n.startTokenIndex <= snapshot.confirmedToken);
  if (section) return section.title;
  /*
   * A script with no headings still ended SOMEWHERE, and it used to be told in
   * the engine's units: "Token 417". A token is an internal measured span — it
   * is not a word count, it does not appear anywhere else the presenter can
   * see, and it cannot be converted into one by anybody reading the summary.
   * The sentence the take ended on is the same fact in the document's own
   * terms, and it is the only unit this screen already speaks (the transport
   * steps by sentences).
   */
  const sentences = s.sentences;
  // No headings AND no sentence metadata: say so rather than invent a position.
  // "Beginning" would be a claim about where the take ended, and this is the
  // one case where nothing is known about that.
  if (sentences.length === 0) return 'Location unavailable';
  const reached = sentences.filter((unit) => unit.startTokenIndex <= snapshot.confirmedToken).length;
  // Before the first sentence starts. Ordinary compiler output opens at token 0
  // so this needs degraded input to reach, but flooring it to "Sentence 1"
  // would report a sentence that had not been begun.
  if (reached === 0) return 'Beginning';
  return `Sentence ${reached} of ${sentences.length}`;
}

function stopInternals(): void {
  /*
   * The take's warnings end with the take. Every one of them describes a
   * microphone or a transport that is no longer in use, and `danger` toasts do
   * not expire — so left standing they arrive all at once on the summary
   * screen, reading as a fresh pile of problems rather than an old one that
   * resolved itself.
   */
  clearConditionToasts();
  /*
   * The take's appearance ends with the take.
   *
   * Anything the in-session sheet changed and did not save was scoped to the
   * take on purpose; carrying `takeTeleprompter` into the next one would make
   * "Cancel" mean "until you quit". The next take composes from the saved
   * settings again, which is where OK put anything worth keeping.
   */
  takeTeleprompter = null;
  takeMirror = null;
  takePresentationMode = null;
  stageDisplay = null;
  driver?.dispose();
  driver = null;
  if (pipeline) {
    const p = pipeline;
    pipeline = null;
    void p.stop().catch(() => {});
  }
  if (clock) clearInterval(clock);
  clock = null;
  if (transcriptFlushTimer) clearInterval(transcriptFlushTimer);
  transcriptFlushTimer = null;
  if (displayWatchTimer) clearInterval(displayWatchTimer);
  displayWatchTimer = null;
  transcriptRetained = false;
  transcriptRetentionDegraded = false;
  transcriptBuffer = [];
  // Anything still in flight belongs to the take that just ended, not to this
  // buffer or to whatever take fills it next.
  transcriptEpoch += 1;
  stopVoicePill();
  stopSidecarFeed?.();
  stopSidecarFeed = null;
  compiledScript = null;
  stageSettings = null;
  // §36.3: `stopSession` closes the open take first, so anything still here got
  // past the normal stop path and belongs to a session that is already gone.
  activeTake = null;
}

/**
 * The realtime connection pill (§15.1). Three states, not two: `offline` is a
 * non-recoverable failure and nothing is retrying, so labelling it
 * "Reconnecting" in a warning tone tells the operator to wait for a recovery
 * that is never coming.
 */
export function connectionPill(connection: SessionState['connection']): {
  tone: 'success' | 'warning' | 'danger';
  label: string;
} {
  switch (connection) {
    case 'connected':
      return { tone: 'success', label: 'Connected' };
    case 'reconnecting':
      return { tone: 'warning', label: 'Reconnecting' };
    default:
      return { tone: 'danger', label: 'Disconnected' };
  }
}

const PAUSED_LISTENING_LABEL = 'Paused — still listening for “CandidCue, resume”';
/** No microphone in this take, so nothing is listening for a wake word. */
const PAUSED_MANUAL_LABEL = 'Paused — the script stays where it is';

/**
 * F.11 status line for the top bar and tracking visualization.
 *
 * Every connection/microphone clause here is gated on the take actually HAVING
 * a realtime transport. Only a voice take constructs the pipeline, so in a
 * manual or fixed-speed take `connection` and `micState` never move off their
 * optimistic `initial` values — and this line was reporting a microphone that
 * was never opened and a wake word that nothing is listening for.
 */
export const liveStatusLabel = derived(state, (s): string => {
  if (!s.active) return s.summary ? 'Take complete' : 'Ready to start';
  const voice = s.mode === 'voice';
  if (voice) {
    if (s.connection === 'offline') return 'Disconnected — voice following has stopped';
    if (s.connection === 'reconnecting') return 'Reconnecting — position held';
    if (s.micState === 'disconnected') return 'Microphone disconnected — position held';
  }
  if (s.paused === 'hard') return voice ? 'Hard paused — microphone off' : 'Paused';
  if (s.paused === 'listening') return voice ? PAUSED_LISTENING_LABEL : PAUSED_MANUAL_LABEL;
  if (!s.prompting) return 'Ready to start';
  switch (s.snapshot?.state) {
    case 'following':
      return 'Following';
    // `ambiguous` deliberately reads the same as `holding`. The distinction —
    // "two places fit" versus "nothing fits" — is real, and it belongs in the
    // detail line where it can be acted on; as a status it would only tell the
    // presenter that the app has an internal state machine.
    case 'holding':
    case 'ambiguous':
      return 'Holding your place';
    case 'searching':
      return 'Looking for your place';
    default:
      return voice ? 'Listening' : 'Prompting';
  }
});
