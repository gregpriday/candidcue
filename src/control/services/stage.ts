/**
 * Stage window/display service. Exact command names, camelCase
 * payloads, matching the Rust registrations in src-tauri/src/app.rs.
 *
 * High-level command actions never reach the stage: control translates them
 * into `StageDirective`s (contracts/stage.ts) and relays them through
 * `publish_stage_command`, which validates the
 * directive kind and stage generation in Rust.
 */
import type {
  StageDirective,
  StageSessionEnvelope,
  StageStatePayload,
  StageStatus,
  } from '../../shared/contracts';
import { CONTROL_EVENT } from '../../shared/contracts/stage';
import { invokeOrMock, isTauriRuntime } from './ipc';
import { mockStage } from './mock-backend';
import type {
  DisplayDescriptor,
  IdentificationSession,
  StageAck,
  StageOpenRequest,
  StageOpenResult,
  StageWindowState,
} from './stage-types';

export async function listDisplays(): Promise<DisplayDescriptor[]> {
  return invokeOrMock<DisplayDescriptor[]>('list_displays', undefined, () =>
    mockStage.listDisplays(),
  );
}

/**
 * The panel the CONTROL window is on right now, or null when it cannot be
 * named — from any window, Settings included, because Rust looks the
 * control window up by label rather than asking whoever called.
 *
 * It is where a prompter take opens when nothing pinned is connected
 * (`resolvePrompterDisplay` in `lib/take-destination.ts` has the whole rule).
 * Null is a real answer — the caller must say it does not know rather than
 * substituting another display, which is the confusion this exists to remove.
 */
export async function currentWindowDisplay(): Promise<DisplayDescriptor | null> {
  return invokeOrMock<DisplayDescriptor | null>('current_window_display', undefined, () =>
    mockStage.currentWindowDisplay(),
  );
}

/**
 * Never null: Rust's `identify_displays` returns an `IdentificationSession` or
 * an error, and the mock returns one too.
 */
export async function identifyDisplays(): Promise<IdentificationSession> {
  return invokeOrMock<IdentificationSession>('identify_displays', undefined, () =>
    mockStage.identifyDisplays(),
  );
}

export async function openStage(request: StageOpenRequest): Promise<StageOpenResult> {
  return invokeOrMock<StageOpenResult>('open_stage', { request }, () =>
    mockStage.openStage(request.displayFingerprint ?? undefined),
  );
}

export async function closeStage(sessionId: string): Promise<void> {
  return invokeOrMock<void>('close_stage', { sessionId }, () => undefined);
}

/**
 * Present (or un-present) the separate stage window.
 *
 * `native` opts into OS fullscreen and defaults to false. The default is
 * BORDERLESS: a frameless window sized to the monitor's exact bounds and
 * pinned always-on-top. On macOS `setFullscreen(true)` allocates a new Space,
 * animates into it, and steals focus from the control window the operator is
 * driving — none of which a teleprompter wants.
 */
export async function setStageFullscreen(
  sessionId: string,
  enabled: boolean,
  native = false,
): Promise<StageWindowState> {
  return invokeOrMock<StageWindowState>(
    'set_stage_fullscreen',
    { sessionId, enabled, native },
    () => mockStage.setFullscreen(enabled),
  );
}

/** Publish the full StageSessionEnvelope to the separate stage window. */
export async function publishStageDocument(
  sessionId: string,
  envelope: StageSessionEnvelope,
): Promise<StageAck> {
  return invokeOrMock<StageAck>(
    'publish_stage_document',
    { sessionId, documentEnvelope: envelope },
    () => ({ accepted: true, stageGeneration: envelope.stageGeneration, sessionId }),
  );
}


/** Relay one imperative directive to the stage (stale generations dropped). */
export async function publishStageDirective(
  sessionId: string,
  stageGeneration: number,
  directive: StageDirective,
): Promise<void> {
  const action: StageStatePayload = { stageGeneration, directive };
  return invokeOrMock<void>('publish_stage_command', { sessionId, action }, () => undefined);
}

/**
 * Never null: Rust's `get_stage_status` returns a `StageStatus`
 * unconditionally — "no stage" is `exists: false` — and the browser-dev mock
 * answers the same way.
 */
export async function getStageStatus(): Promise<StageStatus> {
  return invokeOrMock<StageStatus>('get_stage_status', undefined, () => mockStage.stageStatus());
}

/**
 * Which step of the handshake a stalled stage got stuck on.
 *
 * The timeout used to say only "the stage did not finish preparing in time",
 * which names no step and suggests nothing to try. The coordinator already
 * knows how far the handshake got — whether the window is even open, whether
 * the envelope was ever received, whether the layout ever settled — and those
 * are three unrelated failures with three different causes. Pure, so the
 * wording is testable without a stage.
 */
export function stageStalledMessage(
  status: StageStatus | null,
  expectedGeneration: number,
): string {
  if (!status || !status.exists) {
    return 'The stage window closed before it was ready.';
  }
  if (status.stageGeneration !== expectedGeneration) {
    return 'Another stage window replaced this one while it was preparing.';
  }
  if (!status.listening) {
    return 'The stage window opened but never finished loading.';
  }
  if (!status.hydrated) {
    return 'The stage window opened but never received the script.';
  }
  if (!status.layoutReady) {
    return 'The stage received the script but never finished laying it out.';
  }
  return 'The stage did not finish preparing in time.';
}

/**
 * How long the stage webview gets to load its bundle and start listening.
 *
 * Deliberately much longer than the handshake budget below, because the two
 * measure different things. Booting the webview is I/O the app does not
 * control — and under `tauri dev` it means Vite compiling the stage's whole
 * module graph on demand, which on a cold start is comfortably more than ten
 * seconds. Spending the handshake budget on that produced a start failure on a
 * perfectly healthy machine.
 */
const STAGE_BOOT_TIMEOUT_MS = 30000;

/**
 * How long the handshake itself gets, measured from the moment the stage says
 * it is listening. This part is CPU the app does own: receive the envelope,
 * settle the fonts, measure the layout.
 */
const STAGE_HANDSHAKE_TIMEOUT_MS = 12000;

/**
 * After publish_stage_document, wait for the separate stage window's handshake
 * (hydrated + layout ready + fonts) before going full screen. Its caller is
 * `stage-preview-session.ts`; a take's stage is embedded in the control window
 * and does not wait on this. Listens for the
 * Rust-relayed `stage://ready` event and polls get_stage_status as a backstop.
 * Resolves immediately outside the Tauri runtime (browser dev).
 *
 * The deadline is in two parts (see the constants above): the clock restarts
 * once the stage proves it is alive, so a slow boot cannot eat the budget the
 * layout needs, and a stage that never loads at all still fails in bounded
 * time with a message that says so.
 */
export async function waitForStageReady(
  stageGeneration: number,
  timeoutMs = STAGE_HANDSHAKE_TIMEOUT_MS,
  bootTimeoutMs = STAGE_BOOT_TIMEOUT_MS,
): Promise<void> {
  const { isTauriRuntime } = await import('./ipc');
  if (!isTauriRuntime()) return;
  const { listen } = await import('@tauri-apps/api/event');

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let unlisten: (() => void) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The last status the poll saw, so the timeout can say what stalled. */
    let lastStatus: StageStatus | null = null;
    /** The boot budget is spent once; a flapping flag must not extend it. */
    let booted = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      unlisten?.();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const deadline = (ms: number) => {
      // A status request in flight when the wait ends resolves after it, and
      // arming a fresh timer there would leave a live timeout holding this
      // closure for its full duration after everyone stopped caring.
      if (done) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => finish(new Error(stageStalledMessage(lastStatus, stageGeneration))),
        ms,
      );
    };

    deadline(bootTimeoutMs);

    void listen<{ stageGeneration: number }>('stage://ready', (event) => {
      if (event.payload.stageGeneration === stageGeneration) finish();
    })
      .then((fn) => {
        unlisten = fn;
        if (done) fn();
      })
      .catch(() => {
        // Registration failed, so the fast path is gone — but the poll below
        // is a complete backstop on its own, and it is the one the browser
        // shim relies on. Losing the listener must not become an unhandled
        // rejection on top of a wait that can still succeed.
      });

    poll = setInterval(() => {
      void getStageStatus()
        .then((status) => {
          if (done) return;
          lastStatus = status;
          if (status.stageGeneration !== stageGeneration) return;
          // The stage is alive: hand the rest of the wait to the handshake
          // budget, which is what the remaining steps are actually bounded by.
          if (status.listening && !booted) {
            booted = true;
            deadline(timeoutMs);
          }
          if (status.hydrated && status.layoutReady) finish();
        })
        .catch(() => {
          /*
           * The backstop must not become the failure. A rejected status read
           * (the command is unavailable for an instant during teardown, say)
           * is not evidence about the handshake, so it is dropped rather than
           * left to surface as an unhandled rejection — and `lastStatus`
           * deliberately keeps whatever the last successful read said, because
           * that is the honest answer to "how far did it get".
           */
        });
    }, 400);
  });
}

/**
 * Notice a monitor being plugged, unplugged or rearranged.
 *
 * Rust polls the display topology every two seconds and emits
 * `app://device-or-display-change` when it moves. This is what keeps a display
 * list on screen from going stale the moment somebody unplugs a monitor.
 *
 * The payload is deliberately ignored. It says the topology CHANGED; what it
 * changed to is `list_displays`, which is the one answer that cannot be stale
 * by the time it is read.
 */
export function onDisplayTopologyChange(handler: () => void): () => void {
  if (!isTauriRuntime()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const stop = await listen(CONTROL_EVENT.deviceOrDisplayChange, () => handler());
    if (cancelled) stop();
    else unlisten = stop;
  })().catch(() => {
    // A missing listener means the list refreshes only when a section is
    // opened. Not worth escalating.
  });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/**
 * Re-read display facts when they may have changed, at most once per burst.
 * Returns a teardown.
 *
 * Coalesced, because a drag emits one native `Moved` per frame: Rust forwards
 * the control window's moves onto the display-change event — that is what
 * makes dragging between two already-connected monitors visible at all — so a
 * drag arrives as a burst, and each event would otherwise start its own IPC
 * reads. 150 ms is below noticing and well above a frame.
 *
 * `focus` adds window focus as a second trigger, for a screen whose answer is
 * worth re-checking the moment somebody comes back to press Present. It is off
 * by default because the move event already covers a drag, and a screen that
 * re-asks on every focus re-asks a great deal.
 */
export function watchDisplayChanges(
  handler: () => void,
  options: { focus?: boolean } = {},
): () => void {
  let coalesce: ReturnType<typeof setTimeout> | null = null;
  const soon = (): void => {
    if (coalesce !== null) clearTimeout(coalesce);
    coalesce = setTimeout(() => {
      coalesce = null;
      handler();
    }, 150);
  };

  const stopTopology = onDisplayTopologyChange(soon);
  const focus = options.focus === true && typeof window !== 'undefined';
  if (focus) window.addEventListener('focus', soon);

  return () => {
    if (coalesce !== null) clearTimeout(coalesce);
    coalesce = null;
    stopTopology();
    if (focus) window.removeEventListener('focus', soon);
  };
}
