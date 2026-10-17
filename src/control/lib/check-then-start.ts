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
import type { PresentationMode } from '../services/settings-types';
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

/** Mounted by the shell, so the sheet is there whichever route launched. */
export const takeReadinessPrompt: Readable<TakeReadinessPrompt | null> = {
  subscribe: prompt.subscribe,
};

/**
 * Resolve the verdict for launching `scriptId`.
 *
 * Async because the device list is the only fact here that has to be fetched,
 * and it must be fetched the SAME way the take path fetches it — through
 * `matchRememberedMicrophone`, which matches on id and falls back to the
 * remembered label, because WKWebView salts device ids per origin and a
 * replug can change them. Comparing raw ids here would report a perfectly
 * present microphone as missing on some restarts.
 */
export async function resolveTakeReadiness(
  scriptId: string,
  intent: LaunchIntent = {},
): Promise<ReadinessVerdict> {
  const s = get(settings);
  const audio = s.audio;
  const pinned = audio.followSystemDefault ? undefined : audio.preferredDeviceId;

  let pinnedMicLabel: string | null = null;
  let pinnedMicAvailable = true;
  if (pinned !== undefined) {
    pinnedMicLabel = audio.preferredDeviceLabel ?? pinned;
    try {
      const devices = await getVoiceFacade().listMicrophones();
      pinnedMicAvailable =
        matchRememberedMicrophone(devices, {
          deviceId: pinned,
          ...(audio.preferredDeviceLabel === undefined
            ? {}
            : { label: audio.preferredDeviceLabel }),
        }) !== null;
    } catch {
      // Enumeration failed, so absence is not proven. `start-take.ts` honours
      // the pin in exactly this case; accusing the hardware would be worse.
      pinnedMicAvailable = true;
    }
  }

  /*
   * Read AFTER the await: the answer is live, and an install that finished
   * while the device list was being fetched is an install that finished.
   */
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
    pinnedMicLabel,
    pinnedMicAvailable,
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
  const verdict = await resolveTakeReadiness(scriptId, intent);
  if (!verdict.show) {
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

/** Close the sheet without launching anything. */
export function dismissTakeReadiness(): void {
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
  prompt.set(null);
  if (held === null || held.verdict.blocked) return;
  await held.start();
}
