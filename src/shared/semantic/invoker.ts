/**
 * Adapter from the injected IPC `invoke` to {@link SemanticInvoker}
 * (companion §50.4: network calls live only in Rust).
 *
 * The invoke function is a parameter, not an import, so the scheduler and its
 * tests never depend on a Tauri runtime.
 */
import type { SemanticInvoker } from './scheduler';
import type {
  SemanticAssistResult,
  SemanticClassificationRequest,
  SemanticLandmarkPreparationResult,
  SemanticLandmarkRetrievalResult,
  SemanticOperationResponse,
  SemanticPreparationRequest,
  SemanticRetrievalRequest,
} from './types';

export type IpcInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Rust command names (companion §50.2). Arguments are camelCase. */
export const SEMANTIC_COMMANDS = {
  classify: 'classify_semantic_tracking_window',
  retrieve: 'retrieve_semantic_landmarks',
  prepare: 'prepare_semantic_landmarks',
  cancel: 'cancel_semantic_request',
} as const;

export function createSemanticInvoker(invoke: IpcInvoke): SemanticInvoker {
  return {
    classify(request: SemanticClassificationRequest) {
      return invoke<SemanticOperationResponse<SemanticAssistResult>>(SEMANTIC_COMMANDS.classify, {
        request,
      });
    },
    retrieve(request: SemanticRetrievalRequest) {
      return invoke<SemanticOperationResponse<SemanticLandmarkRetrievalResult>>(
        SEMANTIC_COMMANDS.retrieve,
        { request },
      );
    },
    cancel(requestId: string) {
      // Best-effort (§36.5): correctness never depends on this succeeding.
      void invoke<boolean>(SEMANTIC_COMMANDS.cancel, { requestId }).catch(() => undefined);
    },
  };
}

/** One-shot preparation call; not part of the live scheduling lanes. */
export function prepareSemanticLandmarks(
  invoke: IpcInvoke,
  request: SemanticPreparationRequest,
): Promise<SemanticOperationResponse<SemanticLandmarkPreparationResult>> {
  return invoke<SemanticOperationResponse<SemanticLandmarkPreparationResult>>(
    SEMANTIC_COMMANDS.prepare,
    { request },
  );
}
