/**
 * The post-signing inspection, `scripts/verify-signed-bundle.mjs`.
 *
 * Nobody here holds the Developer ID certificate, so a passing run can only
 * happen on a release runner. What CAN be proven without it is that every
 * build short of a release signature fails, and for the right reason:
 *
 *   - the parsers and judgements, from `codesign -dvvv` text: the issue's own
 *     ad-hoc output (#189), a Developer ID release signature, and each way the
 *     latter can be wrong;
 *   - on a Mac, the whole script against real bundles this test signs ad hoc
 *     (`codesign -s -`), which CAN carry the hardened runtime and
 *     entitlements: so the runtime and entitlement checks are exercised on
 *     codesign's real output, while the signature checks must still refuse.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HARDENED_RUNTIME,
  MICROPHONE,
  entitlementProblems,
  parseCodesignDetails,
  signatureProblems,
  teamFromIdentity,
} from '../../scripts/verify-signed-bundle.mjs';

const SCRIPT = resolve(__dirname, '../../scripts/verify-signed-bundle.mjs');
const ENTITLEMENTS = resolve(__dirname, '../../src-tauri/entitlements/entitlements.macos.plist');
const IDENTIFIER = 'com.speakingglass.app';
const TEAM = 'A1B2C3D4E5';
const IDENTITY = `Developer ID Application: Ada Lovelace (${TEAM})`;

/** Synthetic, shaped on what #189 reported: the linker's signature and nothing else. */
const ISSUE_ADHOC = `Executable=/tmp/Speaking Glass.app/Contents/MacOS/speaking-glass
Identifier=speaking_glass-5f0c1d2e3a4b5c6d
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20400 size=12345 flags=0x20002(adhoc,linker-signed) hashes=380+0 location=embedded
Hash type=sha256 size=32
CDHash=0123456789abcdef0123456789abcdef01234567
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
`;

/** A notarised Developer ID release signature, as `codesign -dvvv --arch arm64` prints one. */
const RELEASE = `Executable=/tmp/Speaking Glass.app/Contents/MacOS/speaking-glass
Identifier=${IDENTIFIER}
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=98765 flags=0x10000(runtime) hashes=3075+7 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=0123456789abcdef0123456789abcdef01234567
CDHash=0123456789abcdef0123456789abcdef01234567
Signature size=9041
Authority=${IDENTITY}
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=19 Nov 2026 at 10:00:00
Notarization Ticket=stapled
Info.plist entries=24
TeamIdentifier=${TEAM}
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=42
Internal requirements count=1 size=216
`;

const expected = { team: TEAM, identifier: IDENTIFIER };
const SOURCE = { [MICROPHONE]: true, 'com.apple.security.network.client': true };

describe('reading a signature', () => {
  it('parses the issue’s ad-hoc build and refuses it on every count', () => {
    const details = parseCodesignDetails(ISSUE_ADHOC);
    expect(details.flags).toBe(0x20002);
    expect(details.flagNames).toEqual(['adhoc', 'linker-signed']);
    expect(details.signature).toBe('adhoc');
    expect(details.teamIdentifier).toBe('not set');
    expect(details.authorities).toEqual([]);

    const problems = signatureProblems(details, expected).join('\n');
    expect(problems).toContain('signed ad hoc (flags=0x20002(adhoc,linker-signed))');
    expect(problems).toContain('the hardened runtime is off');
    expect(problems).toContain('not signed by a Developer ID Application certificate (first authority: none)');
    expect(problems).toContain('carries no Team ID');
    expect(problems).toContain(`its signing identifier is speaking_glass-5f0c1d2e3a4b5c6d, not ${IDENTIFIER}`);
    expect(problems).toContain('no secure timestamp');
  });

  it('accepts a Developer ID, hardened-runtime, timestamped signature by the release team', () => {
    const details = parseCodesignDetails(RELEASE);
    expect(details.flags! & HARDENED_RUNTIME).toBe(HARDENED_RUNTIME);
    expect(details.authorities[0]).toBe(IDENTITY);
    expect(details.teamIdentifier).toBe(TEAM);
    expect(signatureProblems(details, expected)).toEqual([]);
  });

  it('reads the runtime bit from the flags, whatever else is set beside it', () => {
    // `runtime` alongside other bits, as codesign prints for a library-validated app.
    const withKill = RELEASE.replace('flags=0x10000(runtime)', 'flags=0x12200(kill,library-validation,runtime)');
    expect(signatureProblems(parseCodesignDetails(withKill), expected)).toEqual([]);
    // The number decides, not codesign's label for it.
    const unlabelled = RELEASE.replace('flags=0x10000(runtime)', 'flags=0x10000');
    expect(signatureProblems(parseCodesignDetails(unlabelled), expected)).toEqual([]);
    const labelOnly = RELEASE.replace('flags=0x10000(runtime)', 'flags=0x0(runtime)');
    expect(signatureProblems(parseCodesignDetails(labelOnly), expected).join('\n')).toContain(
      'the hardened runtime is off',
    );
  });

  it.each([
    ['the ad-hoc flag alone', RELEASE.replace('flags=0x10000(runtime)', 'flags=0x10002(adhoc,runtime)')],
    ['the Signature line alone', RELEASE.replace('Signature size=9041', 'Signature=adhoc')],
  ])('calls a signature ad hoc on %s', (_label, text) => {
    expect(signatureProblems(parseCodesignDetails(text), expected).join('\n')).toContain('it is signed ad hoc');
  });

  it.each([
    ['without the hardened runtime', RELEASE.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), 'the hardened runtime is off'],
    ['by a development certificate', RELEASE.replace(`Authority=${IDENTITY}`, `Authority=Apple Development: Ada Lovelace (${TEAM})`), 'first authority: Apple Development: Ada Lovelace'],
    ['by another team', RELEASE.replaceAll(TEAM, 'Z9Y8X7W6V5'), `signed by Team ID Z9Y8X7W6V5, not ${TEAM}`],
    ['with a Developer ID that is not the leaf', RELEASE.replace(`Authority=${IDENTITY}`, `Authority=Apple Development: Ada (${TEAM})\nAuthority=${IDENTITY}`), 'first authority: Apple Development: Ada'],
    ['with no TeamIdentifier line', RELEASE.replace(`TeamIdentifier=${TEAM}\n`, ''), 'it carries no Team ID'],
    ['with an empty timestamp', RELEASE.replace(/^Timestamp=.*$/m, 'Timestamp='), 'no secure timestamp'],
    ['as another app', RELEASE.replace(`Identifier=${IDENTIFIER}`, 'Identifier=com.example.other'), `its signing identifier is com.example.other, not ${IDENTIFIER}`],
    ['with only the signer’s own clock', RELEASE.replace(/^Timestamp=.*$/m, 'Signed Time=19 Nov 2026 at 10:00:00'), 'no secure timestamp'],
    ['with no code directory at all', 'test.app: code object is not signed at all\n', 'not signed at all'],
  ])('refuses a signature made %s', (_label, text, problem) => {
    const problems = signatureProblems(parseCodesignDetails(text), expected);
    expect(problems.join('\n')).toContain(problem);
    if (_label !== 'with no code directory at all') expect(problems).toHaveLength(1);
  });

  it('refuses any team when the release identity is unknown, rather than accepting every one', () => {
    expect(signatureProblems(parseCodesignDetails(RELEASE), { team: undefined, identifier: IDENTIFIER })).toEqual([
      `it is signed by Team ID ${TEAM}, not the release identity`,
    ]);
  });

  it('takes the Team ID from the release identity, and nothing from any other shape', () => {
    expect(teamFromIdentity(IDENTITY)).toBe(TEAM);
    expect(teamFromIdentity('Developer ID Application: Acme (UK) Ltd (Q1W2E3R4T5)')).toBe('Q1W2E3R4T5');
    for (const other of [undefined, '', '-', `Apple Development: Ada (${TEAM})`, 'F'.repeat(40)]) {
      expect(teamFromIdentity(other)).toBeUndefined();
    }
  });
});

describe('reading entitlements', () => {
  it('accepts exactly the declared set', () => {
    expect(entitlementProblems({ ...SOURCE }, SOURCE)).toEqual([]);
  });

  it.each([
    ['absent', {}],
    ['false', { [MICROPHONE]: false }],
    ['not a boolean', { [MICROPHONE]: 1 }],
  ])('refuses a microphone entitlement that is %s, and says why it matters', (_label, mic) => {
    const signed = { 'com.apple.security.network.client': true, ...mic };
    const problems = entitlementProblems(signed, SOURCE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${MICROPHONE} is`);
    expect(problems[0]).toContain('not by the usage string');
  });

  it('compares values, not just keys', () => {
    expect(entitlementProblems({ ...SOURCE, 'com.apple.security.network.client': false }, SOURCE)).toEqual([
      'com.apple.security.network.client is false in the signed bundle and true in src-tauri/entitlements/entitlements.macos.plist',
    ]);
  });

  it('holds the microphone to the source in both directions too', () => {
    // A source that stopped declaring it, or declared it false, is a change the
    // signed bundle must follow, and the microphone check alone would miss it.
    expect(entitlementProblems(SOURCE, { 'com.apple.security.network.client': true })).toEqual([
      `${MICROPHONE} is granted by the signed bundle but not declared in src-tauri/entitlements/entitlements.macos.plist`,
    ]);
    expect(entitlementProblems(SOURCE, { ...SOURCE, [MICROPHONE]: false })).toEqual([
      `${MICROPHONE} is true in the signed bundle and false in src-tauri/entitlements/entitlements.macos.plist`,
    ]);
  });

  it('refuses a declared entitlement that did not survive signing', () => {
    expect(entitlementProblems({ [MICROPHONE]: true }, SOURCE)).toEqual([
      'com.apple.security.network.client is absent in the signed bundle and true in src-tauri/entitlements/entitlements.macos.plist',
    ]);
  });

  it('refuses entitlements the source never declared, naming the debug one', () => {
    const problems = entitlementProblems(
      { ...SOURCE, 'com.apple.security.get-task-allow': true, 'com.apple.security.cs.allow-jit': true },
      SOURCE,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('com.apple.security.get-task-allow is granted by the signed bundle but not declared');
    expect(problems[0]).toContain('a debug entitlement notarisation refuses');
    expect(problems[1]).toContain('com.apple.security.cs.allow-jit is granted');
  });
});

describe('the command line', () => {
  // `--unsigned` was an escape hatch with no caller; a release must not find one.
  it.each([[['--unsigned']], [[]], [['a.app', 'b.app']]])('refuses the invocation %j', (args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});

/*
 * The real thing, on a Mac. A universal executable from the system compiler
 * carries exactly the linker's ad-hoc signature the issue reported; codesign
 * then re-signs copies of it ad hoc, with and without the runtime.
 */
const canSign =
  process.platform === 'darwin' &&
  spawnSync('cc', ['--version']).status === 0 &&
  spawnSync('codesign', ['-h']).error === undefined;

describe.skipIf(!canSign)('the inspection, run on bundles signed here', () => {
  let root = '';
  let binary = '';
  let compiled: ReturnType<typeof spawnSync> | undefined;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'verify-signed-bundle-'));
    const source = join(root, 'main.c');
    writeFileSync(source, 'int main(void) { return 0; }\n');
    binary = join(root, 'speaking-glass');
    compiled = spawnSync('cc', ['-arch', 'arm64', '-arch', 'x86_64', '-o', binary, source], {
      encoding: 'utf8',
      timeout: 60_000,
    });
  }, 90_000);
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  let count = 0;
  function bundle(sign?: string[], entitlements?: string): string {
    expect(compiled?.status, String(compiled?.stderr)).toBe(0);
    const app = join(root, `case-${++count}`, 'Speaking Glass.app');
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(
      join(app, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>speaking-glass</string>
  <key>CFBundleIdentifier</key><string>${IDENTIFIER}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Test.</string>
</dict></plist>
`,
    );
    const exe = join(app, 'Contents/MacOS/speaking-glass');
    copyFileSync(binary, exe);
    chmodSync(exe, 0o755);
    if (sign) {
      const args = ['--force', '--sign', '-', ...sign];
      if (entitlements) args.push('--entitlements', entitlements);
      const signed = spawnSync('codesign', [...args, app], { encoding: 'utf8' });
      expect(signed.status, signed.stderr).toBe(0);
    }
    return app;
  }

  function verify(app: string, env: Record<string, string> = { APPLE_SIGNING_IDENTITY: IDENTITY }) {
    const result = spawnSync(process.execPath, [SCRIPT, app], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('refuses the build #189 reported: linker-signed, no runtime, no entitlements', { timeout: 30_000 }, () => {
    const { status, stdout, stderr } = verify(bundle());
    expect(status, stdout + stderr).toBe(1);
    // The linker signs only the arm64 slice (Apple silicon requires it)...
    expect(stderr).toContain('arm64 slice: it is signed ad hoc (flags=0x20002(adhoc,linker-signed))');
    expect(stderr).toContain('arm64 slice: the hardened runtime is off');
    expect(stderr).toContain(`arm64 slice: ${MICROPHONE} is absent, not true`);
    // ...and leaves the Intel one with no signature at all.
    expect(stderr).toMatch(/x86_64 slice: codesign could not describe it: .*not signed at all/);
    expect(stdout).toContain('PASS   architectures: x86_64, arm64');
  });

  it('reads the runtime and the entitlements off the slices, and still refuses an ad-hoc signer', { timeout: 30_000 }, () => {
    const { status, stdout, stderr } = verify(bundle(['--options', 'runtime'], ENTITLEMENTS));
    expect(status, stdout + stderr).toBe(1);
    for (const arch of ['arm64', 'x86_64']) {
      // What signing CAN prove here, it proves.
      expect(stderr).not.toContain(`${arch} slice: the hardened runtime is off`);
      expect(stdout).toContain(`PASS   ${arch} slice: hardened runtime (flags=0x10002)`);
      expect(stdout).toContain(`PASS   ${arch} slice: entitlements match src-tauri/entitlements/entitlements.macos.plist, microphone granted`);
      // And what only a Developer ID can satisfy, it refuses.
      expect(stderr).toContain(`${arch} slice: it is signed ad hoc (flags=0x10002(adhoc,runtime))`);
      expect(stderr).toContain(`${arch} slice: it is not signed by a Developer ID Application certificate`);
      expect(stderr).toContain(`${arch} slice: it carries no Team ID`);
      expect(stderr).toContain(`${arch} slice: it has no secure timestamp`);
    }
    expect(stderr).toContain('Gatekeeper assessment');
    expect(stderr).toContain('notarisation ticket');
  });

  it('refuses a signature without the hardened runtime even when the entitlements are right', { timeout: 30_000 }, () => {
    const { status, stdout, stderr } = verify(bundle([], ENTITLEMENTS));
    expect(status, stdout + stderr).toBe(1);
    expect(stderr).toContain('arm64 slice: the hardened runtime is off (flags=0x2(adhoc)');
    expect(stdout).toContain('PASS   arm64 slice: entitlements match');
  });

  it('refuses a muted microphone and a debug entitlement read back off the signature', { timeout: 30_000 }, () => {
    const plist = join(root, 'wrong.plist');
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>${MICROPHONE}</key><false/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.get-task-allow</key><true/>
</dict></plist>
`,
    );
    const { status, stderr } = verify(bundle(['--options', 'runtime'], plist));
    expect(status).toBe(1);
    expect(stderr).toContain(`x86_64 slice: ${MICROPHONE} is false, not true`);
    expect(stderr).toContain('x86_64 slice: com.apple.security.get-task-allow is granted by the signed bundle but not declared');
  });

  it('fails, rather than skipping the team, when the release identity is not given', { timeout: 30_000 }, () => {
    const app = bundle(['--options', 'runtime'], ENTITLEMENTS);
    for (const env of [{}, { APPLE_SIGNING_IDENTITY: '-' }] as Array<Record<string, string>>) {
      const { status, stderr } = verify(app, env);
      expect(status).toBe(1);
      expect(stderr).toContain('APPLE_SIGNING_IDENTITY is not set to a "Developer ID Application: <name> (<TEAM ID>)" identity');
    }
  });
});
