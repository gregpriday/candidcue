import type {
  TextToSpeechAdapter,
  TtsInput,
  TestVoiceInput,
  TtsResult,
} from '@shared/contracts/adapters';
import { AppError } from '@shared/errors/app-error';
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import { nowMs } from '@shared/utils/deadline';
import { isWavFile, wavDurationMs } from './wav';

/** Injectable fetch implementation. Defaults to the global `fetch`. */
export type TtsFetch = typeof fetch;

export interface InworldTtsClientOptions {
  apiKey: string;
  /** Inworld TTS model id. Defaults to {@link INWORLD_DEFAULTS.ttsModel}. */
  modelId?: string;
  /** Base URL of the Inworld TTS endpoint. */
  baseUrl?: string;
  /** Injectable fetch (real `fetch` in production, fake in tests). */
  fetchImpl?: TtsFetch;
}

/** Default synthesize endpoint (real Inworld tts/v1/voice contract; overridable). */
const DEFAULT_BASE_URL = 'https://api.inworld.ai/tts/v1/voice';

/** Single mono channel for all TTS output (spec §17). */
const TTS_CHANNELS = 1;

/**
 * Inworld TTS client (spec §13.4, §17).
 *
 * MVP requirement: each request is buffered fully before returning — we read the
 * entire audio body, compute its duration deterministically from the PCM byte
 * length, and hand back a complete {@link TtsResult}. There is no streaming
 * playback in the MVP, so callers always receive the whole clip up front.
 *
 * Wire shape: the Inworld `tts/v1/voice` endpoint returns JSON with a base64
 * `audioContent` field. For `LINEAR16` the field carries a complete WAV file
 * (RIFF/WAVE header + pcm_s16le samples), so we base64-decode it and pass the
 * bytes through unchanged — re-wrapping would nest a second RIFF header and
 * corrupt playback. Duration is read from the WAV header, and we report
 * `audio/wav`.
 */
export class InworldTtsClient implements TextToSpeechAdapter {
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: TtsFetch;

  constructor(options: InworldTtsClientOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.modelId ?? INWORLD_DEFAULTS.ttsModel;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Synthesize speech for `input.text` in voice `input.voiceId`. Buffers the
   * whole response, reads duration from the returned WAV header, and returns a
   * complete {@link TtsResult}.
   * @throws AppError INWORLD_AUTH on 401/403, TTS_FAILED on any other non-OK
   *   response or a malformed/empty/non-WAV `audioContent`.
   */
  async synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsResult> {
    const start = nowMs();

    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Inworld passes the API key verbatim as the Basic credential — it is
        // already the Basic token, so we do NOT base64-encode it again.
        Authorization: `Basic ${this.apiKey}`,
      },
      // Follows the documented Inworld `tts/v1/voice` request contract. Field
      // names are doc-derived and may need live confirmation against the API.
      body: JSON.stringify({
        text: input.text,
        voiceId: input.voiceId,
        modelId: this.modelId,
        audioConfig: {
          audioEncoding: 'LINEAR16',
          sampleRateHertz: input.sampleRate,
          speakingRate: input.speakingRate,
        },
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      // 401/403 specifically mean bad credentials; everything else is a generic
      // synthesis failure. Both are surfaced as user-safe AppErrors.
      const code = response.status === 401 || response.status === 403 ? 'INWORLD_AUTH' : 'TTS_FAILED';
      throw new AppError(code, {
        message: `Inworld TTS failed with status ${response.status}`,
      });
    }

    const providerRequestId =
      response.headers.get('x-request-id') ?? response.headers.get('x-inworld-request-id');

    let payload: { audioContent?: unknown };
    try {
      payload = (await response.json()) as { audioContent?: unknown };
    } catch (error) {
      // Preserve abort semantics: a caller-triggered abort surfaces here as an
      // AbortError and must propagate unchanged, never masked as TTS_FAILED.
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      // An OK status with a non-JSON or truncated body is a synthesis failure,
      // not a raw SyntaxError leaking out of the adapter.
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS response body was not valid JSON',
        cause: error,
      });
    }

    const audioContent = payload.audioContent;
    if (typeof audioContent !== 'string' || audioContent.trim().length === 0) {
      // A missing/empty/whitespace-only/non-string body is a failure, not silence.
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS response did not include base64 audioContent',
      });
    }

    // `audioContent` for LINEAR16 is a base64-encoded, fully-formed WAV file.
    // Decode it and pass the bytes through unchanged — re-wrapping would nest a
    // second RIFF header and corrupt the clip.
    const bytes = base64ToBytes(audioContent);
    if (!isWavFile(bytes)) {
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS response was not a valid WAV file',
      });
    }
    // Duration comes from the WAV header (data chunk / byte rate), not the total
    // byte length — the header bytes are not audio and would skew calibration.
    let durationMs: number;
    try {
      durationMs = wavDurationMs(bytes);
    } catch (error) {
      throw new AppError('TTS_FAILED', {
        message: 'Inworld TTS WAV header could not be parsed',
        cause: error,
      });
    }

    return {
      bytes,
      mimeType: 'audio/wav',
      sampleRate: input.sampleRate,
      channels: TTS_CHANNELS,
      durationMs,
      providerRequestId,
      latencyMs: nowMs() - start,
    };
  }

  /** Probe a voice configuration. Delegates to {@link synthesize} (spec §13.4). */
  async testVoice(input: TestVoiceInput, signal?: AbortSignal): Promise<TtsResult> {
    return this.synthesize(input, signal);
  }
}

/** Decode a base64 string to raw bytes (works in both Node and Electron main). */
function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
