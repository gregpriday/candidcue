/**
 * The two gates that keep eSpeak NG and ucd-tools (GPL-3.0) out of the
 * Windows and Linux builds.
 *
 * `sherpa-no-tts.mjs` prepares the libraries those builds link: upstream's
 * text-to-speech-free sherpa-onnx, plus empty stand-ins for the three
 * libraries `sherpa-onnx-sys` names unconditionally. `verify-no-gpl-in-binary.mjs`
 * then reads the finished executable for bytes only those libraries contain.
 * The real evidence — which markers, and the stock and -no-tts binaries they
 * were proven on — is in the second script's header. These tests prove the
 * gates fail the way they are meant to, without a download or a toolchain, so
 * they run in the node suite on every host, Windows included.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  LINKED,
  STAMP,
  STUBBED,
  TARGETS,
  VERSION,
  alreadyVerified,
  coffEmptyArchive,
  markerProblems,
  problemsWith,
  stampFor,
} from '../../scripts/sherpa-no-tts.mjs';
import { ANCHORS, MARKERS, scanFile } from '../../scripts/verify-no-gpl-in-binary.mjs';

const REPO_ROOT = join(__dirname, '../..');
const VERIFY = join(REPO_ROOT, 'scripts/verify-no-gpl-in-binary.mjs');
const FETCH = join(REPO_ROOT, 'scripts/sherpa-no-tts.mjs');

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidcue-gpl-'));
  workspaces.push(dir);
  return dir;
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ENV: '', ...env },
  });
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

/** The first marker of a component and kind, so fixtures use the gate's own bytes. */
function markerOf(component: string, kind?: string): Buffer {
  const found = MARKERS.find((m) => m.component === component && (!kind || m.kind === kind));
  if (!found) throw new Error(`no ${kind ?? ''} marker for ${component}`);
  return found.bytes;
}

/* ------------------------------------------------- verify-no-gpl-in-binary */

const MAGIC = {
  PE: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  ELF: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  'Mach-O': Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
} as const;

/** A file that starts like an executable of `format` and carries `payload`. */
function executable(
  format: keyof typeof MAGIC | 'text',
  payload: Buffer[],
  { anchors = true }: { anchors?: boolean } = {},
): string {
  const head = format === 'text' ? Buffer.from('not a binary\n') : MAGIC[format];
  const filler = Buffer.alloc(512, 0x90);
  const parts = [head, filler, ...(anchors ? ANCHORS.map((a) => a.bytes) : []), ...payload].flatMap(
    (part) => [part, filler],
  );
  const path = join(workspace(), 'candidcue');
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

describe('verify-no-gpl-in-binary', () => {
  it('passes an executable that carries the speech runtime and no marker', () => {
    const result = run(VERIFY, [executable('PE', [])]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('eSpeak NG 0/');
    expect(result.output).toContain('GPL check OK');
  });

  it('fails a Windows executable carrying an eSpeak NG string, and names it', () => {
    const result = run(VERIFY, [executable('PE', [markerOf('eSpeak NG', 'literal')])]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/eSpeak NG is in /);
  });

  it("fails on ucd-tools' tables alone, the marker a stripped binary keeps", () => {
    const result = run(VERIFY, [executable('ELF', [markerOf('ucd-tools', 'table')])]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/ucd-tools is in /);
  });

  it('fails piper-phonemize alone on Windows and Linux, which link no text-to-speech at all', () => {
    for (const format of ['PE', 'ELF'] as const) {
      const result = run(VERIFY, [executable(format, [markerOf('piper-phonemize')])]);
      expect(result.status, format).toBe(1);
      expect(result.output).toMatch(/piper-phonemize is in .*must hold no\s+text-to-speech code/s);
    }
  });

  /*
   * macOS links the stock archive and ld64 dead-strips it; two of piper's own
   * MIT symbols survive, which the inventory records as its terms governing.
   * The gate reads that policy from sbom/native-components.json rather than
   * keeping a second copy of it.
   */
  it('reports piper-phonemize alone in a Mach-O binary without failing it', () => {
    const result = run(VERIFY, [executable('Mach-O', [markerOf('piper-phonemize')])]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/piper-phonemize is in .*its own terms govern/s);
  });

  it('fails piper-phonemize in a Mach-O binary once eSpeak NG ships beside it', () => {
    const result = run(VERIFY, [
      executable('Mach-O', [markerOf('piper-phonemize'), markerOf('eSpeak NG', 'literal')]),
    ]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/piper-phonemize is in .*beside eSpeak NG/s);
  });

  it('refuses a binary without the speech runtime rather than calling it clean', () => {
    const result = run(VERIFY, [executable('PE', [], { anchors: false })]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/would prove nothing/);
  });

  /*
   * A gate that decides it is "not the main module" exits 0 having checked
   * nothing. Comparing argv[1] with the module URL did exactly that through a
   * symlinked path, which `import.meta.main` does not.
   */
  it.skipIf(process.platform === 'win32')('still judges when run through a symlink', () => {
    const link = join(workspace(), 'verify-link.mjs');
    symlinkSync(VERIFY, link);
    const result = run(link, [executable('PE', [markerOf('eSpeak NG', 'literal')])]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/eSpeak NG is in /);
  });

  it('refuses a file that is not an executable', () => {
    const result = run(VERIFY, [executable('text', [])]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/not a PE, ELF or Mach-O executable/);
  });

  it('counts a marker that straddles a read boundary exactly once', () => {
    const marker = MARKERS[0]!;
    const path = join(workspace(), 'straddle');
    // With 16-byte reads, the second copy crosses a boundary; the third is whole.
    writeFileSync(
      path,
      Buffer.concat([marker.bytes, Buffer.alloc(9, 0x20), marker.bytes, Buffer.alloc(40, 0x20), marker.bytes]),
    );
    expect(scanFile(path, [marker], 16)).toEqual([3]);
    expect(scanFile(path, [marker])).toEqual([3]);
  });

  it('has a marker for every component the inventory forbids, and no marker the inventory does not classify', () => {
    const components = JSON.parse(
      readFileSync(join(REPO_ROOT, 'sbom/native-components.json'), 'utf8'),
    ).components as Array<{ component: string; forbiddenInBinary?: boolean; copyleftIfLinkedWith?: string[] }>;
    const marked = new Set(MARKERS.map((m) => m.component));
    for (const entry of components) {
      if (entry.forbiddenInBinary === true) expect(marked, entry.component).toContain(entry.component);
    }
    for (const name of marked) {
      const entry = components.find((c) => c.component === name);
      expect(
        entry?.forbiddenInBinary === true || Array.isArray(entry?.copyleftIfLinkedWith),
        `${name} has markers but the inventory does not classify it as copyleft`,
      ).toBe(true);
    }
  });

  /*
   * `piper` is also a Rust crate in this lockfile and `espeak` appears in
   * sherpa-onnx's own model-loading messages, so a short marker would fail a
   * clean binary. Every marker in the table was measured; this keeps a loose
   * one from being added without that.
   */
  it('uses no marker short enough to turn up by accident', () => {
    for (const marker of MARKERS) {
      expect(marker.bytes.length, marker.label).toBeGreaterThanOrEqual(11);
    }
  });
});

/* ------------------------------------------------------------ sherpa-no-tts */

/** Read a System V / COFF archive into its members. */
function members(archive: Buffer): Array<{ name: string; data: Buffer; at: number }> {
  expect(archive.subarray(0, 8).toString('latin1')).toBe('!<arch>\n');
  const out: Array<{ name: string; data: Buffer; at: number }> = [];
  let at = 8;
  while (at < archive.length) {
    const header = archive.subarray(at, at + 60).toString('latin1');
    expect(header.slice(58, 60), `member header at ${at}`).toBe('`\n');
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    out.push({ name: header.slice(0, 16).trim(), data: archive.subarray(at + 60, at + 60 + size), at });
    at += 60 + size + (size % 2);
  }
  expect(at).toBe(archive.length);
  return out;
}

describe('sherpa-no-tts', () => {
  /*
   * MSVC refuses a zero-member archive (LNK1107), and one with only linker
   * members, and ignores one with only an object (LNK4003). These are the
   * bytes `lib.exe /list` and `link.exe` were shown to accept, and that a
   * Windows release linked; changing them needs that proof again.
   */
  it('writes the COFF stub MSVC was proven to accept, and it holds nothing', () => {
    const stub = coffEmptyArchive();
    expect(createHash('sha256').update(stub).digest('hex')).toBe(
      '8b90e18a1e87bb3ba45992777f31f2dff93eaed009fcb17ea068efb72fb5630d',
    );
    expect(coffEmptyArchive().equals(stub)).toBe(true);
    expect(TARGETS['win-x64'].stub().equals(stub)).toBe(true);

    const [first, second, object] = members(stub);
    expect([first?.name, second?.name, object?.name]).toEqual(['/', '/', 'stub.obj/']);
    expect(first!.data.readUInt32BE(0)).toBe(0); // no symbols
    expect(second!.data.readUInt32LE(0)).toBe(1); // one member…
    expect(second!.data.readUInt32LE(4)).toBe(object!.at); // …at the object
    expect(second!.data.readUInt32LE(8)).toBe(0); // and no symbols

    const coff = object!.data;
    expect(coff.readUInt16LE(0)).toBe(0x8664); // AMD64
    expect(coff.readUInt16LE(2)).toBe(0); // no sections: no code, no data
    expect(coff.readUInt32LE(12)).toBe(1); // one symbol…
    expect(coff.subarray(20, 28).toString('latin1')).toBe('@feat.00');
    expect(coff.readInt16LE(32)).toBe(-1); // …absolute
    expect(coff.readUInt8(36)).toBe(3); // and static: nothing to resolve against
  });

  it('writes the empty GNU archive on Linux', () => {
    expect(TARGETS['linux-x64'].stub().toString('latin1')).toBe('!<arch>\n');
  });

  it('fetches the release both lockfiles pin', () => {
    for (const lockfile of ['src-tauri/Cargo.lock', 'crates/Cargo.lock']) {
      const pinned = readFileSync(join(REPO_ROOT, lockfile), 'utf8').match(
        /\nname = "sherpa-onnx-sys"\nversion = "([^"]+)"/,
      )?.[1];
      expect(pinned, lockfile).toBe(VERSION);
    }
    for (const target of Object.values(TARGETS)) {
      expect(target.archive).toContain(`v${VERSION}-`);
      expect(target.archive).toMatch(/-no-tts-lib\.tar\.bz2$/);
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const lib of STUBBED) expect(LINKED).toContain(lib);
  });

  /** A library directory as a -no-tts archive leaves it, before the stubs. */
  function noTtsLibDir(target: (typeof TARGETS)['win-x64']): string {
    const lib = join(workspace(), 'lib');
    mkdirSync(lib, { recursive: true });
    for (const name of LINKED.filter((n) => !STUBBED.includes(n))) {
      writeFileSync(join(lib, target.file(name)), `real library ${name}\n`);
    }
    return lib;
  }

  it('accepts a -no-tts directory, then its stubs, for both targets', () => {
    for (const target of Object.values(TARGETS)) {
      const lib = noTtsLibDir(target);
      expect(problemsWith(lib, target, { stubs: false })).toEqual([]);
      for (const name of STUBBED) writeFileSync(join(lib, target.file(name)), target.stub());
      expect(problemsWith(lib, target, { stubs: true })).toEqual([]);
      expect(markerProblems(lib)).toEqual([]);
    }
  });

  it('refuses an archive that brought a text-to-speech library with it', () => {
    const target = TARGETS['linux-x64'];
    const lib = noTtsLibDir(target);
    writeFileSync(join(lib, 'libespeak-ng.a'), 'the real thing');
    expect(problemsWith(lib, target, { stubs: false }).join('\n')).toMatch(/libespeak-ng\.a came with the archive/);
  });

  it('refuses a missing library and a stub that is not the generated one', () => {
    const target = TARGETS['win-x64'];
    const lib = noTtsLibDir(target);
    rmSync(join(lib, 'kissfft-float.lib'));
    for (const name of STUBBED) writeFileSync(join(lib, target.file(name)), target.stub());
    writeFileSync(join(lib, 'ucd.lib'), '!<arch>\n');
    const problems = problemsWith(lib, target, { stubs: true }).join('\n');
    expect(problems).toMatch(/kissfft-float\.lib is missing/);
    expect(problems).toMatch(/ucd\.lib is not the empty stub/);
  });

  it('refuses any library that carries text-to-speech code, whatever it is called', () => {
    const target = TARGETS['win-x64'];
    const lib = noTtsLibDir(target);
    writeFileSync(
      join(lib, 'sherpa-onnx-core.lib'),
      Buffer.concat([Buffer.from('core '), markerOf('piper-phonemize', 'symbol'), Buffer.from(' core')]),
    );
    expect(markerProblems(lib).join('\n')).toMatch(/sherpa-onnx-core\.lib contains piper-phonemize/);
  });

  /*
   * A re-run against a directory it already verified must not download or
   * re-scan anything: it prints the directory and exports it again. Driven
   * through the CLI, so the export a CI step depends on is what is tested.
   */
  /** A destination holding a directory as a finished run leaves it, stamp included. */
  function verifiedDest(target: (typeof TARGETS)['linux-x64']) {
    const dest = workspace();
    const root = join(dest, target.archive.replace(/\.tar\.bz2$/, ''));
    const lib = join(root, 'lib');
    mkdirSync(lib, { recursive: true });
    for (const name of LINKED) {
      const body = STUBBED.includes(name) ? target.stub() : Buffer.from(`real library ${name}\n`);
      writeFileSync(join(lib, target.file(name)), body);
    }
    writeFileSync(join(root, STAMP), JSON.stringify(stampFor(lib, target), null, 2));
    return { dest, root, lib };
  }

  it('re-uses a verified directory without fetching, and exports it', () => {
    const target = TARGETS['linux-x64'];
    const { dest, lib } = verifiedDest(target);
    const githubEnv = join(dest, 'github-env');
    writeFileSync(githubEnv, '');

    const result = run(FETCH, ['--target', 'linux-x64', '--dest', dest], { GITHUB_ENV: githubEnv });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('already fetched and verified');
    expect(result.stdout.trim().split('\n').at(-1)).toBe(lib);
    expect(readFileSync(githubEnv, 'utf8')).toBe(`SHERPA_ONNX_LIB_DIR=${lib}\n`);
  });

  /*
   * The stamp is what lets a re-run skip the scan, so it must not be fooled by
   * a library changed in place. Same size on purpose: a size-only stamp passed
   * exactly this.
   */
  it('stops trusting a verified directory once a library changes, even at the same size', () => {
    const target = TARGETS['linux-x64'];
    const { root, lib } = verifiedDest(target);
    expect(alreadyVerified(root, lib, target)).toBe(true);

    const core = join(lib, target.file('sherpa-onnx-core'));
    const before = readFileSync(core);
    const marker = markerOf('eSpeak NG', 'literal');
    expect(marker.length).toBeLessThanOrEqual(before.length);
    const after = Buffer.alloc(before.length, 0x20);
    marker.copy(after);
    writeFileSync(core, after);
    expect(alreadyVerified(root, lib, target)).toBe(false);
  });

  it('stops trusting a directory verified against a different marker table', () => {
    const target = TARGETS['linux-x64'];
    const { root, lib } = verifiedDest(target);
    const stamp = JSON.parse(readFileSync(join(root, STAMP), 'utf8'));
    writeFileSync(join(root, STAMP), JSON.stringify({ ...stamp, markers: '0'.repeat(64) }));
    expect(alreadyVerified(root, lib, target)).toBe(false);
  });

  it('refuses an unknown target or a missing argument before touching the network', () => {
    expect(run(FETCH, []).output).toMatch(/Usage:/);
    const unknown = run(FETCH, ['--target', 'linux-aarch64', '--dest', workspace()]);
    expect(unknown.status).toBe(1);
    expect(unknown.output).toMatch(/unknown target linux-aarch64/);
  });
});
