/**
 * Script library/document service — thin typed wrappers over the spec §46.2
 * commands. Command names are exact; payload keys are camelCase. While the
 * Rust side is unimplemented, calls fall through to the mock backend.
 */
import type { ScriptDocument, ScriptSummary } from '../../shared/contracts';
import { invokeOrMock } from './ipc';
import { mockScripts } from './mock-backend';
import type {
  ExportResult,
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

export async function duplicateScript(scriptId: string): Promise<ScriptSummary> {
  return invokeOrMock<ScriptSummary>('duplicate_script', { scriptId }, () =>
    mockScripts.duplicate(scriptId),
  );
}

export async function trashScript(scriptId: string): Promise<void> {
  return invokeOrMock<void>('trash_script', { scriptId }, () => mockScripts.trash(scriptId));
}

export async function restoreScript(scriptId: string): Promise<ScriptSummary> {
  return invokeOrMock<ScriptSummary>('restore_script', { scriptId }, () =>
    mockScripts.restore(scriptId),
  );
}

export async function permanentlyDeleteScript(scriptId: string): Promise<void> {
  return invokeOrMock<void>('permanently_delete_script', { scriptId }, () =>
    mockScripts.deletePermanently(scriptId),
  );
}

export async function importScript(options: { sourcePath?: string }): Promise<ImportResult> {
  return invokeOrMock<ImportResult>('import_script', { options }, () => {
    // MOCK: no file access in the browser fallback — create a placeholder doc.
    const name = options.sourcePath?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Imported script';
    const doc = mockScripts.create({ title: name, source: `# ${name}\n\nImported placeholder content.\n` });
    return { script: doc, warnings: [] };
  });
}

export async function exportScript(
  scriptId: string,
  options?: { format?: 'markdown' | 'candidcue' },
): Promise<ExportResult> {
  return invokeOrMock<ExportResult>('export_script', { scriptId, options }, () => ({
    cancelled: false,
  }));
}

export async function revealScriptFolder(scriptId: string): Promise<void> {
  return invokeOrMock<void>('reveal_script_folder', { scriptId }, () => undefined);
}
