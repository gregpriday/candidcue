/**
 * Single source of truth for Project Asset Library ("Sources") size and count
 * limits. The same constants drive native import validation, the renderer
 * budget display, Zod save validation, preparation validation, and tests, so
 * the previously-divergent import (100k) and save (200k) caps stay reconciled.
 */
export const PROJECT_SOURCE_LIMITS = {
  /** Maximum number of source documents a project may hold. */
  maxDocuments: 50,
  /** Maximum files accepted in a single native import selection. */
  maxImportBatch: 50,
  /** Hard per-document character cap (content length). */
  maxCharactersPerDocument: 100_000,
  /** Hard aggregate character cap across all documents in a project. */
  maxTotalCharacters: 300_000,
  /** Soft threshold at which the UI warns the project is approaching the cap. */
  softWarningTotalCharacters: 240_000,
  /** Maximum source title length. */
  maxTitleCharacters: 200,
  /** Maximum stored original filename (basename) length. */
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
