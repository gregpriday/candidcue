/**
 * AppStatusStore (spec §45.2) — startup facts: version, first-launch flag.
 */
import { writable } from 'svelte/store';
import * as settingsService from '../services/settings';
import { adoptLegacyValue } from '../lib/legacy-storage';

const WELCOMED_KEY = 'speaking-glass.welcomed.v1';

export interface AppStatus {
  version: string;
  firstLaunch: boolean;
}

const state = writable<AppStatus>({ version: '', firstLaunch: false });
export const appStatus = { subscribe: state.subscribe };

export function hasSeenWelcome(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    adoptLegacyValue(localStorage, WELCOMED_KEY);
    return localStorage.getItem(WELCOMED_KEY) === '1';
  } catch {
    return true;
  }
}

export function markWelcomed(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(WELCOMED_KEY, '1');
  } catch {
    // Non-fatal: the welcome screen may show again next launch.
  }
  state.update((s) => ({ ...s, firstLaunch: false }));
}

export async function initAppStatus(): Promise<AppStatus> {
  const version = await settingsService.getAppVersion().catch(() => 'unknown');
  const status: AppStatus = { version, firstLaunch: !hasSeenWelcome() };
  state.set(status);
  return status;
}
