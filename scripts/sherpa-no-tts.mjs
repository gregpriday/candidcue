#!/usr/bin/env node
/**
 * Fetch sherpa-onnx's text-to-speech-free static libraries for a Windows or
 * Linux link, and prove they carry no eSpeak NG, ucd-tools or piper-phonemize.
 *
 * ## Why this exists
 *
 * `sherpa-onnx-sys` 1.13.4 links a FIXED list of static archives, and three of
 * them are the text-to-speech front end: `espeak-ng` and `ucd` are
 * GPL-3.0-or-later, and `piper_phonemize` calls eSpeak NG. CandidCue only
 * recognises speech, and on macOS ld64 dead-strips every eSpeak NG and ucd-tools
 * object it loads (`verify-no-copyleft-objects.mjs` measures that from the
 * linker map). MSVC does not: it keeps the C++ static initialisers of the
 * text-to-speech objects as roots, and the Windows release binary linked from
 * the stock archive carried 784 eSpeak NG, 179 ucd-tools and 129
 * piper-phonemize symbols. GNU ld keeps it too: the stripped Linux release
 * binary linked from the stock archive carries eSpeak NG's strings and
 * ucd-tools' tables (measured 2026-10-19; see `verify-no-gpl-in-binary.mjs`).
 * So on Windows and Linux the copyleft code has to be absent from the INPUT,
 * not removed by the linker.
 *
 * Upstream publishes exactly that input: `-no-tts` builds of the same release,
 * configured with `SHERPA_ONNX_ENABLE_TTS=OFF`. Their `sherpa-onnx-core` has no
 * text-to-speech objects, their C API defines the `SherpaOnnx*OfflineTts*`
 * entry points itself with no reference into the core's text-to-speech code
 * (the stock one leaves 7 such references), and the three archives are simply
 * not in them. The
 * crate's link line still names those three unconditionally, so this writes an
 * EMPTY static library under each name. Nothing references them, so nothing is
 * pulled from them, and the link line is satisfied.
 *
 * `sherpa-onnx-sys` links from `SHERPA_ONNX_LIB_DIR` directly when it is set,
 * skipping its own download, which is what the printed directory is for.
 *
 * ## What it proves before handing the directory over
 *
 *   - the archive is the pinned one (SHA-256 below, which is also the digest
 *     GitHub records for the release asset);
 *   - every library the crate links, apart from the three, is present;
 *   - none of the three arrived with the archive;
 *   - no library in the directory contains any eSpeak NG, ucd-tools or
 *     piper-phonemize marker from `verify-no-gpl-in-binary.mjs`, whose header
 *     records which markers they are and the evidence that each one is present
 *     in the stock archives and absent from these.
 *
 * ## The stub libraries
 *
 * On Linux an empty archive is the 8-byte global header `!<arch>\n`, which GNU
 * ld and rustc both accept. MSVC does not: `lib.exe` and `link.exe` both refuse
 * it with LNK1107 ("invalid or corrupt file: cannot read at 0x8"), and so do an
 * archive holding only the two linker members (LNK1107 at the end of them) and
 * one holding only an object (LNK4003, "invalid library format; library
 * ignored"). Tested on MSVC 14.44 (Build Tools 2022). The smallest form both
 * accept, listing and linking with no warning, is both linker members — with no
 * symbols — followed by one x64 COFF object that has no sections and only the
 * `@feat.00` symbol every MSVC object carries. It is written here byte by byte,
 * so producing it needs no Visual Studio tool, and it is identical every time.
 *
 * (rustc 1.97 copies a static native library's members into the crate's rlib
 * with its own reader and never hands the file itself to `link.exe`, so an
 * 8-byte stub did link a Windows build too. That is an implementation detail
 * of rustc; a stub `link.exe` rejects is one rustc change away from a broken
 * release.)
 *
 * ## Usage
 *
 *   node scripts/sherpa-no-tts.mjs --target <win-x64|linux-x64> --dest <dir>
 *
 * Prints the absolute library directory as the last line of stdout (progress
 * goes to stderr), and appends `SHERPA_ONNX_LIB_DIR=<dir>` to `$GITHUB_ENV`
 * when that is set. Re-running against a directory it already verified only
 * re-hashes its files against the stamp it left, then prints it again; any
 * difference starts the verification over from the pinned archive. Keep
 * `--dest` OUTSIDE `target/`: rust-cache empties every directory there that is
 * not a Cargo profile.
 *
 * There is no `-no-tts` archive for linux-aarch64, and while win-arm64 has
 * one, `sherpa-onnx-sys` has no Windows arm64 target at all; so this covers the
 * two targets CandidCue builds outside macOS, both x64.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { MARKERS, scanFile } from './verify-no-gpl-in-binary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The release these archives come from. Must equal the crate the lockfiles pin. */
export const VERSION = '1.13.4';
const RELEASE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}`;

/**
 * Every archive `sherpa-onnx-sys` 1.13.4 links, in its own order
 * (SHERPA_ONNX_STATIC_LIBS in its build.rs).
 */
export const LINKED = [
  'sherpa-onnx-c-api',
  'sherpa-onnx-core',
  'kaldi-decoder-core',
  'sherpa-onnx-kaldifst-core',
  'sherpa-onnx-fstfar',
  'sherpa-onnx-fst',
  'kaldi-native-fbank-core',
  'kissfft-float',
  'piper_phonemize',
  'espeak-ng',
  'ucd',
  'onnxruntime',
  'ssentencepiece_core',
];

/** The text-to-speech front end: absent from a -no-tts archive, stubbed here. */
export const STUBBED = ['piper_phonemize', 'espeak-ng', 'ucd'];

/**
 * The pinned archives. `sha256` was computed from a download on 2026-10-19 and
 * matches the digest GitHub records for the asset; `bytes` is its size, used to
 * tell a truncated download (worth retrying) from a different file (not).
 *
 * win-x64 is the static-CRT (`MT`) Release build: the flavour
 * `sherpa-onnx-sys` downloads when left to itself, so the one thing this
 * changes about the Windows link is the absence of text-to-speech.
 */
export const TARGETS = {
  'win-x64': {
    archive: `sherpa-onnx-v${VERSION}-win-x64-static-MT-Release-no-tts-lib.tar.bz2`,
    sha256: '79dc88ac71e7a33fd0bb7ac01ee0bc1148dbd6407f44aeca7fa7c0eb9930be33',
    bytes: 116684776,
    file: (lib) => `${lib}.lib`,
    stub: coffEmptyArchive,
  },
  'linux-x64': {
    archive: `sherpa-onnx-v${VERSION}-linux-x64-static-no-tts-lib.tar.bz2`,
    sha256: '8ad24470f97e607d603789661ee96da5eef72c3f666a4cb7aa36da2cc1a0faaf',
    bytes: 21142120,
    file: (lib) => `lib${lib}.a`,
    stub: () => Buffer.from('!<arch>\n', 'ascii'),
  },
};

export const STAMP = 'candidcue-no-tts.json';
const ATTEMPTS = 4;

const log = (line) => process.stderr.write(`${line}\n`);

/** A refusal with a message for the operator, as opposed to a crash. */
class Refusal extends Error {}

function fail(message) {
  throw new Refusal(message);
}

/* ------------------------------------------------------------ the COFF stub */

/** A 60-byte archive member header, every field space-padded ASCII. */
function memberHeader(name, size) {
  const field = (value, width) => String(value).padEnd(width, ' ');
  const header =
    field(name, 16) + field(0, 12) + field('', 6) + field('', 6) + field(0, 8) + field(size, 10) + '`\n';
  return Buffer.from(header, 'ascii');
}

/** A member, padded to an even offset as the format requires. */
function member(name, data) {
  const parts = [memberHeader(name, data.length), data];
  if (data.length % 2 === 1) parts.push(Buffer.from('\n', 'ascii'));
  return Buffer.concat(parts);
}

/**
 * The smallest archive MSVC accepts as a static library, holding nothing.
 *
 * PE/COFF specification, "Archive (Library) File Format": the signature, the
 * first linker member (big-endian symbol count, here 0), the second linker
 * member (little-endian member count and offsets, then symbol count, here 0),
 * and one object. The object is an IMAGE_FILE_MACHINE_AMD64 header with no
 * sections, a symbol table holding only `@feat.00` (absolute, static — what
 * every MSVC object carries), and an empty string table. It defines nothing,
 * so no reference can ever pull it in.
 */
export function coffEmptyArchive() {
  const object = Buffer.alloc(20 + 18 + 4);
  object.writeUInt16LE(0x8664, 0); // Machine: AMD64
  object.writeUInt16LE(0, 2); // NumberOfSections
  object.writeUInt32LE(0, 4); // TimeDateStamp: 0, so the bytes never vary
  object.writeUInt32LE(20, 8); // PointerToSymbolTable
  object.writeUInt32LE(1, 12); // NumberOfSymbols
  // SizeOfOptionalHeader and Characteristics stay 0.
  Buffer.from('@feat.00', 'ascii').copy(object, 20);
  object.writeInt16LE(-1, 20 + 12); // SectionNumber: IMAGE_SYM_ABSOLUTE
  object.writeUInt8(3, 20 + 16); // StorageClass: IMAGE_SYM_CLASS_STATIC
  object.writeUInt32LE(4, 38); // string table: just its own size

  const signature = Buffer.from('!<arch>\n', 'ascii');
  const first = member('/', Buffer.alloc(4));
  const secondBody = (offset) => {
    const body = Buffer.alloc(12);
    body.writeUInt32LE(1, 0); // one member
    body.writeUInt32LE(offset, 4); // at this offset
    body.writeUInt32LE(0, 8); // no symbols
    return body;
  };
  const objectAt = signature.length + first.length + member('/', secondBody(0)).length;
  return Buffer.concat([signature, first, member('/', secondBody(objectAt)), member('stub.obj/', object)]);
}

/* --------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [key, inline] = arg.split(/=(.*)/s, 2);
    if (key !== '--target' && key !== '--dest') fail(`unknown argument ${arg}\n\n${USAGE}`);
    const value = inline ?? argv[(i += 1)];
    if (!value) fail(`${key} needs a value\n\n${USAGE}`);
    options[key.slice(2)] = value;
  }
  if (!options.target || !options.dest) fail(USAGE);
  if (!Object.hasOwn(TARGETS, options.target)) {
    fail(`unknown target ${options.target}; expected one of ${Object.keys(TARGETS).join(', ')}`);
  }
  return options;
}

const USAGE =
  'Usage: node scripts/sherpa-no-tts.mjs --target <win-x64|linux-x64> --dest <dir>';

/* ---------------------------------------------------------------- the pins */

/**
 * The archives are pinned to one sherpa-onnx release, and the Rust crate is
 * pinned by the lockfiles. Linking 1.13.4 libraries under a newer crate's FFI
 * would compile and then call through mismatched struct layouts, so a bump that
 * forgets this file is a refusal here, not a crash in a take.
 */
function checkLockfiles() {
  for (const lockfile of ['src-tauri/Cargo.lock', 'crates/Cargo.lock']) {
    let text;
    try {
      text = readFileSync(join(ROOT, lockfile), 'utf8');
    } catch {
      continue; // a partial checkout; the build will say what is missing
    }
    const pinned = text.match(/\nname = "sherpa-onnx-sys"\nversion = "([^"]+)"/)?.[1];
    if (pinned && pinned !== VERSION) {
      fail(
        `${lockfile} pins sherpa-onnx-sys ${pinned}, and this script fetches ${VERSION}'s ` +
          `libraries.\nUpdate VERSION, the archive names and their pinned digests together, ` +
          `then re-establish the\nmarkers in verify-no-gpl-in-binary.mjs against the new stock ` +
          `archives.`,
      );
    }
  }
}

/* ---------------------------------------------------------------- download */

/**
 * Download to `to`, retrying a failed or SHORT transfer. A complete transfer
 * with the wrong digest is never retried: that is a different file under the
 * pinned name, and the right response to it is to stop.
 */
async function download(url, to, { sha256, bytes }) {
  const part = `${to}.part`;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      log(`Downloading ${url} (attempt ${attempt} of ${ATTEMPTS})`);
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
      const got = statSync(part).size;
      if (got !== bytes) throw new Error(`received ${got} bytes, expected ${bytes}`);
    } catch (error) {
      rmSync(part, { force: true });
      if (attempt === ATTEMPTS) fail(`could not download ${url}: ${error.message}`);
      const wait = 2 ** attempt * 1000;
      log(`  ${error.message}; retrying in ${wait / 1000} s`);
      await new Promise((settle) => setTimeout(settle, wait));
      continue;
    }
    const digest = sha256File(part);
    if (digest !== sha256) {
      rmSync(part, { force: true });
      fail(
        `${url}\nhas SHA-256 ${digest}, and the pinned digest is ${sha256}. The release asset ` +
          `is not the\nfile that was reviewed. Do not update the pin without re-running the ` +
          `review it records.`,
      );
    }
    renameSync(part, to);
    return;
  }
}

/* ----------------------------------------------------------------- extract */

/**
 * The system tar, which reads .bz2 on both platforms: GNU tar on Linux (with
 * bzip2), and on Windows the bsdtar Windows 10+ ships as System32\tar.exe —
 * named by path, because on a CI runner `tar` can resolve to Git for Windows'
 * GNU tar instead, which reads `C:` in an archive path as a remote host.
 */
function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(system) ? system : 'tar';
}

function extract(archive, into) {
  const result = spawnSync(tarCommand(), ['-xjf', archive, '-C', into], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fail(
      `could not extract ${archive}: ${result.error?.message ?? result.stderr.trim()}\n` +
        '(tar needs bzip2 support: `apt-get install bzip2` on a minimal Linux image)',
    );
  }
}

/* ------------------------------------------------------------------ verify */

/**
 * Everything that has to be true of the library directory, as problems.
 * `stubs` is false before the stubs are written (they must not be there yet)
 * and true after (they must be exactly the generated bytes).
 */
export function problemsWith(libDir, target, { stubs }) {
  const problems = [];
  const present = new Set(readdirSync(libDir));
  for (const lib of LINKED.filter((name) => !STUBBED.includes(name))) {
    if (!present.has(target.file(lib))) problems.push(`${target.file(lib)} is missing`);
  }
  const stub = target.stub();
  for (const lib of STUBBED) {
    const name = target.file(lib);
    if (!stubs) {
      if (present.has(name)) {
        problems.push(
          `${name} came with the archive. A -no-tts archive has no text-to-speech libraries; ` +
            `this is not the archive that was reviewed.`,
        );
      }
    } else if (!present.has(name) || !readFileSync(join(libDir, name)).equals(stub)) {
      problems.push(`${name} is not the empty stub this script writes`);
    }
  }
  return problems;
}

/** Every marker hit in every file of the directory, as problems. */
export function markerProblems(libDir) {
  const problems = [];
  for (const name of readdirSync(libDir).sort()) {
    const path = join(libDir, name);
    if (!statSync(path).isFile()) continue;
    const counts = scanFile(path, MARKERS);
    MARKERS.forEach((marker, index) => {
      if (counts[index] > 0) {
        problems.push(
          `${name} contains ${marker.component} (${marker.label}) ${counts[index]} time(s). ` +
            `This directory must hold no text-to-speech code at all.`,
        );
      }
    });
  }
  return problems;
}

/** SHA-256 of a file, read in chunks so a 900 MB library costs no memory. */
function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(16 * 1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0; ) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The stamp a verified directory carries: the archive it came from, the digest
 * of every file in it, and the digest of the marker table it was scanned with.
 * A re-run re-hashes the files (seconds, against a minute for the scan) and
 * trusts the directory only when all three still match, so a library changed
 * in place — whatever its size — or a marker added since is a fresh
 * verification, never a pass.
 */
export function stampFor(libDir, target) {
  const markers = createHash('sha256');
  for (const marker of MARKERS) markers.update(`${marker.component}\0${marker.kind}\0`).update(marker.bytes);
  const files = {};
  for (const name of readdirSync(libDir).sort()) files[name] = sha256File(join(libDir, name));
  return { archive: target.archive, sha256: target.sha256, markers: markers.digest('hex'), files };
}

export function alreadyVerified(root, libDir, target) {
  try {
    const recorded = JSON.parse(readFileSync(join(root, STAMP), 'utf8'));
    const now = stampFor(libDir, target);
    return (
      JSON.stringify(recorded) === JSON.stringify(now) &&
      problemsWith(libDir, target, { stubs: true }).length === 0
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- main */

async function main(argv) {
  const options = parseArgs(argv);
  const target = TARGETS[options.target];
  const dest = resolve(options.dest);
  const stem = target.archive.replace(/\.tar\.bz2$/, '');
  const root = join(dest, stem);
  const libDir = join(root, 'lib');

  checkLockfiles();
  mkdirSync(dest, { recursive: true });

  if (alreadyVerified(root, libDir, target)) {
    log(`${stem}: already fetched and verified.`);
  } else {
    rmSync(root, { recursive: true, force: true });
    // What an interrupted earlier run left behind.
    for (const entry of readdirSync(dest)) {
      if (entry.startsWith('.staging-')) rmSync(join(dest, entry), { recursive: true, force: true });
    }

    const archive = join(dest, target.archive);
    if (existsSync(archive) && sha256File(archive) === target.sha256) {
      log(`${target.archive}: using the verified copy already in ${dest}`);
    } else {
      rmSync(archive, { force: true });
      await download(`${RELEASE}/${target.archive}`, archive, target);
    }

    // Extract beside the destination and move into place only once verified,
    // so an interrupted run never leaves a directory a later run could mistake
    // for a finished one.
    const staging = mkdtempSync(join(dest, '.staging-'));
    try {
      extract(archive, staging);
      const stagedLib = join(staging, stem, 'lib');
      if (!existsSync(stagedLib)) fail(`${target.archive} has no ${stem}/lib directory`);

      const before = problemsWith(stagedLib, target, { stubs: false });
      if (before.length > 0) fail(before.join('\n'));

      for (const lib of STUBBED) writeFileSync(join(stagedLib, target.file(lib)), target.stub());

      const after = [
        ...problemsWith(stagedLib, target, { stubs: true }),
        ...markerProblems(stagedLib),
      ];
      if (after.length > 0) fail(after.join('\n'));

      writeFileSync(
        join(staging, stem, STAMP),
        `${JSON.stringify(stampFor(stagedLib, target), null, 2)}\n`,
      );
      renameSync(join(staging, stem), root);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    log(`${stem}: verified — no text-to-speech code, ${STUBBED.length} empty stub libraries.`);
  }

  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `SHERPA_ONNX_LIB_DIR=${libDir}\n`);
    log('Exported SHERPA_ONNX_LIB_DIR to $GITHUB_ENV.');
  }
  process.stdout.write(`${libDir}\n`);
}

// `import.meta.main`, as in release-verify.mjs: importing this module (the
// tests do) runs nothing, and a run through a symlinked path still runs.
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Refusal ? error.message : (error?.stack ?? String(error));
    process.stderr.write(`sherpa-no-tts FAILED:\n\n  ${message.split('\n').join('\n  ')}\n\n`);
    process.exit(1);
  }
}
