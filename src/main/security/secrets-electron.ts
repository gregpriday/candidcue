import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage, app } from 'electron';
import {
  CredentialStore,
  type Encryptor,
  type EnvelopeStore,
  type EncryptedCredentialEnvelope,
} from './secrets';

/** Electron safeStorage-backed encryptor (OS keychain / DPAPI). */
const electronEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (cipher) => safeStorage.decryptString(cipher),
};

/** JSON-file envelope store living outside the project data dir. */
function fileEnvelopeStore(filePath: string): EnvelopeStore {
  return {
    read(): Record<string, EncryptedCredentialEnvelope> {
      if (!existsSync(filePath)) return {};
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, EncryptedCredentialEnvelope>;
      } catch {
        return {};
      }
    },
    write(value): void {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
    },
  };
}

/** Build the production credential store under Electron userData. */
export function createCredentialStore(): CredentialStore {
  const file = join(app.getPath('userData'), 'credentials.json');
  return new CredentialStore(electronEncryptor, fileEnvelopeStore(file));
}
