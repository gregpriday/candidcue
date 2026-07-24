/**
 * SettingsStore (spec §45.2) — validated settings view with optimistic
 * patching through the settings service.
 */
import { get, writable } from 'svelte/store';
import * as settingsService from '../services/settings';
import { defaultAppSettings, type AppSettings } from '../services/settings-types';
import { showToast } from './toasts';

const state = writable<AppSettings>(defaultAppSettings());
export const settings = { subscribe: state.subscribe };

let loaded = false;

export async function loadSettings(force = false): Promise<AppSettings> {
  if (loaded && !force) return get(state);
  const value = await settingsService.getSettings();
  state.set(value);
  loaded = true;
  return value;
}

/** Patch one settings section optimistically; reverts on failure. */
export async function patchSettings<K extends keyof AppSettings>(
  section: K,
  patch: Partial<AppSettings[K]>,
): Promise<void> {
  const before = get(state);
  const sectionValue = before[section];
  const optimistic: AppSettings = {
    ...before,
    [section]:
      typeof sectionValue === 'object' && sectionValue !== null
        ? { ...(sectionValue as object), ...(patch as object) }
        : patch,
  };
  state.set(optimistic);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      [section]: optimistic[section],
    } as Partial<AppSettings>);
    state.set(saved);
  } catch (err) {
    state.set(before);
    showToast('Could not save settings. Nothing was changed.', 'danger');
    throw err;
  }
}

export function getSettingsSnapshot(): AppSettings {
  return get(state);
}
