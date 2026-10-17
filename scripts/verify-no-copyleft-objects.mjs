#!/usr/bin/env node
/**
 * Prove what copyleft code did and did not reach the shipped binary.
 *
 * ## The problem this exists for
 *
 * `sherpa-onnx-sys` links a fixed set of static archives, and three are
 * copyleft: `libespeak-ng.a` and `libucd.a` are GPL-3.0-or-later, and
 * `libpiper_phonemize.a` declares MIT while linking eSpeak NG, which makes its
 * distributed terms GPL-3.0. CandidCue is proprietary. Nothing in that crate
 * removes them from the link line — there is no TTS feature, upstream's
 * `-DSHERPA_ONNX_ENABLE_TTS=OFF` is unavailable because we consume a prebuilt
 * archive, and the `shared` alternative is worse, because the sherpa-onnx
 * dylib genuinely contains the code.
 *
 * The comfortable assumption was that a static link extracts only what
 * resolves an undefined symbol, that CandidCue does speech-to-TEXT and calls
 * no TTS entry point, and that therefore nothing comes out. That assumption is
 * FALSE and this script is how we found out: `libsherpa-onnx-c-api.a` is one
 * broad object with undefined references to `OfflineTts`, so the linker
 * traverses into the whole TTS chain and loads 23 of eSpeak NG's 27 objects.
 *
 * ## Loaded is not the same as shipped, and that distinction is the point
 *
 * Almost all of it is then dead-stripped. Counting loaded objects would
 * condemn a binary that contains none of their code; counting nothing would
 * miss the part that survives. So this reads all three of the map's sections
 * and asks the only question that matters: which symbols from a forbidden
 * archive have an ADDRESS in the output.
 *
 * Those are then split, because they are not alike:
 *
 *   - **Literals.** `"UTF-8"`, `"%s"`, an 8-byte numeric constant. The linker
 *     coalesces identical constants across the whole program, so these are
 *     attributed to whichever object mentioned them and are not that project's
 *     expression in any meaningful sense. Reported, not failed on.
 *   - **Substantive symbols.** A function, a data object, a translation unit's
 *     static initialiser. That is the project's code, in our binary.
 *
 * ## Usage
 *
 *   node scripts/verify-no-copyleft-objects.mjs <lib-dir> <map-file>…
 *
 * `lib-dir` is the extracted sherpa-onnx prebuilt `lib/`, needed because the
 * map records a member name and not the archive it came from — rustc packs the
 * native archives into an rlib on the way through. Membership is resolved with
 * `ar t` against the real archives, and an ambiguous member name is a refusal
 * rather than a guess.
 *
 * Build one map per architecture; a universal build links each slice
 * separately and a clean arm64 slice cannot vouch for an x86_64 one:
 *
 *   RUSTFLAGS="-C link-arg=-Wl,-map,$PWD/link-arm64.map" \
 *     cargo build --release --target aarch64-apple-darwin \
 *     --manifest-path src-tauri/Cargo.toml
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const notes = [];

const [libDir, ...maps] = process.argv.slice(2);
if (!libDir || maps.length === 0) {
  console.error(
    'Usage: node scripts/verify-no-copyleft-objects.mjs <lib-dir> <map-file>…\n\n' +
      '  <lib-dir>   the extracted sherpa-onnx prebuilt lib/ directory\n' +
      '  <map-file>  an ld64 map, one per architecture, from\n' +
      '              `-C link-arg=-Wl,-map,<path>`\n',
  );
  process.exit(1);
}

/* ------------------------------------------------- what counts as forbidden */

let components;
try {
  components = JSON.parse(
    readFileSync(join(ROOT, 'sbom/native-components.json'), 'utf8'),
  ).components;
} catch (error) {
  console.error(`Copyleft check FAILED:\n\n  sbom/native-components.json — ${error.message}\n`);
  process.exit(1);
}

const FORBIDDEN = new Map(); // archive basename -> component
const CONDITIONAL = new Map(); // archive basename -> component, copyleft only in company
for (const component of components ?? []) {
  const conditional = component.copyleftIfLinkedWith;
  for (const library of component.libraries ?? []) {
    if (component.forbiddenInProprietaryBinary === true) FORBIDDEN.set(library, component);
    else if (Array.isArray(conditional) && conditional.length > 0) {
      CONDITIONAL.set(library, component);
    }
  }
}
if (FORBIDDEN.size === 0) {
  problems.push(
    'sbom/native-components.json forbids nothing, so this gate would pass whatever the map ' +
      'contained. If the copyleft archives were genuinely removed from the link, delete this ' +
      'gate deliberately rather than leaving it to pass vacuously.',
  );
}

/* ------------------------------- which archive does a member object come from */

if (!existsSync(libDir)) {
  console.error(`Copyleft check FAILED:\n\n  ${libDir} does not exist.\n`);
  process.exit(1);
}

const owner = new Map(); // member object name -> Set of archive basenames
let archives = 0;
for (const file of readdirSync(libDir).sort()) {
  if (!file.endsWith('.a')) continue;
  archives += 1;
  let listing;
  try {
    listing = execFileSync('ar', ['t', join(libDir, file)], { encoding: 'utf8' });
  } catch (error) {
    problems.push(`could not list ${file} — ${error.message}`);
    continue;
  }
  for (const raw of listing.split('\n')) {
    const member = raw.trim();
    // The archive symbol index is not an object file.
    if (!member || member.startsWith('__.SYMDEF')) continue;
    if (!owner.has(member)) owner.set(member, new Set());
    owner.get(member).add(file);
  }
}
if (archives === 0) {
  problems.push(`${libDir} holds no .a archives — membership could not be resolved from it.`);
}

/*
 * A member name that two archives share cannot be attributed, and guessing
 * would be guessing in the direction that clears the build. It is only a
 * failure when one of the candidates is forbidden — `kaldi-math.cc.o` living
 * in two permissive archives decides nothing.
 */
for (const [member, owners] of owner) {
  if (owners.size < 2) continue;
  if (![...owners].some((archive) => FORBIDDEN.has(archive))) continue;
  problems.push(
    `the member object ${member} appears in ${[...owners].sort().join(' and ')}, one of which ` +
      `is forbidden. A symbol from it cannot be attributed to one archive, so this map cannot ` +
      `be read as evidence either way.`,
  );
}

/* ------------------------------------------------------------ the map files */

/**
 * What KIND of thing a surviving symbol is. Three answers, because lumping
 * them together would condemn a binary over a shared copy of `"UTF-8"`.
 *
 *   - `literal` — a coalesced constant. `"UTF-8"`, `"%s"`, an 8-byte numeric
 *     pool entry, a compiler-generated exception table. The linker merges
 *     identical constants across the whole program and attributes the survivor
 *     to whichever object happened to mention it; the same bytes are in
 *     thousands of programs. Not anybody's expression.
 *   - `stdlib` — a C++ standard-library template INSTANTIATED into this
 *     translation unit. `std::map<…>::insert` compiled into `phonemize.cpp.o`
 *     is libc++'s code that the compiler emitted there, not the project's, and
 *     calling it GPL because of the file it landed in would be wrong in both
 *     directions.
 *   - `project` — everything else: a function, a data object, the translation
 *     unit's static initialiser. That is the project's own code, in our binary,
 *     and it is the only kind that fails this gate.
 */
function classify(name) {
  if (
    /^literal string: /.test(name) ||
    /^\d+-byte-literal$/.test(name) ||
    /^ltmp\d+$/.test(name) ||
    /^GCC_except_table\d+$/.test(name) ||
    /^l_\./.test(name)
  ) {
    return 'literal';
  }
  // Itanium mangling: `_ZNSt…` / `_ZSt…` is namespace std, and libc++ hides
  // its ABI namespace inside it as `St3__1`. The extra leading underscore is
  // the Mach-O convention.
  if (/^__?Z(N?)St/.test(name) || /^__?ZN?St3__1/.test(name)) return 'stdlib';
  return 'project';
}

const survivors = new Map(); // component name -> { literals, substantive: [] }

for (const path of maps) {
  let lines;
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch (error) {
    problems.push(`${path}: could not be read — ${error.message}`);
    continue;
  }

  const sectionAt = (title) => lines.findIndex((line) => line.trim() === title);
  const objectsAt = sectionAt('# Object files:');
  const symbolsAt = sectionAt('# Symbols:');
  const deadAt = sectionAt('# Dead Stripped Symbols:');
  if (objectsAt < 0 || symbolsAt < 0) {
    problems.push(
      `${path}: is missing "# Object files:" or "# Symbols:". That is not a linker map, or the ` +
        `link did not finish — either way it is not evidence.`,
    );
    continue;
  }
  const arch = lines.find((line) => line.startsWith('# Arch:'))?.slice(7).trim();
  if (!arch) {
    problems.push(`${path}: declares no "# Arch:", so which slice it describes is unknown.`);
    continue;
  }

  /* index -> member object name, for objects that came out of an archive. */
  const member = new Map();
  let objectLines = 0;
  for (const line of lines.slice(objectsAt + 1, symbolsAt)) {
    if (line.startsWith('#')) break;
    if (line.trim() === '') continue;
    objectLines += 1;
    // `[  2] /path/thing.rlib(member.cc.o)`, and ld's disambiguated
    // `[  2] /path/thing.a[3](member.o)` variant.
    const match = line.match(/^\[\s*(\d+)\]\s+.*?(?:\[\d+\])?\(([^)]+)\)\s*$/);
    if (match) member.set(match[1], match[2]);
  }
  if (objectLines === 0) {
    problems.push(`${path}: its object-file section is empty, so it describes no link at all.`);
    continue;
  }

  /*
   * Anti-vacuity. A map of some other binary contains no forbidden symbol for
   * the same reason it contains nothing of ours, and would read as a clean
   * bill. The archives this build cannot work without must be in it.
   */
  const ANCHORS = ['libsherpa-onnx-c-api.a', 'libsherpa-onnx-core.a', 'libonnxruntime.a'];
  const present = new Set();
  for (const name of member.values()) {
    for (const archive of owner.get(name) ?? []) present.add(archive);
  }
  const missingAnchors = ANCHORS.filter((archive) => !present.has(archive));
  if (missingAnchors.length > 0) {
    problems.push(
      `${path} (${arch}): links nothing from ${missingAnchors.join(', ')}. A map without the ` +
        `speech runtime is a map of something other than CandidCue, and proves nothing.`,
    );
    continue;
  }

  /* Live symbols only: an address means it is in the output. */
  const end = deadAt > symbolsAt ? deadAt : lines.length;
  for (const line of lines.slice(symbolsAt + 1, end)) {
    if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const entry = parts[2].match(/^\[\s*(\d+)\]\s+(.*)$/);
    if (!entry) continue;
    const name = member.get(entry[1]);
    if (!name) continue;
    const owners = owner.get(name);
    if (!owners || owners.size !== 1) continue;
    const archive = [...owners][0];
    const component = FORBIDDEN.get(archive) ?? CONDITIONAL.get(archive);
    if (!component) continue;

    if (!survivors.has(component.component)) {
      survivors.set(component.component, { component, literal: 0, stdlib: 0, project: [] });
    }
    const record = survivors.get(component.component);
    const kind = classify(entry[2]);
    if (kind === 'project') record.project.push({ arch, symbol: entry[2], member: name });
    else record[kind] += 1;
  }
}

/* ------------------------------------------------------------------ verdict */

/** Which components have code of their own in the binary, by name. */
const shipping = new Set(
  [...survivors.values()].filter((r) => r.project.length > 0).map((r) => r.component.component),
);

for (const { component, literal, stdlib, project } of survivors.values()) {
  const residue = `${literal} coalesced literal(s), ${stdlib} standard-library instantiation(s)`;
  const forbidden = component.forbiddenInProprietaryBinary === true;

  if (project.length === 0) {
    notes.push(
      `${component.component} (${component.spdx}): ${residue}, and none of its own code or ` +
        `data. Everything else the linker loaded was dead-stripped.`,
    );
    continue;
  }

  const shown = project.slice(0, 8);
  const detail =
    shown.map((s) => `      ${s.arch}  ${s.member}  ${s.symbol.slice(0, 90)}`).join('\n') +
    (project.length > shown.length ? `\n      …and ${project.length - shown.length} more` : '');

  if (forbidden) {
    problems.push(
      `${component.component} (${component.spdx}): ${project.length} of its OWN symbol(s) ` +
        `survived into the binary — plus ${residue}, which are not the problem. CandidCue is ` +
        `proprietary and this is that project's code:\n${detail}`,
    );
    continue;
  }

  /*
   * A conditional component: its own licence governs UNLESS the copyleft
   * project it calls is in the binary beside it. That is the piper-phonemize
   * case, and it is the whole reason this is measured rather than argued —
   * "piper is effectively GPL" is a claim about a binary containing both, and
   * whether ours is one is a fact.
   */
  const alongside = (component.copyleftIfLinkedWith ?? []).filter((name) => shipping.has(name));
  if (alongside.length > 0) {
    problems.push(
      `${component.component}: ${project.length} of its own symbol(s) are in the binary, and so ` +
        `is code from ${alongside.join(' and ')}. Together those are distributed on the copyleft ` +
        `terms, whatever ${component.component} declares on its own:\n${detail}`,
    );
    continue;
  }
  notes.push(
    `${component.component} (${component.spdx}): ${project.length} of its own symbol(s) ship, ` +
      `plus ${residue}. None of ${(component.copyleftIfLinkedWith ?? []).join(' or ')} ships ` +
      `with it, so its own terms govern.\n${detail}`,
  );
}

if (notes.length > 0) {
  console.log('Copyleft check — what survived dead-stripping:\n');
  for (const note of notes) console.log(`  · ${note}`);
  console.log('');
}

if (problems.length > 0) {
  console.error('Copyleft check FAILED:\n');
  for (const problem of problems) console.error(`  • ${problem}\n`);
  console.error(
    '  The fix is to stop linking these archives, not to relabel them. See the\n' +
      '  header of scripts/verify-no-copyleft-objects.mjs and the eSpeak NG entry\n' +
      '  in sbom/native-components.json.\n',
  );
  process.exit(1);
}

console.log(
  `Copyleft check OK — ${maps.length} linker map(s); no code from ` +
    `${[...FORBIDDEN.keys()].join(', ')} survived into the binary.`,
);
