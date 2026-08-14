/**
 * Diagnostics + support bundle contract (spec §44.11, §46.8, §47.10).
 *
 * Drives the REAL wrappers in src/control/services/diagnostics.ts against the
 * fixture that `src-tauri/tests/ipc_contract_tests.rs` produces from the Rust
 * DTOs. The service has no mock fallback on purpose — an invented diagnostics
 * report is worse than none — so nothing here can pass against a mock.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/settings-command-payloads.json';
import {
  SUPPORT_BUNDLE_CONTENTS,
  SUPPORT_BUNDLE_EXCLUSIONS,
  diagnosticRows,
  diagnosticsClipboardText,
  platformLabel,
  type SystemDiagnostics,
} from '../../../src/control/lib/diagnostics-format';

const calls: { command: string; payload: unknown }[] = [];
let nextResult: unknown = null;

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  ipcInvoke: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return nextResult;
  },
  BackendUnavailableError: class extends Error {},
}));

const diagnostics = await import('../../../src/control/services/diagnostics');

describe('diagnostics IPC payloads match the Rust signatures', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = null;
  });

  it('get_system_diagnostics takes no arguments', async () => {
    nextResult = fixture.expectedSystemDiagnostics;
    const report = await diagnostics.getSystemDiagnostics();
    expect(calls[0]!.command).toBe('get_system_diagnostics');
    expect(calls[0]!.payload).toBeUndefined();
    expect(report.scriptCount).toBe(12);
    expect(report.databaseIntegrityOk).toBe(true);
  });

  /**
   * C5, second instance. The command used to declare `destination: String`,
   * which this side could never supply — so the payload must stay empty and
   * `null` must mean "the operator cancelled", not "it failed".
   */
  it('export_support_bundle sends no destination and reports cancellation', async () => {
    nextResult = null;
    const cancelled = await diagnostics.exportSupportBundle();
    expect(calls[0]!.command).toBe('export_support_bundle');
    expect(calls[0]!.payload).toBeUndefined();
    expect(cancelled).toEqual({ cancelled: true });

    calls.length = 0;
    nextResult = fixture.expectedSupportBundleResult;
    const written = await diagnostics.exportSupportBundle();
    expect(written.cancelled).toBe(false);
    expect(written.path).toBe(fixture.expectedSupportBundleResult.path);
  });
});

describe('diagnostics presentation is honest about what it knows', () => {
  const base: SystemDiagnostics = fixture.expectedSystemDiagnostics;

  /**
   * The trap this test exists for: nothing wrote the `sessions` table until
   * `start_session` was wired, so a zero must not read as "you have never
   * presented". A bare number with no qualifier is the defect.
   */
  it('qualifies a zero session count instead of presenting it as fact', () => {
    const rows = diagnosticRows({ ...base, sessionCount: 0 });
    const sessions = rows.find((r) => r.label === 'Sessions recorded')!;
    expect(sessions.value).toBe('0');
    expect(sessions.note).toBeTruthy();
    expect(sessions.note).toMatch(/since session recording began/i);

    const withSessions = diagnosticRows({ ...base, sessionCount: 4 });
    expect(withSessions.find((r) => r.label === 'Sessions recorded')!.note).toBeUndefined();
  });

  /**
   * Rust maps both "quick_check failed" and "quick_check could not run" onto
   * `false`, so the copy must not claim which — only that it did not pass.
   */
  it('reports a failed database check without claiming a cause', () => {
    const row = diagnosticRows({ ...base, databaseIntegrityOk: false }).find(
      (r) => r.label === 'Database check',
    )!;
    expect(row.tone).toBe('bad');
    expect(row.value).toBe('Needs attention');
    expect(row.note).toMatch(/did not pass/);
  });

  it('labels known platforms and passes unknown ones through', () => {
    expect(platformLabel('macos', 'aarch64')).toBe('macOS · aarch64');
    expect(platformLabel('windows', 'x86_64')).toBe('Windows · x86_64');
    expect(platformLabel('haiku', '')).toBe('haiku');
    expect(platformLabel('', '')).toBe('Unknown');
  });

  it('copies every row it displays, one per line', () => {
    const text = diagnosticsClipboardText(base);
    const rows = diagnosticRows(base);
    expect(text.split('\n')).toHaveLength(rows.length);
    expect(text).toContain('CandidCue version: 0.1.0');
    expect(text).toContain(base.dataDir);
  });

  /**
   * The disclosure must keep naming what a bundle does NOT carry (§44.11).
   *
   * "API key" used to be in this list, and its removal is the point rather than
   * a relaxation: there is no API key any more — the recogniser is on-device
   * and the credential store went with the hosted provider — so the sentence
   * reassured about a risk that no longer exists. What replaced it is a claim
   * about the user's own words that the mechanism can actually support, plus an
   * instruction to look. `tests/integration/log-content-discipline.test.ts`
   * holds the other end: it fails if the copy goes back to promising "never".
   */
  it('names what a support bundle is designed to leave out', () => {
    expect(SUPPORT_BUNDLE_CONTENTS.length).toBeGreaterThan(0);
    for (const claim of ['scripts', 'transcripts', 'audio', 'database']) {
      expect(SUPPORT_BUNDLE_EXCLUSIONS).toContain(claim);
    }
    expect(
      SUPPORT_BUNDLE_EXCLUSIONS,
      'the disclosure must tell the operator to look at the bundle before ' +
        'sending it — that is what makes a designed exclusion honest',
    ).toMatch(/reveal/i);
  });

  /**
   * The disclosure is read immediately before the operator hands the folder to
   * someone else, so understating it is the failure that matters. When the
   * bundle started carrying logs (§179) this list still ended "nothing else",
   * and the person exporting one had no way to know. Anything the Rust command
   * writes has to be named here.
   */
  it('discloses the logs the bundle now carries', () => {
    const listed = SUPPORT_BUNDLE_CONTENTS.join(' ').toLowerCase();
    expect(listed).toContain('logs');
    expect(listed).toContain('trace');
  });
});
