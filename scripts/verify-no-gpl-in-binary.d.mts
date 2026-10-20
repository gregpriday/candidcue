/**
 * Types for what `verify-no-gpl-in-binary.mjs` exports to TypeScript.
 *
 * `tests/integration/gpl-free-native-libs.test.ts` imports the marker table to
 * build its fixtures from the same bytes the gate looks for, and `scanFile` to
 * test the chunk boundary. The script itself is plain ESM that runs under bare
 * `node`, so its type surface lives here; importing it runs nothing.
 */
export interface Marker {
  /** The `sbom/native-components.json` entry the bytes belong to. */
  readonly component: string;
  readonly kind: 'literal' | 'symbol' | 'table';
  readonly label: string;
  readonly bytes: Buffer;
}

/** Bytes only eSpeak NG, ucd-tools or piper-phonemize contain. */
export declare const MARKERS: ReadonlyArray<Marker>;

/** Bytes any binary carrying the speech runtime contains. */
export declare const ANCHORS: ReadonlyArray<Marker>;

/** How many times each marker occurs in the file, read `chunk` bytes at a time. */
export declare function scanFile(
  path: string,
  markers: ReadonlyArray<Marker>,
  chunk?: number,
): number[];
