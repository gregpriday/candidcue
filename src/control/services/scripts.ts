/**
 * Script library/document service — thin typed wrappers over the spec §46.2
 * commands. Command names are exact; payload keys are camelCase. While the
 * Rust side is unimplemented, calls fall through to the mock backend.
 */
import type { ScriptDocument, ScriptSummary } from '../../shared/contracts';
import { invokeOrMock } from './ipc';
import { mockScripts } from './mock-backend';
import type {
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  SaveResult,
  ScriptFilterPayload,
  ScriptListFilter,
  ScriptPage,
  ScriptPageRequest,
  ScriptSort,
  ScriptSortPayload,
} from './scripts-types';

/**
 * Translate the library's `view` into the fields Rust's `ScriptFilter`
 * declares. Rust has no `view`; sending one is what made the Trash view list
 * live scripts, and `deny_unknown_fields` now makes that mistake fail loudly.
 *
 *  - `trash`  → `status: 'trash'`
 *  - `recent` → live scripts that have been opened, ordered by when
 *  - `all`    → neither field, which Rust reads as "everything but trash"
 */
export function toScriptFilterPayload(filter?: ScriptListFilter): ScriptFilterPayload | undefined {
  if (!filter) return undefined;
  const payload: ScriptFilterPayload = {};
  if (filter.query !== undefined && filter.query !== '') payload.query = filter.query;
  if (filter.view === 'trash') payload.status = 'trash';
  if (filter.view === 'recent') payload.openedOnly = true;
  return payload;
}

export async function listScripts(
  filter?: ScriptListFilter,
  sort?: ScriptSort,
  page?: ScriptPageRequest,
): Promise<ScriptPage> {
  // The Recent view is ordered by when a script was last opened; the sort
  // control is hidden there (Library.svelte) because it would not apply.
  const wireSort: ScriptSortPayload | undefined =
    filter?.view === 'recent' ? 'last_opened' : sort;
  return invokeOrMock<ScriptPage>(
    'list_scripts',
    { filter: toScriptFilterPayload(filter), sort: wireSort, page },
    () => mockScripts.list(filter, sort),
  );
}

export async function createScript(input: { title: string; source: string }): Promise<ScriptDocument> {
  return invokeOrMock<ScriptDocument>('create_script', { input }, () => mockScripts.create(input));
}

export async function getScript(scriptId: string): Promise<ScriptDocument> {
  return invokeOrMock<ScriptDocument>('get_script', { scriptId }, () => mockScripts.get(scriptId));
}

export async function saveScript(
  scriptId: string,
  expectedRevision: number,
  source: string,
  metadataPatch?: { title?: string },
): Promise<SaveResult> {
  return invokeOrMock<SaveResult>(
    'save_script',
    { scriptId, expectedRevision, source, metadataPatch },
    () => mockScripts.save(scriptId, expectedRevision, source, metadataPatch),
  );
}

export async function renameScript(
  scriptId: string,
  title: string,
  expectedRevision: number,
): Promise<ScriptSummary> {
  return invokeOrMock<ScriptSummary>('rename_script', { scriptId, title, expectedRevision }, () =>
    mockScripts.rename(scriptId, title),
  );
}

/**
 * Trash and restore are optimistic-concurrency transitions like a save: Rust
 * requires the revision the caller believes it is acting on and returns the
 * one that follows, so a stale library row can never clobber a concurrent
 * edit (spec §48.4).
 */

export async function duplicateScript(scriptId: string): Promise<ScriptSummary> {
  return invokeOrMock<ScriptSummary>('duplicate_script', { scriptId }, () =>
    mockScripts.duplicate(scriptId),
  );
}

export async function trashScript(
  scriptId: string,
  expectedRevision: number,
): Promise<ScriptSummary> {
  return invokeOrMock<ScriptSummary>('trash_script', { scriptId, expectedRevision }, () =>
    mockScripts.trash(scriptId),
  );
}

export async function restoreScript(
  scriptId: string,
  expectedRevision: number,
): Promise<ScriptSummary> {
  return invokeOrMock<ScriptSummary>('restore_script', { scriptId, expectedRevision }, () =>
    mockScripts.restore(scriptId),
  );
}

export async function permanentlyDeleteScript(scriptId: string): Promise<void> {
  return invokeOrMock<void>('permanently_delete_script', { scriptId }, () =>
    mockScripts.deletePermanently(scriptId),
  );
}

/**
 * Import a script. Rust runs the native open dialog and imports what the
 * operator chose in one trusted operation, so this wrapper sends no path
 * (spec §50.7). `null` means the operator cancelled the dialog.
 */
export async function importScript(options: ImportOptions = {}): Promise<ImportResult | null> {
  return invokeOrMock<ImportResult | null>(
    'import_script',
    { request: { title: options.title } },
    () => {
      // MOCK: no file access in the browser fallback — placeholder document.
      const name = options.title ?? 'Imported script';
      const doc = mockScripts.create({
        title: name,
        source: `# ${name}\n\nImported placeholder content.\n`,
      });
      return { script: doc, warnings: [] };
    },
  );
}

/**
 * Export a script. Rust runs the native save dialog and writes the file in the
 * same operation; `suggestedName` only seeds the dialog's default file name.
 * `null` means the operator cancelled the dialog.
 */
export async function exportScript(
  scriptId: string,
  options: ExportOptions,
): Promise<ExportResult | null> {
  return invokeOrMock<ExportResult | null>(
    'export_script',
    {
      scriptId,
      request: {
        format: options.format,
        includeAssets: options.includeAssets ?? false,
        suggestedName: options.suggestedName,
      },
    },
    () => ({ path: options.suggestedName ?? 'script', format: options.format, warnings: [] }),
  );
}

export async function revealScriptFolder(scriptId: string): Promise<void> {
  return invokeOrMock<void>('reveal_script_folder', { scriptId }, () => undefined);
}
