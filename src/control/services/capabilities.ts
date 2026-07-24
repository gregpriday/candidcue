/**
 * Model capability registry (spec §27.8, §26.1).
 *
 * `get_model_capabilities` had zero consumers and no TypeScript type even
 * named `ModelCapabilities`, which made the registry a decoy: it looked like
 * the safeguard §26.1 requires ("the implementation must isolate this
 * assumption behind model capability metadata") while nothing consulted it.
 *
 * The assumption it exists to isolate is a specific one. §26.1:
 *
 *   "CandidCue must not assume that the primary `gpt-realtime-whisper` session
 *    can accept a custom prompt or dictionary. […] The application therefore
 *    uses script-specific vocabulary as alignment knowledge, not as a hidden
 *    Realtime model parameter."
 *
 * So the registry's job is to decide whether the transcription session may
 * carry a vocabulary `prompt` at all. `supportsVocabularyPrompt` is that
 * decision, and it is the only gate on `sessionConfig.buildSessionUpdateEvent`'s
 * `vocabularyPrompt` option.
 */
import { invokeOrMock } from './ipc';

/** Twin of Rust `ModelCapabilities` (src-tauri/src/openai/mod.rs). */
export interface ModelCapabilities {
  realtimeModel: string;
  commandModel: string;
  realtimePromptSteering: boolean;
  realtimeLogprobs: boolean;
  supportedDelayLevels: string[];
  supportsClientSecretForTranscription: boolean;
  commandStructuredOutputs: boolean;
  semanticModel: string;
  semanticStructuredOutputs: boolean;
  semanticReasoningEfforts: string[];
  semanticDefaultReasoningEffort: string;
  semanticSupportsPromptCacheKey: boolean;
  promptCacheMinTokens: number;
  semanticDefaultMaxOutputTokens: number;
  semanticDefaultTimeoutMs: number;
  semanticInputPricePerMtok?: number | null;
  semanticCachedInputPricePerMtok?: number | null;
  semanticOutputPricePerMtok?: number | null;
  registryVersion: number;
}

/**
 * What to assume when the registry cannot be reached (browser dev, or a
 * backend that failed the call): every optional capability OFF. An unknown
 * capability must never read as supported — that is how a registry stops being
 * a safeguard and becomes a rubber stamp.
 */
export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  realtimeModel: '',
  commandModel: '',
  realtimePromptSteering: false,
  realtimeLogprobs: false,
  supportedDelayLevels: [],
  supportsClientSecretForTranscription: false,
  commandStructuredOutputs: false,
  semanticModel: '',
  semanticStructuredOutputs: false,
  semanticReasoningEfforts: [],
  semanticDefaultReasoningEffort: 'low',
  semanticSupportsPromptCacheKey: false,
  promptCacheMinTokens: 0,
  semanticDefaultMaxOutputTokens: 0,
  semanticDefaultTimeoutMs: 0,
  registryVersion: 0,
};

let cached: ModelCapabilities | null = null;

/** The registry is static for the life of the process, so it is fetched once. */
export async function getModelCapabilities(): Promise<ModelCapabilities> {
  if (cached) return cached;
  const capabilities = await invokeOrMock<ModelCapabilities>(
    'get_model_capabilities',
    undefined,
    () => UNKNOWN_CAPABILITIES,
  );
  cached = capabilities;
  return capabilities;
}

/** Test seam; also used when the OpenAI settings change. */
export function resetCapabilitiesCache(): void {
  cached = null;
}

/**
 * May a transcription session for `model` carry a vocabulary prompt (§26.1)?
 *
 * Two conditions, and both matter:
 *  - the registry says the realtime model accepts prompt steering;
 *  - the model actually being used IS the one the registry describes. A user
 *    can override the realtime model in Settings, and a capability measured
 *    for a different model says nothing about it.
 */
export function supportsVocabularyPrompt(
  capabilities: ModelCapabilities,
  model: string,
): boolean {
  if (!capabilities.realtimePromptSteering) return false;
  if (capabilities.realtimeModel === '') return false;
  return capabilities.realtimeModel === model;
}

/**
 * May Luna be asked for a structured result (vocabulary analysis, semantic
 * assist)? Rust refuses with AUTH_MODEL_UNAVAILABLE otherwise, so asking first
 * turns a backend error into an explained, disabled control.
 */
export function supportsVocabularyAnalysis(capabilities: ModelCapabilities): boolean {
  return capabilities.semanticStructuredOutputs && capabilities.semanticModel !== '';
}
