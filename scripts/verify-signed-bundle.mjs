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
 *   codesign -d --entitlements          did the microphone entitlement survive?
 *   spctl --assess                      would Gatekeeper let this open?
 *   stapler validate                    is the notarisation ticket attached?
 *
 * Usage:
 *   node scripts/verify-signed-bundle.mjs path/to/CandidCue.app [--unsigned]
 *
 * `--unsigned` runs the checks that do not need a signature — layout, Info.plist,
 * architectures, no model weights — and SAYS which it skipped. That is for CI,
 * which builds without credentials; it is not a mode a release may use, and the
 * summary says so rather than printing a green tick.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const bundle = process.argv[2];
const unsignedOnly = process.argv.includes('--unsigned');

if (!bundle) {
  console.error('Usage: node scripts/verify-signed-bundle.mjs <CandidCue.app> [--unsigned]');
  process.exit(1);
}
if (!existsSync(bundle) || !statSync(bundle).isDirectory()) {
  console.error(`Not an application bundle: ${bundle}`);
  process.exit(1);
}

const problems = [];
const passed = [];
const skipped = [];

/** Run a tool, returning `{ ok, output }` rather than throwing. */
function tool(command, args) {
  try {
    // Both `codesign` and `spctl` write their verdict to stderr.
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}` || String(error.message),
    };
  }
}

function check(name, { ok, output }, detail) {
  if (ok) passed.push(name);
  else problems.push(`${name}: ${detail}\n      ${output.trim().split('\n').join('\n      ')}`);
}

/* -------------------------------------------------- structure, unsigned */

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

// Architectures. A release that is arm64-only will not open on an Intel Mac,
// and the failure a user sees is "the application cannot be opened".
const executable = join(bundle, 'Contents/MacOS/CandidCue');
if (existsSync(executable)) {
  const { ok, output } = tool('lipo', ['-archs', executable]);
  if (ok) {
    const archs = output.trim().split(/\s+/);
    passed.push(`architectures: ${archs.join(', ')}`);
    if (!archs.includes('arm64')) {
      problems.push(`the executable has no arm64 slice (found ${archs.join(', ')})`);
    }
  } else {
    problems.push(`could not read the executable's architectures: ${output.trim()}`);
  }
} else {
  problems.push(`Contents/MacOS/CandidCue is missing — the bundle has no executable`);
}

// No model weights. Delegated, because that check has its own tests.
{
  const { ok, output } = tool(process.execPath, [
    join(ROOT, 'scripts/verify-no-model-weights.mjs'),
    bundle,
  ]);
  check('no speech-model weights', { ok, output }, 'the installer must ship zero model bytes');
}

/* --------------------------------------------------- signature and notary */

if (unsignedOnly) {
  skipped.push(
    'code signature, entitlements, Gatekeeper assessment and notarisation ticket — ' +
      '--unsigned was passed',
  );
} else {
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

  // The entitlement, read back off the SIGNED artifact rather than off the
  // plist we handed the signer. Those are different claims.
  const entitlements = tool('codesign', ['-d', '--entitlements', ':-', bundle]);
  if (!entitlements.ok) {
    problems.push(`could not read entitlements: ${entitlements.output.trim()}`);
  } else if (!entitlements.output.includes('com.apple.security.device.audio-input')) {
    problems.push(
      'the signed bundle carries no audio-input entitlement. Under the hardened runtime ' +
        'the microphone is gated by the ENTITLEMENT, not by the usage string — with one ' +
        'and not the other the prompt never appears and the mic is silently dead.',
    );
  } else {
    passed.push('microphone entitlement survived signing');
  }

  // Gatekeeper's own verdict, which is the one that matters on a clean Mac.
  check(
    'Gatekeeper assessment',
    tool('spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]),
    'this is what a user’s Mac decides when they open the app',
  );

  // The stapled ticket. Without it the first launch needs the network, and on
  // a machine that is offline it fails.
  check(
    'notarisation ticket',
    tool('stapler', ['validate', bundle]),
    'a stapled ticket is what lets a first launch work offline',
  );
}

/* ------------------------------------------------------------------ done */

console.log(`Inspected ${bundle}\n`);
for (const name of passed) console.log(`  PASS   ${name}`);
for (const note of skipped) console.log(`  SKIP   ${note}`);

if (problems.length > 0) {
  console.error(`\nArtifact inspection FAILED — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

if (unsignedOnly) {
  console.log(
    '\nArtifact inspection passed the UNSIGNED subset. This is not a releasable result: ' +
      'nothing here has checked the signature, the entitlements as signed, Gatekeeper, ' +
      'or notarisation.',
  );
} else {
  console.log('\nArtifact inspection PASSED — signed, entitled, assessed and stapled.');
}
