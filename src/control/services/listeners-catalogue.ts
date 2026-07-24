/**
 * Listener catalogue (spec §14.2 F, §46.7).
 *
 * `get_listener_catalogue` has always been implemented — it enumerates the
 * bundled packs and reports `source: 'bundled_only'` — and has never had a
 * caller, so the Listeners screen showed a hard-coded "Installed: Mira
 * (bundled)" line and a disabled button.
 *
 * Downloads are a different matter and are handled honestly rather than
 * hopefully: `download_listener` and `cancel_listener_download` return
 * NOT_IMPLEMENTED because no CandidCue-controlled pack host exists. This
 * module therefore exposes `DOWNLOADS_SUPPORTED = false` and the UI shows no
 * download affordance at all — a button that silently does nothing is worse
 * than an absent one. `src-tauri/tests/ipc_contract_tests.rs` asserts the Rust
 * side is still a stub, so the day it is implemented that test fails and this
 * flag has to be revisited.
 *
 * `remove_listener` IS implemented (it refuses bundled packs and deletes
 * downloaded ones), so it is wired for the packs it can act on.
 */
import { invokeOrMock } from './ipc';
import type { InstalledListener } from './listeners';
import { listInstalledListeners } from './listeners';

/** Twin of Rust `ListenerCatalogueEntry`. */
export interface ListenerCatalogueEntry {
  packId: string;
  latestVersion: string;
  displayName: string;
  description: string;
  thumbnailUrl: string;
  approximateBytes: number;
  variants: string[];
  minimumAppVersion: string;
  /** Present when the pack is already on this device. */
  installedVersion?: string;
}

/** Twin of Rust `ListenerCatalogue`. */
export interface ListenerCatalogue {
  entries: ListenerCatalogueEntry[];
  fetchedAt: string;
  /** `bundled_only` until a remote catalogue host exists. */
  source: string;
}

/**
 * Remote pack downloads are not available in this build. Kept as a named
 * constant so the reason travels with the flag and so a single place has to
 * change when the pipeline lands.
 */
export const DOWNLOADS_SUPPORTED = false;

export const DOWNLOADS_UNAVAILABLE_NOTE =
  'Downloadable Listener packs are not available in this version. The packs below ship with the app.';

export async function getListenerCatalogue(forceRefresh = false): Promise<ListenerCatalogue> {
  return invokeOrMock<ListenerCatalogue>(
    'get_listener_catalogue',
    { forceRefresh },
    // Browser dev has no pack library at all. An EMPTY catalogue is the only
    // honest mock: inventing entries here would let a test pass against packs
    // that do not exist.
    () => ({ entries: [], fetchedAt: new Date().toISOString(), source: 'unavailable' }),
  );
}

/**
 * Remove an installed pack. Rust refuses bundled packs with a validation
 * error, so the UI only offers this for downloaded ones — but the refusal is
 * the authority, not the UI.
 */
export async function removeListener(packId: string, version: string): Promise<void> {
  return invokeOrMock<void>('remove_listener', { packId, version }, () => undefined);
}

export type ListenerPackStatus = 'installed' | 'update_available' | 'unavailable';

export interface ListenerPackRow {
  packId: string;
  displayName: string;
  description: string;
  /** The version on this device when installed, otherwise the catalogue's. */
  version: string;
  latestVersion: string;
  thumbnailUrl: string;
  approximateBytes: number;
  installed: boolean;
  source?: InstalledListener['source'];
  status: ListenerPackStatus;
  statusLabel: string;
  /** Only downloaded packs can be removed; Rust refuses bundled ones. */
  removable: boolean;
}

/**
 * Merge the catalogue with what is actually installed.
 *
 * The installed list is the authority on what is on disk: a catalogue entry
 * claims `installedVersion` too, but it is derived from the bundled directory
 * and cannot see a downloaded pack that failed to install.
 */
export function mergeCatalogue(
  catalogue: ListenerCatalogue,
  installed: InstalledListener[],
): ListenerPackRow[] {
  const byId = new Map(installed.map((pack) => [pack.packId, pack]));
  const rows: ListenerPackRow[] = [];

  for (const entry of catalogue.entries) {
    const local = byId.get(entry.packId);
    byId.delete(entry.packId);
    const installedVersion = local?.version ?? entry.installedVersion;
    const isInstalled = installedVersion !== undefined;
    const outdated = isInstalled && installedVersion !== entry.latestVersion;
    const status: ListenerPackStatus = !isInstalled
      ? 'unavailable'
      : outdated
        ? 'update_available'
        : 'installed';
    rows.push({
      packId: entry.packId,
      displayName: entry.displayName,
      description: entry.description,
      version: installedVersion ?? entry.latestVersion,
      latestVersion: entry.latestVersion,
      thumbnailUrl: entry.thumbnailUrl,
      approximateBytes: entry.approximateBytes,
      installed: isInstalled,
      source: local?.source,
      status,
      statusLabel: statusLabelFor(status, local?.source),
      removable: local?.source === 'downloaded',
    });
  }

  // Installed packs the catalogue does not list still exist on disk and must
  // be shown — otherwise a downloaded pack becomes unmanageable the moment the
  // catalogue stops listing it.
  for (const local of byId.values()) {
    rows.push({
      packId: local.packId,
      displayName: local.displayName,
      description: local.description,
      version: local.version,
      latestVersion: local.version,
      thumbnailUrl: '',
      approximateBytes: local.sizeBytes,
      installed: true,
      source: local.source,
      status: 'installed',
      statusLabel: statusLabelFor('installed', local.source),
      removable: local.source === 'downloaded',
    });
  }

  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}

function statusLabelFor(
  status: ListenerPackStatus,
  source: InstalledListener['source'] | undefined,
): string {
  if (status === 'installed') return source === 'bundled' ? 'Included' : 'Installed';
  if (status === 'update_available') {
    // There is no download pipeline, so an available update is information,
    // not an action. Saying "Update" would imply a button that cannot exist.
    return 'Newer version listed';
  }
  return 'Not available in this version';
}

/** "18 MB" / "940 KB" — informational only, never a limit. */
export function formatPackSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
