/**
 * Types for what `release-feed.mjs` exports to TypeScript.
 *
 * `tests/integration/release-feed.test.ts` drives the feed's pure functions
 * and its network checks with a fake fetch. The script itself is plain ESM —
 * the release workflows run it under bare `node` — so its type surface lives
 * here rather than in the script.
 */
import type { KeyObject } from 'node:crypto';

export declare const DEFAULT_PUBLIC_URL: string;
export declare const PRODUCT: string;

export type Os = 'macos' | 'windows' | 'linux';
export type Channel = 'latest' | 'beta' | 'rc';

export declare function channelFor(version: string): Channel;
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
export declare function monotonicVerdict(
  live: string | null,
  candidate: string,
): 'first' | 'published' | 'newer' | 'older';

export declare const PLATFORMS: Record<Os, { readonly targets: readonly string[] }>;
export declare function updaterFeedName(channel: Channel, target: string): string;
export declare function downloadsFeedName(channel: Channel, os: Os): string;

export declare function updaterPublicKey(pubkeyBase64: string): { keyId: Buffer; key: KeyObject };
export declare function verifyUpdaterSignature(
  sigBase64: string,
  data: Buffer,
  publicKey: { keyId: Buffer; key: KeyObject },
): void;

export interface StagedRelease {
  version: string;
  channel: Channel;
  os: Os;
  targets: string[];
  publicUrl: string;
}

export declare function stage(options: {
  os: Os;
  bundle: string;
  out: string;
  version: string;
  notes?: string;
  publicUrl: string;
  pubkey: string;
  now?: Date;
}): StagedRelease;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
interface NetworkOptions {
  fetchFn?: FetchLike;
  log?: (line: string) => void;
  attempts?: number;
  delayMs?: number;
}

export type MonotonicVerdict = 'first' | 'published' | 'newer' | 'older';
export declare function monotonic(
  stageDir: string,
  options?: NetworkOptions,
): Promise<{ verdicts: MonotonicVerdict[] }>;
export declare function writeOnce(
  stageDir: string,
  options?: NetworkOptions,
): Promise<{ unpublished: string[]; published: string[] }>;
export declare function checkOrigin(stageDir: string, publicUrl: string): void;
export declare function newestStable(tags: readonly string[]): string | null;
export declare function rustLines(text: string): string[];
export declare function verifyFiles(stageDir: string, options?: NetworkOptions): Promise<void>;
export declare function verifyFeed(stageDir: string, options?: NetworkOptions): Promise<void>;
