/**
 * Listener catalogue contract and merge logic (spec §14.2 F, §46.7).
 *
 * The wrapper assertions drive the real service against the shared fixture
 * `src-tauri/tests/ipc_contract_tests.rs` also reads. The merge assertions are
 * pure and DOM-free, which is the only way to test this repo's UI logic.
 *
 * MOCK CAVEAT, stated explicitly: `getListenerCatalogue` falls through to a
 * mock when there is no Tauri runtime, and that mock returns an EMPTY
 * catalogue on purpose — inventing entries would let a test pass against packs
 * that do not exist. The payload tests below therefore stub `ipc` and assert
 * what is actually sent, rather than relying on the fallback.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fixture from '../../fixtures/ipc/listener-command-payloads.json';
import type { InstalledListener } from '../../../src/control/services/listeners';
import type {
  ListenerCatalogue,
  ListenerCatalogueEntry,
} from '../../../src/control/services/listeners-catalogue';

const calls: { command: string; payload: unknown }[] = [];
let nextResult: unknown = null;

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  invokeOrMock: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return nextResult;
  },
  BackendUnavailableError: class extends Error {},
}));

const catalogueService = await import('../../../src/control/services/listeners-catalogue');
const {
  DOWNLOADS_SUPPORTED,
  formatPackSize,
  getListenerCatalogue,
  mergeCatalogue,
  removeListener,
} = catalogueService;

const entry: ListenerCatalogueEntry = fixture.expectedCatalogueEntry;

function installed(overrides: Partial<InstalledListener> = {}): InstalledListener {
  return {
    packId: 'mira',
    version: '1.0.0',
    displayName: 'Mira',
    description: 'A calm listener who holds eye contact.',
    source: 'bundled',
    sizeBytes: 18874368,
    clipCount: 2,
    state: 'installed',
    ...overrides,
  };
}

function catalogue(entries: ListenerCatalogueEntry[]): ListenerCatalogue {
  return { entries, fetchedAt: '2026-07-24T09:15:00Z', source: 'bundled_only' };
}

describe('listener catalogue IPC payloads', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = null;
  });

  it('get_listener_catalogue sends forceRefresh in Tauri camelCase', async () => {
    nextResult = fixture.expectedCatalogue;
    await getListenerCatalogue();
    expect(calls[0]!.command).toBe('get_listener_catalogue');
    expect(calls[0]!.payload).toEqual(fixture.get_listener_catalogue);
  });

  it('remove_listener sends the pack id and the version to delete', async () => {
    nextResult = undefined;
    await removeListener('aurora', '1.2.0');
    expect(calls[0]!.command).toBe('remove_listener');
    expect(calls[0]!.payload).toEqual(fixture.remove_listener);
  });

  /**
   * The honesty flag. `download_listener` and `cancel_listener_download` are
   * NOT_IMPLEMENTED in Rust; the Rust contract test asserts they still are.
   * If this flips to true without the Rust side changing, the UI would show a
   * button that does nothing — the exact failure mode being avoided.
   */
  it('declares downloads unsupported and calls neither download command', async () => {
    expect(DOWNLOADS_SUPPORTED).toBe(false);
    nextResult = fixture.expectedCatalogue;
    await getListenerCatalogue();
    for (const command of fixture.notImplementedCommands) {
      expect(calls.map((c) => c.command)).not.toContain(command);
    }
  });
});

describe('catalogue and installed packs merge', () => {
  it('marks a bundled pack as included and not removable', () => {
    const [row] = mergeCatalogue(catalogue([entry]), [installed()]);
    expect(row!.status).toBe('installed');
    expect(row!.statusLabel).toBe('Included');
    // Rust refuses to remove a bundled pack, so offering the action would be
    // an affordance that always fails.
    expect(row!.removable).toBe(false);
  });

  it('offers removal only for downloaded packs', () => {
    const [row] = mergeCatalogue(catalogue([entry]), [installed({ source: 'downloaded' })]);
    expect(row!.statusLabel).toBe('Installed');
    expect(row!.removable).toBe(true);
  });

  /**
   * A catalogue entry that is not on disk cannot be obtained in this build, so
   * it is labelled as unavailable rather than offered.
   */
  it('labels an uninstalled catalogue entry as unavailable, not downloadable', () => {
    const remote = { ...entry, packId: 'aurora', installedVersion: undefined };
    const [row] = mergeCatalogue(catalogue([remote]), []);
    expect(row!.installed).toBe(false);
    expect(row!.status).toBe('unavailable');
    expect(row!.statusLabel).toBe('Not available in this version');
    expect(row!.removable).toBe(false);
  });

  /**
   * The installed list is the authority on what is on disk. A newer catalogue
   * version is information only — there is no pipeline that could fetch it.
   */
  it('prefers the installed version over the catalogue claim', () => {
    const [row] = mergeCatalogue(
      catalogue([{ ...entry, latestVersion: '2.0.0' }]),
      [installed({ version: '1.0.0', source: 'downloaded' })],
    );
    expect(row!.version).toBe('1.0.0');
    expect(row!.latestVersion).toBe('2.0.0');
    expect(row!.status).toBe('update_available');
    expect(row!.statusLabel).toBe('Newer version listed');
  });

  it('still lists an installed pack the catalogue has dropped', () => {
    const rows = mergeCatalogue(catalogue([]), [
      installed({ packId: 'aurora', displayName: 'Aurora', source: 'downloaded' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.packId).toBe('aurora');
    expect(rows[0]!.removable).toBe(true);
  });

  it('sorts rows by display name', () => {
    const rows = mergeCatalogue(
      catalogue([
        { ...entry, packId: 'zeta', displayName: 'Zeta' },
        { ...entry, packId: 'aurora', displayName: 'Aurora' },
      ]),
      [],
    );
    expect(rows.map((r) => r.displayName)).toEqual(['Aurora', 'Zeta']);
  });

  it('formats pack sizes informationally', () => {
    expect(formatPackSize(18874368)).toBe('18 MB');
    expect(formatPackSize(1536)).toBe('2 KB');
    expect(formatPackSize(0)).toBe('');
    expect(formatPackSize(Number.NaN)).toBe('');
  });
});
