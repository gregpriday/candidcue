/**
 * What Settings says about restoring from an export (#488).
 *
 * Pure, so the promises it makes can be tested without a window: choosing an
 * export used to arm a full replacement of the library with no confirmation,
 * and once the toast was gone nothing said a restore was waiting.
 */
import type { ConfirmRequest } from '../stores/confirm';
import type { PendingRestore, RestorePreview } from '../services/settings-types';

/**
 * When an export was taken, in the reader's own locale and time zone.
 *
 * An unparseable stamp comes back as itself rather than as "Invalid Date": the
 * manifest wrote it, and the raw text still tells two exports apart.
 */
export function formatExportTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}

function scriptCount(count: number): string {
  return count === 1 ? '1 script' : `${count} scripts`;
}

/**
 * The question asked before anything is scheduled.
 *
 * It says what is replaced (scripts, settings with the calibrated rigs, take
 * history), when (the next launch, not now), where the current data goes (the
 * quarantine folder), and that work done before quitting goes with it — the
 * part nobody would guess.
 */
export function restoreConfirmation(preview: RestorePreview): ConfirmRequest {
  return {
    title: 'Restore from this export?',
    body:
      `The export in ${preview.path} was taken on ${formatExportTime(preview.createdAt)} ` +
      `and holds ${scriptCount(preview.scriptsInExport)}. ` +
      'The next time Speaking Glass opens, it replaces your current scripts, settings ' +
      '(calibrated rigs included) and take history with the export’s. ' +
      'Those are moved to the quarantine folder in the data folder as they are then, so ' +
      'anything you change in them before you quit goes there too.',
    confirmLabel: 'Schedule restore',
    cancelLabel: 'Don’t restore',
    danger: true,
  };
}

/** The persistent row's lines while a restore is waiting. */
export function pendingRestoreLines(pending: PendingRestore): { head: string; body: string; note: string | null } {
  const taken =
    pending.exportCreatedAt === null
      ? 'From the export'
      : `From the export taken on ${formatExportTime(pending.exportCreatedAt)}`;
  return {
    head: 'Restore scheduled for the next launch',
    body:
      `${taken}, in ${pending.exportPath}. When Speaking Glass next opens, your current ` +
      'scripts, settings and take history are moved to the quarantine folder and replaced with ' +
      'the export’s.',
    note: pending.cancellable
      ? null
      : 'A launch of Speaking Glass has already started this restore, so it can no longer be ' +
        'cancelled.',
  };
}
