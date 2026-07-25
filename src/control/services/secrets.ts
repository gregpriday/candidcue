/**
 * OpenAI key lifecycle (spec §46.4). The candidate key crosses the boundary
 * exactly once per validate/save call and is never retained, logged, or
 * echoed back — callers must clear their field state after submission.
 *
 * Adapters: Rust returns `KeyValidationResult { status: valid_ready | … }`
 * and redacted `{ hint }` metadata; this service maps both onto the UI view
 * shapes in `secrets-types.ts`.
 */
import { ipcInvoke, isTauriRuntime, BackendUnavailableError } from './ipc';
import { mockSecrets } from './mock-backend';
import type { KeyValidationResult, OpenAiKeySource, OpenAiKeyStatus } from './secrets-types';

interface RustKeyValidationResult {
  status: string;
  realtimeModelAvailable: boolean;
  commandModelAvailable: boolean;
  message?: string;
}

function mapValidation(rust: RustKeyValidationResult): KeyValidationResult {
  const models = { realtime: rust.realtimeModelAvailable, command: rust.commandModelAvailable };
  switch (rust.status) {
    case 'valid_ready':
      return { status: 'valid', models };
    case 'valid_realtime_unavailable':
      return { status: 'partial', missing: 'Realtime transcription', models };
    case 'valid_model_unavailable':
      return { status: 'partial', missing: 'the command model', models };
    case 'quota_exhausted':
      return { status: 'quota' };
    case 'network_error':
    case 'provider_error':
      return { status: 'network' };
    default:
      return { status: 'invalid' };
  }
}

/**
 * Rust reports the source alongside the hint. Anything it does not recognise
 * falls back to `keychain`, because that is the only source a packaged build
 * has and the only one the mock and browser fixtures ever stand in for —
 * guessing `environment` would put a development-only warning in front of a
 * real user.
 */
function sourceFromRust(raw: string | undefined, present: boolean): OpenAiKeySource {
  if (!present) return 'none';
  return raw === 'environment' ? 'environment' : 'keychain';
}

function statusFromHint(
  hint: string | undefined,
  present: boolean,
  source?: string,
): OpenAiKeyStatus {
  if (!present) return { present: false, state: 'unknown', source: 'none' };
  const lastFour = hint ? hint.slice(-4) : undefined;
  return {
    present: true,
    ...(lastFour ? { lastFour } : {}),
    state: 'connected',
    source: sourceFromRust(source, true),
  };
}

export async function validateOpenAiKey(candidateKey: string): Promise<KeyValidationResult> {
  if (!isTauriRuntime()) return mockSecrets.validate(candidateKey);
  try {
    const rust = await ipcInvoke<RustKeyValidationResult>('validate_openai_key', { candidateKey });
    return mapValidation(rust);
  } catch (err) {
    if (err instanceof BackendUnavailableError) return mockSecrets.validate(candidateKey);
    throw err;
  }
}

export async function saveOpenAiKey(candidateKey: string): Promise<OpenAiKeyStatus> {
  if (!isTauriRuntime()) return mockSecrets.save(candidateKey);
  const metadata = await ipcInvoke<{ hint: string; source?: string }>('save_openai_key', {
    candidateKey,
  });
  return statusFromHint(metadata.hint, true, metadata.source);
}

export async function getOpenAiKeyStatus(): Promise<OpenAiKeyStatus> {
  if (!isTauriRuntime()) return mockSecrets.status();
  const rust = await ipcInvoke<{ present: boolean; hint?: string; source?: string }>(
    'get_openai_key_status',
  );
  return statusFromHint(rust.hint, rust.present, rust.source);
}

export async function deleteOpenAiKey(): Promise<void> {
  if (!isTauriRuntime()) return mockSecrets.remove();
  return ipcInvoke<void>('delete_openai_key');
}
