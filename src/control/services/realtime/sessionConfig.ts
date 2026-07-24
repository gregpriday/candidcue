/**
 * Realtime transcription session configuration (spec §27.5, A.6). Pure.
 */
import type { TranscriptionConfig } from '../../../shared/contracts';

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: true,
};

export interface TranscriptionSessionOptions {
  /**
   * Vocabulary prompt injection point (spec §27.5): a compact steering
   * prompt built from the script's dictionary terms. Omitted when empty.
   */
  vocabularyPrompt?: string;
  noiseReduction?: 'near_field' | 'far_field' | null;
}

/**
 * Build the `session.update` client event sent over the data channel once
 * it opens. Mirrors the §27.5 shape: transcription-only session, manual
 * commits (`turn_detection: null`), near-field noise reduction, logprobs
 * included only when requested — their absence must never break matching.
 */
export function buildSessionUpdateEvent(
  config: TranscriptionConfig,
  options: TranscriptionSessionOptions = {},
): Record<string, unknown> {
  const transcription: Record<string, unknown> = {
    model: config.model,
    delay: config.delay,
  };
  if (config.language) transcription.language = config.language;
  const vocabularyPrompt = options.vocabularyPrompt?.trim();
  if (vocabularyPrompt) transcription.prompt = vocabularyPrompt;

  const session: Record<string, unknown> = {
    type: 'transcription',
    audio: {
      input: {
        transcription,
        // Manual commit strategy: local VAD owns turn boundaries (§29.3).
        turn_detection: null,
        noise_reduction:
          options.noiseReduction === null
            ? null
            : { type: options.noiseReduction ?? 'near_field' },
      },
    },
  };
  if (config.requestLogprobs) {
    session.include = ['item.input_audio_transcription.logprobs'];
  }
  return { type: 'session.update', session };
}
