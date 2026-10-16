/**
 * On-device speech-to-text, as the control window sees it.
 *
 * The recogniser itself is not here — it is in Rust (`src-tauri/src/speech/`),
 * running a streaming Zipformer transducer against ~43 MB of bundled ONNX
 * graphs. What lives here is the thin half: start a session, push captured PCM
 * at it, and receive the frames Rust emits.
 *
 * The renderer's side of this is UNCHANGED from the websocket era, deliberately.
 * The capture graph, the level meter, the device picker and the transcript
 * ledger were all built against `stt://event` and none of them care where the
 * words come from. Replacing the provider was allowed to touch the recogniser
 * and nothing else.
 *
 * Frames are not translated here. The alignment engine lives in Rust and
 * consumes them directly beside the audio clock they are timed against, so the
 * mapping layer this file used to own has no consumers. What crosses into
 * JavaScript is the wire shape, for the transcript bar and the retained record.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No API key, no model picker, no language picker, no commit driver, no local
 * speech gate, no noise-floor calibration.
 *
 * The key and the model id are gone because there is no service to present them
 * to. The language picker is gone because there is one bundled model and
 * nothing yet reads the setting, and a control that is written, displayed and
 * ignored is worse than no control. Not because the model is English-only — it
 * is bilingual (`zh-en`), and Rust now honours a language it can serve.
 * The rest were absent already: the recogniser endpoints itself, deciding where
 * an utterance ends and emitting a final for it.
 *
 * The transcript is UPPERCASE and unpunctuated. Nothing renders it as prose —
 * it is a position signal, normalised before it is matched against the script —
 * but anything that does show it to a human should case it deliberately.
 */
import { ipcInvoke, invokeOrMock } from '../ipc';

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
 * The capture graph resamples to this and Rust converts sample counts into an
 * audio clock with it, so both must agree. The recogniser resamples internally
 * and would accept any rate, but a mismatch between what we say we are sending
 * and what we send is heard as a chipmunk and transcribed as nonsense.
 */
export const STT_SAMPLE_RATE_HZ = 24_000;

/** How much audio each `stt_audio` call carries. */
export const STT_FRAME_MS = 100;

/** What Settings shows in place of a key status. Mirrors `SpeechEngineStatus`. */
export interface SpeechEngineStatus {
  available: boolean;
  loaded: boolean;
  model: string;
  detail?: string;
}

/**
 * Whether this installation can transcribe, and whether it is warm.
 *
 * Falls back to the mock in plain-browser dev, where there is no ONNX runtime
 * to ask — Settings still has to render something, and "checking… forever" is
 * not it.
 */
export async function getSpeechEngineStatus(): Promise<SpeechEngineStatus> {
  const { mockSpeech } = await import('../mock-backend');
  return invokeOrMock<SpeechEngineStatus>('get_speech_engine_status', undefined, () =>
    mockSpeech.status(),
  );
}

/**
 * Load the model without starting a take.
 *
 * `startTake` calls it before anything else in a take: a cold load takes over
 * a second, and the earlier it starts the less of it the presenter spends
 * talking ahead of a recogniser that is not there yet.
 */
export async function preloadSpeechEngine(): Promise<void> {
  await ipcInvoke<void>('preload_speech_engine');
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
export async function startTranscription(): Promise<number> {
  return ipcInvoke<number>('start_transcription', { options: {} });
}

export async function pushTranscriptionAudio(generation: number, chunk: string): Promise<void> {
  await ipcInvoke<void>('push_transcription_audio', { generation, chunk });
}

export async function stopTranscription(generation: number): Promise<void> {
  await ipcInvoke<void>('stop_transcription', { generation });
}
