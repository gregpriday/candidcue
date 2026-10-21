/**
 * The copyleft gate, driven the way the release drives it.
 *
 * `sherpa-onnx-sys` links `libespeak-ng.a` and `libucd.a` — both
 * GPL-3.0-or-later — into an MIT-licensed binary, and nothing in that crate
 * removes them. What keeps Speaking Glass defensible is that the linker
 * dead-strips every one of their objects, and that is a fact about a
 * particular binary rather than a policy: the next sherpa-onnx bump, or a
 * linker that decides differently, changes it silently.
 *
 * So the gate reads a real ld64 map. These tests build small synthetic maps
 * and archives — a 25 MB real map is not a fixture — and check that the gate
 * fails on each way it is supposed to fail. A gate that only passes on a clean
 * input has not been tested at all.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/verify-no-copyleft-objects.mjs');
const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speaking-glass-copyleft-'));
  workspaces.push(dir);
  return dir;
}

/**
 * A lib directory of real `ar` archives holding empty members.
 *
 * Real archives, because the gate resolves membership with `ar t` — the map
 * records a member name and not the archive it came from, since rustc packs
 * the native archives into an rlib on the way through. Faking that resolution
 * would test the fake.
 */
function archives(dir: string, spec: Record<string, string[]>): string {
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });
  const objects = join(dir, 'obj');
  mkdirSync(objects, { recursive: true });
  for (const [archive, members] of Object.entries(spec)) {
    const paths: string[] = [];
    for (const member of members) {
      /*
       * A REAL object file, compiled. Touching an empty file does not work:
       * macOS `ar` runs ranlib, warns "not a mach-o file", and leaves the
       * member out of the listing entirely — so `ar t` would report an empty
       * archive and every one of these tests would pass vacuously.
       *
       * The symbol name is derived from the member so two archives holding a
       * same-named member still differ, which the ambiguity test needs.
       */
      const source = join(objects, `${member}.c`);
      const symbol = member.replace(/[^A-Za-z0-9]/g, '_');
      writeFileSync(source, `int ${symbol}(void) { return 0; }\n`);
      const path = join(objects, member);
      execFileSync('cc', ['-c', '-x', 'c', source, '-o', path]);
      paths.push(path);
    }
    execFileSync('ar', ['rcs', join(lib, archive), ...paths]);
  }
  return lib;
}

/** The three archives every real map must show, or the gate calls it vacuous. */
const ANCHORS = {
  'libsherpa-onnx-c-api.a': ['c-api.cc.o'],
  'libsherpa-onnx-core.a': ['recognizer.cc.o'],
  'libonnxruntime.a': ['session.cc.o'],
};

interface MapSpec {
  arch?: string;
  /** member object name -> symbols that SURVIVED into the output */
  live: Record<string, string[]>;
  /** member object name -> symbols the linker dead-stripped */
  dead?: Record<string, string[]>;
}

function mapFile(dir: string, name: string, spec: MapSpec): string {
  const members = [
    ...new Set([...Object.keys(spec.live), ...Object.keys(spec.dead ?? {})]),
  ];
  const lines = [
    '# Path: /build/speaking-glass',
    `# Arch: ${spec.arch ?? 'arm64'}`,
    '# Object files:',
    '[  0] linker synthesized',
    ...members.map((member, index) => `[${String(index + 1).padStart(3)}] /build/libnative.rlib(${member})`),
    '# Sections:',
    '# Address\tSize    \tSegment\tSection',
    '# Symbols:',
    '# Address\tSize    \tFile  Name',
  ];
  const indexOf = (member: string) => members.indexOf(member) + 1;
  for (const [member, symbols] of Object.entries(spec.live)) {
    for (const symbol of symbols) {
      lines.push(`0x100000000\t0x00000010\t[${String(indexOf(member)).padStart(3)}] ${symbol}`);
    }
  }
  lines.push('# Dead Stripped Symbols:', '#        \tSize    \tFile  Name');
  for (const [member, symbols] of Object.entries(spec.dead ?? {})) {
    for (const symbol of symbols) {
      lines.push(`<<dead>>\t0x00000010\t[${String(indexOf(member)).padStart(3)}] ${symbol}`);
    }
  }
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function check(lib: string, ...maps: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, lib, ...maps], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const LIB_SPEC = {
  ...ANCHORS,
  'libespeak-ng.a': ['speech.c.o', 'synthesize.c.o'],
  'libucd.a': ['case.c.o'],
  'libpiper_phonemize.a': ['phonemize.cpp.o'],
};

/** The anchors, always live, so no test trips the vacuity check by accident. */
const ANCHOR_LIVE = {
  'c-api.cc.o': ['_SherpaOnnxCreateOnlineRecognizer'],
  'recognizer.cc.o': ['__ZN11sherpa_onnx10RecognizerC1Ev'],
  'session.cc.o': ['__ZN3Ort7SessionC1Ev'],
};

/*
 * Every test here compiles real objects with `cc` and packs them with `ar`,
 * and the first one also pays the toolchain's cold start: on a fresh macOS
 * runner that alone has taken 5-7 s against well under a second locally. That
 * is the cost of the real archives above, not a hang, so the budget fits it
 * rather than vitest's 5 s unit-test default.
 *
 * Not on Windows. The gate reads ld64 maps — the macOS linker's — of the macOS
 * universal binary, and these fixtures are built with the `cc` and `ar` that
 * toolchain provides. Windows has neither, and a Windows build is not this
 * gate's to vouch for: it links the text-to-speech-free libraries, and
 * `verify-no-gpl-in-binary.mjs` checks it. The release that runs this gate is
 * the macOS one, and CI's node tests, this suite among them, run on macOS for
 * every push.
 */
describe.skipIf(process.platform === 'win32')('the copyleft gate', { timeout: 30_000 }, () => {
  it('passes when every copyleft object was dead-stripped', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const map = mapFile(dir, 'clean.map', {
      live: { ...ANCHOR_LIVE, 'speech.c.o': ['literal string: UTF-8'] },
      dead: { 'speech.c.o': ['_espeak_Initialize'], 'case.c.o': ['_ucd_tolower'] },
    });
    const result = check(lib, map);
    expect(result.output).toContain('no code from');
    expect(result.status).toBe(0);
  });

  /* The failure it exists for: GPL code with an address in the output. */
  it('fails when GPL code survives into the binary', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const map = mapFile(dir, 'contaminated.map', {
      live: { ...ANCHOR_LIVE, 'synthesize.c.o': ['_Synthesize', '_WavegenFill'] },
    });
    const result = check(lib, map);
    expect(result.status).toBe(1);
    expect(result.output).toContain('eSpeak NG');
    expect(result.output).toContain('_Synthesize');
  });

  /*
   * A coalesced `"UTF-8"` is attributed to whichever object mentioned it and
   * is identical in thousands of programs. Failing on it would condemn a
   * binary that contains none of the project's expression, and would train
   * people to disable the gate.
   */
  it('does not fail on coalesced literals or standard-library instantiations', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const map = mapFile(dir, 'literals.map', {
      live: {
        ...ANCHOR_LIVE,
        'speech.c.o': ['literal string: UTF-8', '8-byte-literal', 'GCC_except_table12'],
        'synthesize.c.o': ['__ZNSt3__16vectorIiNS_9allocatorIiEEE6insertEv'],
      },
    });
    expect(check(lib, map).status).toBe(0);
  });

  /*
   * piper-phonemize declares MIT and is called GPL because it links eSpeak.
   * That is a claim about a binary holding BOTH, so the gate measures which
   * binary this is rather than taking the reputation.
   */
  it('accepts piper alone and refuses piper in eSpeak’s company', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const alone = mapFile(dir, 'piper-alone.map', {
      live: { ...ANCHOR_LIVE, 'phonemize.cpp.o': ['__ZN5piper19DEFAULT_PHONEME_MAPE'] },
    });
    const together = mapFile(dir, 'piper-with-espeak.map', {
      live: {
        ...ANCHOR_LIVE,
        'phonemize.cpp.o': ['__ZN5piper19DEFAULT_PHONEME_MAPE'],
        'speech.c.o': ['_espeak_TextToPhonemes'],
      },
    });
    const ok = check(lib, alone);
    expect(ok.status).toBe(0);
    expect(ok.output).toContain('its own terms govern');

    const bad = check(lib, together);
    expect(bad.status).toBe(1);
    expect(bad.output).toContain('eSpeak NG');
  });

  /*
   * Anti-vacuity, which is the failure mode of every "we looked and found
   * nothing" check. A map of some other binary contains no GPL symbol for the
   * same reason it contains nothing of ours.
   */
  it('refuses a map that is not of this program', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const foreign = mapFile(dir, 'foreign.map', { live: { 'phonemize.cpp.o': ['_whatever'] } });
    const result = check(lib, foreign);
    expect(result.status).toBe(1);
    expect(result.output).toContain('map of something other than Speaking Glass');
  });

  it('refuses a map with no object-file section at all', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const truncated = join(dir, 'truncated.map');
    writeFileSync(truncated, '# Path: /build/speaking-glass\n# Arch: arm64\n');
    const result = check(lib, truncated);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/not a linker map|did not finish/);
  });

  /*
   * A member name two archives share cannot be attributed, and guessing would
   * guess in the direction that clears the build.
   */
  it('refuses when a member name cannot be attributed to one archive', () => {
    const dir = workspace();
    const lib = archives(dir, { ...LIB_SPEC, 'libkissfft-float.a': ['speech.c.o'] });
    const map = mapFile(dir, 'ambiguous.map', { live: ANCHOR_LIVE });
    const result = check(lib, map);
    expect(result.status).toBe(1);
    expect(result.output).toContain('cannot be attributed');
  });

  it('needs every architecture the release ships, not just one', () => {
    const dir = workspace();
    const lib = archives(dir, LIB_SPEC);
    const arm = mapFile(dir, 'arm.map', { arch: 'arm64', live: ANCHOR_LIVE });
    const intel = mapFile(dir, 'intel.map', {
      arch: 'x86_64',
      live: { ...ANCHOR_LIVE, 'speech.c.o': ['_Synthesize'] },
    });
    /* A clean arm64 slice cannot vouch for a contaminated x86_64 one. */
    expect(check(lib, arm).status).toBe(0);
    const both = check(lib, arm, intel);
    expect(both.status).toBe(1);
    expect(both.output).toContain('x86_64');
  });
});
