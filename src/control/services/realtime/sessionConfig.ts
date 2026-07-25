/**
 * Realtime transcription session configuration (spec §27.5, A.6). Pure.
 */
import type { TranscriptionConfig } from '../../../shared/contracts';

/**
 * Models that will do their own endpointing.
 *
 * `gpt-realtime-whisper` will not — it answers a `turn_detection` of any shape
 * with "Turn detection is not supported for this transcription model", which
 * is why this app carried a local VAD, a noise-floor calibration, a speech
 * gate and a manual commit driver just to decide when a sentence had ended.
 * Every one of those was a way for a take to transcribe nothing while the
 * connection stayed perfectly healthy, and between them they cost a day.
 *
 * `gpt-4o-transcribe` does. Verified against the live API with real speech and
 * no client commit at all (tests/integration/realtime-transcription.live.test.ts).
 */
export const SERVER_VAD_MODELS = new Set(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);

export function supportsServerTurnDetection(model: string): boolean {
  return SERVER_VAD_MODELS.has(model);
}

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  model: 'gpt-4o-transcribe',
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
  const transcription: Record<string, unknown> = { model: config.model };
  /*
   * `delay` is not universally supported: `gpt-4o-transcribe` rejects it with
   * "The 'delay' parameter is not supported for this model", and a rejected
   * `session.update` means the session keeps its defaults and the take
   * transcribes nothing — the same silent failure, arriving a different way.
   * Sent only where it is accepted.
   */
  if (config.delay && !supportsServerTurnDetection(config.model)) {
    transcription.delay = config.delay;
  }
  if (config.language) transcription.language = config.language;
  const vocabularyPrompt = options.vocabularyPrompt?.trim();
  if (vocabularyPrompt) transcription.prompt = vocabularyPrompt;

  const session: Record<string, unknown> = {
    type: 'transcription',
    audio: {
      input: {
        transcription,
        /*
         * Let the SERVER decide where a turn ends, when the model can.
         *
         * §29.3 specified manual commits and a local VAD as the boundary
         * source. That put the burden of endpointing on a browser audio graph,
         * a two-second noise-floor calibration and a speech gate — and a take
         * that transcribed nothing looked identical to a healthy one, because
         * with `turn_detection: null` an uncommitted stream is simply never
         * transcribed. Server-side detection removes the entire class: audio
         * is streamed, turns are found, transcripts arrive.
         *
         * Still `null` for a model that cannot do it, which is a hard error
         * rather than a silent downgrade — see `supportsServerTurnDetection`.
         */
        turn_detection: supportsServerTurnDetection(config.model)
          ? { type: 'server_vad' }
          : null,
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
