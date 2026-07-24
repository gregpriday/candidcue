/**
 * Critical-term extraction (§19.2).
 *
 * The assertions name the exact terms found, in order, with the exact authored
 * text each one would quote. An extractor that found nothing, or that quoted a
 * normalized form instead of the author's own characters, fails here.
 */
import { describe, expect, it } from 'vitest';
import { extractCriticalTerms } from '../../../../src/shared/coaching/fidelity/terms';
import { authoredTokens, type SpanOptions } from './harness';

function terms(script: string, options: SpanOptions = {}): string[] {
  return extractCriticalTerms(authoredTokens(script, options)).terms.map(
    (term) => `${term.kind}:${term.authoredText}`,
  );
}

describe('extractCriticalTerms', () => {
  it('extracts numbers, units and negations in authored order', () => {
    expect(terms('The result is not 1,500 ms on a cold cache.')).toEqual([
      'negation:not 1,500',
      'number:1,500',
      'unit:ms',
    ]);
  });

  it('keeps the authored surface exactly, including the percent sign', () => {
    expect(terms('Adoption reached 62% overall.')).toEqual([
      'number:62%',
      'unit:62%',
    ]);
  });

  it('folds a scale word into the numeric value', () => {
    const extracted = extractCriticalTerms(authoredTokens('The fund holds $50 million today.'));
    const number = extracted.terms.find((term) => term.kind === 'number');
    expect(number?.value).toBe(50_000_000);
    expect(number?.authoredText).toBe('$50 million');
  });

  it('reads spelled-out numbers as values', () => {
    const extracted = extractCriticalTerms(authoredTokens('We grew fifteen hundred accounts.'));
    const number = extracted.terms.find((term) => term.kind === 'number');
    expect(number?.value).toBe(1500);
    expect(number?.authoredText).toBe('fifteen hundred');
  });

  it('marks ordinals so ordinal wordings are accepted', () => {
    const extracted = extractCriticalTerms(authoredTokens('We placed 3rd overall.'));
    const number = extracted.terms.find((term) => term.kind === 'number');
    expect(number?.value).toBe(3);
    expect(number?.ordinal).toBe(true);
  });

  it('quotes a negation together with the word it scopes over (§25.5)', () => {
    const extracted = extractCriticalTerms(authoredTokens('The data is not available yet.'));
    const negation = extracted.terms.find((term) => term.kind === 'negation');
    expect(negation?.authoredText).toBe('not available');
    expect(negation?.negatedStems).toContain('available');
  });

  it('treats a contraction as a negation', () => {
    expect(terms('We don’t ship on Fridays.')).toEqual(['negation:don’t ship']);
  });

  it('finds proper nouns but not sentence-initial capitals', () => {
    expect(terms('Revenue rose after Ndlovu joined the board.')).toEqual(['name:Ndlovu']);
  });

  it('merges consecutive proper nouns into one name', () => {
    expect(terms('We spoke to Sarah Ndlovu yesterday.')).toEqual(['name:Sarah Ndlovu']);
  });

  it('defers to the compiler flags when they are supplied', () => {
    const script = 'Our partner Acme confirmed the schedule.';
    expect(terms(script, { properNouns: ['Acme'] })).toEqual(['name:Acme']);
    // Flags present and not set means "the compiler says this is not a name",
    // and the heuristic must not override it.
    expect(terms(script, { properNouns: [] })).toEqual([]);
  });

  it('does not extract URLs, emails or acronyms', () => {
    // Each of these is read aloud in ways no local comparator can predict, so
    // they are left out rather than checked badly.
    expect(terms('See docs.example.com or email us@example.com about the API.')).toEqual([]);
  });

  it('does not extract month names', () => {
    expect(terms('The report lands in March before the board meets.')).toEqual([]);
  });

  it('never claims the same word for two terms', () => {
    const extracted = extractCriticalTerms(authoredTokens('It is not 20 minutes but 30 minutes.'));
    const covered = new Set<number>();
    for (const term of extracted.terms) {
      for (let index = term.wordStart; index < term.wordEnd; index++) {
        expect(covered.has(index)).toBe(false);
        covered.add(index);
      }
    }
    expect(extracted.terms.length).toBeGreaterThan(2);
  });
});
