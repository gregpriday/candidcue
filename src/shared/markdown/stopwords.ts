/**
 * English stopword / filler-like common word list used for token weighting
 * (spec §25.7) and rare-token indexing (spec §25.6). Bounded on purpose;
 * light-weight rather than exhaustive.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for',
  'of', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'about', 'into',
  'over', 'under', 'up', 'down', 'out', 'off', 'as', 'than', 'then',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having',
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'they', 'them', 'their', 'theirs',
  'this', 'that', 'these', 'those', 'there', 'here',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'not', 'no', 'yes', 'if', 'else', 'because', 'while', 'until',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'too', 'very', 'just', 'also', 'now',
  'again', 'once', 'ever', 'never', 'always',
  'well', 'like', 'really', 'actually', 'basically', 'right', 'okay', 'ok',
  'um', 'uh', 'hmm',
  "it's", "that's", "i'm", "we're", "you're", "don't", "doesn't", "didn't",
  "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "let's",
  'its', 'thats', 'im', 'were', 'youre', 'dont', 'doesnt', 'didnt',
  'cant', 'wont', 'isnt', 'arent', 'wasnt', 'werent', 'lets',
  'get', 'got', 'go', 'going', 'gone', 'come', 'came',
  'make', 'made', 'take', 'took', 'put', 'let', 'say', 'said', 'see', 'saw',
  'one', 'two', 'thing', 'things', 'way', 'lot', 'bit', 'kind', 'sort',
]);

export function isStopword(normalized: string): boolean {
  return STOPWORDS.has(normalized);
}
