#!/usr/bin/env node
/**
 * Does this artifact actually work on somebody else's Mac?
 *
 * A Tauri application can pass every test in the repository and still fail
 * after signing — because of entitlements, nested binaries, quarantine, the
 * hardened runtime, a missing resource, or an architecture mismatch. None of
 * those are visible from source. The 1.0 readiness review's point was that a
 * release needs evidence about the ARTIFACT, and there was none.
 *
 * So this asks the artifact directly, using the tools that will be run on it
 * anyway when a user opens it:
 *
 *   codesign --verify --deep --strict   is every nested binary signed?
 *   codesign -dvvv --arch <slice>       for EACH slice: a Developer ID
 *                                       Application signature (not ad hoc),
 *                                       the release's Team ID, the bundle id,
 *                                       a secure timestamp, and the hardened
 *                                       runtime flag (0x10000)
 *   codesign -d --entitlements          for each slice: exactly the
 *                                       entitlements the source plist
 *                                       declares, the microphone among them
 *   spctl --assess                      would Gatekeeper let this open?
 *   stapler validate                    is the notarisation ticket attached?
 *
 * Why each of those, rather than the first and the last alone: #189. The
 * build that shipped until then was `flags=0x20002(adhoc,linker-signed)` —
 * the linker's ad-hoc signature, no hardened runtime, no entitlements at all —
 * and under the hardened runtime the microphone is gated by the
 * `com.apple.security.device.audio-input` ENTITLEMENT. A signature with the
 * runtime bit and no entitlement opens fine and never shows the microphone
 * prompt. Nothing but reading the flags and the entitlements back off the
 * signed slices tells those builds apart.
 *
 * Usage:
 *   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" \
 *     node scripts/verify-signed-bundle.mjs "path/to/Speaking Glass.app"
 *
 * The identity is how the check knows which Team ID the bundle must carry; it
 * is the same secret the build signed with (`release-credentials.mjs` holds
 * its shape). Without it the inspection FAILS rather than skipping the team:
 * a check that weakened itself when its input went missing would pass a
 * bundle signed by anybody.
 *
 * There is no unsigned mode. CI builds an unsigned `.app` and checks it with
 * `verify-no-model-weights.mjs` directly; this script exists for the signed
 * artifact and nothing else.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEVELOPER_ID_IDENTITY } from './release-credentials.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `CS_RUNTIME`: the hardened runtime. `codesign` prints it as `runtime`. */
export const HARDENED_RUNTIME = 0x10000;
/** `CS_ADHOC`: signed with no identity. The linker sets it on its own signature. */
const ADHOC = 0x2;

/** The slices a universal release must carry, each signed in its own right. */
export const ARCHITECTURES = ['arm64', 'x86_64'];

/** The entitlement voice following cannot work without under the hardened runtime. */
export const MICROPHONE = 'com.apple.security.device.audio-input';

const ENTITLEMENTS_SOURCE = 'src-tauri/entitlements/entitlements.macos.plist';

/** The Team ID in a `Developer ID Application: <name> (<TEAM ID>)` identity. */
export function teamFromIdentity(identity) {
  return DEVELOPER_ID_IDENTITY.exec(identity ?? '')?.[1];
}

/**
 * What `codesign -dvvv` says about one slice. It writes all of this to
 * STDERR, on success as well as failure.
 */
export function parseCodesignDetails(text) {
  const field = (key) => {
    const match = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return match ? match[1].trim() : undefined;
  };
  const directory = /^CodeDirectory\b.*\bflags=(0x[0-9a-fA-F]+)(?:\(([^)]*)\))?/m.exec(text);
  return {
    identifier: field('Identifier'),
    flags: directory ? Number.parseInt(directory[1], 16) : undefined,
    flagNames: directory?.[2] ? directory[2].split(',').map((name) => name.trim()) : [],
    signature: field('Signature'),
    authorities: [...text.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1].trim()),
    teamIdentifier: field('TeamIdentifier'),
    timestamp: field('Timestamp'),
  };
}

/**
 * Everything wrong with one slice's signature, for a bundle meant to be
 * signed by `team` as `identifier`. Empty means it is a Developer ID,
 * hardened-runtime, timestamped signature of the right app by the right team.
 */
export function signatureProblems(details, { team, identifier }) {
  if (details.flags === undefined) {
    return ['codesign reports no code directory: the slice is not signed at all'];
  }
  const problems = [];
  const flags = `flags=0x${details.flags.toString(16)}(${details.flagNames.join(',')})`;
  if ((details.flags & ADHOC) !== 0 || details.signature === 'adhoc') {
    problems.push(
      `it is signed ad hoc (${flags}). That is the linker's own signature, or codesign's "-" identity: ` +
        'Gatekeeper refuses it on every Mac but the one that built it.',
    );
  }
  if ((details.flags & HARDENED_RUNTIME) === 0) {
    problems.push(
      `the hardened runtime is off (${flags}, no 0x10000 "runtime" bit). Notarisation refuses it, and a ` +
        `build without it never exercises the ${MICROPHONE} entitlement the release depends on.`,
    );
  }
  const leaf = details.authorities[0];
  if (!leaf?.startsWith('Developer ID Application: ')) {
    problems.push(
      `it is not signed by a Developer ID Application certificate (first authority: ${leaf ?? 'none'}). ` +
        'Only that certificate is accepted for an app downloaded outside the App Store.',
    );
  }
  const signedTeam = details.teamIdentifier;
  if (signedTeam === undefined || signedTeam === 'not set') {
    problems.push('it carries no Team ID');
  } else if (signedTeam !== team) {
    problems.push(`it is signed by Team ID ${signedTeam}, not ${team ?? 'the release identity'}`);
  }
  if (details.identifier !== identifier) {
    problems.push(`its signing identifier is ${details.identifier ?? 'not reported'}, not ${identifier}`);
  }
  if (!details.timestamp) {
    problems.push(
      'it has no secure timestamp (no Timestamp= line). Notarisation requires one; `Signed Time=` is the ' +
        "signing machine's own clock and does not count.",
    );
  }
  return problems;
}

const shown = (value) => (value === undefined ? 'absent' : JSON.stringify(value));

/**
 * Everything that differs between the entitlements read off a signed slice
 * and the ones the source plist declares. The comparison is exact in both
 * directions: a missing entitlement silently disables something, and an extra
 * one (`get-task-allow`, `allow-jit`, `disable-library-validation`) weakens
 * the runtime or is refused by notarisation outright.
 */
export function entitlementProblems(signed, source) {
  const problems = [];
  if (signed[MICROPHONE] !== true) {
    problems.push(
      `${MICROPHONE} is ${shown(signed[MICROPHONE])}, not true. Under the hardened runtime the microphone ` +
        'is gated by this ENTITLEMENT, not by the usage string: without it the prompt never appears and ' +
        'voice following is silently dead.',
    );
  }
  for (const [key, value] of Object.entries(source)) {
    if (key === MICROPHONE && signed[key] !== true) continue;
    if (!isDeepStrictEqual(signed[key], value)) {
      problems.push(`${key} is ${shown(signed[key])} in the signed bundle and ${shown(value)} in ${ENTITLEMENTS_SOURCE}`);
    }
  }
  for (const key of Object.keys(signed)) {
    if (Object.hasOwn(source, key)) continue;
    problems.push(
      `${key} is granted by the signed bundle but not declared in ${ENTITLEMENTS_SOURCE}` +
        (key === 'com.apple.security.get-task-allow' ? ' (a debug entitlement notarisation refuses)' : ''),
    );
  }
  return problems;
}

/** Run a tool, returning its status and both streams rather than throwing. */
function tool(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    ok: result.status === 0,
    stdout,
    stderr,
    output: `${stdout}${stderr}` || String(result.error?.message ?? `exited ${result.status}`),
  };
}

/** A property list file, or `codesign`'s XML on stdin, as a plain object. */
function readPlist(args, input) {
  const converted = tool('plutil', ['-convert', 'json', '-o', '-', ...args], input);
  if (!converted.ok) return { error: converted.output.trim() };
  try {
    return { value: JSON.parse(converted.stdout) };
  } catch (error) {
    return { error: String(error.message) };
  }
}

function inspect(bundle, env) {
  const problems = [];
  const passed = [];

  const check = (name, { ok, output }, detail) => {
    if (ok) passed.push(name);
    else problems.push(`${name}: ${detail}\n      ${output.trim().split('\n').join('\n      ')}`);
  };

  /* ------------------------------------------------------------ structure */

  // Info.plist, and the two keys a microphone app cannot ship without.
  const plist = join(bundle, 'Contents/Info.plist');
  if (!existsSync(plist)) {
    problems.push('Contents/Info.plist is missing — this is not an application bundle');
  } else {
    const raw = readFileSync(plist, 'utf8');
    /*
     * `NSMicrophoneUsageDescription` is what macOS SHOWS in the permission
     * prompt. Without it the prompt does not appear and the microphone is
     * silently dead in the signed build — the exact "works in dev, mic dead in
     * the DMG" failure the entitlements file was written to prevent, in its
     * other half.
     */
    if (!raw.includes('NSMicrophoneUsageDescription')) {
      problems.push(
        'Info.plist has no NSMicrophoneUsageDescription. macOS will not show a microphone ' +
          'prompt, and voice following will be silently dead in this build.',
      );
    } else {
      passed.push('microphone usage description');
    }

    if (!raw.includes('LSMinimumSystemVersion')) {
      problems.push('Info.plist declares no LSMinimumSystemVersion');
    } else {
      passed.push('minimum system version');
    }
  }

  /*
   * The executable is named by Info.plist, not by the product.
   *
   * This used to be `Contents/MacOS/Speaking Glass`, and there is no such file: the
   * Mach-O carries the CARGO BIN name, which is `speaking-glass`, while `Speaking Glass` is
   * only the bundle's display name. Every release would have reported "the bundle
   * has no executable" and stopped — a gate failing on its own spelling. Reading
   * CFBundleExecutable is also the only version that survives a rename of either.
   */
  const executableLookup = tool('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist]);
  const bundleExecutableName = executableLookup.ok ? executableLookup.stdout.trim() : '';
  if (!bundleExecutableName) {
    // `plutil`'s own words. "No CFBundleExecutable" and "no Info.plist" and
    // "that is not a property list" are three different problems, and a report
    // that flattens them sends the reader to the wrong one.
    problems.push(
      'Info.plist does not yield a CFBundleExecutable, so the bundle does not say which ' +
        `file to run: ${executableLookup.output.trim() || 'the key is absent or empty'}`,
    );
  }
  const executable = join(bundle, 'Contents/MacOS', bundleExecutableName || 'Speaking Glass');
  if (bundleExecutableName && existsSync(executable)) {
    passed.push(`executable: Contents/MacOS/${bundleExecutableName}`);
    const archs = tool('lipo', ['-archs', executable]);
    if (archs.ok) {
      const found = archs.stdout.trim().split(/\s+/);
      passed.push(`architectures: ${found.join(', ')}`);
      // BOTH, not just arm64. This script runs on the universal build and
      // nowhere else, and the release promises an app that opens on an Intel
      // Mac. Accepting an arm64-only slice here would let a bundler that
      // silently dropped the x86_64 target ship as "universal" — a claim a user
      // only discovers is false when the app will not open, with no reason
      // given. `lipo -archs` says `arm64` for the arm slice and `x86_64` for
      // the Intel one.
      for (const required of ARCHITECTURES) {
        if (!found.includes(required)) {
          problems.push(
            `the executable has no ${required} slice (found ${found.join(', ')}). The release ` +
              `is advertised as universal; either build both targets or stop advertising it.`,
          );
        }
      }
    } else {
      problems.push(`could not read the executable's architectures: ${archs.output.trim()}`);
    }
  } else if (bundleExecutableName) {
    problems.push(
      `Contents/MacOS/${bundleExecutableName} is missing — Info.plist names an executable ` +
        `the bundle does not contain`,
    );
  }

  // No model weights. Delegated, because that check has its own tests.
  check(
    'no speech-model weights',
    tool(process.execPath, [join(ROOT, 'scripts/verify-no-model-weights.mjs'), bundle]),
    'the installer must ship zero model bytes',
  );

  /* ----------------------------------------------------------- signature */

  /*
   * `--deep --strict` because the interesting failures are in the NESTED
   * binaries. A top-level signature can be perfectly valid over a bundle
   * containing an unsigned dylib, and the first anyone hears about it is a
   * user's Mac refusing to open the app.
   */
  check(
    'code signature (deep, strict)',
    tool('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]),
    'every nested binary must be signed, or Gatekeeper refuses the bundle',
  );

  const team = teamFromIdentity(env.APPLE_SIGNING_IDENTITY);
  if (!team) {
    problems.push(
      'APPLE_SIGNING_IDENTITY is not set to a "Developer ID Application: <name> (<TEAM ID>)" identity, ' +
        'so there is no Team ID to hold the signature to. Export the identity the release was signed with.',
    );
  }
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  const identifier = conf.identifier;

  const source = readPlist([join(ROOT, ENTITLEMENTS_SOURCE)]);
  if (source.error) problems.push(`could not read ${ENTITLEMENTS_SOURCE}: ${source.error}`);

  /*
   * Per slice. Each architecture of a universal binary carries its own code
   * directory, flags and entitlements, and Gatekeeper reads the one the Mac
   * runs: an Intel Mac never sees the arm64 slice's signature. The main
   * executable is what the hardened runtime and the entitlements apply to;
   * nested code (none today) is covered by the deep, strict verify above.
   */
  for (const arch of ARCHITECTURES) {
    const described = tool('codesign', ['-d', '-vvv', '--arch', arch, bundle]);
    const details = parseCodesignDetails(described.stderr);
    const signature = described.ok
      ? signatureProblems(details, { team, identifier })
      : [`codesign could not describe it: ${described.output.trim()}`];
    for (const problem of signature) problems.push(`${arch} slice: ${problem}`);
    // Said on its own, because it is the one #189 turned on: a log that shows
    // it passing beside an ad-hoc failure says which half of signing broke.
    if (details.flags !== undefined && (details.flags & HARDENED_RUNTIME) !== 0) {
      passed.push(`${arch} slice: hardened runtime (flags=0x${details.flags.toString(16)})`);
    }
    if (signature.length === 0) {
      passed.push(`${arch} slice: Developer ID, Team ${details.teamIdentifier}, hardened runtime, timestamped`);
    }

    // The entitlements, read back off the SIGNED slice rather than off the
    // plist handed to the signer. Those are different claims.
    const xml = tool('codesign', ['-d', '--arch', arch, '--entitlements', '-', '--xml', bundle]);
    if (!xml.ok) {
      problems.push(`${arch} slice: could not read its entitlements: ${xml.output.trim()}`);
      continue;
    }
    // A signature with no entitlements prints nothing at all.
    const signed = xml.stdout.trim() === '' ? { value: {} } : readPlist(['-'], xml.stdout);
    if (signed.error) {
      problems.push(`${arch} slice: could not parse its entitlements: ${signed.error}`);
      continue;
    }
    if (source.error) continue;
    const entitlements = entitlementProblems(signed.value, source.value);
    for (const problem of entitlements) problems.push(`${arch} slice: ${problem}`);
    if (entitlements.length === 0) {
      passed.push(`${arch} slice: entitlements match ${ENTITLEMENTS_SOURCE}, microphone granted`);
    }
  }

  // Gatekeeper's own verdict, which is the one that matters on a clean Mac.
  // Its `source=` line ("Notarized Developer ID") goes in the report; the
  // stapled ticket below is what holds notarisation itself.
  const gatekeeper = tool('spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
  const verdictSource = /^source=(.*)$/m.exec(gatekeeper.output)?.[1]?.trim();
  check(
    `Gatekeeper assessment${verdictSource ? ` (${verdictSource})` : ''}`,
    gatekeeper,
    'this is what a user’s Mac decides when they open the app',
  );

  // The stapled ticket. Without it the first launch needs the network, and on
  // a machine that is offline it fails. Tauri's own stapling ignores the
  // stapler's exit status, so a build that "notarised" can still lack one.
  // `validate` asks Apple's ticket service, and the release runs it on three
  // copies after an hour of building: when it is the ONLY thing wrong, a
  // transient service error gets two more tries. A missing or invalid ticket
  // fails all three, a few seconds later.
  let stapled = tool('xcrun', ['stapler', 'validate', bundle]);
  const otherwiseClean = problems.length === 0;
  for (let attempt = 2; attempt <= 3 && !stapled.ok && otherwiseClean; attempt++) {
    spawnSync('sleep', ['5']);
    stapled = tool('xcrun', ['stapler', 'validate', bundle]);
  }
  check('notarisation ticket', stapled, 'a stapled ticket is what lets a first launch work offline');

  return { problems, passed };
}

function main(argv, env) {
  const [bundle, ...rest] = argv;
  if (!bundle || bundle.startsWith('-') || rest.length > 0) {
    console.error('Usage: APPLE_SIGNING_IDENTITY=… node scripts/verify-signed-bundle.mjs <Speaking Glass.app>');
    return 2;
  }
  if (!existsSync(bundle) || !statSync(bundle).isDirectory()) {
    console.error(`Not an application bundle: ${bundle}`);
    return 1;
  }

  const { problems, passed } = inspect(bundle, env);

  console.log(`Inspected ${bundle}\n`);
  for (const name of passed) console.log(`  PASS   ${name}`);

  if (problems.length > 0) {
    console.error(`\nArtifact inspection FAILED — ${problems.length} problem(s):\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    return 1;
  }
  console.log('\nArtifact inspection PASSED — Developer ID signed, hardened, entitled, assessed and stapled.');
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
