/**
 * Press Present, turn this window into the teleprompter.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A SCREEN
 * ---------------------------------------------------------------------------
 * There used to be a Preflight page between the editor and presentation: a
 * scrollable form with a display picker, a microphone picker, a speech-key
 * field, a tracking mode, an appearance panel, and a footer
 * that refused to start until five readiness rows agreed. Every one of those is
 * a choice a presenter makes once and then never thinks about again, so the
 * page was skipped without being read — which is the worst thing a gate can be,
 * because the moment it does block something the operator has no idea what it
 * is talking about.
 *
 * So the choices moved to Settings, where a thing you set once belongs, and
 * what is left is this: the ordered sequence that turns a script id into a
 * live, fullscreen take in the control webview. Present runs it and goes.
 *
 * There is deliberately no second stage window in this path. The same webview
 * owns microphone capture, transcript state and rendering, removing the
 * cross-webview transport from the critical presentation path.
 */
import { get } from 'svelte/store';
import { matchRememberedMicrophone } from '../services/audio';
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
import * as stageService from '../services/stage';
import {
  buildStageEnvelope,
  resolveDocumentAssets,
  stageSettingsFromSettings,
} from '../services/stage-envelope';
import type { DisplayDescriptor } from '../services/stage-types';
import type { AppSettings, PresentationMode } from '../services/settings-types';
import { editor, saveNow } from '../stores/editor';
import { navigate } from '../stores/router';
import {
  clearSession,
  startLiveSession,
  stopSession,
} from '../stores/session';
import { setPresentingPhase } from '../stores/presenting';
import { loadSettings, settings } from '../stores/settings';
import { showToast } from '../stores/toasts';
import { getVoiceFacade } from '../services/voice-facade';
import { writable } from 'svelte/store';

const startingStore = writable(false);

/**
 * True while a take is being opened. Present buttons read it so a second press
 * cannot start the same take twice — the sequence below is long enough to be
 * double-clicked through.
 */
export const takeStarting = { subscribe: startingStore.subscribe };

/**
 * The display the take's geometry is resolved against.
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
 * KNOWN GAP: a reader who drags their window to another display mid-take keeps
 * the first panel's scale, because nothing re-resolves. The complete fix is for
 * `set_control_presenting` to report the monitor the window actually landed on
 * (`windows::window_monitor_fingerprint` already computes exactly that for the
 * separate stage) and for the envelope to be rebuilt from it. That is a wire
 * change on the take-opening path and is filed rather than smuggled in here.
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
 * Compile the script this take will read (§29.2 step 1).
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
    throw new Error('CandidCue did not finish reading this script.');
  }
  return { ...output, script: output.script };
}

/** A compile that is known to have produced a document. */
type CompiledTake = CompileOutput & { script: NonNullable<CompileOutput['script']> };

/**
 * §28.1. The device id the remembered microphone has RIGHT NOW, or undefined
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
  if (s.audio.followSystemDefault || s.audio.preferredDeviceId === undefined) return undefined;
  try {
    const devices = await getVoiceFacade().listMicrophones();
    const match = matchRememberedMicrophone(devices, {
      deviceId: s.audio.preferredDeviceId,
      label: s.audio.preferredDeviceLabel,
    });
    if (match) return match.deviceId;
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
 * Open a take for a script and route to Live. Resolves true when the take is
 * running.
 *
 * Every failure path leaves nothing behind: no half-open stage window, no
 * unfinished session row, no microphone held by a session that does not exist.
 */
export async function startTake(scriptId: string): Promise<boolean> {
  if (get(startingStore)) return false;
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
     * §29.2 step 1: the take reads what is on disk, so flush the editor first —
     * and then check that the flush actually landed.
     *
     * `saveNow()` reports a conflict or a failed write through store state and
     * resolves normally either way, so awaiting it proves nothing on its own.
     * Presenting through an unsaved conflict means the stage shows the older
     * text while the editor shows the newer, and Rust's pre-session revision
     * snapshot (§21.4) records a revision that does not match the compile the
     * aligner was built from. The remedy is on the Editor screen, so say so and
     * stop rather than present something the operator did not write.
     */
    await saveNow().catch(() => {});
    const editorState = get(editor);
    if (editorState.scriptId === scriptId && editorState.saveState === 'conflict') {
      throw new Error(
        'This script changed outside CandidCue. Resolve that in the editor before presenting.',
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
    const s = await loadSettings(true).catch(() => get(settings));
    const compiled = await compileForTake(scriptId, doc.source, s.general.readHeadings);

    /*
     * C1: open the session record FIRST.
     *
     * `start_session` is the only path to `AppCoordinator::begin_session`,
     * which is the only writer of the Rust-side session generation. Skipping it
     * left the coordinator at generation 0 while control stamped every stage
     * payload with a hard-coded 1, so `validate_stage_payload_header` rejected
     * the whole stage stream and no session could start at all in a packaged
     * build. Rust assigns, control adopts.
     */
    const record = await startSessionRecord({
      scriptId,
      scriptSourceHash: compiled.script.sourceHash,
      mode: s.general.defaultSessionMode,
      startTokenIndex: 0,
      compileHash: compiled.script.sourceHash,
    });
    sessionId = record.id;

    // The renderer still needs the selected panel's calibrated geometry even
    // though it no longer opens a window there. Enumeration is read-only; the
    // user moves this window to that panel before pressing Present.
    const displays = await stageService.listDisplays().catch(() => []);
    const display = chooseStageDisplay(
      displays,
      s.stage.displayFingerprint,
      s.stage.presentationMode,
    );
    const stageSettings = stageSettingsFromSettings(s, display);
    const assets = await resolveDocumentAssets(compiled.script);
    const stageEnvelope = buildStageEnvelope({
      script: compiled.script,
      sessionId,
      sessionGeneration: record.sessionGeneration,
      stageGeneration: 0,
      stageSettings,
      assets,
      following: s.following,
    });
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
    const presentation = await enterPresentation(s.stage.presentationMode);
    await awaitViewportSettled(presentation);

    // There is no stage window. Alignment, transcription and rendering all
    // live in this one webview, so generation zero deliberately disables every
    // cross-window bridge in the session store.
    startLiveSession({
      scriptId,
      scriptTitle: doc.title,
      mode: s.general.defaultSessionMode,
      displayLabel: 'This window',
      outline: compiled.outline,
      sentences: compiled.sentences,
      totalTokens: Math.max(compiled.spokenWordCount, 1),
      sessionId,
      compiled: compiled.script,
      scriptRevision: doc.scriptRevision,
      sessionGeneration: record.sessionGeneration,
      stageGeneration: 0,
      transcriptRetained: record.transcriptRetained,
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
      presentationMode: s.stage.presentationMode,
      stageDisplay: display,
      transcription: {
        model: s.speech.transcriptionModel,
        language: s.speech.language,
      },
      following: s.following,
      // "Follow system default" means exactly that: no pinned device id, so the
      // pipeline opens (and keeps following) whatever the system input is.
      ...(micDeviceId === undefined ? {} : { micDeviceId }),
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
      // the billing meter running under whatever page is still showing.
      await abandonTake(sessionId);
      showToast('Could not open the Live screen, so the session was stopped.', 'danger');
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
     * script placed, which is the interval the previous fix already owns.
     */
    await painted();
    setPresentingPhase('on');
    return true;
  } catch (err) {
    await abandonTake(sessionId);
    showToast(`Could not start the session. ${describeError(err)}`, 'danger');
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
