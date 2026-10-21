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
 * `sherpa-onnx-sys` fetches at build time, the bundled typefaces, and the
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
 * the fonts' OFL) do travel, as their own files. Every dependency is named
 * with its version and SPDX identifier, which is what makes the claim checkable.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD_PARTY_NOTICES.md');

const problems = [];

function run(command, args) {
  const options = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  return process.platform === 'win32'
    ? execSync(throughCmd(command, args), options)
    : execFileSync(command, args, options);
}

/**
 * A command line for cmd.exe, which is how a tool is reached on Windows.
 *
 * There `pnpm` is not an executable but a `pnpm.cmd` shim. Spawned directly,
 * Node looks only for `pnpm.com` and `pnpm.exe`, so `execFileSync('pnpm', …)`
 * fails with ENOENT before pnpm ever runs — and naming `pnpm.cmd` does not
 * help, because since the fix for CVE-2024-27980 Node refuses to spawn a batch
 * file without a shell. cmd.exe resolves a bare name through PATHEXT, so a
 * tool is found the way a terminal would find it. It receives the arguments
 * unquoted, which is exact only for plain tokens — every argument this script
 * passes is one, and anything else is refused rather than handed to cmd.exe's
 * own parser.
 *
 * Kept in step with the copies in verify-supply-chain.mjs, release-verify.mjs
 * and report-advisories.mjs; the gates' tests run each script alone in a
 * scratch tree, so they cannot share a module.
 */
function throughCmd(command, args) {
  const tokens = [command, ...args];
  const unsafe = tokens.find((token) => !/^[\w@+=:,./\\-]+$/.test(token));
  if (unsafe !== undefined) {
    throw new Error(`${JSON.stringify(unsafe)} cannot be passed through cmd.exe unquoted`);
  }
  return tokens.join(' ');
}

/* ------------------------------------------------------------- JavaScript */

/**
 * Production dependencies only. A test runner or a bundler is not in the
 * artifact, and listing it would make the disclosure describe a machine that
 * built Speaking Glass rather than the application anyone received.
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
  /*
   * Sorted on the whole row, not on the name.
   *
   * `pnpm licenses list` groups BY LICENCE, so one package name can appear
   * under two of them, and a name-only sort leaves those two rows in whatever
   * order `Object.entries` happened to yield. That is stable enough on one
   * machine to look fine and is exactly the shape of thing that makes
   * `--check` fail in CI and pass locally — which is how a gate gets deleted.
   */
  const before = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return packages.sort(
    (a, b) =>
      before(a.name, b.name) ||
      before(a.licence, b.licence) ||
      before(a.versions.join(','), b.versions.join(',')),
  );
}

/* ------------------------------------------------------------------- Rust */

/**
 * A crate's SPDX expression, read from the copy cargo already unpacked.
 *
 * Not `cargo license`: that is another build-time download, which is the exact
 * class of input the supply-chain gate exists to bound. The registry source
 * tree is already on any machine that has built this, and on one that has not
 * — a fresh CI runner — the `cargo tree` in `rustCrates()` unpacks it, because
 * resolving the graph needs every manifest in it.
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
    /*
     * The `[package]` table, ending at the next table header OR at the end of
     * the file. The obvious lazy match needs a following `[` to stop at, so a
     * manifest whose `[package]` table is last matched nothing and fell back
     * to scanning the WHOLE file — where a `license` key under
     * `[package.metadata.…]` would be read as the crate's own.
     */
    const packageTable =
      source.match(/^\[package\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m)?.[1] ?? '';
    const spdx = packageTable.match(/^\s*license\s*=\s*["']([^"']+)["']/m)?.[1];
    if (spdx) return spdx;
    const file = packageTable.match(/^\s*license-file\s*=\s*["']([^"']+)["']/m)?.[1];
    if (file) return `see ${file}`;
    /*
     * `license.workspace = true` should not reach here — cargo resolves
     * workspace inheritance when it publishes, so a registry manifest carries
     * the concrete value. If one ever does, saying so beats reporting it as
     * having no licence at all.
     */
    if (/^\s*license\s*\.\s*workspace\s*=\s*true/m.test(packageTable)) {
      return 'inherited from its workspace (unresolved)';
    }
    return null;
  }
  return undefined; // not unpacked here, which is different from having none
}

/**
 * Where cargo keeps its registry, by cargo's own rule: `CARGO_HOME` when it is
 * set and not empty, resolved against the directory cargo runs in (ROOT, see
 * `run`), and `~/.cargo` otherwise. Reading `~/.cargo` unconditionally would
 * look in one place while cargo unpacked into another.
 */
function cargoHome() {
  const configured = process.env.CARGO_HOME;
  return configured ? resolve(ROOT, configured) : join(homedir(), '.cargo');
}

function rustCrates() {
  /*
   * Pinned to the RELEASE targets, and to normal dependencies.
   *
   * `cargo tree` with no `--target` resolves for the host, so this Mac
   * selected `objc2-web-kit` where a Linux runner would select `gtk` and
   * `webkit2gtk` — two machines generating two different committed files, and
   * `--check` failing in CI for a reason nobody could reproduce locally. The
   * artifact is a universal macOS build, so both macOS triples are unioned and
   * nothing else is asked about.
   *
   * `-e normal` because a test runner is not in the artifact; the default
   * includes dev and build dependencies, which made this describe the machine
   * that built Speaking Glass rather than the application anyone received.
   *
   * And the Windows triple, since the installer ships this same file: Windows
   * pulls in crates macOS never selects (`webview2-com`, the `windows` family),
   * and a notices file that omits code in the artifact is the failure that
   * matters. The union is the honest answer for both artifacts — naming a
   * crate one of them does not contain costs nothing, leaving out one it does
   * contain is the gap.
   *
   * Linux likewise: its AppImage and .deb ship this file, and select the
   * GTK/WebKitGTK bindings and zbus that no other target does.
   *
   * The resolution is still not perfectly host-independent — asked from a
   * Windows or Linux host, the macOS triples drop `swift-rs` — so the file is
   * generated and checked on macOS, the host whose answer is the complete
   * one, and the Windows and Linux release jobs do not re-check it.
   */
  const RELEASE_TARGETS = [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ];
  const seen = new Map();
  let failedTrees = 0;
  for (const manifest of ['src-tauri/Cargo.toml', 'crates/Cargo.toml']) {
    for (const target of RELEASE_TARGETS) {
    let tree;
    try {
      tree = run('cargo', [
        'tree',
        '--locked',
        '--manifest-path',
        manifest,
        '--target',
        target,
        '--edges',
        'normal',
        '--prefix',
        'none',
        '--no-dedupe',
      ]);
    } catch (error) {
      problems.push(
        `could not read the crate tree for ${manifest} on ${target} — ${error.message}`,
      );
      failedTrees += 1;
      continue;
    }
    for (const line of tree.split('\n')) {
      const match = line.trim().match(/^([A-Za-z0-9_-]+) v(\S+)/);
      if (!match) continue;
      const [, name, version] = match;
      // The workspace's own crates are Speaking Glass, not a third party.
      if (['speaking-glass', 'cc-align', 'cc-stt', 'cc-bench'].includes(name)) continue;
      seen.set(`${name} ${version}`, { name, version });
    }
    }
  }

  /*
   * Nothing to classify. When a tree failed it has already said why, and a
   * missing registry on top of that would only be a second, misleading account
   * of the same failure. When none failed, the empty graph IS the failure: a
   * notices file that lists no crates reads as complete.
   */
  if (seen.size === 0) {
    if (failedTrees === 0) {
      problems.push(
        '`cargo tree` succeeded for both workspaces and printed no third-party crates — ' +
          'its output format may have changed under the parser in rustCrates().',
      );
    }
    return [];
  }

  /*
   * The registry is read AFTER the trees, not before.
   *
   * It was read first, and on a fresh CI runner there was nothing to read: no
   * cargo command had unpacked a crate yet, so the gate failed on every push
   * and passed on every developer machine. The trees above do the unpacking —
   * `cargo tree` loads every manifest in the graph it prints — so by now the
   * registry holds the crates being asked about, whether or not anything had
   * unpacked them before this ran.
   */
  const registryRoot = join(cargoHome(), 'registry', 'src');
  let registries = [];
  try {
    // Sorted: `readdirSync` order is the filesystem's, and a machine with two
    // registry directories would otherwise resolve them in an order that is
    // stable per-machine and not across them.
    registries = readdirSync(registryRoot)
      .sort()
      .map((entry) => join(registryRoot, entry));
  } catch {
    // Not an early return: every crate below then reads as unknown and is
    // counted and named, so the failure says what as well as where it looked.
    problems.push(
      `no unpacked cargo registry at ${registryRoot}, even after \`cargo tree\` resolved ` +
        `the release crates — is CARGO_HOME pointing somewhere cargo did not use?`,
    );
  }

  /*
   * A plain comparator, not `localeCompare`: collation is locale-dependent, so
   * a runner with a different ICU locale would order `_`-prefixed and
   * hyphenated crate names differently and fail `--check` for no real reason.
   */
  const before = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const crates = [...seen.values()].sort(
    (a, b) => before(a.name, b.name) || before(a.version, b.version),
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
        `${unknown.length > 8 ? ', …' : ''}. \`cargo tree\` unpacks every registry crate it ` +
        `prints, so each of these either has no manifest under ${registryRoot} (a git or ` +
        `path dependency, a replaced source) or declares its licence in a form ` +
        `crateLicence() does not recognise — a notices file may not silently omit what it ` +
        `failed to classify.`,
    );
  }
  return crates;
}

/* ----------------------------------------------------------------- native */

/**
 * The provenance fields that are missing or unusable, by name. Kept in step with
 * the copy in verify-native-review.mjs; each script runs alone in the gates'
 * scratch-tree tests, so they cannot share a module.
 */
function provenanceProblems(provenance) {
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['source.repository', 'source.revision'];
  }
  const unusable = [];
  let url = null;
  try {
    url = new URL(provenance.repository);
  } catch {
    // Not a URL at all; reported below with the rest.
  }
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    unusable.push('source.repository');
  }
  if (typeof provenance.revision !== 'string' || provenance.revision.trim() === '') {
    unusable.push('source.revision');
  }
  return unusable;
}

/**
 * Where a work's code came from, as one table cell. That is often not the
 * project's home: several of these are built from forks, and some are vendored
 * inside somebody else's repository. A component nobody has traced says so.
 */
function builtFrom(work) {
  if (provenanceProblems(work.source).length > 0) {
    return work.upstream ? `unconfirmed; upstream <${work.upstream}>` : 'unconfirmed';
  }
  const { repository, revision, path, prebuiltBy } = work.source;
  // Forty hex digits do not fit a table; the inventory keeps the full commit.
  const shown = /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 12) : revision;
  const cell = [`${path ? `\`${path}\` in ` : ''}<${repository}> @ \`${shown}\``];
  if (work.upstream && work.upstream !== repository) {
    if (!path) cell.push(`(fork of <${work.upstream}>)`);
    else if (work.source.adapted === true) cell.push(`(adapted from <${work.upstream}>)`);
    else cell.push(`(vendored; upstream <${work.upstream}>)`);
  }
  if (prebuiltBy) cell.push(`(prebuilt by <${prebuiltBy}>)`);
  return cell.join(' ');
}

/**
 * A component's note, and a link to any notices file its source publishes for
 * code compiled into it — ONNX Runtime's runs to hundreds of entries, which
 * belong to it and are linked rather than copied here.
 */
function aboutComponent(component) {
  const { note, source } = component;
  const link =
    typeof source?.noticeFile === 'string' && provenanceProblems(source).length === 0
      ? `Its own third-party notices: <${source.repository}/blob/${source.revision}/${source.noticeFile}>.`
      : '';
  return [note, link].filter(Boolean).join(' ');
}

/**
 * The static libraries linked into the binary, named individually.
 *
 * This listed a COUNT and a release name — "15 libraries from
 * sherpa-onnx-v1.13.4-…" — which reads as disclosure and is not. That archive
 * is not one project: it carries ONNX Runtime, kaldi, KISS FFT,
 * sentencepiece, PortAudio, piper-phonemize and eSpeak NG, on at least four
 * different licences, and sherpa-onnx's Apache-2.0 cannot speak for any of
 * them. These are also the components no dependency scanner will ever find,
 * because they are in neither lockfile — which is exactly why the readiness
 * review asked for them by name.
 *
 * `sbom/native-inputs.json` says which files there are and what they hash to;
 * `sbom/native-components.json` says what they ARE. A file claimed by no
 * component is a refusal, not an omission.
 */
function nativeComponents() {
  let recorded;
  let reviewed;
  try {
    recorded = JSON.parse(readFileSync(join(ROOT, 'sbom', 'native-inputs.json'), 'utf8'));
  } catch (error) {
    problems.push(`could not read sbom/native-inputs.json — ${error.message}`);
    return { components: [], releases: [] };
  }
  try {
    reviewed = JSON.parse(readFileSync(join(ROOT, 'sbom', 'native-components.json'), 'utf8'));
  } catch (error) {
    problems.push(`could not read sbom/native-components.json — ${error.message}`);
    return { components: [], releases: [] };
  }

  const files = (recorded.libraries ?? []).map((lib) => lib.path.split('/').pop());
  const claimed = new Map();
  for (const component of reviewed.components ?? []) {
    for (const library of component.libraries ?? []) {
      if (claimed.has(library)) {
        problems.push(
          `${library} is claimed by both ${claimed.get(library).component} and ` +
            `${component.component} in sbom/native-components.json.`,
        );
      }
      claimed.set(library, component);
    }
  }

  const unclaimed = files.filter((file) => !claimed.has(file));
  if (unclaimed.length > 0) {
    problems.push(
      `${unclaimed.length} native librar(y/ies) recorded in sbom/native-inputs.json are ` +
        `classified nowhere: ${unclaimed.join(', ')}. Add each to ` +
        `sbom/native-components.json with its upstream and licence — a static library in ` +
        `the binary that nobody classified is the component no dependency scan can find.`,
    );
  }
  const missing = [...claimed.keys()].filter((library) => !files.includes(library));
  if (missing.length > 0) {
    problems.push(
      `sbom/native-components.json classifies ${missing.join(', ')}, which the recorded ` +
        `build does not link. Re-run \`node scripts/verify-supply-chain.mjs native\` after a ` +
        `sherpa-onnx bump, then reconcile — a notice for a component that is not there is as ` +
        `wrong as a missing one.`,
    );
  }

  // The table prints where each reviewed component was built from, so a review
  // that cannot say is refused here — in CI — rather than first at a release.
  // An UNreviewed entry may still lack a source: the dagger discloses that.
  for (const component of reviewed.components ?? []) {
    if (component.reviewed === true) {
      const unusable = provenanceProblems(component.source);
      if (unusable.length > 0) {
        problems.push(
          `${component.component} is marked reviewed in sbom/native-components.json but has ` +
            `no usable ${unusable.join(' or ')}. A review has to say which source it read.`,
        );
      }
    }
    if (component.embeds === undefined) continue;
    if (!Array.isArray(component.embeds)) {
      problems.push(`${component.component}: \`embeds\` in sbom/native-components.json is not a list.`);
      continue;
    }
    const named = (value) => typeof value === 'string' && value.trim() !== '';
    for (const [index, work] of component.embeds.entries()) {
      const unusable =
        work !== null && typeof work === 'object'
          ? [
              ...(named(work.component) ? [] : ['component']),
              ...(named(work.spdx) ? [] : ['spdx']),
              ...provenanceProblems(work.source),
            ]
          : ['the entry itself'];
      if (unusable.length > 0) {
        problems.push(
          `${component.component}: embeds[${index}] in sbom/native-components.json has no ` +
            `usable ${unusable.join(', ')}. Code compiled into a component is disclosed with ` +
            `its own licence and source, or not claimed at all.`,
        );
      }
    }
  }

  const present = (reviewed.components ?? []).filter((component) =>
    (component.libraries ?? []).some((library) => files.includes(library)),
  );
  return {
    components: present.sort((a, b) => (a.component < b.component ? -1 : 1)),
    releases: [...new Set((recorded.libraries ?? []).map((lib) => lib.release))].sort(),
  };
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
  const native = nativeComponents();
  const models = speechModels();
  // A malformed embed is already a problem, so nothing will be written; it is
  // skipped here only so that the run reaches the report instead of a TypeError.
  const embedded = native.components.flatMap((carrier) =>
    (Array.isArray(carrier.embeds) ? carrier.embeds : [])
      .filter((work) => work !== null && typeof work === 'object' && typeof work.spdx === 'string')
      .map((work) => ({ work, carrier })),
  );
  const notes = native.components
    .map((component) => [component, aboutComponent(component)])
    .filter(([, about]) => about !== '')
    .map(([component, about]) => `- **${component.component}** — ${about}`);

  const out = [];
  const w = (...lines) => out.push(...lines);

  w(
    '<!-- Generated by scripts/generate-notices.mjs. Run `pnpm notices` after a',
    '     dependency change; `pnpm notices:check` fails when this is stale. -->',
    '',
    '# Third-party notices',
    '',
    'Speaking Glass is built on work other people published. This file names every',
    'third-party component in a release, with its version and its licence, so the',
    'question "what is in this application, and under what terms?" can be answered',
    'from the application itself rather than from a repository.',
    '',
    'It ships inside the app. On macOS it is at',
    '`Speaking Glass.app/Contents/Resources/THIRD_PARTY_NOTICES.md`; in the Linux',
    'packages, at `/usr/lib/Speaking Glass/THIRD_PARTY_NOTICES.md`.',
    '',
    'Speaking Glass itself is free software under the MIT licence. Its text is in',
    '`Contents/Resources/LICENSE.txt`, beside this file.',
    '',
    'Two third-party licences travel in full with the work they cover:',
    '',
    '- the typefaces, whose SIL Open Font License is in',
    '  `Contents/Resources/LICENSE-fonts.txt`;',
    '- the speech recognition model, whose licence is written into the model',
    '  directory beside the weights when you install it.',
    '',
    '## The typefaces',
    '',
    '**Atkinson Hyperlegible Next** — Braille Institute of America, Inc. The',
    "stage's high-legibility face. Licensed under the SIL Open Font License 1.1.",
    'The woff2 subsets are the ones published as',
    '`@fontsource-variable/atkinson-hyperlegible-next@5.3.0`, unmodified.',
    '',
    '**Archivo** — The Archivo Project Authors (Omnibus-Type). The brand face,',
    'for the wordmark and a few display headings on the desk, and nothing on the',
    'stage. Licensed under the SIL Open Font License 1.1. The upright latin and',
    'latin-ext woff2 subsets are the ones published as',
    '`@fontsource-variable/archivo@5.3.0`, unmodified.',
    '',
    'One file carries both copyright notices and the licence text:',
    '`LICENSE-fonts.txt`, beside this file.',
    '',
    '## Shared libraries in the Linux AppImage',
    '',
    'The AppImage carries the shared libraries Speaking Glass needs from Ubuntu 22.04',
    '("jammy") so that it runs on distributions that lack them: chiefly WebKitGTK,',
    'GTK 3, GLib, GStreamer, cairo, pango, HarfBuzz, libsoup, GnuTLS and Nettle,',
    'and their dependencies. The `.deb` carries none of them; the package manager',
    'installs them. Each is the unmodified Ubuntu build, dynamically linked and',
    "replaceable, under its own licence — most under the GNU LGPL (2.1 or later, or",
    '3), the rest under permissive licences (MIT, BSD, the Unicode licence for ICU),',
    'with some offered under a choice that includes the GPL. None is under the GPL',
    'alone. The exact list is the AppImage\'s `usr/lib` directory, and the',
    'corresponding source for each is published in the Ubuntu 22.04 archive',
    '(<https://launchpad.net/ubuntu/jammy>), under the package that ships it. On',
    'request, the source for any of them is also available from the Speaking Glass',
    'project at <https://github.com/gregpriday/candidcue/issues>, for at least three',
    'years after the release that carried it.',
    '',
    '## Statically linked native components',
    '',
    'Speech recognition runs through **sherpa-onnx**, linked statically. Its',
    'prebuilt release archive is fetched at build time and is in neither lockfile,',
    'so no dependency scanner sees what is inside it — and it is not one project.',
    'Each component below is a separate work under its own terms. Digests are in',
    `the release provenance (\`sbom/native-inputs.json\`), from ` +
      `${native.releases.map((r) => `\`${r}\``).join(', ') || '(none recorded)'}.`,
    '',
    '| Component | Licence | Built from |',
    '|---|---|---|',
    ...native.components.map(
      (component) =>
        `| ${component.component} | ${component.spdx}${component.reviewed === true ? '' : ' †'} ` +
        `| ${builtFrom(component)} |`,
    ),
    '',
    ...(native.components.some((component) => component.reviewed !== true)
      ? [
          '† Recorded from the upstream project, and **not yet confirmed against the',
          'exact build in this archive**. The archive carries no licence metadata of its',
          'own, so each of these has to be verified before Speaking Glass is released. They',
          'are listed rather than omitted because a component nobody has classified is',
          'still in the binary.',
          '',
        ]
      : []),
    ...(embedded.length > 0
      ? [
          'Compiled into those libraries, and under their own licences rather than the',
          "licence of the component that carries them. Each one's source is published at",
          ...(embedded.some(({ work }) => work.spdx.includes('MPL-2.0'))
            ? [
                'the revision named, which for a work under the MPL-2.0 is where its Source',
                'Code Form is available.',
              ]
            : ['the revision named.']),
          '',
          '| Component | Licence | Compiled into | Built from |',
          '|---|---|---|---|',
          ...embedded.map(
            ({ work, carrier }) =>
              `| ${work.component} | ${work.spdx} | ${carrier.component} | ${builtFrom(work)} |`,
          ),
          '',
        ]
      : []),
    ...(notes.length > 0
      ? ['On particular components:', '', ...notes.flatMap((line) => [line, ''])]
      : []),
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
