/**
 * Types for what `sherpa-no-tts.mjs` exports to TypeScript.
 *
 * `tests/integration/gpl-free-native-libs.test.ts` imports the pins, the stub
 * generator and the directory checks, so they are tested without a download.
 * The script itself is plain ESM that runs under bare `node`, so its type
 * surface lives here; importing it runs nothing.
 */
export interface Target {
  /** The release asset's file name. */
  readonly archive: string;
  /** Its pinned SHA-256. */
  readonly sha256: string;
  /** Its size in bytes. */
  readonly bytes: number;
  /** The file name the platform's linker gives a library. */
  file(lib: string): string;
  /** The empty static library written under each stubbed name. */
  stub(): Buffer;
}

/** The sherpa-onnx release the archives come from. */
export declare const VERSION: string;
/** Every library `sherpa-onnx-sys` links, in its own order. */
export declare const LINKED: ReadonlyArray<string>;
/** The text-to-speech libraries a -no-tts archive lacks. */
export declare const STUBBED: ReadonlyArray<string>;
export declare const TARGETS: Readonly<Record<'win-x64' | 'linux-x64', Target>>;
/** The file a verified directory carries beside `lib/`. */
export declare const STAMP: string;

/** The smallest static library MSVC accepts, holding nothing. */
export declare function coffEmptyArchive(): Buffer;
/** What is wrong with a library directory, before or after the stubs. */
export declare function problemsWith(
  libDir: string,
  target: Target,
  options: { stubs: boolean },
): string[];
/** Every text-to-speech marker found in the directory's libraries. */
export declare function markerProblems(libDir: string): string[];
/** The stamp a verified directory carries: archive, marker table and file digests. */
export declare function stampFor(
  libDir: string,
  target: Target,
): { archive: string; sha256: string; markers: string; files: Record<string, string> };
/** Whether the directory under `root` still matches the stamp it was verified with. */
export declare function alreadyVerified(root: string, libDir: string, target: Target): boolean;
