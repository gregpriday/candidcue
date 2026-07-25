/**
 * §46.4 — the OpenAI key status must say WHICH key is in play, not just that
 * one is.
 *
 * A debug build reads `OPENAI_API_KEY` ahead of the OS credential store,
 * because macOS ties a Keychain item's ACL to the requesting binary's code
 * signature and `tauri dev` presents a new one on every rebuild. That leaves two
 * possible keys, and a status that only reports `present: true` describes both
 * situations identically — the operator cannot tell which key is billing their
 * account, and a key saved into the shadowed store looks saved forever.
 *
 * This drives the REAL wrappers in src/control/services/secrets.ts against
 * `tests/fixtures/ipc/openai-key-status.json`, the same document
 * `src-tauri/tests/ipc_contract_tests.rs` asserts the Rust DTOs serialize to.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/openai-key-status.json';

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

const secrets = await import('../../../src/control/services/secrets');

describe('OpenAI key status carries its source across the boundary', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = null;
  });

  it('reports a keychain key as coming from the keychain', async () => {
    nextResult = fixture.expectedKeychainStatus;
    const status = await secrets.getOpenAiKeyStatus();
    expect(calls[0]?.command).toBe('get_openai_key_status');
    expect(status.present).toBe(true);
    expect(status.source).toBe('keychain');
    expect(status.lastFour).toBe(fixture.notes.lastFourOfKeychainHint);
  });

  it('reports an environment key as coming from the environment', async () => {
    // The whole point of the field: the operator sees the tail of a key they
    // may never have typed into CandidCue, and is told where it came from.
    nextResult = fixture.expectedEnvironmentStatus;
    const status = await secrets.getOpenAiKeyStatus();
    expect(status.present).toBe(true);
    expect(status.source).toBe('environment');
  });

  it('reports no source at all when there is no key', async () => {
    nextResult = fixture.expectedAbsentStatus;
    const status = await secrets.getOpenAiKeyStatus();
    expect(status.present).toBe(false);
    expect(status.source).toBe('none');
    expect(status.lastFour).toBeUndefined();
  });

  it('carries the source through a save, not just through a status read', async () => {
    // `save_openai_key` returns the metadata the UI then displays. Dropping the
    // source here would blank out what a status read had just established.
    nextResult = fixture.expectedSavedMetadata;
    const status = await secrets.saveOpenAiKey('sk-whatever-7f2a');
    expect(calls[0]).toEqual({
      command: 'save_openai_key',
      payload: { candidateKey: 'sk-whatever-7f2a' },
    });
    expect(status.source).toBe('keychain');
    expect(status.lastFour).toBe(fixture.notes.lastFourOfKeychainHint);
  });

  it('falls back to keychain rather than guessing environment', async () => {
    // A backend or fixture that predates the field must not put a
    // development-only warning in front of a real user; keychain is the only
    // source a packaged build has.
    nextResult = { present: true, hint: 'sk-…7f2a' };
    const status = await secrets.getOpenAiKeyStatus();
    expect(status.source).toBe('keychain');
  });

  it('never receives the key itself — only a redacted tail', async () => {
    for (const name of [
      'expectedKeychainStatus',
      'expectedEnvironmentStatus',
      'expectedSavedMetadata',
    ] as const) {
      const hint = (fixture[name] as { hint?: string }).hint ?? '';
      expect(hint.startsWith('sk-…')).toBe(true);
      expect(hint.length).toBe('sk-…'.length + 4);
    }
  });

  it('the fixture enumerates exactly the sources the UI can render', () => {
    expect(fixture.notes.allSources).toEqual(['environment', 'keychain', 'none']);
  });
});
