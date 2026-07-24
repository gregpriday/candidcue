/**
 * §20.3/§23. The production {@link CoachObserverTransport}: the coach observer's
 * single budgeted path to the API.
 *
 * It invokes one Rust command, `classify_coaching_window`, which reuses the
 * semantic sidecar's structured-output and cost machinery rather than opening a
 * second, unmetered path to OpenAI. The observer above it owns coalescing, the
 * rate limit, the per-take ceiling, and — through the injected
 * `isBudgetExhausted` gate — the session's shared semantic budget.
 *
 * §23.2: every failure here is silent. A rejected invoke (no key, model
 * unavailable, network, malformed output) surfaces as a rejected promise, which
 * the observer treats as "no tip, back off" and which never touches the local
 * pace / microphone / strict-filler lanes because they do not pass through here.
 */
import type { LunaCoachRequest } from '../../shared/contracts/coaching';
import type {
  CoachObserverResponse,
  CoachObserverTransport,
} from '../../shared/coaching/coach/luna-observer';
import type { LunaUsage } from '../../shared/semantic';
import { ipcInvoke } from './ipc';

/** The `SemanticOperationResponse<Value>` shape the Rust command returns. */
interface CoachingOperationResponse {
  result: unknown;
  usage: LunaUsage;
  latencyMs: number;
}

export type CoachingInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Build the transport. `invoke` is injected so the wiring is observable in a
 * node test without a Tauri runtime; production passes the real `ipcInvoke`.
 */
export function createCoachingObserverTransport(
  invoke: CoachingInvoke = ipcInvoke,
): CoachObserverTransport {
  return {
    async classify(request: LunaCoachRequest): Promise<CoachObserverResponse> {
      const requestId = `${request.sessionId}:${request.takePassId}:${request.requestAudioTimeMs}`;
      const response = await invoke<CoachingOperationResponse>('classify_coaching_window', {
        request: {
          requestId,
          // The bounded `LunaCoachRequest` is forwarded verbatim as the payload;
          // the observer already truncated every field per §20.4.
          payload: request,
          // §22 validity window drives the model's own `valid_for_ms`, but the
          // request options are the semantic ones; defaults are fine here.
        },
      });
      return {
        result: response.result,
        ...(response.usage ? { usage: response.usage } : {}),
        ...(typeof response.latencyMs === 'number' ? { latencyMs: response.latencyMs } : {}),
      };
    },
    cancel(requestId: string): void {
      // Best-effort (§23.2): correctness never depends on this succeeding, and a
      // coaching request is cheap enough that cancellation is a courtesy.
      void invoke<boolean>('cancel_semantic_request', { requestId }).catch(() => undefined);
    },
  };
}
