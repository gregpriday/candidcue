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
  /** The file in the copy naming each script's folder, when it was written. */
  namesFile?: string;
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
  const answer = await ipcInvoke<unknown>('get_boot_status');
  /*
   * Validated, not dereferenced.
   *
   * `boot.databaseReady` on whatever came back is one malformed reply away
   * from a `TypeError` thrown out of the shell's startup path — which is
   * exactly what happened: a backend that answered `null` produced "Cannot
   * read properties of null (reading 'databaseReady')" on the generic
   * could-not-start screen, telling the user nothing and pointing the reader
   * at the wrong file.
   *
   * An unusable answer fails CLOSED, for the same reason a rejection does
   * (see the caller in `App.svelte`): the command exists, it was asked, and
   * what came back cannot be read. Assuming the database is fine on the
   * strength of an answer nobody can parse is the situation this whole gate
   * was added for.
   */
  if (typeof answer !== 'object' || answer === null) {
    return {
      databaseReady: false,
      code: 'DATABASE_UNAVAILABLE',
      message:
        'CandidCue could not determine whether its database opened: it asked, and the ' +
        'answer could not be read.',
      dataDirectory: '',
    };
  }
  const report = answer as Partial<BootStatusReport>;
  return {
    ...report,
    // A missing flag is not a `true` flag.
    databaseReady: report.databaseReady === true,
    dataDirectory: typeof report.dataDirectory === 'string' ? report.dataDirectory : '',
  };
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
 * The recovery screen's heading, by failure code: what happened, in a few
 * words, before anything explains it.
 *
 * An answer nobody could read gets its own, because "could not open" is a
 * diagnosis the screen does not have — the database may be perfectly fine.
 */
export function bootFailureTitle(status: BootStatusReport): string {
  switch (status.code) {
    case 'DATABASE_CORRUPT':
      return 'CandidCue’s database is damaged';
    case 'DATABASE_MIGRATION_FAILED':
      return 'CandidCue couldn’t finish updating';
    case 'DATABASE_BACKUP_REQUIRED':
      return 'CandidCue couldn’t back up its database';
    case 'DATABASE_UNAVAILABLE':
      return 'CandidCue couldn’t check its database';
    default:
      return 'CandidCue couldn’t open its database';
  }
}

/**
 * What happened, by failure code, in the words the screen explains it with.
 *
 * Pure and exported so the wording is testable without mounting anything. It
 * is the CAUSE only. That the scripts are safe is said once, by the screen,
 * above every one of these — it used to be repeated inside each of them as
 * well, so the same reassurance was read two and three times over.
 */
export function describeBootFailure(status: BootStatusReport): string {
  switch (status.code) {
    case 'DATABASE_CORRUPT':
      return (
        'CandidCue checks its database every time it opens, and this time it found damage, ' +
        'so it stopped without changing anything.'
      );
    case 'DATABASE_MIGRATION_FAILED':
      return (
        'This version of CandidCue needed to update its database and couldn’t, so it ' +
        'stopped rather than leave the database half-changed.'
      );
    case 'DATABASE_BACKUP_REQUIRED':
      return (
        'This version of CandidCue needs to update its database, and it always saves a ' +
        'backup first. It couldn’t save one, so it changed nothing. That usually means the ' +
        'disk is full, or CandidCue isn’t allowed to write to its data folder.'
      );
    /*
     * The shell's own wording for this one narrates the exchange ("it asked,
     * and the answer could not be read"). What the person needs is the
     * consequence; the exchange is in the log.
     */
    case 'DATABASE_UNAVAILABLE':
      return 'CandidCue couldn’t confirm that its database was ready, so it opened nothing.';
    default:
      return status.message ?? 'CandidCue couldn’t open its database.';
  }
}

export type RepairAdvice = 'restore' | 'rebuild' | 'reopen';

/**
 * Which way back the screen recommends.
 *
 * - `restore` — an update failed, and the backup saved just before it is the
 *   state the user had a moment ago.
 * - `rebuild` — the database is damaged, or an update failed with no usable
 *   backup: the script files are what is left to build from.
 * - `reopen` — nothing says the database is damaged. A backup that could not be
 *   taken is a disk or permissions problem, and an unreadable answer may be a
 *   one-off; replacing a database that may well be fine, on a guess, is the
 *   wrong first move.
 *
 * `backups` is `null` while they are still being listed, or when they could
 * not be — a failed update cannot be advised on until the screen knows whether
 * there is a backup to go back to, so it says nothing rather than guess.
 */
export function recommendRepair(
  status: BootStatusReport,
  backups: readonly DatabaseBackup[] | null,
): RepairAdvice | null {
  switch (status.code) {
    case 'DATABASE_MIGRATION_FAILED':
      if (backups === null) return null;
      return backups.some((backup) => backup.verified) ? 'restore' : 'rebuild';
    case 'DATABASE_CORRUPT':
      return 'rebuild';
    default:
      return 'reopen';
  }
}

/**
 * What startup reconciliation found on this launch, if anything.
 *
 * Read once and cleared by Rust. Reconciliation runs inside Tauri's setup hook,
 * before the control webview has executed a line of JavaScript, so the
 * `diagnostic://warning` it used to emit landed on a page with no listeners —
 * the Rust comment called the emit "best effort" and pointed at a diagnostics
 * file as the fallback, which is a file nobody opens. That emit is gone; this
 * is the delivery.
 *
 * A repair that rewrote somebody's script index is worth telling them about,
 * so the findings wait to be collected rather than being shouted into an empty
 * room.
 */
export async function getStartupFindings(): Promise<Record<string, unknown> | null> {
  if (!isTauriRuntime()) return null;
  return await ipcInvoke<Record<string, unknown> | null>('get_startup_findings');
}
