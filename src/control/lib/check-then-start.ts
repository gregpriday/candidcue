/**
 * Every way of starting a take, through one readiness check (CCUX-013, #301).
 *
 * The check used to live in the editor, and only the editor's own Present
 * button and split menu went through it. File › Present (⌘↩, which the menu
 * claims before the editor's shortcut can see it), Present As, Practise,
 * Session › Start Take, the Library and the summary's Present again all called
 * `startTake` directly — so whether somebody was told their take could not
 * follow their voice depended on which control they happened to reach for.
 *
 * Now each of them comes here. A healthy setup still launches at once, with no
 * sheet (`resolveReadiness` is the rule); anything else is held, and the sheet
 * the shell mounts against `takeReadinessPrompt` offers Start anyway exactly as
 * the editor's always did. Nothing here is a gate: `startTake` is unchanged and
 * remains the executor.
 */
import { get, writable, type Readable } from 'svelte/store';
import { resolveReadiness, type ReadinessVerdict } from './take-readiness';
import { startTake, type StartTakeOptions } from './start-take';
import { isCompileSettledForScript } from './editor-readiness';
import { matchRememberedMicrophone } from '../services/audio/devices';
import { getVoiceFacade } from '../services/voice-facade';
import type { AppSettings, PresentationMode } from '../services/settings-types';
import type { AudioDeviceInfo } from '../../shared/contracts';
import { compiled } from '../stores/compiled';
import { takeDestination } from '../stores/destination';
import { editor } from '../stores/editor';
import { route } from '../stores/router';
import { settings } from '../stores/settings';
import { speechModelReadiness } from '../stores/speech-model-readiness';

/** What is being launched, as far as readiness cares. */
export interface LaunchIntent {
  /** The shape explicitly chosen, when one was. */
  mode?: PresentationMode;
  /** A rehearsal, which always opens in its own window. */
  practice?: boolean;
  /** Somebody asked to see the sheet ("Review take setup…"). */
  requested?: boolean;
}

/** The sheet, held open over a launch that has not happened yet. */
export interface TakeReadinessPrompt {
  verdict: ReadinessVerdict;
  /**
   * Resume exactly the launch that was asked for — its mode, start point and
   * part — rather than a default one.
   */
  start: () => Promise<unknown>;
}

const prompt = writable<TakeReadinessPrompt | null>(null);

/*
 * Which check is current. A check awaits the device list, so two can be in
 * flight — Present pressed twice, or File › Present while the sheet is up —
 * and one can finish after the sheet it would have filled was dismissed. Only
 * the newest may launch or hold a prompt; a dismissal retires every check
 * before it.
 */
let generation = 0;

/** Mounted by the shell, so the sheet is there whichever route launched. */
export const takeReadinessPrompt: Readable<TakeReadinessPrompt | null> = {
  subscribe: prompt.subscribe,
};

/**
 * The microphone Settings pins, or undefined for "follow the system default".
 *
 * Older builds auto-pinned the browser's own `default` pseudo-device, which is
 * the system-default choice spelled a second way — Settings reads it so, and
 * so must this, or every take on such a profile is warned about a microphone
 * nobody chose.
 */
function pinnedDeviceId(audio: AppSettings['audio']): string | undefined {
  if (audio.followSystemDefault) return undefined;
  const id = audio.preferredDeviceId;
  return id === undefined || id === '' || id === 'default' ? undefined : id;
}

/**
 * The pinned microphone, and whether it is connected right now.
 *
 * Fetched the SAME way the take path fetches it — through
 * `matchRememberedMicrophone`, which matches on id and falls back to the
 * remembered label, because WKWebView salts device ids per origin and a
 * replug can change them. Comparing raw ids here would report a perfectly
 * present microphone as missing on some restarts.
 *
 * The list is fetched for the pin as it was when the check began, but judged
 * against the pin as it is when the list arrives: Settings is another window,
 * and a pin changed in between is the one the take will open.
 */
async function pinnedMicrophone(): Promise<{ label: string | null; available: boolean }> {
  let devices: AudioDeviceInfo[] | null = null;
  if (pinnedDeviceId(get(settings).audio) !== undefined) {
    try {
      devices = await getVoiceFacade().listMicrophones();
    } catch {
      // Enumeration failed, so absence is not proven. `start-take.ts` honours
      // the pin in exactly this case; accusing the hardware would be worse.
      devices = null;
    }
  }

  const audio = get(settings).audio;
  const pinned = pinnedDeviceId(audio);
  if (pinned === undefined) return { label: null, available: true };
  const label = audio.preferredDeviceLabel ?? pinned;
  // No list — it failed, or the pin is newer than it. Not proven absent.
  if (devices === null) return { label, available: true };
  // `undefined`, not null, is the matcher's "not connected". Comparing with
  // null was always true, so a missing microphone was never reported.
  const match = matchRememberedMicrophone(devices, {
    deviceId: pinned,
    ...(audio.preferredDeviceLabel === undefined ? {} : { label: audio.preferredDeviceLabel }),
  });
  return { label, available: match !== undefined };
}

/**
 * Resolve the verdict for launching `scriptId`.
 *
 * Async because the device list is the only fact here that has to be fetched.
 */
export async function resolveTakeReadiness(
  scriptId: string,
  intent: LaunchIntent = {},
): Promise<ReadinessVerdict> {
  const mic = await pinnedMicrophone();

  /*
   * Everything else is read AFTER the await. The model's answer is live, and
   * an install that finished while the device list was being fetched is an
   * install that finished; so is a switch to a voice take made in Settings in
   * the same moment, which `startTake` will read when it loads the document.
   */
  const s = get(settings);
  const model = get(speechModelReadiness);

  /*
   * SCRIPT FACTS ONLY WHEN THE COMPILE HAS SETTLED, AND ONLY FOR THIS SCRIPT.
   *
   * They come off the EDITOR's compile, which is debounced against typing.
   * Mid-compile there is no result, so both read zero — and a zero word count
   * is a BLOCKING finding. Reading them unconditionally would refuse to present
   * a perfectly good script for as long as somebody had recently typed in it.
   * And a launch from the Library names a script the editor may not hold at
   * all, whose compile this is not.
   *
   * Optimistic when unknown, and safe to be: `startTake` compiles again from
   * the saved source and throws on a blocking diagnostic itself, so skipping
   * these costs only the chance to say so a moment earlier.
   */
  const compile = get(compiled);
  const scriptFactsKnown = isCompileSettledForScript(scriptId, get(editor), compile);
  const result = compile.result;

  /*
   * The mismatch belongs to the mode being LAUNCHED, not the saved default.
   *
   * `takeDestination` is resolved for the default, and a reading window
   * deliberately never mismatches — it is placed by dragging it. So choosing
   * "Present in a window" from a prompter default would otherwise warn about a
   * rig the take is not going to use. A practice always opens in a window.
   *
   * And only while the editor for this script is the screen: that is the only
   * place the destination is watched (`watchTakeDestination`), and the store
   * keeps its last answer after the watcher stops. Read from the Library it
   * could describe a display that has since been unplugged or fixed.
   */
  const launchMode = intent.practice ? 'reader' : (intent.mode ?? s.stage.presentationMode);
  const here = get(route);
  const destinationWatched = here.name === 'editor' && here.scriptId === scriptId;

  return resolveReadiness({
    voiceTake: s.general.defaultSessionMode === 'voice',
    modelInstalled: model.installed,
    modelSupported: model.supported,
    modelDamaged: model.damaged,
    modelInstalling: model.installing,
    pinnedMicLabel: mic.label,
    pinnedMicAvailable: mic.available,
    spokenWordCount: scriptFactsKnown ? (result?.spokenWordCount ?? 0) : 1,
    blockingDiagnostics: scriptFactsKnown
      ? (result?.diagnostics ?? []).filter((d) => d.blocking).length
      : 0,
    destinationMismatch:
      launchMode === 'reader' || !destinationWatched
        ? null
        : (get(takeDestination)?.mismatch ?? null),
    requested: intent.requested ?? false,
  });
}

/**
 * Launch, unless there is something the presenter has to know first.
 *
 * The immediate-launch rule is load-bearing: on a healthy familiar setup this
 * is exactly the old behaviour, one click, no sheet. Anything else and the
 * launch is held rather than cancelled — `start` keeps the whole request so
 * Start anyway resumes precisely the take that was asked for.
 */
export async function checkThenStart(
  scriptId: string,
  intent: LaunchIntent,
  launch: () => Promise<unknown>,
): Promise<void> {
  const mine = ++generation;
  const verdict = await resolveTakeReadiness(scriptId, intent);
  if (mine !== generation) return;
  if (!verdict.show) {
    // A sheet held over an earlier attempt is answered by this one. Left up,
    // it would sit over the take with that attempt's launch still behind it.
    prompt.set(null);
    await launch();
    return;
  }
  prompt.set({ verdict, start: launch });
}

/** `startTake`, through the check. What every launcher outside the editor calls. */
export function checkThenStartTake(
  scriptId: string,
  options: StartTakeOptions = {},
): Promise<void> {
  return checkThenStart(
    scriptId,
    {
      ...(options.presentationMode === undefined ? {} : { mode: options.presentationMode }),
      ...(options.practice ? { practice: true } : {}),
    },
    () => startTake(scriptId, options),
  );
}

/**
 * Close the sheet without launching anything, and retire any check still in
 * flight — one finishing afterwards must not put the sheet back.
 */
export function dismissTakeReadiness(): void {
  generation += 1;
  prompt.set(null);
}

/**
 * Start anyway.
 *
 * Refused for a blocked verdict, which the sheet offers no button for anyway —
 * there is genuinely nothing to start.
 */
export async function startAnyway(): Promise<void> {
  const held = get(prompt);
  dismissTakeReadiness();
  if (held === null || held.verdict.blocked) return;
  await held.start();
}
