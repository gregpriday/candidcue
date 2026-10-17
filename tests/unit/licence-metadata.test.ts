import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * CandidCue is MIT, copyright Greg Priday, and that is stated in more places
 * than one: the root `LICENSE`, both package managers' manifests, and the
 * copyright string the bundler writes into the app's Info.plist. They used to
 * disagree — a closed-source `LICENSE` with its holder never filled in, no
 * licence in any Cargo manifest, and no copyright in the bundle at all — and
 * nothing noticed, because nothing compared them. This does.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** One TOML table's lines, up to the next table header or the end of file. */
function table(toml: string, header: string): string {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => line.replace(/#.*/, '').trim() === `[${header}]`);
  if (start < 0) throw new Error(`no [${header}] table`);
  const end = lines.findIndex((line, i) => i > start && line.trim().startsWith('['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

describe('the licence is stated once and agreed with everywhere', () => {
  const licence = read('LICENSE');
  const copyright = licence.split('\n').find((line) => line.startsWith('Copyright (c) '));

  it('is the MIT licence, copyright Greg Priday, with nothing appended', () => {
    expect(licence.startsWith('MIT License\n')).toBe(true);
    expect(copyright).toMatch(/^Copyright \(c\) \d{4}(-\d{4})? Greg Priday$/);
    expect(licence).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy');
    // GitHub's licence detection reads the whole file, and text after the
    // warranty disclaimer is how a recognisable MIT becomes "Other".
    expect(licence.replace(/\s+/g, ' ').trim().endsWith('OTHER DEALINGS IN THE SOFTWARE.')).toBe(true);
  });

  it('is what package.json declares', () => {
    expect(JSON.parse(read('package.json')).license).toBe('MIT');
  });

  it('is what every Cargo package declares', () => {
    const mit = /^license\s*=\s*"MIT"\s*(#.*)?$/m;
    const inherited = /^license(\s*\.\s*workspace\s*=\s*true|\s*=\s*\{\s*workspace\s*=\s*true\s*\})\s*(#.*)?$/m;
    expect(table(read('src-tauri/Cargo.toml'), 'package')).toMatch(mit);
    expect(table(read('crates/Cargo.toml'), 'workspace.package')).toMatch(mit);
    for (const member of ['cc-align', 'cc-stt', 'cc-bench']) {
      expect(table(read(`crates/${member}/Cargo.toml`), 'package'), member).toMatch(inherited);
    }
  });

  it('travels inside the app, beside the copyright the bundle declares', () => {
    const bundle = JSON.parse(read('src-tauri/tauri.conf.json')).bundle;
    expect(bundle.copyright).toBe(copyright);
    expect(bundle.resources['../LICENSE']).toBe('LICENSE.txt');
  });
});
