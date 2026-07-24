export {};

/**
 * Test-only control surface the injected Tauri shim (tauri-shim.ts) hangs on
 * `window` so specs can inspect recorded IPC calls and force failure responses.
 */
declare global {
  interface Window {
    __E2E__: {
      calls: Array<{ command: string; args: unknown }>;
      fail: Record<string, unknown>;
      stageGeneration: number;
      setFail(command: string, error: unknown): void;
      lastCall(command: string): { command: string; args: unknown } | null;
      reset(): void;
    };
  }
}
