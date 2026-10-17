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
import { invokeOrMock } from './ipc';

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
