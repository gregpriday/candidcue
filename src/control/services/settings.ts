/**
 * Application settings + maintenance service (spec §46.8). Exact command
 * names, camelCase payloads; mock-backed until Rust lands.
 */
import { invokeOrMock } from './ipc';
import { mockSettings } from './mock-backend';
import type { AppSettings, ClearResult, UpdateCheckResult } from './settings-types';

export async function getSettings(): Promise<AppSettings> {
  return invokeOrMock<AppSettings>('get_settings', undefined, () => mockSettings.get());
}

export async function updateSettings(
  expectedRevision: number,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  return invokeOrMock<AppSettings>('update_settings', { expectedRevision, patch }, () =>
    mockSettings.update(expectedRevision, patch),
  );
}

export async function exportAllData(destination?: string): Promise<{ path?: string; cancelled: boolean }> {
  return invokeOrMock('export_all_data', { destination }, () => ({ cancelled: false }));
}

export async function clearCache(
  kind: 'analysis' | 'listeners' | 'logs',
): Promise<ClearResult> {
  return invokeOrMock<ClearResult>('clear_cache', { kind }, () => mockSettings.clearCache(kind));
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  return invokeOrMock<UpdateCheckResult>('check_for_update', undefined, () =>
    mockSettings.checkForUpdate(),
  );
}

export async function getAppVersion(): Promise<string> {
  return invokeOrMock<string>('app_version', undefined, () => '0.1.0-dev');
}
