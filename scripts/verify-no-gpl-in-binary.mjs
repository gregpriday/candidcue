#!/usr/bin/env node
/**
 * Prove that a linked, stripped CandidCue binary carries no eSpeak NG or
 * ucd-tools code — and, on Windows and Linux, nothing of the text-to-speech
 * front end at all.
 *
 * ## The problem
 *
 * `sherpa-onnx-sys` puts `espeak-ng`, `ucd` and `piper_phonemize` on the link
 * line of every build. eSpeak NG and ucd-tools are GPL-3.0-or-later;
 * piper-phonemize is MIT but calls eSpeak NG. On macOS ld64 dead-strips all of
 * eSpeak NG and ucd-tools, and `verify-no-copyleft-objects.mjs` proves that
 * from the linker map. MSVC keeps them — the Windows binary linked from the
 * stock archive carried 784 eSpeak NG, 179 ucd-tools and 129 piper-phonemize
 * symbols — and GNU ld does too (below), so Windows and Linux link
 * sherpa-onnx's `-no-tts` libraries instead (`sherpa-no-tts.mjs`), which do
 * not contain that code at all.
 *
 * A linker map is evidence about a link; this is evidence about the ARTIFACT.
 * It reads the finished executable and looks for bytes that only those three
 * libraries contain, so it works on a release binary as shipped and needs
 * nothing from the build that made it.
 *
 * ## Why these markers
 *
 * Release binaries are stripped and LTO'd, so symbol names are gone. What
 * survives is DATA: string literals and tables. Each marker below was chosen
 * from the strings and tables of the stock archives' `espeak-ng`, `ucd` and
 * `piper_phonemize` libraries that occur in NO other library of either the
 * stock or the `-no-tts` archive, on either platform, and then measured in real
 * links. The symbol-name markers are there for archives and unstripped
 * binaries (`sherpa-no-tts.mjs` scans the library directory with this same
 * list); in a stripped binary they mostly cannot occur, and do no harm.
 *
 * The ucd-tools markers are bytes of its Unicode tables: the case-conversion
 * records for U+01C4..U+01C6 (DŽ, Dž, dž — the 16-byte {code point, upper,
 * lower, title} records ucd-tools stores) and the 64 bytes of its
 * general-category table for U+0020..U+005F, one byte per code point in its
 * own enumeration. ucd-tools has no string literals worth the name, and its
 * tables are byte-identical on every platform.
 *
 * Deliberately NOT markers: anything containing just `piper` (`piper` is also
 * a Rust crate in this lockfile, smol-rs's async pipe, whose panic paths name
 * it) or `espeak` (sherpa-onnx's own model-loading messages mention espeak-ng
 * data directories, and its speaker-embedding code says "wespeaker").
 *
 * ## The evidence (2026-10-19, sherpa-onnx v1.13.4)
 *
 * Archives (`sherpa-onnx-v1.13.4-…-lib.tar.bz2`, SHA-256 equal to the digests
 * GitHub records for the release assets):
 *
 *   win-x64-static-MT-Release         d81bd1d25112540862d2387072e76b2b6843ef962918d6b5c7db5a19c6276b4c
 *   linux-x64-static                  98b0e31996426f6e78244dbce1955548f2c64e8f01c4be75b85af7cdaa2e8d5c
 *   win-x64-static-MT-Release-no-tts  79dc88ac71e7a33fd0bb7ac01ee0bc1148dbd6407f44aeca7fa7c0eb9930be33
 *   linux-x64-static-no-tts           8ad24470f97e607d603789661ee96da5eef72c3f666a4cb7aa36da2cc1a0faaf
 *
 * Every eSpeak NG marker occurs in the stock `espeak-ng` library, every ucd-tools marker in
 * `ucd`, every piper-phonemize marker in `piper_phonemize`, on both platforms;
 * no marker occurs in any library of either `-no-tts` archive, the 915 MB
 * `onnxruntime.lib` included.
 *
 * Linked binaries, markers present out of 11 eSpeak NG / 5 ucd-tools / 3
 * piper-phonemize. The app is `pnpm tauri build --no-bundle` (release profile:
 * LTO, stripped) — on Windows 11 with MSVC 14.44, on Linux in an Ubuntu 22.04
 * x86_64 container; the example is `cc-stt`'s `probe_timestamps`, an
 * unstripped release build of the same recogniser crate the app links:
 *
 *   Windows x64 app, stock archive (positive control)    11 / 2 / 2   FAILS
 *   Windows x64 app, -no-tts libraries                     0 / 0 / 0   passes
 *   Linux x64 app, stock archive (positive control)        8 / 2 / 1   FAILS
 *   Linux x64 app, -no-tts libraries                       0 / 0 / 0   passes
 *   Linux x64 example, stock archive (unstripped)         11 / 4 / 3   FAILS
 *   Linux x64 example, -no-tts libraries (unstripped)      0 / 0 / 0   passes
 *
 * So GNU ld keeps eSpeak NG's strings and ucd-tools' tables in a stripped
 * release binary exactly as MSVC does. The symbol-name markers absent from the
 * stripped positive controls are absent because the binaries are stripped;
 * they are present in the archives and in the unstripped example. Every
 * binary above contains both anchors. For comparison, a macOS arm64 release
 * binary linked from the stock archive (sha256 4ee1284c0e77ba51d9b990c9e5770335
 * d3ae04a7fad750c5990f299a8ef8aa8b) carries no eSpeak NG or ucd-tools marker
 * and one piper-phonemize marker, `DEFAULT_PHONEME_MAP`, which is what the ld64
 * map shows survives there: it passes, with that reported.
 *
 * ## Usage
 *
 *   node scripts/verify-no-gpl-in-binary.mjs <binary>…
 *
 * Exits 1 when any binary fails. Run it on the executable a release ships —
 * on Windows `src-tauri/target/release/candidcue.exe` before NSIS compresses
 * it into the installer, on Linux the ELF before it is packaged.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const marker = (component, kind, label, value) => ({
  component,
  kind,
  label,
  bytes: kind === 'table' ? Buffer.from(value, 'hex') : Buffer.from(value, 'latin1'),
});

/**
 * Byte strings that only the text-to-speech libraries contain. `component` is
 * the name of the entry in `sbom/native-components.json` that each belongs to.
 */
export const MARKERS = [
  marker('eSpeak NG', 'literal', '"%s/espeak-ng-data"', '%s/espeak-ng-data'),
  marker('eSpeak NG', 'literal', 'status message "…has not been initialized"', 'The espeak-ng library has not been initialized'),
  marker('eSpeak NG', 'literal', 'status message "…not been built into espeak-ng"', 'The requested functionality has not been built into espeak-ng'),
  marker('eSpeak NG', 'literal', '"Wrong version of espeak-ng-data"', 'Wrong version of espeak-ng-data'),
  marker('eSpeak NG', 'literal', 'dictionary compiler "Bad phoneme"', '%5d: Bad phoneme [%s] (U+%x) in: %s'),
  marker('eSpeak NG', 'literal', 'SSML say-as template', '<say-as interpret-as="tts:char">&#%d;</say-as>'),
  marker('eSpeak NG', 'literal', '"Unknown phoneme table"', "Unknown phoneme table: '%s'"),
  marker('eSpeak NG', 'literal', '"Full dictionary is not installed"', "Full dictionary is not installed for '%s'"),
  marker('eSpeak NG', 'symbol', 'espeak_ng_InitializePath', 'espeak_ng_InitializePath'),
  marker('eSpeak NG', 'symbol', 'espeak_SetVoiceByName', 'espeak_SetVoiceByName'),
  marker('eSpeak NG', 'symbol', 'espeak_TextToPhonemes', 'espeak_TextToPhonemes'),
  marker(
    'ucd-tools',
    'table',
    'case records U+01C4..U+01C6',
    'c401000000000000c6010000c5010000c5010000c4010000c6010000c5010000c6010000c401000000000000c5010000',
  ),
  marker(
    'ucd-tools',
    'table',
    'general categories U+0020..U+005F',
    '02161616181616161713161a161216160e0e0e0e0e0e0e0e0e0e16161a1a1a16160a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a1716131911',
  ),
  marker('ucd-tools', 'symbol', 'ucd_lookup_category', 'ucd_lookup_category'),
  marker('ucd-tools', 'symbol', 'ucd_tolower', 'ucd_tolower'),
  marker('ucd-tools', 'symbol', 'ucd_get_script_string', 'ucd_get_script_string'),
  marker('piper-phonemize', 'literal', '"Failed to set eSpeak-ng voice"', 'Failed to set eSpeak-ng voice'),
  marker('piper-phonemize', 'symbol', 'phonemize_eSpeak', 'phonemize_eSpeak'),
  marker('piper-phonemize', 'symbol', 'DEFAULT_PHONEME_MAP', 'DEFAULT_PHONEME_MAP'),
];

/**
 * What a binary must contain for a clean result to mean anything: ONNX Runtime
 * and sherpa-onnx's streaming transducer. A file that is not the app — the
 * installer, a launcher, a typo'd path — contains no marker for the same reason
 * it contains no speech runtime, and would otherwise read as a clean bill.
 */
export const ANCHORS = [
  marker('ONNX Runtime', 'literal', '"ORT Build Info"', 'ORT Build Info: git-branch='),
  marker('sherpa-onnx', 'literal', '"OnlineTransducerModelConfig("', 'OnlineTransducerModelConfig('),
];

/**
 * How many times each marker occurs in the file at `path`.
 *
 * Read in 64 MiB chunks, so a 900 MB `onnxruntime.lib` costs no more memory
 * than a small binary, with the last (longest marker - 1) bytes carried into
 * the next chunk so a marker straddling a boundary is still found — and only
 * counted once, by requiring each match to end beyond the carried bytes.
 * `chunk` exists so a test can cross that boundary without a 64 MiB fixture.
 */
export function scanFile(path, markers, chunk = 64 * 1024 * 1024) {
  const longest = Math.max(...markers.map((entry) => entry.bytes.length));
  const counts = markers.map(() => 0);
  const buffer = Buffer.alloc(chunk + longest);
  const fd = openSync(path, 'r');
  let carried = 0;
  let position = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, carried, chunk, position);
      if (read === 0) break;
      position += read;
      const end = carried + read;
      const view = buffer.subarray(0, end);
      markers.forEach((entry, index) => {
        for (let at = view.indexOf(entry.bytes); at !== -1; at = view.indexOf(entry.bytes, at + 1)) {
          if (at + entry.bytes.length > carried) counts[index] += 1;
        }
      });
      const keep = Math.min(longest - 1, end);
      buffer.copy(buffer, 0, end - keep, end);
      carried = keep;
    }
  } finally {
    closeSync(fd);
  }
  return counts;
}

/** PE, ELF or Mach-O, from the first bytes; anything else is refused. */
function formatOf(path) {
  const head = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (head[0] === 0x4d && head[1] === 0x5a) return 'PE';
  if (head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'ELF';
  const magic = head.readUInt32BE(0);
  if ([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return 'Mach-O';
  return null;
}

/**
 * Which components fail a binary, from the inventory rather than a second list
 * here: `forbiddenInBinary` components always; `copyleftIfLinkedWith` ones
 * when one of those ships beside them — or, on Windows and Linux, always.
 *
 * The difference is deliberate. On macOS the stock archive is linked and ld64
 * dead-strips it; two of piper-phonemize's own symbols survive there, which
 * its MIT terms cover, and the inventory records that. Windows and Linux link
 * the `-no-tts` libraries, so ANY text-to-speech code in those binaries means
 * the wrong libraries were linked, whatever its licence.
 */
function policy() {
  let components;
  try {
    components = JSON.parse(readFileSync(join(ROOT, 'sbom/native-components.json'), 'utf8')).components;
  } catch (error) {
    return { error: `sbom/native-components.json — ${error.message}` };
  }
  const byName = new Map((components ?? []).map((entry) => [entry.component, entry]));
  const forbidden = new Set();
  const conditional = new Map();
  for (const name of new Set(MARKERS.map((entry) => entry.component))) {
    const entry = byName.get(name);
    if (entry?.forbiddenInBinary === true) forbidden.add(name);
    else if (Array.isArray(entry?.copyleftIfLinkedWith)) conditional.set(name, entry.copyleftIfLinkedWith);
    else {
      return {
        error:
          `sbom/native-components.json does not classify ${name} as copyleft, and this script ` +
          `has markers for it. Reconcile the two rather than letting either drift.`,
      };
    }
  }
  return { forbidden, conditional };
}

/** The verdict on one binary: `problems` fail it, `notes` are reported. */
function verifyBinary(path, rules) {
  const problems = [];
  const notes = [];
  const format = formatOf(path);
  if (!format) {
    return { problems: [`${path} is not a PE, ELF or Mach-O executable.`], notes, found: new Map() };
  }

  const anchors = scanFile(path, ANCHORS);
  const missing = ANCHORS.filter((_, index) => anchors[index] === 0);
  if (missing.length > 0) {
    problems.push(
      `${path} contains no ${missing.map((entry) => entry.component).join(' or ')}. A binary ` +
        `without the speech runtime is not the app, and a clean result on it would prove nothing.`,
    );
  }

  const counts = scanFile(path, MARKERS);
  const found = new Map(); // component -> [label xN]
  MARKERS.forEach((entry, index) => {
    if (counts[index] === 0) return;
    if (!found.has(entry.component)) found.set(entry.component, []);
    found.get(entry.component).push(`${entry.label} x${counts[index]}`);
  });

  const strict = format !== 'Mach-O';
  for (const [component, hits] of found) {
    const detail = hits.map((hit) => `      ${hit}`).join('\n');
    if (rules.forbidden.has(component)) {
      problems.push(`${component} is in ${path}:\n${detail}`);
      continue;
    }
    const alongside = (rules.conditional.get(component) ?? []).filter((name) => found.has(name));
    if (strict || alongside.length > 0) {
      problems.push(
        `${component} is in ${path}` +
          (alongside.length > 0
            ? `, beside ${alongside.join(' and ')}:\n${detail}`
            : `. A ${format} binary links the -no-tts libraries and must hold no ` +
              `text-to-speech code at all:\n${detail}`),
      );
      continue;
    }
    notes.push(
      `${component} is in ${path}, with no ${rules.conditional.get(component).join(' or ')} ` +
        `beside it, so its own terms govern:\n${detail}`,
    );
  }
  return { problems, notes, found, format };
}

// `import.meta.main`, as in release-verify.mjs: importing this module (the
// tests and sherpa-no-tts.mjs do) runs nothing, and a run through a symlinked
// path still runs — a gate that silently did nothing would exit 0.
if (import.meta.main) {
  const binaries = process.argv.slice(2);
  if (binaries.length === 0) {
    console.error('Usage: node scripts/verify-no-gpl-in-binary.mjs <binary>…');
    process.exit(1);
  }
  const rules = policy();
  if (rules.error) {
    console.error(`GPL check FAILED:\n\n  ${rules.error}\n`);
    process.exit(1);
  }

  const problems = [];
  for (const binary of binaries) {
    let size;
    try {
      size = statSync(binary).size;
    } catch (error) {
      problems.push(`${binary}: ${error.message}`);
      continue;
    }
    const result = verifyBinary(binary, rules);
    problems.push(...result.problems);
    const components = [...new Set(MARKERS.map((entry) => entry.component))];
    const tally = components
      .map((name) => `${name} ${result.found.get(name)?.length ?? 0}/${MARKERS.filter((m) => m.component === name).length}`)
      .join(', ');
    console.log(`${binary} (${result.format ?? 'unknown'}, ${size} bytes): markers present — ${tally}`);
    for (const note of result.notes) console.log(`  · ${note}`);
  }

  if (problems.length > 0) {
    console.error('\nGPL check FAILED:\n');
    for (const problem of problems) console.error(`  • ${problem}\n`);
    console.error(
      '  Windows and Linux builds must link the libraries `scripts/sherpa-no-tts.mjs`\n' +
        '  prepares (SHERPA_ONNX_LIB_DIR). See the header of this script for the evidence.\n',
    );
    process.exit(1);
  }
  console.log(
    `\nGPL check OK — no eSpeak NG or ucd-tools code in ${binaries.length} ` +
      `binar${binaries.length === 1 ? 'y' : 'ies'}, and no text-to-speech code at all in a ` +
      'Windows or Linux one.',
  );
}
