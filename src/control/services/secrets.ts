/**
 * xAI key lifecycle (spec §46.4). The candidate key crosses the boundary
 * exactly once per validate/save call and is never retained, logged, or
 * echoed back — callers must clear their field state after submission.
 *
 * Adapters: Rust returns `KeyValidationResult { status, message? }` and
 * redacted `{ hint }` metadata; this service maps both onto the UI view shapes
 * in `secrets-types.ts`.
 */
import { ipcInvoke, isTauriRuntime, BackendUnavailableError } from './ipc';
import { mockSecrets } from './mock-backend';
import type { SttKeySource, SttKeyStatus, KeyValidationResult } from './secrets-types';

interface RustKeyValidationResult {
  status: string;
  message?: string;
}

function mapValidation(rust: RustKeyValidationResult): KeyValidationResult {
  const message = rust.message !== undefined ? { message: rust.message } : {};
  switch (rust.status) {
    case 'valid':
      return { status: 'valid' };
    case 'quota':
      return { status: 'quota', ...message };
    // A provider error is a fault on their side or ours, not a verdict on the
    // key — reporting it as `invalid` would send somebody to regenerate a key
    // that was fine.
    case 'network_error':
    case 'provider_error':
      return { status: 'network', ...message };
    default:
      return { status: 'invalid', ...message };
  }
}

/**
 * Rust reports the source alongside the hint. Anything it does not recognise
 * falls back to `keychain`, because that is the only source a packaged build
 * has and the only one the mock and browser fixtures ever stand in for —
 * guessing `environment` would put a development-only warning in front of a
 * real user.
 */
function sourceFromRust(raw: string | undefined, present: boolean): SttKeySource {
  if (!present) return 'none';
  return raw === 'environment' ? 'environment' : 'keychain';
}

function statusFromHint(
  hint: string | undefined,
  present: boolean,
  source?: string,
): SttKeyStatus {
  if (!present) return { present: false, state: 'unknown', source: 'none' };
  const lastFour = hint ? hint.slice(-4) : undefined;
  return {
    present: true,
    ...(lastFour ? { lastFour } : {}),
    state: 'connected',
    source: sourceFromRust(source, true),
  };
}

export async function validateSttKey(candidateKey: string): Promise<KeyValidationResult> {
  if (!isTauriRuntime()) return mockSecrets.validate(candidateKey);
  try {
    const rust = await ipcInvoke<RustKeyValidationResult>('validate_stt_key', { candidateKey });
    return mapValidation(rust);
  } catch (err) {
    if (err instanceof BackendUnavailableError) return mockSecrets.validate(candidateKey);
    throw err;
  }
}

export async function saveSttKey(candidateKey: string): Promise<SttKeyStatus> {
  if (!isTauriRuntime()) return mockSecrets.save(candidateKey);
  const metadata = await ipcInvoke<{ hint: string; source?: string }>('save_stt_key', {
    candidateKey,
  });
  return statusFromHint(metadata.hint, true, metadata.source);
}

export async function getSttKeyStatus(): Promise<SttKeyStatus> {
  if (!isTauriRuntime()) return mockSecrets.status();
  const rust = await ipcInvoke<{ present: boolean; hint?: string; source?: string }>(
    'get_stt_key_status',
  );
  return statusFromHint(rust.hint, rust.present, rust.source);
}

export async function deleteSttKey(): Promise<void> {
  if (!isTauriRuntime()) return mockSecrets.remove();
  return ipcInvoke<void>('delete_stt_key');
}

/**
 * Ask the provider whether the STORED key still works.
 *
 * Distinct from `validateSttKey`, which takes a candidate the user just
 * typed. There is no way to do this from JavaScript — the key is in the OS
 * credential store and deliberately never crosses this boundary — so Rust
 * reads it and performs the round-trip. Nothing about the key comes back;
 * only whether it worked.
 */
export async function testStoredSttKey(): Promise<KeyValidationResult> {
  if (!isTauriRuntime()) return mockSecrets.validate('mock-stored-key');
  try {
    const rust = await ipcInvoke<RustKeyValidationResult>('test_stt_key');
    return mapValidation(rust);
  } catch (err) {
    if (err instanceof BackendUnavailableError) return mockSecrets.validate('mock-stored-key');
    throw err;
  }
}
