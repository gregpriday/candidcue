/**
 * The commands the recovery screen uses.
 *
 * Everything here works on FILES. None of it opens the damaged database for
 * writing, and none of it needs the application to have started — which is the
 * point, because the failures it exists for are the ones that stop it starting.
 *
 * `getBootStatus` is asked BEFORE the shell routes anywhere. Until this
 * existed, `DATABASE_CORRUPT` and a failed migration aborted Tauri's setup hook
 * before a webview existed, so the boot-failure screen the frontend already
 * had could not be reached by the two codes it was written for — its own
 * comment said so.
 */
import { ipcInvoke, isTauriRuntime } from './ipc';

export interface BootStatusReport {
  /** `false` means the application must not open; only recovery may. */
  databaseReady: boolean;
  /** The stable error code, for the recovery copy to branch on. */
  code?: string;
  message?: string;
  /** Where the user's data is, so the screen can offer to reveal it. */
  dataDirectory: string;
}

export interface DatabaseBackup {
  /** File name only — the screen never handles a path. */
  name: string;
  bytes: number;
  takenAt?: string;
  appVersion?: string;
  schemaVersionBefore?: number;
  /** Whether it passes `PRAGMA quick_check` right now. */
  verified: boolean;
}

export interface RecoveryOutcome {
  previousStateAt: string;
  restartRequired: boolean;
}

export interface ScriptRescueResult {
  path: string;
  scriptsCopied: number;
}

/**
 * Did CandidCue actually start?
 *
 * A browser dev session has no Rust at all, and "no backend" is not "broken
 * database" — reporting a boot failure there would put the recovery screen in
 * front of every `pnpm dev`.
 */
export async function getBootStatus(): Promise<BootStatusReport> {
  if (!isTauriRuntime()) {
    return { databaseReady: true, dataDirectory: '' };
  }
  return await ipcInvoke<BootStatusReport>('get_boot_status');
}

export async function listDatabaseBackups(): Promise<DatabaseBackup[]> {
  return await ipcInvoke<DatabaseBackup[]>('list_database_backups');
}

/** `name` comes from `listDatabaseBackups`; Rust refuses anything path-shaped. */
export async function restoreDatabaseBackup(name: string): Promise<RecoveryOutcome> {
  return await ipcInvoke<RecoveryOutcome>('restore_database_backup', { name });
}

export async function rebuildDatabaseIndex(): Promise<RecoveryOutcome> {
  return await ipcInvoke<RecoveryOutcome>('rebuild_database_index');
}

/** Get the writing out first. Reads the canonical tree; needs no database. */
export async function rescueScripts(): Promise<ScriptRescueResult | null> {
  return await ipcInvoke<ScriptRescueResult | null>('rescue_scripts');
}

export async function revealDataFolder(): Promise<void> {
  await ipcInvoke<void>('reveal_data_folder');
}

/**
 * Park editor text that could not be saved, so closing cannot lose it.
 *
 * Returns the path it was written to. Writes to `quarantine/unsaved/`, never
 * to the canonical file — in a conflict the canonical file holds someone
 * else's newer text, and overwriting it here would resolve the conflict by
 * destroying one side of it during a quit.
 */
export async function writeUnsavedRecovery(scriptId: string, source: string): Promise<string> {
  return await ipcInvoke<string>('write_unsaved_recovery', { scriptId, source });
}

/**
 * What the recovery screen leads with, by failure code.
 *
 * Pure and exported so the wording is testable without mounting anything. Each
 * one names the state of the user's data explicitly, because the single most
 * useful thing this screen can say is that the scripts are files and the files
 * are fine.
 */
export function describeBootFailure(status: BootStatusReport): string {
  switch (status.code) {
    case 'DATABASE_CORRUPT':
      return (
        'CandidCue’s database failed its integrity check, so it has not been changed. ' +
        'Your scripts are separate Markdown files and are unaffected — you can save them ' +
        'somewhere else right now, and rebuilding reads them back in.'
      );
    case 'DATABASE_MIGRATION_FAILED':
      return (
        'CandidCue could not upgrade its database to this version, and stopped rather than ' +
        'leaving it half-changed. Your scripts are separate Markdown files and are ' +
        'unaffected. Restoring the backup taken before the upgrade is usually the fastest ' +
        'way back.'
      );
    case 'DATABASE_BACKUP_REQUIRED':
      return (
        'CandidCue needs to upgrade its database but could not first save a backup of it, ' +
        'so it made no changes at all. This is usually a full disk or a permissions problem ' +
        'in CandidCue’s data folder. Your scripts are unaffected.'
      );
    default:
      return (
        status.message ??
        'CandidCue could not open its database. Your scripts are separate Markdown files ' +
          'and are unaffected.'
      );
  }
}

/**
 * What startup reconciliation found on this launch, if anything.
 *
 * Read once and cleared by Rust. Reconciliation runs inside Tauri's setup hook,
 * before the control webview has executed a line of JavaScript, so the
 * `diagnostic://warning` it emits can land on a page with no listeners — the
 * Rust comment called the emit "best effort" and pointed at a diagnostics file
 * as the fallback, which is a file nobody opens.
 *
 * A repair that rewrote somebody's script index is worth telling them about,
 * so the findings wait to be collected rather than being shouted into an empty
 * room.
 */
export async function getStartupFindings(): Promise<Record<string, unknown> | null> {
  if (!isTauriRuntime()) return null;
  return await ipcInvoke<Record<string, unknown> | null>('get_startup_findings');
}
