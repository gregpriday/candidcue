/**
 * Stage window/display service (spec §46.6). Exact command names, camelCase
 * payloads, matching the Rust registrations in src-tauri/src/app.rs.
 *
 * High-level command actions never reach the stage: control translates them
 * into `StageDirective`s (contracts/stage.ts) and relays them through
 * `publish_stage_command` / `publish_listener_state`, which validate the
 * directive kind and stage generation in Rust.
 */
import type {
  StageDirective,
  StageSessionEnvelope,
  StageStatePayload,
  StageStatus,
  TrackingSnapshot,
} from '../../shared/contracts';
import { invokeOrMock } from './ipc';
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
 * C12: this used to be typed `| null`. Rust's `identify_displays` returns an
 * `IdentificationSession` or an error — never null — and the mock returns one
 * too, so the null branch was unreachable and every `?.` guarding it was
 * protecting against nothing.
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
 * Present (or un-present) the stage.
 *
 * `native` opts into OS fullscreen and defaults to false. The default is
 * BORDERLESS: a frameless window sized to the monitor's exact bounds and
 * pinned always-on-top. On macOS `setFullscreen(true)` allocates a new Space,
 * animates into it, and steals focus from the control window the operator is
 * driving — none of which a teleprompter wants (spec §52.7).
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

/** §29.2 step 3 — publish the full StageSessionEnvelope to the stage. */
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

export async function publishStageSnapshot(
  sessionId: string,
  snapshot: TrackingSnapshot,
): Promise<void> {
  return invokeOrMock<void>('publish_stage_snapshot', { sessionId, snapshot }, () => undefined);
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

/** Listener selection/geometry changes travel on their own event (§46.6). */
export async function publishListenerState(
  sessionId: string,
  stageGeneration: number,
  directive: Extract<StageDirective, { kind: 'listener' }>,
): Promise<void> {
  const state: StageStatePayload = { stageGeneration, directive };
  return invokeOrMock<void>('publish_listener_state', { sessionId, state }, () => undefined);
}

/**
 * C12: also used to be typed `| null`. Rust's `get_stage_status` returns a
 * `StageStatus` unconditionally — "no stage" is `exists: false`, not null — so
 * the browser-dev mock now answers the same way instead of returning null and
 * making every caller write a check that can never fire in Tauri.
 */
export async function getStageStatus(): Promise<StageStatus> {
  return invokeOrMock<StageStatus>('get_stage_status', undefined, () => mockStage.stageStatus());
}

/**
 * §29.2/§43.3: after publish_stage_document, wait for the stage handshake
 * (hydrated + layout ready + fonts) before going full screen. Listens for the
 * Rust-relayed `stage://ready` event and polls get_stage_status as a backstop.
 * Resolves immediately outside the Tauri runtime (browser dev).
 */
export async function waitForStageReady(
  stageGeneration: number,
  timeoutMs = 12000,
): Promise<void> {
  const { isTauriRuntime } = await import('./ipc');
  if (!isTauriRuntime()) return;
  const { listen } = await import('@tauri-apps/api/event');

  await new Promise<void>((resolve, reject) => {
    let done = false;
    let unlisten: (() => void) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      unlisten?.();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    timer = setTimeout(
      () => finish(new Error('The stage did not finish preparing in time.')),
      timeoutMs,
    );

    void listen<{ stageGeneration: number }>('stage://ready', (event) => {
      if (event.payload.stageGeneration === stageGeneration) finish();
    }).then((fn) => {
      unlisten = fn;
      if (done) fn();
    });

    poll = setInterval(() => {
      void getStageStatus().then((status) => {
        if (
          status.stageGeneration === stageGeneration &&
          status.hydrated &&
          status.layoutReady
        ) {
          finish();
        }
      });
    }, 400);
  });
}
