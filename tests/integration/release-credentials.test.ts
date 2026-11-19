/**
 * The release credential gate, run the way the workflows run it.
 *
 * `scripts/release-credentials.mjs` exists because GitHub hands a workflow an
 * empty string for a secret nobody has added, and every consumer of one
 * failed late and under its own name: codesign, notarytool, the AWS CLI.
 * Each test here removes a credential and asserts the gate names it, and that
 * no value it was given ever reaches its output.
 *
 * The child gets an environment built from nothing but what the test passes,
 * so a developer who happens to have a real key exported cannot make a test
 * pass.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEVELOPER_ID_IDENTITY, REQUIRED, malformed, missing } from '../../scripts/release-credentials.mjs';

const SCRIPT = resolve(__dirname, '../../scripts/release-credentials.mjs');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A value no message could contain by accident. */
const sentinel = (name: string) => `sentinel-value-of-${name.toLowerCase()}-0f3a`;

/*
 * The identity's shape is checked too, so its stand-in has that shape and
 * still carries the sentinel the redaction assertions look for.
 */
const valueFor = (name: string) =>
  name === 'APPLE_SIGNING_IDENTITY' ? `Developer ID Application: ${sentinel(name)} (A1B2C3D4E5)` : sentinel(name);

const all = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, valueFor(name)]));

function gate(args: string[], env: Record<string, string>, { withSummary = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-credentials-'));
  dirs.push(dir);
  const summary = join(dir, 'summary.md');
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: withSummary ? { ...env, GITHUB_STEP_SUMMARY: summary } : env,
  });
  let written = '';
  try {
    written = readFileSync(summary, 'utf8');
  } catch {
    // No summary written.
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}`, summary: written };
}

const CHECKS: Array<[string, string[], readonly string[]]> = [
  ['the macOS build', ['build', 'macos'], REQUIRED.build.macos],
  ['the Windows build', ['build', 'windows'], REQUIRED.build.windows],
  ['the Linux build', ['build', 'linux'], REQUIRED.build.linux],
  ['publishing', ['publish'], REQUIRED.publish],
];

describe('the release credential gate', () => {
  it('requires the six Apple secrets and the updater key for macOS, and the updater key alone elsewhere', () => {
    expect([...REQUIRED.build.macos].sort()).toEqual(
      [
        'APPLE_API_ISSUER',
        'APPLE_API_KEY',
        'APPLE_API_KEY_ID',
        'APPLE_CERTIFICATE',
        'APPLE_CERTIFICATE_PASSWORD',
        'APPLE_SIGNING_IDENTITY',
        'TAURI_SIGNING_PRIVATE_KEY',
      ].sort(),
    );
    expect(REQUIRED.build.windows).toEqual(['TAURI_SIGNING_PRIVATE_KEY']);
    expect(REQUIRED.build.linux).toEqual(['TAURI_SIGNING_PRIVATE_KEY']);
    expect([...REQUIRED.publish].sort()).toEqual(
      ['R2_ACCESS_KEY_ID', 'R2_ENDPOINT', 'R2_SECRET_ACCESS_KEY', 'SPEAKING_GLASS_R2_BUCKET'].sort(),
    );
  });

  it('never requires the updater key password, which is empty for a key generated without one', () => {
    for (const names of [...Object.values(REQUIRED.build), REQUIRED.publish]) {
      expect(names).not.toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    }
  });

  it('treats unset, empty and whitespace-only alike', () => {
    expect(missing(['A', 'B', 'C', 'D'], { B: '', C: ' \n\t', D: 'x' })).toEqual(['A', 'B', 'C']);
  });

  it.each(CHECKS)('passes %s when every credential is present, and says so without a value', (_label, args, names) => {
    const { status, output, summary } = gate(args, all(names));
    expect(status, output).toBe(0);
    for (const name of names) {
      expect(output).toContain(`present  ${name}`);
      expect(summary).toContain(`\`${name}\` | present`);
      expect(output + summary).not.toContain(sentinel(name));
    }
    expect(output).not.toContain('::error');
  });

  it.each(CHECKS)('names the one credential %s is missing, for each in turn', (_label, args, names) => {
    for (const absent of names) {
      for (const empty of [undefined, '', '   ']) {
        const env = all(names);
        if (empty === undefined) delete env[absent];
        else env[absent] = empty;
        const { status, output, summary } = gate(args, env);
        expect(status, `${absent} = ${JSON.stringify(empty)}\n${output}`).toBe(1);
        // Every row says what it is: only the absent one is missing.
        for (const name of names) {
          const status = name === absent ? 'MISSING' : 'present';
          expect(output, name).toContain(`${status}  ${name}`);
          expect(summary, name).toContain(`\`${name}\` | ${name === absent ? '**missing**' : 'present'} |`);
        }
        expect(output).toMatch(new RegExp(`::error title=Missing release credentials::[^\\n]*: ${absent}\\. `));
        expect(summary).toContain(`\`${absent}\` | **missing**`);
        for (const name of names) expect(output + summary).not.toContain(sentinel(name));
      }
    }
  });

  it('lists every missing credential at once, not the first it meets', () => {
    const env = all(REQUIRED.build.macos);
    delete env.APPLE_API_ISSUER;
    env.APPLE_SIGNING_IDENTITY = '';
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    const { status, output } = gate(['build', 'macos'], env);
    expect(status).toBe(1);
    expect(output).toContain(
      '3 secrets that are not set: APPLE_SIGNING_IDENTITY, APPLE_API_ISSUER, TAURI_SIGNING_PRIVATE_KEY.',
    );
    expect(output).toContain('This build attempt stopped before building anything.');
  });

  /*
   * The identity is the one secret whose wrong value does not fail: Tauri
   * hands it to `codesign --sign`, and `-` signs ad hoc and succeeds. Each of
   * these would have passed a presence check.
   */
  it.each([
    ['codesign\'s ad-hoc identity', '-'],
    ['an Apple Development identity', `Apple Development: ${sentinel('dev')} (A1B2C3D4E5)`],
    ['a Mac App Store identity', `3rd Party Mac Developer Application: ${sentinel('mas')} (A1B2C3D4E5)`],
    ['the installer identity', `Developer ID Installer: ${sentinel('installer')} (A1B2C3D4E5)`],
    ['a certificate hash, which names no Team ID', 'A'.repeat(40)],
    ['a name with no Team ID', `Developer ID Application: ${sentinel('noteam')}`],
    ['a lower-case Team ID', `Developer ID Application: ${sentinel('lower')} (a1b2c3d4e5)`],
    ['a nine-character Team ID', `Developer ID Application: ${sentinel('short')} (A1B2C3D4E)`],
    ['a value pasted with a trailing newline', `Developer ID Application: ${sentinel('newline')} (A1B2C3D4E5)\n`],
    ['a value pasted with a leading space', ` Developer ID Application: ${sentinel('space')} (A1B2C3D4E5)`],
  ])('refuses %s as the signing identity, without printing it', (_label, identity) => {
    const env = { ...all(REQUIRED.build.macos), APPLE_SIGNING_IDENTITY: identity };
    const { status, output, summary } = gate(['build', 'macos'], env);
    expect(status, output).toBe(1);
    expect(output).toContain('INVALID  APPLE_SIGNING_IDENTITY');
    expect(summary).toContain('`APPLE_SIGNING_IDENTITY` | **invalid** |');
    expect(output).toContain('::error title=Malformed release credential::APPLE_SIGNING_IDENTITY is set, but not to');
    expect(output).toContain('This build attempt stopped before building anything.');
    // Nothing else is blamed, and nothing is reported missing.
    for (const name of REQUIRED.build.macos.filter((name) => name !== 'APPLE_SIGNING_IDENTITY')) {
      expect(output).toContain(`present  ${name}`);
    }
    expect(output).not.toContain('Missing release credentials');
    if (identity.length > 1) expect(output + summary).not.toContain(identity.trim());
    for (const name of REQUIRED.build.macos) expect(output + summary).not.toContain(sentinel(name));
  });

  it('accepts a Developer ID Application identity, and reads its Team ID', () => {
    const identity = 'Developer ID Application: Ada O\'Neill-Lovelace (Z9Y8X7W6V5)';
    expect(malformed(['APPLE_SIGNING_IDENTITY'], { APPLE_SIGNING_IDENTITY: identity })).toEqual([]);
    expect(DEVELOPER_ID_IDENTITY.exec(identity)?.[1]).toBe('Z9Y8X7W6V5');
    // A name with parentheses of its own still yields the LAST group.
    expect(DEVELOPER_ID_IDENTITY.exec('Developer ID Application: Acme (UK) Ltd (A1B2C3D4E5)')?.[1]).toBe(
      'A1B2C3D4E5',
    );
  });

  it('reports a malformed identity and missing secrets in the same run', () => {
    const env = { ...all(REQUIRED.build.macos), APPLE_SIGNING_IDENTITY: '-' };
    delete env.APPLE_API_ISSUER;
    const { status, output } = gate(['build', 'macos'], env);
    expect(status).toBe(1);
    expect(output).toContain('MISSING  APPLE_API_ISSUER');
    expect(output).toContain('INVALID  APPLE_SIGNING_IDENTITY');
    expect(output).toContain('a secret that is not set: APPLE_API_ISSUER.');
    expect(output).toContain('Malformed release credential::APPLE_SIGNING_IDENTITY');
  });

  it('checks no shape on a secret that is missing, and none on the other operating systems', () => {
    expect(malformed(['APPLE_SIGNING_IDENTITY'], { APPLE_SIGNING_IDENTITY: '  ' })).toEqual([]);
    expect(malformed(['APPLE_SIGNING_IDENTITY'], {})).toEqual([]);
    expect(malformed(REQUIRED.build.windows, { TAURI_SIGNING_PRIVATE_KEY: '-' })).toEqual([]);
  });

  it('tells a failed publish how to finish once the secrets are added', () => {
    const { status, output } = gate(['publish'], {});
    expect(status).toBe(1);
    expect(output).toContain('re-run only this publish job');
    expect(output).toContain('the release environment');
  });

  it('writes no step summary outside a workflow, and still reports', () => {
    const { status, output, summary } = gate(['build', 'linux'], all(REQUIRED.build.linux), { withSummary: false });
    expect(status, output).toBe(0);
    expect(output).toContain('present  TAURI_SIGNING_PRIVATE_KEY');
    expect(summary).toBe('');
  });

  it.each([
    [[]],
    [['build']],
    [['build', 'android']],
    [['build', 'constructor']],
    [['build', 'macos', 'extra']],
    [['publish', 'macos']],
    [['sign']],
  ])('refuses an invocation it does not know: %j', (args) => {
    const env = all(REQUIRED.build.macos);
    const { status, output, summary } = gate(args, env);
    expect(status).toBe(2);
    expect(output).toContain('Usage:');
    expect(summary).toBe('');
    for (const name of REQUIRED.build.macos) expect(output).not.toContain(sentinel(name));
  });
});
