/**
 * Grok (xAI) speech-to-text, as the control window sees it.
 *
 * The socket itself is not here — it is in Rust (`src-tauri/src/stt/`), because
 * Grok authenticates with an `Authorization: Bearer` header, a browser
 * `WebSocket` cannot send one, and xAI's own documentation says the key must
 * never reach client-side code. What lives here is the thin half: start a
 * session, push captured PCM at it, and hand the frames Rust emits to the
 * transcript bar and the retained record.
 *
 * Frames are NOT translated here. The alignment engine lives in Rust and
 * consumes `SttFrame` directly from the socket, so the mapping layer this file
 * used to own — a provider-agnostic transcript event model — had exactly one
 * consumer left and no longer has any. What crosses into JavaScript is the wire
 * shape.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No commit driver, no local speech gate, no noise-floor calibration. Grok
 * endpoints server-side: it decides where an utterance ends from the audio and
 * sends a final transcript for it. The provider before last left that decision
 * to the client, and every mechanism that implemented it was a way to hold a
 * perfectly healthy connection open and transcribe nothing — which is what it
 * did. There is nothing to configure here because there is nothing to get
 * wrong.
 *
 * No model, either. The streaming endpoint takes no model parameter, so there
 * is no list to keep in step with Rust and no persisted name that can go stale.
 * The setting that used to exist here took takes down after a provider change;
 * see `src-tauri/src/stt/mod.rs`.
 */
import type { AlignToken } from '../alignment';
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
 * Declared on the Rust session URL and used there to convert byte counts into
 * an audio clock, so all three must agree. 24 kHz is one of the six rates the
 * provider accepts natively, so nothing resamples on the way in — but a
 * mismatch between what we *say* we are sending and what we send is still heard
 * as a chipmunk and transcribed as nonsense.
 */
export const STT_SAMPLE_RATE_HZ = 24_000;

/** How much audio each `stt_audio` call carries. */
export const STT_FRAME_MS = 100;

export interface SttSessionOptions {
  /** BCP-47, e.g. `en-US`. Rust narrows it to a primary subtag for the wire. */
  language?: string;
  /**
   * The take's spoken tokens, for the recogniser's custom vocabulary (§26).
   *
   * The SCRIPT, not the terms. Rust decides which words are unusual enough to
   * bias, because that is the same lexical judgement the alignment engine makes
   * about anchors and weights, and it is made in one place on purpose.
   *
   * Omitted by the microphone test, which has no script to draw one from.
   */
  vocabulary?: AlignToken[];
}

/**
 * The ONE place a transcription session's options are built.
 *
 * Both callers go through this — the Preflight microphone test and a real
 * take — and that is the entire point. They used to build their own: the test
 * passed nothing, so Rust applied its defaults and it worked perfectly; the
 * take passed the model from the persisted settings document, which on an
 * upgraded install still named the PREVIOUS provider's model. The service
 * answered "Unsupported model" and the take reconnected seven times in twelve
 * seconds while the test button beside it kept working.
 *
 * A diagnostic that exercises a different configuration from the thing it is
 * diagnosing is worse than no diagnostic, because it is believed. If this
 * function returns something the provider rejects, the test fails too — which
 * is the only arrangement in which "the test passes" means anything.
 *
 * Unknown values are dropped rather than forwarded: an absent field lets Rust
 * apply a default it knows is valid, where a stale one is an error mid-take.
 */
export function sttSessionOptions(
  settings: { language?: string | null } | null | undefined,
  vocabulary?: AlignToken[] | null,
): SttSessionOptions {
  const options: SttSessionOptions = {};
  const language = settings?.language?.trim();
  if (language) options.language = language;
  if (vocabulary && vocabulary.length > 0) options.vocabulary = vocabulary;
  return options;
}

/**
 * The languages the app offers, in one list.
 *
 * Preflight and Settings each had their own picker, over different values, and
 * only Preflight's reached a take — so the Settings choice was written,
 * displayed, and ignored. One list, one stored value, both screens.
 *
 * Stored in the regional form because that is what a presenter recognises. The
 * provider takes only a primary subtag, so `en-US`, `en-GB` and `en-AU` all
 * narrow to `en` at the wire; the distinction survives here because it costs
 * nothing and the picker reads better for it.
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
 * Encode Float32 mono samples as base64 PCM16, which is what the IPC bridge
 * wants.
 *
 * Base64 is the IPC hop only — Rust decodes it and hands raw bytes to the
 * socket, because the provider takes binary frames.
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
    },
  });
}

export async function pushTranscriptionAudio(generation: number, chunk: string): Promise<void> {
  await ipcInvoke<void>('push_transcription_audio', { generation, chunk });
}

export async function stopTranscription(generation: number): Promise<void> {
  await ipcInvoke<void>('stop_transcription', { generation });
}
