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

/**
 * Twin of Rust `ImportRequest` (scripts/import_export.rs).
 *
 * There is deliberately no path here. Rust runs the native open dialog itself
 * and imports what the operator chose in the same trusted operation, so the
 * webview cannot name a file (spec §50.7). It used to send an absolute path,
 * which meant anything running in the control window could read any Markdown
 * or text file on the machine.
 */
export interface ImportOptions {
  title?: string;
}

export interface ImportResult {
  script: ScriptSummary;
  warnings: string[];
}

/**
 * Twin of Rust `ExportRequest`. `format` must be one of the three strings the
 * Rust matcher accepts — `candidcue` is the file EXTENSION, not a format name.
 *
 * As with imports there is no destination: Rust runs the save dialog and writes
 * the file in one operation. The old shape let the webview name any absolute
 * destination, which `File::create` then truncated (spec §50.7).
 */
export type ExportFormat = 'markdown' | 'text' | 'bundle';

export interface ExportOptions {
  format: ExportFormat;
  includeAssets?: boolean;
  /** Seeds the save dialog's default file name only. */
  suggestedName?: string;
}

export interface ExportResult {
  path: string;
  format: string;
  warnings: string[];
}
