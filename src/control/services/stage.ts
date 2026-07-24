/**
 * Stage window/display service (spec §46.6). Exact command names, camelCase
 * payloads; mock-backed until the Rust window commands land.
 */
import type { StageStatus, TrackingSnapshot } from '../../shared/contracts';
import { invokeOrMock } from './ipc';
import { mockStage } from './mock-backend';
import type {
  DisplayDescriptor,
  StageOpenRequest,
  StageOpenResult,
  StageWindowState,
} from './stage-types';

export async function listDisplays(): Promise<DisplayDescriptor[]> {
  return invokeOrMock<DisplayDescriptor[]>('list_displays', undefined, () =>
    mockStage.listDisplays(),
  );
}

export async function identifyDisplays(): Promise<void> {
  return invokeOrMock<void>('identify_displays', undefined, () => undefined);
}

export async function openStage(request: StageOpenRequest): Promise<StageOpenResult> {
  return invokeOrMock<StageOpenResult>('open_stage', { request }, () =>
    mockStage.openStage(request.displayId),
  );
}

export async function closeStage(sessionId: string): Promise<void> {
  return invokeOrMock<void>('close_stage', { sessionId }, () => undefined);
}

export async function setStageFullscreen(
  sessionId: string,
  enabled: boolean,
): Promise<StageWindowState> {
  return invokeOrMock<StageWindowState>('set_stage_fullscreen', { sessionId, enabled }, () =>
    mockStage.setFullscreen(enabled),
  );
}

export async function publishStageSnapshot(
  sessionId: string,
  snapshot: TrackingSnapshot,
): Promise<void> {
  return invokeOrMock<void>('publish_stage_snapshot', { sessionId, snapshot }, () => undefined);
}

export async function publishStageCommand(
  sessionId: string,
  action: Record<string, unknown>,
): Promise<void> {
  return invokeOrMock<void>('publish_stage_command', { sessionId, action }, () => undefined);
}

export async function getStageStatus(sessionId: string): Promise<StageStatus | null> {
  return invokeOrMock<StageStatus | null>('get_stage_status', { sessionId }, () => null);
}
