/**
 * Script vocabulary preparation (spec §26).
 *
 * The local half (§26.4) has existed and been tested in
 * `src/shared/markdown/vocabulary.ts` since the compiler landed. The Luna half
 * (§26.5) has existed in Rust as `analyze_vocabulary` — with a strict schema,
 * candidate-only payload and invented-surface rejection — and had no caller,
 * so every unusual name in every script went into a session unassisted and the
 * editor's Vocabulary panel showed a permanent "not connected" placeholder.
 *
 * What the result is used FOR is constrained by §26.1: vocabulary is
 * ALIGNMENT KNOWLEDGE first. It only becomes a transcription `prompt` when the
 * capability registry says the realtime model in use accepts one — see
 * `buildVocabularyPrompt` and services/capabilities.ts.
 */
import type { CompiledScript } from '../../shared/contracts';
import { extractVocabularyCandidates } from '../../shared/markdown/vocabulary';
import type { VocabularyCandidate } from '../../shared/markdown/vocabulary';
import { invokeOrMock } from './ipc';
import { supportsVocabularyPrompt, type ModelCapabilities } from './capabilities';

/** Twin of Rust `VocabularyTerm` (openai/luna_ops.rs). Snake_case on purpose:
 * the strict response schema in Appendix E.6 uses snake_case keys and Rust
 * derives `Serialize`/`Deserialize` with NO rename, so these are the exact
 * field names that cross the boundary. */
export interface VocabularyTerm {
  surface: string;
  canonical_spoken: string;
  aliases: string[];
  category: 'person' | 'place' | 'brand' | 'acronym' | 'technical' | 'number' | 'other';
  importance: number;
  case_sensitive: boolean;
  notes: string;
}

export interface VocabularyAnalysis {
  terms: VocabularyTerm[];
}

/** Twin of Rust `VocabularyCandidate` — the bounded payload of §26.5. */
export interface VocabularyRequestCandidate {
  surface: string;
  contexts: string[];
}

/**
 * Twin of Rust `VocabularyRequest`. `SemanticRequestOptions` is
 * `#[serde(flatten)]`ed into it, so `timeoutMs` and friends sit at the TOP
 * level of the request — not nested under `options`.
 */
export interface VocabularyRequest {
  language: string;
  candidates: VocabularyRequestCandidate[];
  existingDictionary?: unknown[];
  timeoutMs?: number;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  promptCacheKey?: string;
}

/** Words of context either side of an occurrence (§26.5 "a small amount"). */
const CONTEXT_WINDOW_TOKENS = 6;
/** Contexts per candidate. Rust takes the first 3; sending more is waste. */
const MAX_CONTEXTS = 3;

/**
 * Build the §26.5 request from a compiled script.
 *
 * Context comes from the spoken-token stream rather than the rendered blocks,
 * so it is deterministic and carries no Markdown. There is no cap on the
 * number of candidates here — Rust already bounds the payload at 300, and
 * capping user content in the UI is not this layer's business.
 */
export function buildVocabularyRequest(
  compiled: CompiledScript,
  language = 'en',
  candidates: VocabularyCandidate[] = extractVocabularyCandidates(compiled),
): VocabularyRequest {
  const byNormalized = new Map<string, string[]>();
  const tokens = compiled.spokenTokens;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const contexts = byNormalized.get(token.normalized);
    if (contexts !== undefined && contexts.length >= MAX_CONTEXTS) continue;
    const start = Math.max(0, i - CONTEXT_WINDOW_TOKENS);
    const end = Math.min(tokens.length, i + CONTEXT_WINDOW_TOKENS + 1);
    const window = tokens
      .slice(start, end)
      .map((t) => t.surface)
      .join(' ');
    if (contexts === undefined) byNormalized.set(token.normalized, [window]);
    else contexts.push(window);
  }

  return {
    language,
    candidates: candidates.map((candidate) => ({
      surface: candidate.term,
      contexts: (byNormalized.get(candidate.normalized) ?? []).slice(0, MAX_CONTEXTS),
    })),
  };
}

/**
 * Ask Luna to classify and enrich the candidates (§26.5).
 *
 * Rust discards any term whose surface was not among the candidates, so the
 * result can only ever describe words that are actually in the script.
 */
export async function analyzeVocabulary(request: VocabularyRequest): Promise<VocabularyAnalysis> {
  if (request.candidates.length === 0) return { terms: [] };
  return invokeOrMock<VocabularyAnalysis>(
    'analyze_vocabulary',
    { request },
    // Browser dev has no API key and no Rust client. An EMPTY analysis is the
    // only honest stand-in: fabricating pronunciations would put invented
    // words in front of a user as if a model had produced them.
    () => ({ terms: [] }),
  );
}

/* ---------------------------------------------------------------------------
 * §26.1 — vocabulary as a transcription prompt, only when permitted
 * ------------------------------------------------------------------------- */

/** Terms below this importance are not worth prompt budget. */
const PROMPT_IMPORTANCE_FLOOR = 0.5;
/** Keep the steering prompt compact; it is prepended to every turn. */
const PROMPT_MAX_TERMS = 40;

/**
 * The compact steering prompt for `session.update`, or `undefined`.
 *
 * `undefined` is the normal answer today: the registry decides, and §26.1
 * states the primary realtime model does not accept prompt steering. Returning
 * a string when the model cannot use one would put an unsupported field in the
 * session payload — the kind of change that breaks live transcription while
 * the UI still reports a healthy session.
 */
export function buildVocabularyPrompt(
  terms: VocabularyTerm[],
  capabilities: ModelCapabilities,
  model: string,
): string | undefined {
  if (!supportsVocabularyPrompt(capabilities, model)) return undefined;
  const surfaces = terms
    .filter((term) => term.importance >= PROMPT_IMPORTANCE_FLOOR)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, PROMPT_MAX_TERMS)
    .map((term) => term.surface.trim())
    .filter((surface) => surface !== '');

  if (surfaces.length === 0) return undefined;
  return `Vocabulary: ${surfaces.join(', ')}.`;
}

/* ---------------------------------------------------------------------------
 * Panel rows
 * ------------------------------------------------------------------------- */

const KIND_LABELS: Record<string, string> = {
  proper_noun_phrase: 'Name',
  camel_case: 'Brand',
  acronym: 'Acronym',
  numeric: 'Number',
  low_frequency: 'Unusual',
  hyphenated: 'Compound',
  domain_like: 'Address',
  heading_term: 'Heading',
  spoken_override: 'Spoken override',
};

const CATEGORY_LABELS: Record<VocabularyTerm['category'], string> = {
  person: 'Person',
  place: 'Place',
  brand: 'Brand',
  acronym: 'Acronym',
  technical: 'Technical',
  number: 'Number',
  other: 'Term',
};

export interface VocabularyRow {
  term: string;
  /** What the local extractor thought this was, or Luna's category. */
  label: string;
  occurrences: number;
  /** How the term should be spoken, when Luna supplied one. */
  spoken?: string;
  aliases: string[];
  /**
   * True when the row carries model-generated content. §26.5: generated
   * material is LABELLED as generated and never presented as authority.
   */
  generated: boolean;
}

/**
 * Merge the deterministic local candidates (§26.4) with Luna's enrichment
 * (§26.5). The local list is the spine — it exists offline, with no key, and
 * is what the alignment engine already uses — and analysis only annotates it.
 * A term Luna returned for a surface that is no longer a candidate (the script
 * changed) is dropped rather than shown against nothing.
 */
export function vocabularyRows(
  candidates: VocabularyCandidate[],
  analysis: VocabularyAnalysis | null,
): VocabularyRow[] {
  const bySurface = new Map<string, VocabularyTerm>();
  for (const term of analysis?.terms ?? []) bySurface.set(term.surface, term);

  return candidates.map((candidate) => {
    const enriched = bySurface.get(candidate.term);
    const localLabel = KIND_LABELS[candidate.kinds[0] ?? ''] ?? 'Term';
    const aliases = enriched
      ? [...new Set([...candidate.aliases, ...enriched.aliases])]
      : candidate.aliases;
    return {
      term: candidate.term,
      label: enriched ? CATEGORY_LABELS[enriched.category] : localLabel,
      occurrences: candidate.occurrences,
      ...(enriched && enriched.canonical_spoken !== enriched.surface
        ? { spoken: enriched.canonical_spoken }
        : {}),
      aliases,
      generated: enriched !== undefined,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Per-script cache
 * ------------------------------------------------------------------------- */

interface CacheEntry {
  sourceHash: string;
  analysis: VocabularyAnalysis;
}

/**
 * In-memory only, keyed by script AND source hash so an edited script never
 * shows the previous analysis. Deliberately not persisted: Rust owns a
 * `cache/vocabulary` directory but exposes no command to write it, and a
 * localStorage copy would be a second store nothing can clear from Settings
 * ("Clear analysis cache" maps to the Rust `vocabulary` cache kind).
 */
const cache = new Map<string, CacheEntry>();

export function cachedAnalysis(scriptId: string, sourceHash: string): VocabularyAnalysis | null {
  const entry = cache.get(scriptId);
  if (!entry || entry.sourceHash !== sourceHash) return null;
  return entry.analysis;
}

export function cacheAnalysis(
  scriptId: string,
  sourceHash: string,
  analysis: VocabularyAnalysis,
): void {
  cache.set(scriptId, { sourceHash, analysis });
}

export function clearVocabularyCache(): void {
  cache.clear();
}

/**
 * The one-line seam for the live transcription session.
 *
 * `WebRtcTranscriptionTransport` takes `getVocabularyPrompt?: () => string |
 * undefined` and feeds it to `buildSessionUpdateEvent` at connect time
 * (webrtcTransport.ts:355). Nothing supplies it, so the injection point
 * §27.5 built has never carried anything.
 *
 * This function is that supplier, and it is synchronous by design — the
 * transport dep must be. It reads the cached analysis for the script and the
 * capability registry the caller already holds, so wiring it is:
 *
 *   new WebRtcTranscriptionTransport({
 *     …,
 *     getVocabularyPrompt: () =>
 *       vocabularyPromptFor(
 *         deps.compiled.scriptId,
 *         deps.compiled.sourceHash,
 *         capabilities,              // awaited getModelCapabilities() at start
 *         deps.transcription.model,
 *       ),
 *   });
 *
 * in `services/voice-session.ts` (VoiceSession constructor) — the file another
 * agent is editing in this pass, which is why it is described rather than
 * changed. Today it returns `undefined` for every input, because the registry
 * says the realtime model does not accept prompt steering (§26.1); the value
 * of wiring it is that the capability flag, not an absent call site, is what
 * decides.
 */
export function vocabularyPromptFor(
  scriptId: string,
  sourceHash: string,
  capabilities: ModelCapabilities,
  model: string,
): string | undefined {
  const analysis = cachedAnalysis(scriptId, sourceHash);
  if (analysis === null) return undefined;
  return buildVocabularyPrompt(analysis.terms, capabilities, model);
}
