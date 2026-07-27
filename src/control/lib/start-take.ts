/**
 * Press Present, get a stage (spec §29.2, §43.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A SCREEN
 * ---------------------------------------------------------------------------
 * There used to be a Preflight page between the editor and the stage: a
 * scrollable form with a display picker, a microphone picker, a speech-key
 * field, a tracking mode, an appearance panel, a Listener panel, and a footer
 * that refused to start until five readiness rows agreed. Every one of those is
 * a choice a presenter makes once and then never thinks about again, so the
 * page was skipped without being read — which is the worst thing a gate can be,
 * because the moment it does block something the operator has no idea what it
 * is talking about.
 *
 * So the choices moved to Settings, where a thing you set once belongs, and
 * what is left is this: the ordered sequence that turns a script id into a live
 * take. Present runs it and goes.
 *
 * Nothing here refuses to start. A missing display, a busy microphone and a
 * speech connection that will not open are all reported from the take itself —
 * the stage's voice pill and the Live screen's status row — rather than
 * predicted beforehand by a check that has to guess. The only failures that
 * stop this function are the ones that mean there is no session to report
 * from at all, and each of them tears down whatever it had already built.
 */
import { get } from 'svelte/store';
import { matchRememberedMicrophone } from '../services/audio';
import { compileScript, type CompileOutput } from '../services/compiler';
import {
  buildDisplayProfile,
  listDisplayProfiles,
  profileForDisplay,
  saveDisplayProfile,
} from '../services/display-profiles';
import { describeError } from '../services/errors';
import { buildListenerSelection, listInstalledListeners } from '../services/listeners';
import * as scriptsService from '../services/scripts';
import { endSessionRecord, startSessionRecord } from '../services/session-records';
import * as stageService from '../services/stage';
import {
  buildStageEnvelope,
  buildStageSettings,
  resolveDocumentAssets,
} from '../services/stage-envelope';
import type { DisplayDescriptor } from '../services/stage-types';
import { activeOpticalProfile, type AppSettings } from '../services/settings-types';
import { editor, saveNow } from '../stores/editor';
import { navigate } from '../stores/router';
import {
  clearSession,
  reportStageWindowFault,
  startLiveSession,
  stopSession,
} from '../stores/session';
import { loadSettings, settings } from '../stores/settings';
import { showToast } from '../stores/toasts';
import { getVoiceFacade } from '../services/voice-facade';
import { writable } from 'svelte/store';
import type { ListenerStageSelection } from '../../shared/contracts';

const startingStore = writable(false);

/**
 * True while a take is being opened. Present buttons read it so a second press
 * cannot open a second stage on top of the first — the sequence below is long
 * enough (a compile, a window, a handshake) to be double-clicked through.
 */
export const takeStarting = { subscribe: startingStore.subscribe };

/**
 * The display the stage opens on.
 *
 * A pinned fingerprint wins while that panel is connected. Otherwise: any
 * display that is not the primary one, because on the rig this app is for the
 * primary display is the one with the operator's face pointed at the control
 * window, and putting the prompt window on top of it is not presenting. With
 * one display there is nothing to choose and it goes there.
 */
export function chooseStageDisplay(
  displays: DisplayDescriptor[],
  pinned: string | null,
): DisplayDescriptor | null {
  if (pinned !== null) {
    const match = displays.find((d) => d.fingerprint === pinned);
    if (match) return match;
  }
  return displays.find((d) => !d.primary) ?? displays[0] ?? null;
}

/**
 * The stage appearance a take runs with, straight out of Settings.
 *
 * The display is an argument rather than a lookup because it is what turns a
 * saved calibration into geometry: the rig is chosen by the panel's
 * fingerprint, and `resolveStageGeometry` sizes type against that panel's own
 * CSS-pixel viewport. Called without a display — a preview, a test — it falls
 * back to the uncalibrated percentage layout, which is the same thing an
 * uncalibrated rig gets and is labelled as a guess wherever it is shown.
 *
 * Font metrics are deliberately not supplied. Control cannot measure a font it
 * does not render; the DIN fallbacks resolve a defensible size and mark
 * themselves `metricsMeasured: false`, which the stage improves on once it has
 * painted its own text.
 */
export function stageSettingsFromSettings(
  s: AppSettings,
  display?: DisplayDescriptor | null,
): ReturnType<typeof buildStageSettings> {
  const t = s.teleprompter;
  const profile = activeOpticalProfile(s.optical, display?.fingerprint ?? null);
  return buildStageSettings({
    fontFamilyId: t.fontFamilyId,
    fontSizePx: t.fontSizePx,
    lineHeight: t.lineHeight,
    columnWidthPercent: t.columnWidthPercent,
    readingBandCenterPercent: t.readingBandCenterPercent,
    mirrorX: t.mirrorX,
    mirrorY: t.mirrorY,
    pastDimming: t.pastDimming,
    phraseHighlight: t.phraseHighlight,
    textIntensity: t.textIntensity,
    ...(profile && display
      ? {
          optical: {
            profile,
            viewport: {
              widthPx: display.logicalSize.width,
              heightPx: display.logicalSize.height,
            },
          },
        }
      : {}),
  });
}

/**
 * Record what this panel just ran with (§52).
 *
 * Write-only on purpose. Appearance is decided by Settings and by the rig in
 * `settings.optical`; a take that READ a row to decide it would reintroduce the
 * defect that made §52 dormant — the version that shipped for one afternoon
 * restored a profile only for an explicitly PINNED display, so the default
 * "Automatic" path wrote a row per take and read none, and moving from a pinned
 * panel to Automatic carried the pinned panel's type across and then saved it
 * over the other panel's row. The one read here resolves the row's ID and
 * nothing else: Rust's upsert is keyed on `id`, so without it every take would
 * insert a new row and the table would grow by one per Present forever.
 *
 * What makes the row worth writing now is `opticalProfile`, which rides inside
 * the `StageSettings` it saves. The calibration itself lives in the
 * localStorage overlay, and "Clear cache", a fresh profile directory or a
 * reinstalled webview all wipe that without warning; this row is what lets the
 * calibration screen hand a measured rig back afterwards instead of asking
 * somebody to re-measure a distance they already measured.
 *
 * Nothing here may fail a take. Failing to remember a preference is not a
 * reason not to present.
 */
async function rememberDisplayProfile(
  display: DisplayDescriptor,
  stageSettings: ReturnType<typeof buildStageSettings>,
  listener: ListenerStageSelection | null,
): Promise<void> {
  const existing = profileForDisplay(await listDisplayProfiles(), display.fingerprint);
  await saveDisplayProfile(
    buildDisplayProfile(
      display.name ?? 'Stage display',
      display.fingerprint,
      stageSettings,
      listener?.geometry,
      existing?.id,
    ),
  );
}

/**
 * Resolve the Listener for this take, or null.
 *
 * "Turn the Listener on automatically" plus a remembered pack is the whole
 * decision — there is no per-take Listener picker any more. A remembered pack
 * that is not installed is said out loud rather than skipped in silence: an
 * empty stage where a person was expected is exactly the surprise worth one
 * sentence.
 */
async function resolveListener(s: AppSettings): Promise<ListenerStageSelection | null> {
  const packId = s.listeners.defaultPackId;
  if (!s.listeners.autoplay || packId === null) return null;

  const installed = await listInstalledListeners().catch(() => []);
  const pack = installed.find((p) => p.packId === packId && p.state === 'installed');
  if (!pack) {
    showToast(
      `The ${packId} Listener is not installed, so the stage is running without it.`,
      'info',
    );
    return null;
  }

  const f = s.listenerFraming;
  return buildListenerSelection(packId, pack.version, {
    placement: f.placement,
    sizePercent: f.sizePercent,
    zoomPercent: f.zoomPercent,
    offsetXPercent: f.offsetXPercent,
    offsetYPercent: f.offsetYPercent,
    dimPercent: s.listeners.dimPercent,
    blurPx: s.listeners.blurPx,
    saturationPercent: Math.round(s.listeners.saturation * 100),
    mirrorVideo: f.mirrorVideo,
  });
}

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

    const displays = await stageService.listDisplays();
    const display = chooseStageDisplay(displays, s.stage.displayFingerprint);
    if (display === null) {
      throw new Error('No displays were detected. Connect the teleprompter display and try again.');
    }
    if (s.stage.displayFingerprint !== null && display.fingerprint !== s.stage.displayFingerprint) {
      // The chosen panel is unplugged. Presenting on another one beats not
      // presenting, but silently doing it is how "it opened on the wrong
      // screen" becomes unexplainable.
      showToast(
        `The display chosen in Settings is not connected, so the stage opened on ${display.name ?? 'another display'}.`,
        'info',
      );
    }

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

    const listener = await resolveListener(s);
    // The display is passed so the take can resolve this panel's optical rig;
    // the microphone is resolved here because a pinned device is remembered by
    // label and has to be looked up against what is actually connected now.
    const stageSettings = stageSettingsFromSettings(s, display);
    const micDeviceId = await resolvePinnedMicrophone(s);

    // 1. Open the stage hidden on the chosen display.
    const opened = await stageService.openStage({
      displayFingerprint: display.fingerprint,
      sessionId,
    });

    // 2. Publish the full session envelope and await the handshake.
    const assets = await resolveDocumentAssets(compiled.script);
    const envelope = buildStageEnvelope({
      script: compiled.script,
      sessionId,
      sessionGeneration: record.sessionGeneration,
      stageGeneration: opened.stageGeneration,
      stageSettings,
      ...(listener ? { listener } : {}),
      assets,
      following: s.following,
    });
    const ready = stageService.waitForStageReady(opened.stageGeneration);
    /*
     * The wait is armed before the publish, so every path out of the publish
     * owes it a handler — including the one where the publish itself throws.
     * Left bare, its timeout rejects into nothing minutes later.
     *
     * A refused envelope is an ack, not an error (§43.5), and nothing used to
     * read it: a refusal was indistinguishable from a slow stage, so the wait
     * ran its full 12 s and then blamed the timing. Rust only refuses for a
     * stale generation, which means a second stage window raced this one.
     */
    const ack = await stageService.publishStageDocument(sessionId, envelope).catch((err) => {
      void ready.catch(() => {});
      throw err;
    });
    if (!ack.accepted) {
      void ready.catch(() => {});
      throw new Error('The stage was replaced while the script was being sent to it.');
    }
    await ready;

    // 3. Show it.
    const shown = await stageService.setStageFullscreen(sessionId, s.stage.fullscreen);
    /*
     * §52.7. Rust verifies the monitor the stage landed on and emits
     * `STAGE_DISPLAY_MISMATCH` on `stage://error` — but it emits it HERE, one
     * step before `startLiveSession` installs the stage bridge, so control is
     * not listening yet and the event is lost. The same fact is in the value
     * this command returns, so the check is repeated on this side and raised
     * after the session exists to carry it.
     */
    const landedElsewhere =
      typeof shown.displayFingerprint === 'string' &&
      shown.displayFingerprint !== display.fingerprint;

    // 4. Bind the alignment session + realtime pipeline and go live.
    startLiveSession({
      scriptId,
      scriptTitle: doc.title,
      mode: s.general.defaultSessionMode,
      displayLabel: display.name ?? 'Stage display',
      outline: compiled.outline,
      sentences: compiled.sentences,
      totalTokens: Math.max(compiled.spokenWordCount, 1),
      sessionId,
      compiled: compiled.script,
      scriptRevision: doc.scriptRevision,
      sessionGeneration: record.sessionGeneration,
      stageGeneration: opened.stageGeneration,
      transcriptRetained: record.transcriptRetained,
      stageSettings,
      listener,
      transcription: {
        model: s.inworld.transcriptionModel,
        language: s.inworld.language,
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
    // Detached, and after the take is live: this is bookkeeping about a panel,
    // not a step the presenter is waiting on.
    void rememberDisplayProfile(display, stageSettings, listener).catch(() => {});

    if (landedElsewhere) {
      reportStageWindowFault({
        code: 'STAGE_DISPLAY_MISMATCH',
        message: 'The stage opened on a different display than the one selected.',
        requestedFingerprint: display.fingerprint,
        actualFingerprint: shown.displayFingerprint ?? null,
      });
    }

    const arrived = await navigate({ name: 'live', sessionId, scriptId });
    if (!arrived) {
      // A guard vetoed the move. The session is already live behind this
      // screen — tear it down rather than leave the microphone, the worker and
      // the billing meter running under whatever page is still showing.
      await abandonTake(sessionId);
      showToast('Could not open the Live screen, so the session was stopped.', 'danger');
      return false;
    }
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
 * Undo a partially-started take. `closeStage` alone left the tracking worker,
 * the realtime transport, the microphone capture, the billing meter, the
 * elapsed clock and the heartbeat all running.
 */
async function abandonTake(sessionId: string): Promise<void> {
  stopSession();
  clearSession();
  // The record may have been opened before the failure. Closing it twice is
  // harmless (it rewrites `ended_at`); leaving it open is not — an unfinished
  // row is indistinguishable from a crash and would be closed at next launch.
  if (sessionId) await endSessionRecord(sessionId).catch(() => {});
  if (sessionId) await stageService.closeStage(sessionId).catch(() => {});
}
