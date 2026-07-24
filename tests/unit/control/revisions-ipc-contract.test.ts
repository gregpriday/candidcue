/**
 * Revision browser IPC contract (spec §21.4, §46.2).
 *
 * These drive the REAL wrappers in src/control/services/revisions.ts and
 * compare what they emit against the shared fixture that
 * `src-tauri/tests/ipc_contract_tests.rs` checks against the Rust command
 * signatures. Nothing here can be satisfied by the mock backend: the revision
 * service deliberately does not use `invokeOrMock`, because a mock revision
 * history would be an invented restore point.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/script-command-payloads.json';
import type {
  RestoreResult,
  RevisionDocument,
  RevisionSummary,
} from '../../../src/control/services/revisions';
import {
  formatWordDelta,
  revisionReasonLabel,
  revisionTimestamp,
  revisionWordDelta,
  REVISION_REASONS,
} from '../../../src/control/lib/revision-format';

const calls: { command: string; payload: unknown }[] = [];

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  ipcInvoke: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return [];
  },
  BackendUnavailableError: class extends Error {},
}));

const revisions = await import('../../../src/control/services/revisions');

function payloadFor(command: string): unknown {
  const call = calls.find((c) => c.command === command);
  expect(call, `no invoke recorded for ${command}`).toBeDefined();
  return call!.payload;
}

describe('revision command IPC payloads match the Rust signatures', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('list_revisions sends only the script id', async () => {
    await revisions.listRevisions(fixture.scriptId);
    expect(payloadFor('list_revisions')).toEqual(fixture.list_revisions);
  });

  it('get_revision sends scriptId and revisionId in Tauri camelCase', async () => {
    await revisions.getRevision(fixture.scriptId, fixture.revisionId);
    expect(payloadFor('get_revision')).toEqual(fixture.get_revision);
  });

  /**
   * The compare-and-swap argument is the whole reason a restore cannot
   * silently clobber a concurrent edit. Dropping it would make Rust fail to
   * deserialize (`expected_revision: i64` is not optional), so this asserts
   * the wrapper sends it under the exact camelCase name.
   */
  it('restore_revision carries the expected script revision', async () => {
    await revisions.restoreRevision(fixture.scriptId, fixture.revisionId, 7);
    const payload = payloadFor('restore_revision') as Record<string, unknown>;
    expect(payload).toEqual(fixture.restore_revision);
    expect(typeof payload.expectedRevision).toBe('number');
  });

  /**
   * The response shape the panel reads. `RevisionDocument` is a FLATTENED
   * summary plus `source` — not `{ summary, source }` — and the Rust test
   * asserts the same fixture round-trips through the real structs.
   */
  it('the fixture revision summary matches the TypeScript twin', () => {
    const summary: RevisionSummary = fixture.expectedRevisionSummary;
    expect(summary.revisionNumber).toBe(3);
    expect(summary.wordCount).toBe(412);
    expect(summary.createdAt).toBeTruthy();

    const document: RevisionDocument = {
      ...fixture.expectedRevisionSummary,
      source: '# Keynote\n',
    };
    expect(document.source).toContain('Keynote');
  });

  /**
   * `restore_revision` returns Rust's `SaveResult`, which has NO `status`
   * field — a stale revision or an external change is an Err. The older
   * `SaveResult` type in scripts-types.ts declares one; anything branching on
   * it is dead code.
   */
  it('the restore result carries a revision number and no status field', () => {
    const result: RestoreResult = fixture.expectedRestoreResult;
    expect(result.scriptRevision).toBe(8);
    expect(result.revisionCreated).toBe(true);
    expect(Object.keys(fixture.expectedRestoreResult)).not.toContain('status');
  });
});

describe('revision labelling', () => {
  it('names every reason Rust can write', () => {
    for (const reason of fixture.revisionReasons) {
      const label = revisionReasonLabel(reason);
      expect(label).not.toBe('');
      // A raw snake_case reason leaking into the UI is the failure mode.
      expect(label).not.toContain('_');
    }
    expect([...REVISION_REASONS]).toEqual(fixture.revisionReasons);
  });

  it('humanises an unknown reason instead of hiding the revision', () => {
    expect(revisionReasonLabel('some_future_reason')).toBe('Some future reason');
    expect(revisionReasonLabel('')).toBe('Saved version');
  });

  it('reports the word movement a restore would cause', () => {
    expect(revisionWordDelta(500, 400)).toBe(100);
    expect(revisionWordDelta(undefined, 400)).toBeUndefined();
    expect(formatWordDelta(100)).toBe('+100 words');
    expect(formatWordDelta(-1)).toBe('−1 word');
    expect(formatWordDelta(0)).toBe('same length');
    expect(formatWordDelta(undefined)).toBe('');
  });

  it('shows a clock for today and a date for older revisions', () => {
    const now = Date.parse('2026-07-24T18:00:00Z');
    const today = revisionTimestamp('2026-07-24T09:15:00Z', now);
    const older = revisionTimestamp('2026-07-02T09:15:00Z', now);
    expect(today).not.toBe('');
    expect(older).toContain(',');
    expect(older.length).toBeGreaterThan(today.length);
    expect(revisionTimestamp('not a date', now)).toBe('');
  });
});
