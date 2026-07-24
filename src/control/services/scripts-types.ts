/**
 * Request/response types for the script commands (spec §46.2) that are not
 * yet mirrored in `src/shared/contracts`. Kept UI-side so contract files stay
 * owned by the Rust integration; promote these additively when Rust lands.
 */
import type { ScriptSummary } from '../../shared/contracts';

export type LibraryView = 'all' | 'recent' | 'trash';

export type ScriptSort = 'recently_edited' | 'name' | 'created' | 'estimated_length';

export interface ScriptListFilter {
  view?: LibraryView;
  query?: string;
}

export interface ScriptPage {
  items: ScriptSummary[];
  total: number;
}

export interface SaveResult {
  status: 'saved' | 'conflict';
  scriptRevision: number;
  savedAt: string;
}

/** Twin of Rust `ImportOptions` (scripts/import_export.rs). */
export interface ImportOptions {
  /** Absolute path from the native open dialog. Required by Rust. */
  path: string;
  title?: string;
}

export interface ImportResult {
  script: ScriptSummary;
  warnings: string[];
}

/**
 * Twin of Rust `ExportOptions`. `format` must be one of the three strings the
 * Rust matcher accepts — `candidcue` is the file EXTENSION, not a format name.
 */
export type ExportFormat = 'markdown' | 'text' | 'bundle';

export interface ExportOptions {
  /** Absolute path from the native save dialog. Required by Rust. */
  destination: string;
  format: ExportFormat;
  includeAssets?: boolean;
}

export interface ExportResult {
  path: string;
  format: string;
  warnings: string[];
}
