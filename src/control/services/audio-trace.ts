/**
 * Step-by-step trace of a take's audio path (spec §30.1 triage).
 *
 * Why this exists. A session that connects and transcribes nothing has been the
 * one failure nothing could see from outside the machine it happens on. Capture
 * lives in the control webview, so a `console.log` never reaches the terminal
 * running `tauri dev`; the pipeline's own diagnostics are only readable through
 * a UI that the failure prevents anyone from reaching. Three rounds of
 * investigation were spent narrowing it by reasoning, which is the wrong tool —
 * the fourth added this and found the cause in one take.
 *
 * So each step reports itself, with elapsed milliseconds, to a Rust command
 * that prints through `tracing` and appends to `logs/client-trace.log`. The
 * trace names the step, the state and the timing, and nothing else: no
 * transcript text, and above all no API key. Lines are composed from fixed step
 * names and small scalars rather than from anything the provider or the user
 * supplied, so there is no path by which a secret reaches one.
 *
 * On by default in a dev build; see {@link initConnectTrace}.
 */
import { ipcInvoke } from './ipc';

let enabled = false;
let startedAtMs = 0;
let sequence = 0;

/**
 * Turn tracing on for this window.
 *
 * On by default in a DEV build, because the first attempt to collect a trace
 * was lost to a step that should not have existed: the operator had to open the
 * Web Inspector and set a localStorage key before the run that reproduced the
 * fault, and a diagnostic you must remember to arm before the thing you cannot
 * predict is a diagnostic that does not get collected. `pnpm tauri dev` is
 * already the debugging build; it can afford a few dozen lines per take.
 *
 * The localStorage key still works, so a PACKAGED build can be asked for a
 * trace without a rebuild — which is the case where arming it deliberately is
 * the right trade.
 */
export function initAudioTrace(): void {
  try {
    enabled =
      localStorage.getItem('candidcue.trace.audio') === '1' ||
      Boolean(import.meta.env?.DEV);
  } catch {
    enabled = Boolean(import.meta.env?.DEV);
  }
}

export function audioTraceEnabled(): boolean {
  return enabled;
}

/** Begin a new attempt; timings are relative to this. */
export function traceBegin(): void {
  if (!enabled) return;
  startedAtMs = performance.now();
  sequence = 0;
  void emit('begin', 'connect attempt started');
}

/**
 * Record one step.
 *
 * `detail` must be composed by the caller from fixed strings and scalars. It is
 * truncated defensively, but the real guarantee is the call sites: nothing here
 * is ever handed a credential, an SDP body, or a transcript.
 */
export function trace(step: string, detail = ''): void {
  if (!enabled) return;
  void emit(step, detail);
}

async function emit(step: string, detail: string): Promise<void> {
  const at = Math.round(performance.now() - startedAtMs);
  const line = `#${++sequence} +${at}ms ${step}${detail ? ` — ${detail}` : ''}`;
  try {
    await ipcInvoke('log_client_diagnostic', { scope: 'realtime', line });
  } catch {
    // Tracing must never be able to fail a connect. If the log command is
    // unavailable the attempt carries on untraced.
  }
}

