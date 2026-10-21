/**
 * `localStorage` keys from before the rename to Speaking Glass.
 *
 * The app was CandidCue until October 2026, and its keys were
 * `candidcue.<name>`. Where an old store is still in reach, the first read
 * under the new key adopts the old value: a Linux build's data folder is copied
 * with its web view's profile inside it (`src-tauri/src/legacy_data.rs`), and a
 * browser dev server keeps its origin. Copied, not moved, because an older
 * checkout still reads its own key.
 *
 * Packaged macOS and Windows builds keep the web view's store under the bundle
 * identifier, which changed as well, so there is nothing to adopt there: these
 * values start over once.
 */

const PREFIX = 'speaking-glass.';
const LEGACY_PREFIX = 'candidcue.';

/** The key `key` was stored under before the rename. */
export function legacyKeyFor(key: string): string {
  return key.startsWith(PREFIX) ? LEGACY_PREFIX + key.slice(PREFIX.length) : key;
}

/**
 * Give `key` the value its pre-rename key holds, when it has none of its own.
 *
 * Never throws: a store that refuses the read or the write leaves the key
 * empty, which is the state the caller already handles.
 */
export function adoptLegacyValue(store: Storage, key: string): void {
  try {
    if (store.getItem(key) !== null) return;
    const legacy = store.getItem(legacyKeyFor(key));
    if (legacy !== null) store.setItem(key, legacy);
  } catch {
    // Storage disabled or over quota: nothing to adopt into.
  }
}
