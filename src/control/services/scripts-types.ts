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

export interface ImportResult {
  script: ScriptSummary;
  warnings: string[];
}

export interface ExportResult {
  path?: string;
  cancelled: boolean;
}
