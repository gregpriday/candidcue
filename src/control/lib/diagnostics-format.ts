/**
 * Presentation of the system diagnostics report (spec §44.11, §47.10).
 * Pure, so the honesty rules below are unit-testable without a DOM.
 *
 * Two of these numbers can lie by omission, and the rules exist to stop them:
 *
 *  - `sessionCount` counts rows in the `sessions` table. Nothing wrote that
 *    table until `start_session` was wired, so on an existing install a zero
 *    means "not recorded", not "you have never presented". A bare `0` next to
 *    "Sessions" would be read as the latter, so a zero carries a note.
 *  - `databaseIntegrityOk` is `PRAGMA quick_check == "ok"`, and Rust maps a
 *    FAILED check and a check it could not run to the same `false`. It is
 *    reported as "needs attention", never as a clean bill of health.
 */

/** Twin of Rust `SystemDiagnostics` (commands/settings_cmds.rs). */
export interface SystemDiagnostics {
  appVersion: string;
  os: string;
  arch: string;
  databaseIntegrityOk: boolean;
  scriptCount: number;
  sessionCount: number;
  dataDir: string;
}

export interface DiagnosticRow {
  label: string;
  value: string;
  tone: 'neutral' | 'good' | 'bad';
  /** Qualifier shown under the value when the number alone would mislead. */
  note?: string;
}

const OS_LABELS: Record<string, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

export function platformLabel(os: string, arch: string): string {
  const name = OS_LABELS[os] ?? (os === '' ? 'Unknown' : os);
  return arch === '' ? name : `${name} · ${arch}`;
}

export function diagnosticRows(d: SystemDiagnostics): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [
    { label: 'CandidCue version', value: d.appVersion || 'unknown', tone: 'neutral' },
    { label: 'Platform', value: platformLabel(d.os, d.arch), tone: 'neutral' },
    {
      label: 'Database check',
      value: d.databaseIntegrityOk ? 'Passed' : 'Needs attention',
      tone: d.databaseIntegrityOk ? 'good' : 'bad',
      // `false` covers both a failed integrity check and a check that could
      // not be run, so the copy must not promise which one it was.
      note: d.databaseIntegrityOk
        ? undefined
        : 'The database check did not pass. Export a support bundle before making further changes.',
    },
    { label: 'Scripts', value: d.scriptCount.toLocaleString(), tone: 'neutral' },
    {
      label: 'Sessions recorded',
      value: d.sessionCount.toLocaleString(),
      tone: 'neutral',
      note:
        d.sessionCount === 0
          ? 'No session records on this device. Only sessions started since session recording began are counted.'
          : undefined,
    },
    { label: 'Data folder', value: d.dataDir || 'unknown', tone: 'neutral' },
  ];
  return rows;
}

/** Plain-text report for the clipboard — the same facts, one per line. */
export function diagnosticsClipboardText(d: SystemDiagnostics): string {
  return diagnosticRows(d)
    .map((row) => `${row.label}: ${row.value}`)
    .join('\n');
}

/**
 * What a support bundle actually contains (spec §44.11), stated before the
 * operator sends it to anyone. The command writes `diagnostics.json` plus the
 * JSON recovery reports from the diagnostics directory — nothing else.
 */
export const SUPPORT_BUNDLE_CONTENTS = [
  'The facts listed above, as diagnostics.json.',
  'Recovery reports, which carry ids and counts — not script text.',
] as const;

export const SUPPORT_BUNDLE_EXCLUSIONS =
  'A bundle never includes your API key, microphone audio, script text, or transcripts.';
