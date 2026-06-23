import { describe, it, expect, beforeEach } from 'vitest';
import {
  CredentialStore,
  publicKeyState,
  type Encryptor,
  type EnvelopeStore,
  type EncryptedCredentialEnvelope,
} from '@main/security/secrets';

/** Reversible XOR-ish fake so tests exercise the store without the OS keychain. */
function fakeEncryptor(available = true): Encryptor {
  return {
    isAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^enc:/, ''),
  };
}

function memoryStore(): EnvelopeStore {
  let state: Record<string, EncryptedCredentialEnvelope> = {};
  return {
    read: () => structuredClone(state),
    write: (value) => {
      state = structuredClone(value);
    },
  };
}

describe('CredentialStore', () => {
  let store: CredentialStore;
  beforeEach(() => {
    store = new CredentialStore(fakeEncryptor(), memoryStore(), () => '2026-06-23T00:00:00.000Z');
  });

  it('round-trips an encrypted key', () => {
    store.setKey('openai', 'sk-test-123');
    expect(store.hasKey('openai')).toBe(true);
    expect(store.getKey('openai')).toBe('sk-test-123');
  });

  it('trims whitespace from keys', () => {
    store.setKey('inworld', '  my-key  ');
    expect(store.getKey('inworld')).toBe('my-key');
  });

  it('does not overwrite an existing key with an empty value', () => {
    store.setKey('openai', 'sk-original');
    store.setKey('openai', '   ');
    expect(store.getKey('openai')).toBe('sk-original');
  });

  it('clears a key', () => {
    store.setKey('openai', 'sk-x');
    store.clearKey('openai');
    expect(store.hasKey('openai')).toBe(false);
    expect(store.getKey('openai')).toBeNull();
  });

  it('exposes only presence booleans to the renderer view', () => {
    store.setKey('openai', 'sk-x');
    const view = publicKeyState(store);
    expect(view).toEqual({ hasOpenAiKey: true, hasInworldKey: false });
    expect(Object.values(view).every((v) => typeof v === 'boolean')).toBe(true);
  });

  it('refuses to store when secure storage is unavailable', () => {
    const unavailable = new CredentialStore(fakeEncryptor(false), memoryStore());
    expect(() => unavailable.setKey('openai', 'sk-x')).toThrow();
  });
});
