/**
 * Compact phonetic keying for the candidate-generation index (spec §25.6).
 * A metaphone-flavored reduction: cheap, deterministic, and tolerant of the
 * common transcription substitutions we care about (ph/f, c/k, tio/sh, silent
 * letters). Not a linguistic gold standard — indexes only generate
 * candidates, never final alignment scores.
 */
export function phoneticKey(normalized: string): string {
  let w = normalized.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';

  // Leading silent patterns.
  w = w
    .replace(/^kn/, 'n')
    .replace(/^gn/, 'n')
    .replace(/^pn/, 'n')
    .replace(/^wr/, 'r')
    .replace(/^ps/, 's')
    .replace(/^x/, 's');

  // Multi-letter substitutions.
  w = w
    .replace(/ough/g, 'o')
    .replace(/augh/g, 'a')
    .replace(/tion/g, 'xn')
    .replace(/tia/g, 'xa')
    .replace(/sh/g, 'x')
    .replace(/ch/g, 'x')
    .replace(/ph/g, 'f')
    .replace(/th/g, '0')
    .replace(/gh/g, '')
    .replace(/wh/g, 'w')
    .replace(/ck/g, 'k')
    .replace(/dg/g, 'j')
    .replace(/mb$/g, 'm');

  // Single-letter class merges.
  w = w
    .replace(/[bp]/g, 'p')
    .replace(/[dt]/g, 't')
    .replace(/[gjq]/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/[sz]/g, 's')
    .replace(/[fvw]/g, 'f')
    .replace(/[mn]/g, 'n')
    .replace(/l/g, 'l')
    .replace(/r/g, 'r')
    .replace(/[hy]/g, '');

  // Drop vowels except a leading one, collapse runs.
  const head = /[aeiou]/.test(w.charAt(0)) ? 'a' : '';
  w = head + w.slice(head ? 1 : 0).replace(/[aeiou]/g, '');
  w = w.replace(/(.)\1+/g, '$1');
  return w.slice(0, 8);
}
