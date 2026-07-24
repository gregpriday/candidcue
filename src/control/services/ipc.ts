/**
 * Single narrow doorway to the Tauri IPC boundary.
 *
 * Every control-window service funnels its `invoke` calls through here so:
 *  - tests can inject a recording/faking invoke without touching Tauri;
 *  - screens keep working in a plain browser (`pnpm dev` without Tauri) by
 *    falling back to the clearly-marked mock backend;
 *  - command names stay auditable in one grep (`ipcInvoke(`).
 *
 * Command names are the EXACT snake_case names from spec §46; payload keys
 * are camelCase (Tauri's default argument casing).
 */

export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invokeOverride: InvokeFn | null = null;

/** Inject a fake invoke in unit tests. Pass `null` to restore the default. */
export function setInvokeForTesting(fn: InvokeFn | null): void {
  invokeOverride = fn;
}

/** True when running inside a Tauri webview. */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Raised when no backend is reachable (browser dev, missing command). */
export class BackendUnavailableError extends Error {
  constructor(readonly command: string, detail?: string) {
    super(`Backend unavailable for command "${command}"${detail ? `: ${detail}` : ''}`);
    this.name = 'BackendUnavailableError';
  }
}

export async function ipcInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (invokeOverride) return invokeOverride<T>(command, args);
  if (!isTauriRuntime()) throw new BackendUnavailableError(command, 'not a Tauri runtime');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * Invoke a backend command, falling back to the typed mock backend ONLY when
 * the Tauri runtime itself is absent (plain-browser dev). Every command in
 * spec §46 is registered in src-tauri/src/app.rs, so inside Tauri all errors
 * — including NOT_IMPLEMENTED stubs — propagate as real AppError payloads.
 */
export async function invokeOrMock<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  mock: () => T | Promise<T>,
): Promise<T> {
  try {
    return await ipcInvoke<T>(command, args);
  } catch (err) {
    if (err instanceof BackendUnavailableError) return mock();
    throw err;
  }
}
