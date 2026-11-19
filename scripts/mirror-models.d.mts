/**
 * Types for what `mirror-models.mjs` exports to TypeScript.
 *
 * `tests/integration/mirror-models.test.ts` drives the key derivation, the
 * transfers and the upload decisions with fakes. The script itself is plain
 * ESM — the mirror workflow runs it under bare `node` — so its type surface
 * lives here rather than in the script.
 */
import type { spawnSync } from 'node:child_process';

export declare const DEFAULT_PUBLIC_URL: string;

export interface MirrorModel {
  id: string;
  installDir: string;
  archive: { fileName: string; upstreamUrl: string; sha256: string; bytes: number };
  attribution: { license: { id: string } };
}

export interface Catalogue {
  mirrorBaseUrl: string | null;
  models: Array<MirrorModel & Record<string, unknown>>;
}

export interface Expected {
  sha256: string;
  bytes: number;
}

export type ReadBack = { status: number } | { status: 200; sha256: string; bytes: number };

export interface MirrorKeys {
  archive: string;
  attribution: string;
  license: string;
}

export interface Bucket {
  head(key: string): { size: number } | null;
  put(
    key: string,
    file: string,
    options: { contentType: string; cacheControl: string; ifAbsent?: boolean },
  ): 'created' | 'exists';
}

type Log = (line: string) => void;

export declare function mirrorUrl(base: string, model: MirrorModel): string;
export declare function mirrorPrefix(mirrorBaseUrl: string, publicUrl: string): string;
export declare function mirrorKeys(prefix: string, model: MirrorModel): MirrorKeys;
export declare function checkModel<T extends MirrorModel>(model: T): T;
export declare function loadCatalogue(path?: string): Catalogue;

export declare function readBack(
  url: string,
  limit: number,
  options?: { fetchFn?: typeof fetch },
): Promise<ReadBack>;
export declare function downloadVerified(
  url: string,
  dest: string,
  expected: Expected,
  options?: { fetchFn?: typeof fetch },
): Promise<void>;

export declare function awsBucket(options: {
  endpoint?: string;
  bucket?: string;
  run?: typeof spawnSync;
}): Bucket;

export declare function verifyArchive(
  url: string,
  expected: Expected,
  options?: {
    read?: (url: string, limit: number) => Promise<ReadBack>;
    attempts?: number;
    delayMs?: number;
    log?: Log;
  },
): Promise<void>;

export declare function syncModel(
  model: MirrorModel,
  context: {
    bucket: Bucket;
    keys: MirrorKeys;
    url: string;
    download: (url: string, dest: string, expected: Expected) => Promise<void>;
    scratch: string;
    log?: Log;
    verify?: (url: string, expected: Expected, options: { log: Log }) => Promise<void>;
  },
): Promise<void>;

export declare function syncNotices(
  model: MirrorModel,
  context: { bucket: Bucket; keys: MirrorKeys; root?: string },
): void;

export declare function syncCatalogue(
  catalogue: Catalogue,
  context: {
    publicUrl: string;
    bucket: Bucket;
    download: (url: string, dest: string, expected: Expected) => Promise<void>;
    scratch: string;
    root?: string;
    log?: Log;
    verify?: (url: string, expected: Expected, options: { log: Log }) => Promise<void>;
  },
): Promise<void>;

export declare function verifyCatalogue(
  catalogue: Catalogue,
  context: {
    publicUrl: string;
    log?: Log;
    verify?: (url: string, expected: Expected, options: { log: Log; attempts: number }) => Promise<void>;
    attempts?: number;
  },
): Promise<void>;
