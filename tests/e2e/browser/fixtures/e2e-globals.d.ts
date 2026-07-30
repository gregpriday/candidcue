export {};

/**
 * Test-only control surface the injected Tauri shim (tauri-shim.ts) hangs on
 * `window` so specs can inspect recorded IPC calls and force failure responses.
 */
declare global {
  interface Window {
    __E2E__: {
      calls: Array<{ command: string; args: unknown }>;
      /** Commands that have ANSWERED, in order — `calls` records only the ask. */
      settled: string[];
      fail: Record<string, unknown>;
      stageGeneration: number;
      sessionGeneration: number;
      /** The last row `start_session` minted — Rust assigns, control adopts. */
      lastSession: { id: string; sessionGeneration: number } | null;
      stage: { exists: boolean; visible: boolean; fullscreen: boolean; nativeFullscreen: boolean };
      /** Whether THIS window is presenting (single-window takes). */
      presenting: boolean;
      /** Hold a command open for `ms` before it answers; null clears. */
      setDelay(command: string, ms: number | null): void;
      /** StageDirectives relayed through publish_stage_command, in order. */
      directives: Array<{ kind: string; payload: Record<string, unknown> }>;
      setFail(command: string, error: unknown): void;
      lastCall(command: string): { command: string; args: unknown } | null;
      directivesOfKind(kind: string): Array<{ kind: string; payload: Record<string, unknown> }>;
      /** Deliver a Rust → control event; returns the listener count reached. */
      emit(event: string, payload: unknown): number;
      reset(): void;
    };
    /**
     * Microphone-API call counters installed by welcome.spec.ts.
     *
     * Chromium implements the Permissions API and this suite grants the
     * microphone globally, so a screen that wrongly asked the browser instead
     * of reading the persisted grant would still answer correctly here and look
     * fine. Counting the calls is the only way to see that difference.
     */
    __MIC_PROBES__?: { query: number; getUserMedia: number; enumerateDevices: number };
  }
}
