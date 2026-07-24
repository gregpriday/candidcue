import { describe, expect, it } from 'vitest';
import { compile } from './compile';
import { extractVocabularyCandidates } from './vocabulary';

const OPTS = { scriptId: 'vocab-test' };

const SOURCE = `# Vocabulary Extraction Test

This vocabulary extraction pass covers many unusual terms.

Last year, Sarah Chen presented the QuantumFlow architecture at NeurIPS.

The API uses OAuth for auth, and the SDK ships with TypeScript types.

We measured a 37ms latency on GPT-4 with the new pipeline. The rollout hit
ninety-nine point nine percent uptime across all self-hosted regions.

Contact us at hello@quantumflow.ai or visit quantumflow.ai for the docs.

Sarah Chen also mentioned the idiosyncratic hyperparameter sweep.

The CandidCue{say="Candid Cue"} brand name needs an override.
`;

describe('extractVocabularyCandidates (spec §26.4)', () => {
  const compiled = compile(SOURCE, OPTS);
  const candidates = extractVocabularyCandidates(compiled);
  const byTerm = new Map(candidates.map((c) => [c.normalized, c]));

  it('finds capitalized multiword phrases that are not sentence starts', () => {
    const phrase = candidates.find((c) => c.kinds.includes('proper_noun_phrase'));
    expect(phrase).toBeDefined();
    expect(phrase!.term.toLowerCase()).toContain('sarah chen');
  });

  it('finds CamelCase brand names', () => {
    const camel = byTerm.get('quantumflow');
    expect(camel).toBeDefined();
    expect(camel!.kinds).toContain('camel_case');
  });

  it('finds acronyms and initialisms', () => {
    for (const term of ['api', 'sdk', 'oauth']) {
      const hit = byTerm.get(term);
      expect(hit, term).toBeDefined();
    }
    expect(byTerm.get('api')!.kinds).toContain('acronym');
  });

  it('finds tokens containing digits', () => {
    const mixed = candidates.filter((c) => c.kinds.includes('numeric'));
    expect(mixed.map((c) => c.normalized)).toEqual(
      expect.arrayContaining(['37ms', 'gpt-4']),
    );
  });

  it('finds hyphenated compounds', () => {
    const hyphenated = candidates.filter((c) => c.kinds.includes('hyphenated'));
    expect(hyphenated.map((c) => c.normalized)).toEqual(
      expect.arrayContaining(['ninety-nine', 'self-hosted']),
    );
  });

  it('finds email-like and domain-like strings', () => {
    const domainLike = candidates.filter((c) => c.kinds.includes('domain_like'));
    expect(domainLike.length).toBeGreaterThanOrEqual(1);
  });

  it('marks terms that appear in headings', () => {
    const heading = candidates.filter((c) => c.kinds.includes('heading_term'));
    expect(heading.map((c) => c.normalized)).toContain('vocabulary');
  });

  it('captures explicit spoken overrides', () => {
    const override = byTerm.get('candidcue');
    expect(override).toBeDefined();
    expect(override!.kinds).toContain('spoken_override');
    expect(override!.aliases).toContain('candid cue');
  });

  it('excludes ordinary common words and stopwords', () => {
    expect(byTerm.has('the')).toBe(false);
    expect(byTerm.has('and')).toBe(false);
    expect(byTerm.has('with')).toBe(false);
  });

  it('excludes long opaque hashes and URLs as URLs', () => {
    const hashSource = 'Deploy commit c0ffee1234deadbeef4242c0ffee1234deadbeef today. See https://example.com/x for details.';
    const hashCompiled = compile(hashSource, OPTS);
    const hashCandidates = extractVocabularyCandidates(hashCompiled);
    expect(
      hashCandidates.some((c) => c.normalized.includes('c0ffee1234deadbeef')),
    ).toBe(false);
  });

  it('is deterministic and sorted by occurrences', () => {
    const again = extractVocabularyCandidates(compile(SOURCE, OPTS));
    expect(again).toEqual(candidates);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1]!.occurrences).toBeGreaterThanOrEqual(candidates[i]!.occurrences);
    }
  });
});
