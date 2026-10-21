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
    { label: 'Speaking Glass version', value: d.appVersion || 'unknown', tone: 'neutral' },
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
 * operator sends it to anyone.
 *
 * This list is a promise made to someone about to hand a folder to a stranger,
 * so it has to track what `export_support_bundle` actually writes. It used to
 * end "— nothing else", which stopped being true the moment the bundle started
 * carrying logs (§179) — the disclosure went stale in the direction that
 * matters, understating what leaves the machine.
 */
export const SUPPORT_BUNDLE_CONTENTS = [
  'The facts listed above, as diagnostics.json.',
  'Recovery reports, which carry ids and counts — not script text.',
  'Application logs from the last few days, and the step-by-step trace of the current and previous runs.',
] as const;

/**
 * What a bundle is designed to leave out — stated as a design, not as a
 * guarantee, because that is what the mechanism supports.
 *
 * This used to say a bundle "never includes your API key, microphone audio,
 * script text, or transcripts". Two things were wrong with it. There is no API
 * key any more — the recogniser runs on-device and the credential store went
 * with it — so the sentence reassured about a risk that no longer exists while
 * saying nothing about the one that does. And "never" is stronger than the code
 * proves: `redact_log_line` in `diagnostics/logging.rs` handles paths, URLs and
 * device names, and says plainly that it cannot tell a sentence the user wrote
 * from any other prose. What keeps scripts out of logs is that the call sites
 * log ids, counts and step names — a discipline enforced by
 * `tests/integration/log-content-discipline.test.ts`, which is a tripwire and
 * not a proof.
 *
 * A discipline is a good reason to believe a bundle is clean. It is not a good
 * reason to promise a stranger that it is. So the claim is what the app does,
 * and the last sentence hands the decision to the person whose folder it is.
 */
export const SUPPORT_BUNDLE_EXCLUSIONS =
  'A bundle is designed to leave out your scripts, your transcripts and your microphone audio, and it never contains the database or a recording. What it carries is diagnostic state, versions, timings, and log lines with home paths and web addresses removed. Speaking Glass cannot recognise prose, so that last part rests on what the app writes rather than on a filter — reveal the bundle and read it before you send it to anyone.';
