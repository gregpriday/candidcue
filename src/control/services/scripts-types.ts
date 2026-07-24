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

/**
 * Twin of Rust `ScriptFilter` (scripts/mod.rs) — the shape that actually goes
 * over the wire.
 *
 * `view` is a UI concept and Rust has never had a field for it. It used to be
 * sent anyway; serde discarded it, so `status` stayed unset and the Trash view
 * listed the LIVE scripts. `listScripts` now translates the view here, and
 * Rust rejects any field it does not declare (`deny_unknown_fields`).
 */
export interface ScriptFilterPayload {
  query?: string;
  status?: 'draft' | 'ready' | 'archived' | 'trash';
  /** Recent view: only scripts that have been opened at least once. */
  openedOnly?: boolean;
}

/**
 * Sort keys Rust accepts. The four `ScriptSort` values are the library's own
 * options; `last_opened` exists for the Recent view, which orders by when a
 * script was last opened rather than by the sort control.
 */
export type ScriptSortPayload = ScriptSort | 'last_opened';

/** Twin of Rust `PageRequest`. Rust deserializes a struct, never a number. */
export interface ScriptPageRequest {
  page: number;
  pageSize: number;
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
