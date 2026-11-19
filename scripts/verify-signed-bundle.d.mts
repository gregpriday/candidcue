/**
 * Types for what `verify-signed-bundle.mjs` exports to TypeScript, for
 * `tests/integration/verify-signed-bundle.test.ts`. The script itself is
 * plain ESM, run by bare `node` in the macOS release workflow.
 */

/** `CS_RUNTIME`, the hardened-runtime bit of a code directory's flags. */
export declare const HARDENED_RUNTIME: number;

/** The slices a universal release must carry. */
export declare const ARCHITECTURES: readonly string[];

/** `com.apple.security.device.audio-input`. */
export declare const MICROPHONE: string;

export interface CodesignDetails {
  identifier: string | undefined;
  flags: number | undefined;
  flagNames: string[];
  signature: string | undefined;
  authorities: string[];
  teamIdentifier: string | undefined;
  timestamp: string | undefined;
}

/** The Team ID in a `Developer ID Application: <name> (<TEAM ID>)` identity. */
export declare function teamFromIdentity(identity: string | undefined): string | undefined;

/** What `codesign -dvvv` (its stderr) says about one slice. */
export declare function parseCodesignDetails(text: string): CodesignDetails;

/** Everything wrong with one slice's signature; empty when it is a release signature. */
export declare function signatureProblems(
  details: CodesignDetails,
  expected: { team: string | undefined; identifier: string },
): string[];

/** Every difference between signed and declared entitlements, in both directions. */
export declare function entitlementProblems(
  signed: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, unknown>>,
): string[];
