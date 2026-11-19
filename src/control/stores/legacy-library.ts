/**
 * What this launch has to say about the CandidCue library, and whether the
 * user has put it away (`services/legacy-library.ts`).
 *
 * Set once at boot, before the first route is painted, so Welcome can show it
 * above the sample before the sample can be pressed. Dismissal lives here and
 * nowhere else: it lasts as long as this page, so a reload says it again, which
 * is the point. Rust reports the same fact for the whole run, and a reload is
 * one more chance to read where the old library is.
 */
import { writable, type Readable } from 'svelte/store';
import type { LegacyLibraryNotice } from '../services/legacy-library';

export interface LegacyLibraryState {
  notice: LegacyLibraryNotice | null;
  dismissed: boolean;
}

const store = writable<LegacyLibraryState>({ notice: null, dismissed: false });

export const legacyLibrary: Readable<LegacyLibraryState> = { subscribe: store.subscribe };

export function setLegacyLibraryNotice(notice: LegacyLibraryNotice | null): void {
  store.set({ notice, dismissed: false });
}

export function dismissLegacyLibraryNotice(): void {
  store.update((state) => ({ ...state, dismissed: true }));
}
