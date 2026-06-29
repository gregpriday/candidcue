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

  it('returns null (does not throw) when secure storage is unavailable on read', () => {
    const shared = memoryStore();
    new CredentialStore(fakeEncryptor(true), shared, () => '2026-06-23T00:00:00.000Z').setKey(
      'openai',
      'sk-stored',
    );
    // Keychain dropped out after the key was written: getKey must fail soft.
    const reader = new CredentialStore(fakeEncryptor(false), shared);
    expect(() => reader.getKey('openai')).not.toThrow();
    expect(reader.getKey('openai')).toBeNull();
  });

  it('returns null (does not throw) when decryption fails', () => {
    const shared = memoryStore();
    new CredentialStore(fakeEncryptor(true), shared, () => '2026-06-23T00:00:00.000Z').setKey(
      'inworld',
      'iw-stored',
    );
    // Available but decrypt throws (corrupted envelope / transient native error).
    const throwingEncryptor: Encryptor = {
      isAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: () => {
        throw new Error('keychain locked');
      },
    };
    const reader = new CredentialStore(throwingEncryptor, shared);
    expect(() => reader.getKey('inworld')).not.toThrow();
    expect(reader.getKey('inworld')).toBeNull();
  });

  it('returns null (does not throw) when the stored envelope is corrupted', () => {
    const shared = memoryStore();
    // A hand-edited / corrupted credentials.json: encryptedBase64 is missing,
    // so Buffer.from would throw before decryption is even attempted.
    shared.write({
      openai: {
        schemaVersion: 1,
        provider: 'openai',
        createdAt: '2026-06-23T00:00:00.000Z',
        updatedAt: '2026-06-23T00:00:00.000Z',
      } as unknown as EncryptedCredentialEnvelope,
    });
    const reader = new CredentialStore(fakeEncryptor(true), shared);
    expect(() => reader.getKey('openai')).not.toThrow();
    expect(reader.getKey('openai')).toBeNull();
  });
});
