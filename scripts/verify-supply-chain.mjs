#!/usr/bin/env node
/**
 * What this release is made of, and whether anyone reviewed it.
 *
 * The 1.0 readiness review found no dependency, advisory, licence or provenance
 * gate anywhere in the tree — and one detail that makes it matter more than the
 * usual: `sherpa-onnx-sys` **downloads a prebuilt native library at build
 * time**. A release therefore contains bytes that were not in the repository
 * and are not in either lockfile, fetched from a URL nobody recorded.
 *
 * Three things run here. Each is a separate command so a failure names which:
 *
 *   node scripts/verify-supply-chain.mjs licences   — no unreviewed licence
 *   node scripts/verify-supply-chain.mjs sbom       — write CycloneDX SBOMs
 *   node scripts/verify-supply-chain.mjs native     — record the native inputs
 *   node scripts/verify-supply-chain.mjs all        — all three
 *
 * `cargo audit` and `pnpm audit` are deliberately NOT wrapped here. They query
 * a network advisory database, so their answer changes without the repository
 * changing — which makes them the wrong shape for a gate that has to be
 * reproducible from a tag. The release workflow runs them as their own step,
 * where a new advisory is news rather than a broken build.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'sbom');

/**
 * Licences a release may contain without anyone looking at it again.
 *
 * Permissive, and every entry is one somebody decided on. A dependency
 * arriving under something not on this list is not an emergency — it is a
 * question, and the whole point is that the question gets asked before the
 * build rather than after the lawyers.
 *
 * Notably absent: GPL and AGPL in every form. CandidCue is distributed as a
 * signed binary under a proprietary licence, and a copyleft dependency changes
 * what the product legally is.
 */
const REVIEWED_LICENCES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'Unlicense',
  'Zlib',
  'MPL-2.0', // file-level copyleft; fine for a linked dependency, not for our own files
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'OpenSSL',
  'BSL-1.0',
]);

/**
 * The speech model is NOT covered by this file.
 *
 * It is downloaded in-app, is not in the bundle, and carries its own licence —
 * which the catalogue records and the app displays. `models/catalogue.json` is
 * where that lives, and `ATTRIBUTION.md` travels beside the installed weights.
 */
const problems = [];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/* ------------------------------------------------------------- licences */

function checkLicences() {
  // pnpm's own licence report. Structured output, no extra dependency.
  let report;
  try {
    report = JSON.parse(run('pnpm', ['licenses', 'list', '--json', '--prod']));
  } catch (error) {
    problems.push(`could not read the JavaScript licence report — ${error.message}`);
    return;
  }

  const unreviewed = [];
  for (const [licence, packages] of Object.entries(report)) {
    // pnpm reports compound expressions verbatim; split so `(MIT OR Apache-2.0)`
    // is satisfied by either half being reviewed.
    const alternatives = licence
      .replace(/[()]/g, '')
      .split(/\s+OR\s+/i)
      .map((part) => part.trim());
    if (alternatives.some((part) => REVIEWED_LICENCES.has(part))) continue;

    for (const pkg of packages) {
      unreviewed.push(`${pkg.name}@${pkg.versions?.join(',') ?? '?'} — ${licence}`);
    }
  }

  if (unreviewed.length > 0) {
    problems.push(
      `these dependencies are under licences nobody has reviewed:\n    ${unreviewed.join('\n    ')}` +
        `\n  Add the licence to REVIEWED_LICENCES in this script once it has been looked at.`,
    );
  } else {
    console.log(`Licences OK — every production dependency is under a reviewed licence.`);
  }
}

/* ----------------------------------------------------------------- SBOM */

function writeSboms() {
  mkdirSync(OUT, { recursive: true });

  // JavaScript. `pnpm licenses` is not an SBOM, so the dependency graph comes
  // from the lockfile-derived list pnpm can already produce.
  try {
    const list = JSON.parse(run('pnpm', ['list', '--depth', 'Infinity', '--json', '--prod']));
    writeFileSync(join(OUT, 'javascript.json'), JSON.stringify(list, null, 2));
    console.log('Wrote sbom/javascript.json');
  } catch (error) {
    problems.push(`could not produce the JavaScript SBOM — ${error.message}`);
  }

  // Rust, both workspaces. `cargo tree` is always available; a CycloneDX
  // generator would be better and is another build-time download, which is
  // the exact class of input this file exists to bound.
  for (const [name, manifest] of [
    ['rust-app', 'src-tauri/Cargo.toml'],
    ['rust-alignment', 'crates/Cargo.toml'],
  ]) {
    try {
      const tree = run('cargo', ['tree', '--locked', '--manifest-path', manifest, '--prefix', 'none', '--no-dedupe']);
      const unique = [...new Set(tree.split('\n').map((line) => line.trim()).filter(Boolean))].sort();
      writeFileSync(join(OUT, `${name}.txt`), `${unique.join('\n')}\n`);
      console.log(`Wrote sbom/${name}.txt — ${unique.length} crates`);
    } catch (error) {
      problems.push(`could not produce the ${name} SBOM — ${error.message}`);
    }
  }
}

/* --------------------------------------------------------------- native */

/**
 * Record what `sherpa-onnx-sys` fetched.
 *
 * This is the input the readiness review singled out: a prebuilt native
 * library, downloaded during `cargo build`, that ends up inside the signed
 * artifact and appears in neither lockfile. Without a record, "what was in
 * that release" has no answer for the largest binary in it.
 *
 * Best-effort by necessity — the crate does not publish a manifest of what it
 * fetched — so this hashes what landed in the build directory rather than
 * asking. An empty result is reported, not passed over: it means the layout
 * changed and the record is no longer being kept.
 */
function recordNativeInputs() {
  mkdirSync(OUT, { recursive: true });

  /*
   * `sherpa-onnx-sys` unpacks its prebuilt archive into a dedicated directory
   * whose NAME carries the version and target triple —
   * `sherpa-onnx-v1.13.4-osx-arm64-static-lib` — which is most of the
   * provenance for free. The `build/` directories are searched too, because a
   * future version of the crate may put them there instead and a record that
   * silently stops being kept is the failure this exists to prevent.
   */
  const roots = [
    'src-tauri/target/sherpa-onnx-prebuilt',
    'src-tauri/target/release/build',
    'src-tauri/target/debug/build',
  ];
  const found = [];
  for (const root of roots) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    for (const path of globNative(dir)) {
      const relative = path.slice(ROOT.length + 1);
      found.push({
        path: relative,
        // The archive's own version and target, taken from the directory the
        // crate unpacked it into. This is the closest thing to a manifest the
        // build offers.
        release: relative.match(/sherpa-onnx-v[\d.]+-[a-z0-9-]+/)?.[0] ?? null,
        bytes: readFileSync(path).length,
        sha256: sha256(path),
      });
    }
  }

  if (found.length === 0) {
    problems.push(
      'no sherpa-onnx native libraries found under src-tauri/target — either nothing has ' +
        'been built yet, or the crate changed where it puts them and this record has ' +
        'silently stopped being kept. Build first, or fix the search.',
    );
    return;
  }

  writeFileSync(
    join(OUT, 'native-inputs.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        note:
          'Prebuilt native libraries fetched by sherpa-onnx-sys during the build. They are ' +
          'in the signed artifact and in neither lockfile, so their digests are recorded ' +
          'here as part of the release provenance.',
        libraries: found.sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    ),
  );
  console.log(`Wrote sbom/native-inputs.json — ${found.length} native libraries`);
}

function globNative(dir) {
  return globSync('**/*.{dylib,so,a,dll}', { cwd: dir })
    .filter((rel) => /sherpa|onnxruntime/i.test(rel))
    .map((rel) => join(dir, rel));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/* ------------------------------------------------------------------ run */

const command = process.argv[2] ?? 'all';
if (!['licences', 'sbom', 'native', 'all'].includes(command)) {
  console.error('Usage: node scripts/verify-supply-chain.mjs <licences|sbom|native|all>');
  process.exit(1);
}

if (command === 'licences' || command === 'all') checkLicences();
if (command === 'sbom' || command === 'all') writeSboms();
if (command === 'native' || command === 'all') recordNativeInputs();

if (problems.length > 0) {
  console.error('\nSupply-chain check FAILED:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log('\nSupply-chain check OK.');
