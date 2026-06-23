const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'as', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its',
  'this', 'that', 'these', 'those', 'do', 'does', 'did', 'so', 'if', 'then',
  'about', 'into', 'over', 'you', 'your', 'we', 'our', 'they', 'them',
]);

/** Collapse internal whitespace and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Count words after whitespace normalization. */
export function wordCount(text: string): number {
  const t = normalizeWhitespace(text);
  return t.length === 0 ? 0 : t.split(' ').length;
}

/** Lowercase, strip punctuation, drop stop words → content tokens. */
export function contentTokens(text: string): string[] {
  return normalizeWhitespace(text.toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/** N-word shingles over content tokens. */
export function shingles(text: string, n = 3): Set<string> {
  const tokens = contentTokens(text);
  const out = new Set<string>();
  if (tokens.length < n) {
    if (tokens.length > 0) out.add(tokens.join(' '));
    return out;
  }
  for (let i = 0; i <= tokens.length - n; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Lexical similarity in [0,1] combining token-set and shingle overlap. */
export function lexicalSimilarity(a: string, b: string): number {
  const tokenSim = jaccard(new Set(contentTokens(a)), new Set(contentTokens(b)));
  const shingleSim = jaccard(shingles(a, 3), shingles(b, 3));
  return 0.5 * tokenSim + 0.5 * shingleSim;
}

/** Split text into paragraphs on blank lines, trimming each. */
export function splitParagraphs(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => normalizeWhitespace(p))
    .filter((p) => p.length > 0);
  return paras.length > 0 ? paras : text.trim() ? [normalizeWhitespace(text)] : [];
}

/** Estimate spoken duration (ms) from word count at a given words/second. */
export function estimateSpeechMs(words: number, wordsPerSecond: number): number {
  if (wordsPerSecond <= 0) return 0;
  return Math.round((words / wordsPerSecond) * 1000);
}
