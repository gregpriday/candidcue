/**
 * C11 regression: the session-record wrappers and the Rust command signatures
 * must agree — and, unlike before, they must exist and be used at all.
 *
 * These drive the REAL wrappers in `services/session-records.ts` and compare
 * what they emit against the shared fixture that
 * `src-tauri/tests/session_lifecycle_tests.rs` deserializes into the Rust DTOs,
 * so a change on either side of the seam fails on one side or the other.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/ipc/session-command-payloads.json';

const calls: { command: string; payload: unknown }[] = [];

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  invokeOrMock: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return command === 'start_session'
      ? { id: 'rust-assigned-id', sessionGeneration: 3 }
      : {};
  },
}));

const sessions = await import('../../../src/control/services/session-records');

function payloadFor(command: string): Record<string, unknown> {
  const call = calls.find((c) => c.command === command);
  expect(call, `no invoke recorded for ${command}`).toBeDefined();
  return call!.payload as Record<string, unknown>;
}

beforeEach(() => {
  calls.length = 0;
});

describe('session-record IPC payloads match the Rust DTOs', () => {
  it('start_session sends exactly the fields StartSessionInput has', async () => {
    await sessions.startSessionRecord(
      fixture.start_session.input as Parameters<typeof sessions.startSessionRecord>[0],
    );
    expect(payloadFor('start_session')).toEqual({ input: fixture.start_session.input });
  });

  /**
   * The generation-ownership rule, stated as a test: `StartSessionInput` has no
   * `sessionGeneration` field, so control cannot propose one even by accident.
   * It is an OUTPUT of `AppCoordinator::begin_session`, and control adopts the
   * value — along with the session id — from the returned record.
   */
  it('takes both the id and the generation from Rust rather than proposing them', async () => {
    const record = await sessions.startSessionRecord(
      fixture.start_session.input as Parameters<typeof sessions.startSessionRecord>[0],
    );
    const sent = payloadFor('start_session').input as Record<string, unknown>;
    expect(sent).not.toHaveProperty('sessionGeneration');
    expect(sent).not.toHaveProperty('sessionId');
    expect(record.id).toBe('rust-assigned-id');
    expect(record.sessionGeneration).toBe(3);
  });

  it('end_session sends the §36.1 aggregate summary', async () => {
    await sessions.endSessionRecord(
      fixture.end_session.sessionId,
      fixture.end_session.summary as Parameters<typeof sessions.endSessionRecord>[1],
    );
    expect(payloadFor('end_session')).toEqual({
      sessionId: fixture.end_session.sessionId,
      summary: fixture.end_session.summary,
    });
  });

  it('list_sessions sends the filter Rust accepts', async () => {
    await sessions.listSessionRecords(fixture.list_sessions.scriptId, fixture.list_sessions.limit);
    expect(payloadFor('list_sessions')).toEqual({
      scriptId: fixture.list_sessions.scriptId,
      limit: fixture.list_sessions.limit,
    });
  });
});
