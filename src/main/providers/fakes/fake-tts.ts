import type {
  TextToSpeechAdapter,
  TtsInput,
  TestVoiceInput,
  TtsResult,
} from '@shared/contracts/adapters';
import { wordCount } from '@shared/utils';

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

  /** Inputs seen so far, for test assertions. */
  public readonly seen: TtsInput[] = [];

  constructor(config: FakeTtsConfig = {}) {
    this.fixedDurationMs = config.durationMs;
    this.wordsPerSecond = config.wordsPerSecond ?? 2.7;
    this.providerRequestId = config.providerRequestId ?? null;
    this.delayMs = config.delayMs ?? 0;
  }

  testVoice(input: TestVoiceInput, signal?: AbortSignal): Promise<TtsResult> {
    return this.run(input, signal);
  }

  synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    return this.run(input, signal);
  }

  /** Shared synthesis path for `synthesize` and `testVoice`. */
  private async run(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);

    this.seen.push(input);
    const durationMs = this.deriveDuration(input.text);
    return {
      bytes: synthBytes(durationMs, input.sampleRate),
      mimeType: input.outputFormat === 'wav' ? 'audio/wav' : 'audio/pcm',
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
