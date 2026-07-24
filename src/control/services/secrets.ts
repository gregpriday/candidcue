/**
 * OpenAI key lifecycle (spec §46.4). The candidate key crosses the boundary
 * exactly once per validate/save call and is never retained, logged, or
 * echoed back — callers must clear their field state after submission.
 */
import { invokeOrMock } from './ipc';
import { mockSecrets } from './mock-backend';
import type { KeyValidationResult, OpenAiKeyStatus } from './secrets-types';

export async function validateOpenAiKey(candidateKey: string): Promise<KeyValidationResult> {
  return invokeOrMock<KeyValidationResult>('validate_openai_key', { candidateKey }, () =>
    mockSecrets.validate(candidateKey),
  );
}

export async function saveOpenAiKey(candidateKey: string): Promise<OpenAiKeyStatus> {
  return invokeOrMock<OpenAiKeyStatus>('save_openai_key', { candidateKey }, () =>
    mockSecrets.save(candidateKey),
  );
}

export async function getOpenAiKeyStatus(): Promise<OpenAiKeyStatus> {
  return invokeOrMock<OpenAiKeyStatus>('get_openai_key_status', undefined, () =>
    mockSecrets.status(),
  );
}

export async function deleteOpenAiKey(): Promise<void> {
  return invokeOrMock<void>('delete_openai_key', undefined, () => mockSecrets.remove());
}
