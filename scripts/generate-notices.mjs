#!/usr/bin/env node
/**
 * Write THIRD_PARTY_NOTICES.md — the licence disclosure that ships in the app.
 *
 * The 1.0 readiness review found the model's attribution and the font's OFL
 * text present in the REPOSITORY and nowhere in the artifact. That is the gap
 * that matters: a repository is not what a customer receives. Somebody who
 * downloads the DMG and asks "what is in this, and under what terms?" has to be
 * able to answer it from the thing they downloaded.
 *
 * So this collects what a release contains — production JavaScript
 * dependencies, both Rust workspaces, the prebuilt native libraries
 * `sherpa-onnx-sys` fetches at build time, the bundled typeface, and the
 * speech model the user installs afterwards — and writes one file that
 * `tauri.conf.json` copies into `Contents/Resources`.
 *
 * Usage:
 *   node scripts/generate-notices.mjs           — write THIRD_PARTY_NOTICES.md
 *   node scripts/generate-notices.mjs --check   — fail if it is out of date
 *
 * `--check` is what makes this a gate rather than a chore. The file is
 * committed so it can be reviewed and so a build does not depend on a network
 * round trip; committed generated output goes stale, and a stale licence
 * disclosure is a wrong one.
 *
 * ## What it does not do
 *
 * It does not reproduce every dependency's licence TEXT. Several hundred MIT
 * and ISC notices would bury the four things a reader actually needs — and the
 * two licences that genuinely require their text to travel (the model's, and
 * the font's OFL) do travel, as their own files. Every dependency is named
 * with its version and SPDX identifier, which is what makes the claim checkable.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD_PARTY_NOTICES.md');

const problems = [];

function run(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* ------------------------------------------------------------- JavaScript */

/**
 * Production dependencies only. A test runner or a bundler is not in the
 * artifact, and listing it would make the disclosure describe a machine that
 * built CandidCue rather than the application anyone received.
 */
function javascriptPackages() {
  let report;
  try {
    report = JSON.parse(run('pnpm', ['licenses', 'list', '--json', '--prod']));
  } catch (error) {
    problems.push(`could not list JavaScript licences — ${error.message}`);
    return [];
  }
  const packages = [];
  for (const [licence, entries] of Object.entries(report)) {
    for (const entry of entries) {
      packages.push({
        name: entry.name,
        versions: [...new Set(entry.versions ?? [])].sort(),
        licence,
      });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------- Rust */

/**
 * A crate's SPDX expression, read from the copy cargo already unpacked.
 *
 * Not `cargo license`: that is another build-time download, which is the exact
 * class of input the supply-chain gate exists to bound. The registry source
 * tree is already on any machine that has built this, and `cargo fetch` puts
 * it on one that has not.
 *
 * A crate whose licence cannot be read is REPORTED, never omitted. A notices
 * file that quietly drops what it could not classify is worse than one that
 * fails: it reads as complete.
 */
function crateLicence(name, version, registries) {
  for (const registry of registries) {
    const manifest = join(registry, `${name}-${version}`, 'Cargo.toml');
    if (!existsSync(manifest)) continue;
    const source = readFileSync(manifest, 'utf8');
    const packageTable = source.match(/^\[package\]([\s\S]*?)(?=^\[)/m)?.[1] ?? source;
    const spdx = packageTable.match(/^license\s*=\s*["']([^"']+)["']/m)?.[1];
    if (spdx) return spdx;
    const file = packageTable.match(/^license-file\s*=\s*["']([^"']+)["']/m)?.[1];
    if (file) return `see ${file}`;
    return null;
  }
  return undefined; // not unpacked here, which is different from having none
}

function rustCrates() {
  const registryRoot = join(homedir(), '.cargo', 'registry', 'src');
  let registries = [];
  try {
    registries = readdirSync(registryRoot).map((entry) => join(registryRoot, entry));
  } catch {
    problems.push(
      `no unpacked cargo registry at ${registryRoot} — run \`cargo fetch\` before generating notices.`,
    );
    return [];
  }

  const seen = new Map();
  for (const manifest of ['src-tauri/Cargo.toml', 'crates/Cargo.toml']) {
    let tree;
    try {
      tree = run('cargo', [
        'tree',
        '--locked',
        '--manifest-path',
        manifest,
        '--prefix',
        'none',
        '--no-dedupe',
      ]);
    } catch (error) {
      problems.push(`could not read the crate tree for ${manifest} — ${error.message}`);
      continue;
    }
    for (const line of tree.split('\n')) {
      const match = line.trim().match(/^([A-Za-z0-9_-]+) v(\S+)/);
      if (!match) continue;
      const [, name, version] = match;
      // The workspace's own crates are CandidCue, not a third party.
      if (['candidcue', 'cc-align', 'cc-stt', 'cc-bench'].includes(name)) continue;
      seen.set(`${name} ${version}`, { name, version });
    }
  }

  const crates = [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const unknown = [];
  for (const crate of crates) {
    const licence = crateLicence(crate.name, crate.version, registries);
    if (licence === undefined || licence === null) {
      unknown.push(`${crate.name} v${crate.version}`);
      crate.licence = 'UNKNOWN';
    } else {
      crate.licence = licence;
    }
  }
  if (unknown.length > 0) {
    problems.push(
      `${unknown.length} crate licence(s) could not be read: ${unknown.slice(0, 8).join(', ')}` +
        `${unknown.length > 8 ? ', …' : ''}. Run \`cargo fetch\` for both workspaces, or record ` +
        `them by hand — a notices file may not silently omit what it failed to classify.`,
    );
  }
  return crates;
}

/* ----------------------------------------------------------------- native */

function nativeLibraries() {
  const path = join(ROOT, 'sbom', 'native-inputs.json');
  try {
    const recorded = JSON.parse(readFileSync(path, 'utf8'));
    const releases = [...new Set((recorded.libraries ?? []).map((lib) => lib.release))].sort();
    return { releases, count: (recorded.libraries ?? []).length };
  } catch (error) {
    problems.push(`could not read sbom/native-inputs.json — ${error.message}`);
    return { releases: [], count: 0 };
  }
}

/* ------------------------------------------------------------------ model */

function speechModels() {
  try {
    const catalogue = JSON.parse(readFileSync(join(ROOT, 'src-tauri/models/catalogue.json'), 'utf8'));
    return catalogue.models.map((model) => ({
      id: model.id,
      title: model.attribution.title,
      author: model.attribution.author,
      source: model.attribution.sourceUrl,
      licence: model.attribution.license,
      modified: model.attribution.modified,
      isDefault: model.id === catalogue.defaultModelId,
    }));
  } catch (error) {
    problems.push(`could not read the model catalogue — ${error.message}`);
    return [];
  }
}

/* ------------------------------------------------------------------ write */

function render() {
  const js = javascriptPackages();
  const crates = rustCrates();
  const native = nativeLibraries();
  const models = speechModels();

  const out = [];
  const w = (...lines) => out.push(...lines);

  w(
    '<!-- Generated by scripts/generate-notices.mjs. Run `pnpm notices` after a',
    '     dependency change; `pnpm notices:check` fails when this is stale. -->',
    '',
    '# Third-party notices',
    '',
    'CandidCue is built on work other people published. This file names every',
    'third-party component in a release, with its version and its licence, so the',
    'question "what is in this application, and under what terms?" can be answered',
    'from the application itself rather than from a repository.',
    '',
    'It ships inside the app. On macOS it is at',
    '`CandidCue.app/Contents/Resources/THIRD_PARTY_NOTICES.md`.',
    '',
    'Two licences require their full text to travel with the work, and both do:',
    '',
    '- the typeface, whose SIL Open Font License is in',
    '  `Contents/Resources/LICENSE-fonts.txt`;',
    '- the speech recognition model, whose licence is written into the model',
    '  directory beside the weights when you install it.',
    '',
    '## The typeface',
    '',
    '**Atkinson Hyperlegible Next** — Braille Institute of America, Inc.',
    'Licensed under the SIL Open Font License 1.1. The woff2 subsets are the ones',
    'published as `@fontsource-variable/atkinson-hyperlegible-next@5.3.0`,',
    'unmodified. Full text: `LICENSE-fonts.txt`, beside this file.',
    '',
    '## Speech recognition',
    '',
    'Inference runs through **sherpa-onnx** (Apache-2.0,',
    '<https://github.com/k2-fsa/sherpa-onnx>), linked statically, which embeds',
    '**ONNX Runtime** (MIT).',
    '',
    `The prebuilt native libraries are fetched at build time and are in neither`,
    `lockfile, so their digests are recorded in the release provenance`,
    `(\`sbom/native-inputs.json\`): ${native.count} libraries from ` +
      `${native.releases.map((r) => `\`${r}\``).join(', ') || '(none recorded)'}.`,
    '',
    'The model weights are **not** part of this application. They are downloaded',
    'after installation, at your request, and each carries its own attribution and',
    'the full text of its licence in its own directory.',
    '',
  );

  for (const model of models) {
    w(
      `### ${model.title}${model.isDefault ? ' (default)' : ''}`,
      '',
      `- Catalogue id: \`${model.id}\``,
      `- Authors: ${model.author}`,
      `- Source: <${model.source}>`,
      `- Licence: ${model.licence.name} (\`${model.licence.id}\`) — <${model.licence.url}>`,
      `- Redistributed ${model.modified ? '**with modifications**' : '**unmodified**'}`,
      '',
    );
  }

  w(
    '## Rust crates',
    '',
    `${crates.length} crates across both workspaces, with the SPDX expression each`,
    'declares in its own manifest.',
    '',
    '| Crate | Version | Licence |',
    '|---|---|---|',
    ...crates.map((crate) => `| ${crate.name} | ${crate.version} | ${crate.licence} |`),
    '',
    '## JavaScript packages',
    '',
    `${js.length} production packages. Development dependencies are not in the`,
    'artifact and are not listed.',
    '',
    '| Package | Version | Licence |',
    '|---|---|---|',
    ...js.map((pkg) => `| ${pkg.name} | ${pkg.versions.join(', ')} | ${pkg.licence} |`),
    '',
  );

  return `${out.join('\n')}`;
}

const checkOnly = process.argv.includes('--check');
const rendered = render();

if (problems.length > 0) {
  console.error('Third-party notices FAILED:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

if (checkOnly) {
  let committed = null;
  try {
    committed = readFileSync(OUTPUT, 'utf8');
  } catch {
    console.error(
      'Third-party notices FAILED:\n\n  THIRD_PARTY_NOTICES.md does not exist. Run `pnpm notices`.\n',
    );
    process.exit(1);
  }
  if (committed !== rendered) {
    console.error(
      'Third-party notices FAILED:\n\n' +
        '  THIRD_PARTY_NOTICES.md is out of date — a dependency changed and the file\n' +
        '  did not. Run `pnpm notices` and commit the result.\n',
    );
    process.exit(1);
  }
  console.log('Third-party notices OK — the committed file matches the dependency graph.');
} else {
  writeFileSync(OUTPUT, rendered, 'utf8');
  console.log(`Wrote THIRD_PARTY_NOTICES.md`);
}
