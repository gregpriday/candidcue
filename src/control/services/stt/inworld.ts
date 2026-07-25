/**
 * Inworld speech-to-text, as the control window sees it.
 *
 * The socket itself is not here — it is in Rust (`src-tauri/src/inworld/`),
 * because Inworld authenticates with an `Authorization: Basic` header and a
 * browser `WebSocket` cannot send one. What lives here is the thin half: start
 * a session, push captured PCM at it, and turn the frames Rust emits back into
 * the `TranscriptEvent` shape the tracking ledger already consumes.
 *
 * That last part is the whole reason this migration was tractable. The aligner,
 * the ledger and the worker protocol were written against a provider-agnostic
 * event model — `item_started` / `delta` / `completed` / `failed` /
 * `transport_state` — so swapping the provider is a change of *producer* and
 * nothing downstream of this file knows which service is talking.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No commit driver, no local speech gate, no noise-floor calibration. Inworld
 * endpoints server-side: it decides where an utterance ends and sends a final
 * transcript for it. The previous provider left that decision to the client,
 * and every mechanism that implemented it was a way to hold a perfectly healthy
 * connection open and transcribe nothing — which is what it did. There is
 * nothing to configure here because there is nothing to get wrong.
 */
import type { TranscriptEvent as TrackingEvent } from '../../../shared/tracking/types';
import { ipcInvoke } from '../ipc';

/** Frames the Rust session emits on `stt://event`. Mirrors `SttFrame`. */
export type SttFrame =
  | {
      kind: 'itemStarted';
      generation: number;
      itemId: string;
      ordinal: number;
      audioStartMs: number;
    }
  | { kind: 'partial'; generation: number; itemId: string; text: string }
  | { kind: 'final'; generation: number; itemId: string; text: string; audioEndMs: number }
  | {
      kind: 'transport';
      generation: number;
      state: 'connecting' | 'connected' | 'degraded' | 'closed';
      detail?: string;
    }
  | {
      kind: 'failed';
      generation: number;
      code: string;
      message: string;
      recoverable: boolean;
    }
  | { kind: 'audioDropped'; generation: number; frames: number };

export const STT_EVENT = 'stt://event';

/**
 * The one sample rate the app captures and streams at.
 *
 * Declared in the Rust config frame and used there to convert byte counts into
 * an audio clock, so all three must agree. Inworld resamples internally, but a
 * mismatch between what we *say* we are sending and what we send is heard as
 * a chipmunk and transcribed as nonsense.
 */
export const STT_SAMPLE_RATE_HZ = 24_000;

/** How much audio each `stt_audio` call carries. */
export const STT_FRAME_MS = 100;

export interface SttSessionOptions {
  /** BCP-47, e.g. `en-US`. Omitted uses the Rust default. */
  language?: string;
  modelId?: string;
}

/**
 * The ONE place a transcription session's options are built.
 *
 * Both callers go through this — the Preflight microphone test and a real
 * take — and that is the entire point. They used to build their own: the test
 * passed nothing, so Rust applied its defaults and it worked perfectly; the
 * take passed the model from the persisted settings document, which on an
 * upgraded install still named the PREVIOUS provider's model. Inworld answered
 * "Unsupported model" and the take reconnected seven times in twelve seconds
 * while the test button beside it kept working.
 *
 * A diagnostic that exercises a different configuration from the thing it is
 * diagnosing is worse than no diagnostic, because it is believed. If this
 * function returns something the provider rejects, the test fails too — which
 * is the only arrangement in which "the test passes" means anything.
 *
 * Unknown values are dropped rather than forwarded: an absent field lets Rust
 * apply a default it knows is valid, where a stale one is an error mid-take.
 * Rust re-checks the model as well; this is the near side of the same rule.
 */
export function sttSessionOptions(
  settings: { transcriptionModel?: string | null; language?: string | null } | null | undefined,
): SttSessionOptions {
  const options: SttSessionOptions = {};
  const model = settings?.transcriptionModel?.trim();
  if (model && SUPPORTED_MODELS.includes(model)) options.modelId = model;
  const language = settings?.language?.trim();
  if (language) options.language = language;
  return options;
}

/**
 * Model ids this build knows Inworld serves.
 *
 * Duplicated from `SUPPORTED_MODELS` in `src-tauri/src/inworld/mod.rs` on
 * purpose — Rust is the authority and re-checks whatever arrives, so this copy
 * only stops a bad value being offered in the UI or sent at all. A test asserts
 * the two lists agree.
 */
export const SUPPORTED_MODELS = ['inworld/inworld-stt-1'];

/**
 * The languages the app offers, in one list.
 *
 * Preflight and Settings each had their own picker, over different values, and
 * only Preflight's reached a take — so the Settings choice was written,
 * displayed, and ignored. One list, one stored value, both screens.
 */
export const SPEECH_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'fr-FR', label: 'French (France)' },
  { value: 'de-DE', label: 'German (Germany)' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
];

/**
 * Turn a Rust frame into the tracking engine's event model.
 *
 * Three clocks and two generations meet here, and getting either wrong is
 * silent — the session connects, transcribes, and the cursor never moves.
 *
 * `sessionGeneration` is the SESSION's, not the frame's. Rust mints its own
 * monotonic generation per socket, and the two are unrelated: the Preflight
 * microphone test consumes Inworld generation 1, so the first real take runs
 * on transport generation 2 while the coordinator is still on session
 * generation 1. `AlignmentEngine.handleTranscriptEvent` drops any update whose
 * `sessionGeneration` does not match the session it was initialised with — so
 * passing the transport's number through would discard every word, on a
 * connection reporting perfect health. The frame's generation is for filtering
 * late frames at the IPC edge and nothing else.
 *
 * `receivedAtMs` is stamped by the caller rather than in Rust because the
 * ledger orders and expires items against the control window's clock.
 *
 * `audioOriginMs` puts Rust's audio clock on that same clock. Rust counts
 * milliseconds of audio handed to the socket, starting at zero; the tracking
 * worker's `SessionClock.map` treats `audioStartMs`/`audioEndMs` as secondary
 * stamps on the SAME producer clock as `receivedAtMs` and subtracts an
 * epoch-scale origin from them. A zero-based duration through that transform
 * clamps to 0 for every item, which quietly destroys the timing the pace
 * estimator and the evidence-age checks run on. Adding the capture origin
 * restores the affine relationship the clock is entitled to assume.
 */
export function toTrackingEvent(
  frame: SttFrame,
  receivedAtMs: number,
  sessionGeneration: number,
  audioOriginMs: number,
): TrackingEvent | null {
  switch (frame.kind) {
    case 'itemStarted':
      return {
        type: 'item_started',
        sessionGeneration,
        itemId: frame.itemId,
        // Inworld has no notion of a commit; the utterance ordinal is the
        // monotonic sequence the ledger needs, and it is minted at the only
        // place that can see an utterance boundary.
        commitSequence: frame.ordinal,
        audioStartMs: audioOriginMs + frame.audioStartMs,
        receivedAtMs,
      };
    case 'partial':
      return {
        type: 'delta',
        sessionGeneration,
        itemId: frame.itemId,
        // Inworld's interims are CUMULATIVE — each one restates the utterance
        // so far rather than appending to the last. The ledger treats a delta
        // as the item's provisional text in full, which matches; a ledger that
        // concatenated would produce "the the quick the quick brown".
        text: frame.text,
        receivedAtMs,
      };
    case 'final':
      return {
        type: 'completed',
        sessionGeneration,
        itemId: frame.itemId,
        text: frame.text,
        audioEndMs: audioOriginMs + frame.audioEndMs,
        receivedAtMs,
      };
    case 'failed':
      return {
        type: 'failed',
        sessionGeneration,
        code: frame.code,
        recoverable: frame.recoverable,
        receivedAtMs,
      };
    case 'transport':
      return {
        type: 'transport_state',
        sessionGeneration,
        state: frame.state === 'closed' ? 'closed' : frame.state,
        receivedAtMs,
      };
    // Not a transcript event: audio that never reached the service. It is
    // reported to the UI separately, because "words heard: 0" with frames
    // silently dropped is the failure this whole rewrite exists to make
    // impossible to misdiagnose.
    case 'audioDropped':
      return null;
  }
}

/**
 * Encode Float32 mono samples as base64 PCM16, which is what the wire wants.
 *
 * Clamped before scaling: a sample outside [-1, 1] wraps rather than clips when
 * it is cast, so a loud passage would arrive as a burst of white noise instead
 * of loud speech.
 */
export function encodePcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(clamped * 32_767), true);
  }
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument limit for
  // anything past a few tens of kilobytes, and a 100 ms frame is 4,800 bytes
  // today — comfortable now, and a stack overflow the first time the frame size
  // is raised.
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/** Open a session and return its generation. */
export async function startTranscription(options: SttSessionOptions = {}): Promise<number> {
  return ipcInvoke<number>('start_transcription', {
    options: {
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    },
  });
}

export async function pushTranscriptionAudio(generation: number, chunk: string): Promise<void> {
  await ipcInvoke<void>('push_transcription_audio', { generation, chunk });
}

export async function stopTranscription(generation: number): Promise<void> {
  await ipcInvoke<void>('stop_transcription', { generation });
}
