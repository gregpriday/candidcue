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
      sessionGeneration: number;
      /** The last row `start_session` minted — Rust assigns, control adopts. */
      lastSession: { id: string; sessionGeneration: number } | null;
      stage: { exists: boolean; visible: boolean; fullscreen: boolean; nativeFullscreen: boolean };
      /** StageDirectives relayed through publish_stage_command, in order. */
      directives: Array<{ kind: string; payload: Record<string, unknown> }>;
      setFail(command: string, error: unknown): void;
      lastCall(command: string): { command: string; args: unknown } | null;
      directivesOfKind(kind: string): Array<{ kind: string; payload: Record<string, unknown> }>;
      /** Deliver a Rust → control event; returns the listener count reached. */
      emit(event: string, payload: unknown): number;
      reset(): void;
    };
  }
}
