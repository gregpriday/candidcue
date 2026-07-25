/**
 * Step-by-step trace of a realtime connect attempt (spec §30.1 triage).
 *
 * Why this exists. A realtime connection that will not OPEN has been the one
 * failure nothing could see from outside the machine it happens on. The whole
 * negotiation lives in the control webview, so a `console.log` never reaches
 * the terminal running `tauri dev`; the transport's own diagnostics are only
 * readable through a UI that the failure prevents anyone from reaching; and no
 * test in this repo touches the SDP exchange, because that needs a real
 * `RTCPeerConnection` and a live audio track. Three rounds of investigation
 * were spent narrowing it by reasoning, which is the wrong tool.
 *
 * So each step reports itself, with elapsed milliseconds, to a Rust command
 * that prints through `tracing` — the terminal already running the app. The
 * trace names the step, the state, and the timing, and nothing else: no
 * transcript text, no SDP body, and above all no credential. `sk-` material and
 * the ephemeral secret never enter a line, because lines are composed from
 * fixed step names and small scalars rather than from anything the provider or
 * the user supplied.
 *
 * Off unless asked for. `enableConnectTrace()` is called from the debug flag,
 * so an ordinary session pays one boolean check per step.
 */
import { ipcInvoke } from '../ipc';

let enabled = false;
let startedAtMs = 0;
let sequence = 0;

/**
 * Turn tracing on for this window.
 *
 * Read from `localStorage` rather than an env var so it can be switched on in
 * a build that is already running, on the machine where the failure happens,
 * without a rebuild.
 */
export function initConnectTrace(): void {
  try {
    enabled = localStorage.getItem('candidcue.trace.realtime') === '1';
  } catch {
    enabled = false;
  }
}

export function connectTraceEnabled(): boolean {
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

/**
 * Attach ICE/connection/data-channel listeners so the trace shows the states
 * the negotiation actually passed through.
 *
 * This is the part that matters for a connect that never opens: whether ICE
 * gathered candidates at all, whether it reached `checking`, and whether the
 * data channel ever left `connecting`. Those three answers separate a blocked
 * network from a rejected SDP from a WebView that cannot do WebRTC.
 */
export function traceConnection(pc: {
  addEventListener?: (type: string, listener: () => void) => void;
  readonly iceConnectionState?: string;
  readonly iceGatheringState?: string;
  readonly connectionState?: string;
  readonly signalingState?: string;
}): void {
  if (!enabled || typeof pc.addEventListener !== 'function') return;
  let candidates = 0;
  pc.addEventListener('icecandidate', () => {
    candidates++;
  });
  pc.addEventListener('icegatheringstatechange', () => {
    trace('ice-gathering', `${pc.iceGatheringState ?? '?'} (candidates so far: ${candidates})`);
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    trace('ice-connection', pc.iceConnectionState ?? '?');
  });
  pc.addEventListener('connectionstatechange', () => {
    trace('pc-connection', pc.connectionState ?? '?');
  });
  pc.addEventListener('signalingstatechange', () => {
    trace('signaling', pc.signalingState ?? '?');
  });
  pc.addEventListener('icecandidateerror', () => {
    // The event carries a URL and an error text; neither is logged, because
    // the only thing needed here is that gathering hit an error at all.
    trace('ice-candidate-error', 'a candidate could not be gathered');
  });
}
