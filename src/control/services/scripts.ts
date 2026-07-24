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
  ScriptListFilter,
  ScriptPage,
  ScriptSort,
} from './scripts-types';

export async function listScripts(
  filter?: ScriptListFilter,
  sort?: ScriptSort,
  page?: number,
): Promise<ScriptPage> {
  return invokeOrMock<ScriptPage>('list_scripts', { filter, sort, page }, () =>
    mockScripts.list(filter, sort),
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
 * Import a file the user picked. Rust's `ImportOptions` requires an absolute
 * `path` — this wrapper used to send `sourcePath`, so every real import failed
 * with a Serde missing-field error before it ran.
 */
export async function importScript(options: ImportOptions): Promise<ImportResult> {
  return invokeOrMock<ImportResult>(
    'import_script',
    { options: { path: options.path, title: options.title } },
    () => {
      // MOCK: no file access in the browser fallback — placeholder document.
      const name = options.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Imported script';
      const doc = mockScripts.create({
        title: options.title ?? name,
        source: `# ${name}\n\nImported placeholder content.\n`,
      });
      return { script: doc, warnings: [] };
    },
  );
}

/**
 * Export to a destination the user picked. Rust's `ExportOptions` requires
 * `destination` and `format`, and its bundle format is `bundle` — the previous
 * wrapper made options optional and sent `candidcue`, so every export failed.
 */
export async function exportScript(
  scriptId: string,
  options: ExportOptions,
): Promise<ExportResult> {
  return invokeOrMock<ExportResult>(
    'export_script',
    {
      scriptId,
      options: {
        destination: options.destination,
        format: options.format,
        includeAssets: options.includeAssets ?? false,
      },
    },
    () => ({ path: options.destination, format: options.format, warnings: [] }),
  );
}

export async function revealScriptFolder(scriptId: string): Promise<void> {
  return invokeOrMock<void>('reveal_script_folder', { scriptId }, () => undefined);
}
