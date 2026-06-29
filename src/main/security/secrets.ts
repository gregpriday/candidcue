import type { ProviderTestResult } from '@shared/contracts';

export type ProviderName = 'openai' | 'inworld';

export interface EncryptedCredentialEnvelope {
  schemaVersion: 1;
  provider: ProviderName;
  encryptedBase64: string;
  createdAt: string;
  updatedAt: string;
}

/** Abstracts the OS keychain so the store is testable without Electron. */
export interface Encryptor {
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/** Minimal persistence the credential store needs (a JSON blob on disk). */
export interface EnvelopeStore {
  read(): Record<string, EncryptedCredentialEnvelope>;
  write(value: Record<string, EncryptedCredentialEnvelope>): void;
}

/**
 * Stores provider credentials encrypted at rest (spec §21.2). Plaintext exists
 * only transiently inside the main process; it is never written to disk, logs,
 * or exports. Renderers never receive a key — only a boolean "has key".
 */
export class CredentialStore {
  constructor(
    private readonly encryptor: Encryptor,
    private readonly store: EnvelopeStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  isSecureStorageAvailable(): boolean {
    return this.encryptor.isAvailable();
  }

  hasKey(provider: ProviderName): boolean {
    return Boolean(this.store.read()[provider]);
  }

  /** Trim + store a key. Empty values never overwrite an existing key. */
  setKey(provider: ProviderName, rawKey: string): void {
    const key = rawKey.trim();
    if (key.length === 0) return; // empty must not clobber (spec appendix B.5)
    if (!this.encryptor.isAvailable()) {
      throw new Error('Secure storage is unavailable on this platform.');
    }
    const envelopes = this.store.read();
    const existing = envelopes[provider];
    const cipher = this.encryptor.encryptString(key);
    envelopes[provider] = {
      schemaVersion: 1,
      provider,
      encryptedBase64: cipher.toString('base64'),
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.store.write(envelopes);
  }

  /**
   * Decrypt a key for immediate provider-client use in main only. Fail-soft:
   * returns null (never throws) when the envelope is missing, secure storage is
   * unavailable, or decryption fails. Secure storage can drop out after a key
   * was written (keychain locked, DPAPI blob from another user, libsecret
   * unreachable) and an envelope can be corrupted on disk; treating any such
   * read failure as "no usable key" keeps callers on the existing null path.
   */
  getKey(provider: ProviderName): string | null {
    const envelope = this.store.read()[provider];
    if (!envelope) return null;
    if (!this.encryptor.isAvailable()) return null; // guard mirrors setKey
    try {
      // Decode inside the try: a corrupted on-disk envelope (non-string
      // encryptedBase64) would otherwise throw from Buffer.from itself.
      const cipher = Buffer.from(envelope.encryptedBase64, 'base64');
      return this.encryptor.decryptString(cipher);
    } catch {
      // Never log: the cipher and any partial plaintext must not leak.
      return null;
    }
  }

  clearKey(provider: ProviderName): void {
    const envelopes = this.store.read();
    delete envelopes[provider];
    this.store.write(envelopes);
  }
}

/** Build a "key present" view for the renderer without exposing secrets. */
export function publicKeyState(store: CredentialStore): {
  hasOpenAiKey: boolean;
  hasInworldKey: boolean;
} {
  return {
    hasOpenAiKey: store.hasKey('openai'),
    hasInworldKey: store.hasKey('inworld'),
  };
}

export type { ProviderTestResult };
