/**
 * Script asset service (spec §46.3, §50.7).
 *
 * C10: these wrappers did not exist. The editor's "Insert image" button typed
 * the literal string `![Image description](./assets/image.png)` into the
 * document — a path that has never existed — so `import_image` had zero
 * callers and the Rust-side picker and the MIME/size validation were
 * unreachable from the product.
 *
 * As with import/export of scripts, the picker runs in Rust: there is no
 * `sourceFile` argument for the webview to forge.
 */
import type { CompiledAsset } from '../../shared/contracts';
import { invokeOrMock } from './ipc';

/** One image the compiler found, in the form Rust looks it up by. */
export interface AssetUrlRequest {
  /** The compiler's `img-<hash>` node key; Rust answers under it. */
  id: string;
  /** The authored reference. Rust resolves its basename inside the script's own asset directory. */
  href: string;
}

/** A scoped `asset://` url Rust has vouched for. */
export interface ResolvedAssetUrl {
  url: string;
  mime: string;
}

/** The images in a compile worth asking about: remote ones are never loaded (§24.2). */
export function localImageRequests(assets: readonly CompiledAsset[]): AssetUrlRequest[] {
  return assets
    .filter((a) => !a.remote && a.kind === 'image')
    .map((a) => ({ id: a.id, href: a.href }));
}

/**
 * Resolve local images to scoped urls through Rust (asset-protocol scope,
 * §47.8).
 *
 * Rust leaves out every id it could not find — unknown, gone from disk, or
 * outside the script's asset directory — so an absent id means "not found". A
 * rejection is a different answer (the lookup itself failed) and is passed on
 * rather than folded into an empty map: a caller that wants to say an image is
 * missing has to be able to tell the two apart.
 */
export async function resolveAssetUrls(
  scriptId: string,
  requests: readonly AssetUrlRequest[],
): Promise<Record<string, ResolvedAssetUrl>> {
  if (requests.length === 0) return {};
  const entries = await invokeOrMock<Record<string, ResolvedAssetUrl>>(
    'resolve_asset_urls',
    { scriptId, assetsToResolve: requests },
    // MOCK: no asset protocol in browser dev, so nothing resolves.
    () => ({}),
  );
  const resolved: Record<string, ResolvedAssetUrl> = {};
  for (const [id, entry] of Object.entries(entries)) {
    resolved[id] = { url: entry.url, mime: entry.mime };
  }
  return resolved;
}

/** Twin of Rust `ImportedAsset` (src-tauri/src/assets/mod.rs). */
export interface ImportedAsset {
  assetId: string;
  sha256: string;
  mime: string;
  extension: string;
  sizeBytes: number;
  /** Markdown-relative path (`assets/<sha256>.<ext>`) to write into the source. */
  markdownPath: string;
  /** Scoped `asset://` url for immediate preview. */
  url: string;
  originalName?: string;
}

/**
 * Copy a local image into the script's asset directory. Rust runs the open
 * dialog, so the operator — not the webview — chooses the file.
 * `null` means the operator cancelled.
 */
export async function importImage(scriptId: string): Promise<ImportedAsset | null> {
  return invokeOrMock<ImportedAsset | null>('import_image', { scriptId }, () =>
    // MOCK: no file access in browser dev. Keep the old placeholder path so
    // `pnpm dev` without Tauri still demonstrates the insertion.
    mockImportedAsset(),
  );
}

function mockImportedAsset(): ImportedAsset {
  return {
    assetId: 'mock-asset',
    sha256: 'mock',
    mime: 'image/png',
    extension: 'png',
    sizeBytes: 0,
    markdownPath: 'assets/image.png',
    url: '',
  };
}
