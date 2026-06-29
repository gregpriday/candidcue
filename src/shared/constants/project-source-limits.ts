/**
 * Project Asset Library ("Sources") constants. Stored content size and document
 * count are intentionally NOT capped — the operator supplies their own material —
 * so `maxCharactersPerDocument` / `maxTotalCharacters` / `maxDocuments` are
 * retained only as reference magnitudes (e.g. for tests), not enforced anywhere.
 * The enforced constants are the title length, the import batch size, the accepted
 * extensions, and `maxCompiledSourceCharacters` — the one runtime budget, derived
 * from the planner model's real context window rather than an arbitrary policy cap.
 */
export const PROJECT_SOURCE_LIMITS = {
  /** Reference only — the document count is no longer enforced. */
  maxDocuments: 50,
  /** Maximum files accepted in a single native import selection (enforced). */
  maxImportBatch: 50,
  /** Reference only — per-document content length is no longer capped. */
  maxCharactersPerDocument: 100_000,
  /** Reference only — aggregate content length is no longer capped. */
  maxTotalCharacters: 300_000,
  /**
   * Enforced budget for the compiled project-source envelope handed to the
   * preparation model (see `AppController.prepareProject`). NOT an arbitrary
   * cap — it is grounded in the planner model's real context window: gpt-5.5
   * offers ~922k input tokens; reserving ~22k tokens for the system prompt, the
   * structured-output JSON schema, and the generated plan leaves ~900k tokens
   * for the compiled source. At the standard ~4-chars-per-token heuristic
   * (slightly optimistic for Markdown/XML, hence the conservative reserve) that
   * is ~3.6M characters. Beyond this the call would fail opaquely as a context
   * overflow, so we reject early with a clear SOURCE_TOO_LARGE message.
   */
  maxCompiledSourceCharacters: 3_600_000,
  /** Maximum source title length (enforced by the Zod save schema). */
  maxTitleCharacters: 200,
  /** Maximum stored original filename (basename) length (enforced). */
  maxOriginalFilenameCharacters: 255,
  /** Lower-cased file extensions accepted by Markdown import. */
  allowedExtensions: ['.md', '.markdown'],
} as const;

export type ProjectSourceLimits = typeof PROJECT_SOURCE_LIMITS;

/**
 * Whether a filename's extension is an accepted Markdown extension. The native
 * dialog filter is not a security boundary, so importers re-check with this.
 */
export function isAllowedMarkdownExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return PROJECT_SOURCE_LIMITS.allowedExtensions.some((ext) => lower.endsWith(ext));
}
