import type {
  TextToSpeechAdapter,
  TtsInput,
  TtsChunk,
  TestVoiceInput,
  TtsResult,
} from '@shared/contracts/adapters';
import { AppError } from '@shared/errors/app-error';
import { wordCount } from '@shared/utils';
import { pcm16ToWav } from '../inworld/wav';

import { throwIfAborted, delay } from './abort';

/** Knobs for {@link FakeTts}. */
export interface FakeTtsConfig {
  /**
   * Fixed duration (ms) for every result. When omitted, the duration is derived
   * deterministically from the input text length.
   */
  durationMs?: number;
  /** Words-per-second used when deriving duration from text. Default 2.7. */
  wordsPerSecond?: number;
  /** Provider request id stamped on results. Default null. */
  providerRequestId?: string | null;
  /** Artificial latency (ms), also reported as `latencyMs`. Default 0. */
  delayMs?: number;
  /**
   * Throw `TTS_FAILED` on the Nth synthesis call onward (1-based). Lets a test
   * simulate a realization failure mid-session (e.g. the opening succeeds but
   * the next question's TTS fails). `resetFailure()` clears it so a later resume
   * can succeed. When omitted, synthesis never fails.
   */
  failAfterCalls?: number;
}

/**
 * Deterministic stand-in for the Inworld TTS adapter. It returns a small PCM
 * buffer and a duration that is either fixed or derived from the input text, so
 * tests can assert on timing-driven behaviour without real audio synthesis.
 */
export class FakeTts implements TextToSpeechAdapter {
  private readonly fixedDurationMs: number | undefined;
  private readonly wordsPerSecond: number;
  private readonly providerRequestId: string | null;
  private readonly delayMs: number;
  private failAfterCalls: number | undefined;
  private callCount = 0;

  /** Inputs seen so far, for test assertions. */
  public readonly seen: TtsInput[] = [];

  constructor(config: FakeTtsConfig = {}) {
    this.fixedDurationMs = config.durationMs;
    this.wordsPerSecond = config.wordsPerSecond ?? 2.7;
    this.providerRequestId = config.providerRequestId ?? null;
    this.delayMs = config.delayMs ?? 0;
    this.failAfterCalls = config.failAfterCalls;
  }

  /**
   * Stop failing and reset the call counter so subsequent synthesis succeeds —
   * lets a single test drive a failure then a recovery (e.g. resume after a
   * realization failure) without swapping the adapter instance.
   */
  resetFailure(): void {
    this.failAfterCalls = undefined;
    this.callCount = 0;
  }

  testVoice(input: TestVoiceInput, signal?: AbortSignal): Promise<TtsResult> {
    return this.run(input, signal);
  }

  synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    return this.run(input, signal);
  }

  /**
   * Streaming stand-in: emits the clip in a few independently-WAV-wrapped chunks
   * (like the real `:stream` endpoint) then resolves with the whole clip. Honours
   * the same delay / fail-after / abort knobs as {@link synthesize}.
   */
  async synthesizeStream(
    input: TtsInput,
    onChunk: (chunk: TtsChunk) => void,
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    this.callCount += 1;
    if (this.failAfterCalls !== undefined && this.callCount >= this.failAfterCalls) {
      throw new AppError('TTS_FAILED', { recoverable: true, retryAction: 'retry-tts' });
    }

    this.seen.push(input);
    const durationMs = this.deriveDuration(input.text);
    const pcm = synthBytes(durationMs, input.sampleRate);
    const perChunk = Math.max(2, Math.ceil(pcm.byteLength / 3 / 2) * 2);
    let sequence = 0;
    for (let offset = 0; offset < pcm.byteLength; offset += perChunk) {
      throwIfAborted(signal);
      const slice = pcm.subarray(offset, Math.min(offset + perChunk, pcm.byteLength));
      onChunk({ sequence: sequence++, bytes: pcm16ToWav(slice, input.sampleRate, 1) });
    }
    return {
      bytes: pcm16ToWav(pcm, input.sampleRate, 1),
      mimeType: 'audio/wav',
      sampleRate: input.sampleRate,
      channels: 1,
      durationMs,
      providerRequestId: this.providerRequestId,
      latencyMs: this.delayMs,
    };
  }

  /** Shared synthesis path for `synthesize` and `testVoice`. */
  private async run(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    this.callCount += 1;
    if (this.failAfterCalls !== undefined && this.callCount >= this.failAfterCalls) {
      throw new AppError('TTS_FAILED', { recoverable: true, retryAction: 'retry-tts' });
    }

    this.seen.push(input);
    const durationMs = this.deriveDuration(input.text);
    // When the caller asks for WAV, return a real RIFF/WAVE container around the
    // PCM payload — not raw PCM labelled audio/wav. The real TTS contract always
    // requests `outputFormat: 'wav'`, and the stage SpeechPlayer decodes via
    // AudioContext.decodeAudioData, which rejects a bare-PCM buffer. Without this
    // the fake silently breaks the playback path it is meant to stand in for.
    const raw = synthBytes(durationMs, input.sampleRate);
    const wav = input.outputFormat === 'wav';
    return {
      bytes: wav ? pcm16ToWav(raw, input.sampleRate, 1) : raw,
      mimeType: wav ? 'audio/wav' : 'audio/pcm',
      sampleRate: input.sampleRate,
      channels: 1,
      durationMs,
      providerRequestId: this.providerRequestId,
      latencyMs: this.delayMs,
    };
  }

  /** Fixed duration when configured, otherwise a word-count-derived estimate. */
  private deriveDuration(text: string): number {
    if (this.fixedDurationMs !== undefined) return this.fixedDurationMs;
    const words = wordCount(text);
    // At least one frame so callers never see a zero-length clip.
    return Math.max(1, Math.round((words / this.wordsPerSecond) * 1000));
  }
}

/**
 * Produce a small, deterministic PCM-s16le buffer whose size is proportional to
 * the duration and sample rate (capped so tests stay cheap). Mono, 16-bit.
 */
function synthBytes(durationMs: number, sampleRate: number): Uint8Array {
  const frames = Math.min(Math.ceil((durationMs / 1000) * sampleRate), 256);
  const bytes = new Uint8Array(Math.max(2, frames * 2));
  // Fill with a simple ramp so the buffer is non-empty and reproducible.
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  return bytes;
}
