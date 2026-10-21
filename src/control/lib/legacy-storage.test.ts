import { describe, expect, it } from 'vitest';
import { adoptLegacyValue, legacyKeyFor } from './legacy-storage';

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const KEY = 'speaking-glass.workspace.v1';
const LEGACY = 'candidcue.workspace.v1';

describe('localStorage keys from before the rename', () => {
  it('maps a key to its CandidCue spelling', () => {
    expect(legacyKeyFor(KEY)).toBe(LEGACY);
    expect(legacyKeyFor('unrelated')).toBe('unrelated');
  });

  it('adopts the old value when the new key holds nothing, and keeps the old one', () => {
    const store = memoryStorage({ [LEGACY]: '{"old":true}' });
    adoptLegacyValue(store, KEY);
    expect(store.getItem(KEY)).toBe('{"old":true}');
    expect(store.getItem(LEGACY)).toBe('{"old":true}');
  });

  it('adopts an empty old value as empty, not as absent', () => {
    const store = memoryStorage({ [LEGACY]: '' });
    adoptLegacyValue(store, KEY);
    expect(store.getItem(KEY)).toBe('');
  });

  it('never overwrites a value stored under the new key, even an empty one', () => {
    const store = memoryStorage({ [LEGACY]: '{"old":true}', [KEY]: '{"new":true}' });
    adoptLegacyValue(store, KEY);
    expect(store.getItem(KEY)).toBe('{"new":true}');

    const empty = memoryStorage({ [LEGACY]: '{"old":true}', [KEY]: '' });
    adoptLegacyValue(empty, KEY);
    expect(empty.getItem(KEY)).toBe('');
  });

  it('leaves the key empty when there is nothing to adopt', () => {
    const store = memoryStorage();
    adoptLegacyValue(store, KEY);
    expect(store.getItem(KEY)).toBeNull();
  });

  it('leaves both keys as they were when the store refuses a write', () => {
    const store = memoryStorage({ [LEGACY]: '{"old":true}' });
    store.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    expect(() => adoptLegacyValue(store, KEY)).not.toThrow();
    expect(store.getItem(KEY)).toBeNull();
    expect(store.getItem(LEGACY)).toBe('{"old":true}');
  });

  it('does not throw when the store refuses a read', () => {
    const store = memoryStorage({ [LEGACY]: '{"old":true}' });
    store.getItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(() => adoptLegacyValue(store, KEY)).not.toThrow();
  });
});
