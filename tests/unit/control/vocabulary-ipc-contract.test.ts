/**
 * Vocabulary analysis (§26) and the model capability registry (§27.8).
 *
 * The payload assertions drive the real wrappers against the fixture
 * `src-tauri/tests/ipc_contract_tests.rs` also reads. The gating assertions are
 * pure.
 *
 * MOCK CAVEAT: both services fall back to a mock outside Tauri — an EMPTY
 * analysis and an all-false capability set. Both are deliberately the
 * conservative answer (never a fabricated pronunciation, never an assumed
 * capability), and neither can satisfy an assertion below: every test either
 * stubs `ipc` and inspects what was sent, or calls a pure function directly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/openai-command-payloads.json';
import type { ModelCapabilities } from '../../../src/control/services/capabilities';
import type {
  VocabularyAnalysis,
  VocabularyRequest,
  VocabularyTerm,
} from '../../../src/control/services/vocabulary';
import type { CompiledScript } from '../../../src/shared/contracts';
import { compile } from '../../../src/shared/markdown/compile';
import { extractVocabularyCandidates } from '../../../src/shared/markdown/vocabulary';

const calls: { command: string; payload: unknown }[] = [];
let nextResult: unknown = null;

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  invokeOrMock: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return nextResult;
  },
  BackendUnavailableError: class extends Error {},
}));

const capabilitiesService = await import('../../../src/control/services/capabilities');
const vocabulary = await import('../../../src/control/services/vocabulary');

const capabilities: ModelCapabilities = fixture.expectedModelCapabilities as ModelCapabilities;
const term: VocabularyTerm = fixture.expectedVocabularyTerm as VocabularyTerm;

describe('vocabulary + capability IPC payloads', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = null;
    capabilitiesService.resetCapabilitiesCache();
  });

  it('analyze_vocabulary nests the request under `request`', async () => {
    nextResult = { terms: [] };
    await vocabulary.analyzeVocabulary(
      fixture.analyze_vocabulary.request as VocabularyRequest,
    );
    expect(calls[0]!.command).toBe('analyze_vocabulary');
    expect(calls[0]!.payload).toEqual(fixture.analyze_vocabulary);
  });

  /**
   * `SemanticRequestOptions` is flattened into the Rust request, so options
   * belong at the top level. Nesting them parses and applies none of them.
   */
  it('sends semantic options at the top level of the request', async () => {
    nextResult = { terms: [] };
    await vocabulary.analyzeVocabulary(
      fixture.analyze_vocabulary_with_options.request as VocabularyRequest,
    );
    const sent = (calls[0]!.payload as { request: Record<string, unknown> }).request;
    expect(sent.timeoutMs).toBe(45000);
    expect(Object.keys(sent)).not.toContain('options');
    expect(calls[0]!.payload).toEqual(fixture.analyze_vocabulary_with_options);
  });

  /** An empty candidate list is answered locally — Rust would too, but a round
   * trip for nothing is a round trip with an API key attached. */
  it('does not call the model with no candidates', async () => {
    const result = await vocabulary.analyzeVocabulary({ language: 'en', candidates: [] });
    expect(result).toEqual({ terms: [] });
    expect(calls).toHaveLength(0);
  });

  it('get_model_capabilities takes no arguments and is fetched once', async () => {
    nextResult = capabilities;
    const first = await capabilitiesService.getModelCapabilities();
    const second = await capabilitiesService.getModelCapabilities();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('get_model_capabilities');
    expect(calls[0]!.payload).toBeUndefined();
    expect(first.registryVersion).toBe(2);
    expect(second).toBe(first);
  });
});

describe('the capability registry actually gates something (§26.1)', () => {
  /**
   * This is the whole point of wiring the registry. §26.1: the primary
   * realtime model does not accept prompt steering, and the app must isolate
   * that assumption behind capability metadata rather than assuming either way.
   */
  it('withholds the vocabulary prompt when the model cannot steer', () => {
    expect(capabilities.realtimePromptSteering).toBe(false);
    expect(
      vocabulary.buildVocabularyPrompt([term], capabilities, capabilities.realtimeModel),
    ).toBeUndefined();
  });

  it('builds a compact prompt when a model does accept one', () => {
    const steering: ModelCapabilities = { ...capabilities, realtimePromptSteering: true };
    expect(vocabulary.buildVocabularyPrompt([term], steering, steering.realtimeModel)).toBe(
      'Vocabulary: CandidCue.',
    );
  });

  /**
   * A capability measured for one model says nothing about another. The user
   * can change the realtime model in Settings.
   */
  it('refuses to apply one model’s capability to a different model', () => {
    const steering: ModelCapabilities = { ...capabilities, realtimePromptSteering: true };
    expect(
      vocabulary.buildVocabularyPrompt([term], steering, 'some-other-model'),
    ).toBeUndefined();
  });

  it('treats unknown capabilities as unsupported, never as permitted', () => {
    const unknown = capabilitiesService.UNKNOWN_CAPABILITIES;
    expect(capabilitiesService.supportsVocabularyPrompt(unknown, 'gpt-realtime-whisper')).toBe(
      false,
    );
    expect(capabilitiesService.supportsVocabularyAnalysis(unknown)).toBe(false);
    expect(capabilitiesService.supportsVocabularyAnalysis(capabilities)).toBe(true);
  });

  it('drops low-importance terms from the prompt', () => {
    const steering: ModelCapabilities = { ...capabilities, realtimePromptSteering: true };
    const weak: VocabularyTerm = { ...term, surface: 'Weak', importance: 0.1 };
    const prompt = vocabulary.buildVocabularyPrompt(
      [term, weak],
      steering,
      steering.realtimeModel,
    );
    expect(prompt).toContain('CandidCue');
    expect(prompt).not.toContain('Weak');
  });
});

describe('building the §26.5 request from a compiled script', () => {
  const source = [
    '# Launch notes',
    '',
    'Welcome to CandidCue, the teleprompter that listens. CandidCue was built by',
    'SiteOrigin in Cape Town.',
    '',
  ].join('\n');

  function compiled(): CompiledScript {
    return compile(source, { scriptId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
  }

  it('sends candidate surfaces with bounded context, never the whole script', () => {
    const script = compiled();
    const request = vocabulary.buildVocabularyRequest(script);
    expect(request.language).toBe('en');
    expect(request.candidates.length).toBeGreaterThan(0);
    expect(request.candidates.map((c) => c.surface)).toContain('CandidCue');
    for (const candidate of request.candidates) {
      // §26.5: candidates plus a small amount of context — Rust also takes
      // only the first three.
      expect(candidate.contexts.length).toBeLessThanOrEqual(3);
      for (const context of candidate.contexts) {
        expect(context.split(/\s+/).length).toBeLessThanOrEqual(13);
      }
    }
  });

  it('is deterministic for the same compile', () => {
    expect(vocabulary.buildVocabularyRequest(compiled())).toEqual(
      vocabulary.buildVocabularyRequest(compiled()),
    );
  });
});

describe('vocabulary panel rows', () => {
  const source = 'Welcome to CandidCue, the teleprompter that listens.\n';
  const script = compile(source, { scriptId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
  const candidates = extractVocabularyCandidates(script);

  it('lists local candidates with no analysis at all', () => {
    const rows = vocabulary.vocabularyRows(candidates, null);
    expect(rows.length).toBe(candidates.length);
    expect(rows.every((row) => row.generated === false)).toBe(true);
  });

  /** §26.5: model output is labelled as generated, never presented as fact. */
  it('labels enriched rows as generated and carries the spoken form', () => {
    const analysis: VocabularyAnalysis = { terms: [term] };
    const rows = vocabulary.vocabularyRows(candidates, analysis);
    const enriched = rows.find((row) => row.term === 'CandidCue');
    expect(enriched).toBeDefined();
    expect(enriched!.generated).toBe(true);
    expect(enriched!.spoken).toBe('Candid Cue');
    expect(enriched!.aliases).toContain('candy cue');
    expect(enriched!.label).toBe('Brand');
  });

  /**
   * An analysis that outlived the edit which produced it must not attach
   * pronunciations to words that are no longer in the script.
   */
  it('drops analysis terms whose surface is no longer a candidate', () => {
    const stale: VocabularyAnalysis = { terms: [{ ...term, surface: 'RemovedWord' }] };
    const rows = vocabulary.vocabularyRows(candidates, stale);
    expect(rows.some((row) => row.term === 'RemovedWord')).toBe(false);
    expect(rows.every((row) => row.generated === false)).toBe(true);
  });
});

describe('the per-script analysis cache', () => {
  beforeEach(() => vocabulary.clearVocabularyCache());

  /**
   * The sync supplier the realtime transport needs. It is `undefined` today
   * for every input — the registry says the model cannot steer — which is
   * precisely the point: the capability decides, not an absent call site.
   */
  it('supplies the session prompt from the cache, gated by the registry', () => {
    vocabulary.cacheAnalysis('script-1', 'hash-a', { terms: [term] });
    expect(
      vocabulary.vocabularyPromptFor('script-1', 'hash-a', capabilities, 'gpt-realtime-whisper'),
    ).toBeUndefined();

    const steering: ModelCapabilities = { ...capabilities, realtimePromptSteering: true };
    expect(
      vocabulary.vocabularyPromptFor('script-1', 'hash-a', steering, 'gpt-realtime-whisper'),
    ).toBe('Vocabulary: CandidCue.');
    // No analysis for that source: nothing to steer with.
    expect(
      vocabulary.vocabularyPromptFor('script-1', 'hash-b', steering, 'gpt-realtime-whisper'),
    ).toBeUndefined();
  });

  it('returns nothing for a different source hash', () => {
    vocabulary.cacheAnalysis('script-1', 'hash-a', { terms: [term] });
    expect(vocabulary.cachedAnalysis('script-1', 'hash-a')!.terms).toHaveLength(1);
    expect(vocabulary.cachedAnalysis('script-1', 'hash-b')).toBeNull();
    expect(vocabulary.cachedAnalysis('script-2', 'hash-a')).toBeNull();
  });
});
