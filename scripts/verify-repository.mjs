#!/usr/bin/env node
/**
 * Does this checkout contain everything it claims to?
 *
 * The 1.0 readiness review could not certify a release because the artifact it
 * was handed referenced files it did not contain — a mock backend, test
 * configs, icons, fonts, lockfiles — and there was no way to tell "excluded by
 * the export" from "missing from the repository". That distinction has to be
 * mechanical, not a matter of someone's local tree happening to be complete.
 *
 * So this walks the references the source actually makes and checks each one
 * resolves:
 *
 *   - lockfiles and toolchain pins, which are what make a build reproducible;
 *   - `package.json` scripts that name a file;
 *   - relative imports in `src/**` (TypeScript and Svelte);
 *   - `@font-face` and other `url(...)` targets in CSS;
 *   - Tauri bundle icons and resources;
 *   - Rust `include_str!` / `include_bytes!` targets in both workspaces;
 *   - the embedded migration directory;
 *   - the model catalogue the Rust catalogue is compiled against.
 *
 * It runs BEFORE anything is compiled, because the whole point is to fail on a
 * missing input with the input's name rather than with a compiler error three
 * layers down.
 *
 * It deliberately does NOT verify Git LFS payloads. That is `bench`'s problem
 * and it has a sharper check of its own (`pnpm bench:verify`) — an LFS pointer
 * is a file that exists, so a completeness check would pass it anyway.
 */

import { existsSync, readFileSync, statSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, resolve, relative, extname, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Every repository-relative path this gate compares or prints is spelled with
 * `/`, whatever the platform.
 *
 * `globSync` answers in the platform's separator, and on Windows that broke
 * the gate on the committed tree: `tests\integration\release-gates.test.ts`
 * is not the allow-listed spelling, and `src-tauri\src\…` does not start with
 * `src-tauri/`, so the migrations directory was looked for in the wrong crate.
 * Splitting on `sep` is the identity wherever `/` is already the separator.
 */
const toRepoPath = (path) => path.split(sep).join('/');

const problems = [];
let checked = 0;

const fail = (message) => problems.push(message);
const has = (path) => existsSync(join(ROOT, path));

/**
 * Read a file, or report why not and carry on.
 *
 * Unreadable is a completeness failure of its own: a file that exists but
 * cannot be opened breaks the build just as thoroughly as one that is absent,
 * and a stack trace here tells the operator less than the path does. `null`
 * means "already reported" at every call site.
 */
function read(path) {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch (error) {
    fail(`${path} could not be read — ${error.message}`);
    return null;
  }
}

function require_(path, why) {
  checked += 1;
  if (!has(path)) fail(`missing ${path} — ${why}`);
}

function requireNonEmpty(path, why) {
  checked += 1;
  if (!has(path)) {
    fail(`missing ${path} — ${why}`);
    return;
  }
  try {
    if (statSync(join(ROOT, path)).size === 0) fail(`${path} is empty — ${why}`);
  } catch (error) {
    fail(`${path} could not be measured — ${error.message}`);
  }
}

/**
 * Glob, and treat a collapsed pattern as a failure rather than a clean sweep.
 *
 * Every scan below reports violations it FINDS, so a pattern that matches
 * nothing reports nothing and the run goes green. That is not a theoretical
 * risk here: these globs encode directory layout, and a rename is exactly the
 * kind of change that would silently switch a whole branch of this gate off.
 */
function globOrFail(pattern, why) {
  let matches = [];
  try {
    matches = globSync(pattern, { cwd: ROOT });
  } catch (error) {
    fail(`glob ${pattern} failed — ${error.message}`);
    return [];
  }
  if (matches.length === 0) fail(`glob ${pattern} matched nothing — ${why}`);
  return matches.map(toRepoPath);
}

/* ------------------------------------------------------- reproducibility */

// Non-empty, not merely present: an emptied lockfile installs nothing and
// `--frozen-lockfile` would report a mismatch rather than a missing file.
requireNonEmpty('pnpm-lock.yaml', 'a release must install with --frozen-lockfile');
requireNonEmpty('src-tauri/Cargo.lock', 'the app workspace must build with --locked');
requireNonEmpty('crates/Cargo.lock', 'the alignment workspace must build with --locked');
require_('.nvmrc', 'the Node version used for a release has to be recorded');
require_('rust-toolchain.toml', 'the Rust compiler used for a release has to be recorded');
requireNonEmpty('sbom/native-components.json', 'the native licence gates and notices require the reviewed component inventory');

const nvmrc = has('.nvmrc') ? read('.nvmrc') : null;
if (nvmrc !== null) {
  checked += 1;
  // An exact version, for the same reason the Rust channel is exact. `lts/*`
  // and a bare major both move, and both would reproduce a release differently
  // six months from now.
  if (!/^v?\d+\.\d+\.\d+$/.test(nvmrc.trim())) {
    fail(
      `.nvmrc says "${nvmrc.trim()}" — a release needs an exact Node version ` +
        `(for example 26.4.0), not a moving alias`,
    );
  }
}

const toolchainToml = has('rust-toolchain.toml') ? read('rust-toolchain.toml') : null;
if (toolchainToml !== null) {
  checked += 1;
  /*
   * Scoped to the `[toolchain]` table, and comment-stripped.
   *
   * Comment stripping first, because the file's own explanation of why
   * `stable` is wrong contains the string `channel = "stable"`, and matching
   * that is how this check once reported a correctly-pinned file as unpinned.
   *
   * Table scoping second, because the first textual `channel =` anywhere is
   * not necessarily the toolchain's: an exact-looking value in some other
   * table would satisfy the check while `[toolchain]` still said `stable`.
   */
  const declarations = toolchainToml
    .split('\n')
    .map((line) => line.replace(/\s#.*$/, ''))
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  // Split on table headers rather than matching one with a lookahead: under
  // the `m` flag `$` means end-of-LINE, so a lazy `[\s\S]*?` terminated on the
  // first newline and captured an empty table.
  const toolchainTable = declarations
    .split(/^\[/m)
    .find((section) => section.startsWith('toolchain]'));
  if (toolchainTable === undefined) {
    fail('rust-toolchain.toml declares no [toolchain] table');
  } else {
    const channel = toolchainTable.match(/\bchannel\s*=\s*"([^"]+)"/)?.[1];
    if (!channel) {
      fail('rust-toolchain.toml [toolchain] declares no channel');
    } else if (!/^\d+\.\d+\.\d+$/.test(channel)) {
      // `1.97` is a moving pin too — it tracks every patch release.
      fail(
        `rust-toolchain.toml pins the moving channel "${channel}" — a release needs an exact ` +
          `compiler version (for example 1.97.0), or two machines build the same tag differently`,
      );
    }
  }
}

/* -------------------------------------------------- package.json scripts */

/**
 * Every path-shaped token in a package script.
 *
 * A script that runs `node scripts/release-verify.mjs` is a promise that the file
 * exists; the review found exactly this class of break. Bare binaries
 * (`vite`, `tsc`) are resolved by the package manager and are not our problem.
 *
 * A checkout without a `package.json` is not a checkout, and a gate that dies
 * with an ENOENT stack trace instead of saying so is a gate nobody trusts. The
 * rest of the file's manifest-driven checks are skipped in that case, but every
 * problem found so far is still reported — the point is to name the missing
 * input, not to guess at what else broke because of it.
 */
const packageJson = readManifestOrReport('package.json', 'the project manifest');
const tauriConfRaw = readManifestOrReport(
  'src-tauri/tauri.conf.json',
  'the Tauri bundle configuration',
);

function readManifestOrReport(path, why) {
  checked += 1;
  if (!has(path)) {
    fail(`missing ${path} — ${why}`);
    return null;
  }
  const source = read(path);
  if (source === null) return null; // `read` already reported why
  try {
    return JSON.parse(source);
  } catch (error) {
    fail(`${path} is not valid JSON — ${error.message}`);
    return null;
  }
}

for (const [name, script] of Object.entries(packageJson?.scripts ?? {})) {
  if (typeof script !== 'string') {
    fail(`package script "${name}" is not a string`);
    continue;
  }
  for (const token of script.split(/\s+/)) {
    const candidate = token.replace(/^--config=/, '').replace(/^\.\//, '');
    if (!/^(scripts|tests|src|bench|crates|src-tauri)\//.test(candidate)) {
      // Also catch bare config filenames passed as arguments.
      if (!/^[\w.-]+\.(?:ts|mjs|js|json|toml)$/.test(candidate)) continue;
    }
    checked += 1;
    if (candidate.includes('*')) {
      // A glob that matches nothing is a script that operates on nothing.
      if (globSync(candidate, { cwd: ROOT }).length === 0) {
        fail(`package script "${name}" uses the glob ${candidate}, which matches nothing`);
      }
      continue;
    }
    if (!has(candidate)) fail(`package script "${name}" references ${candidate}, which is absent`);
  }
}

/* --------------------------------------------------- frontend resolution */

/** Extensions TypeScript/Vite will try for an extensionless relative import. */
const RESOLVE_AS = [
  '',
  '.ts',
  '.mts',
  '.tsx',
  '.js',
  '.mjs',
  '.jsx',
  '.svelte',
  '.json',
  '.css',
  '/index.ts',
  '/index.mts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
  '/index.jsx',
  '/index.svelte',
];

/**
 * Does a relative specifier resolve to an actual MODULE?
 *
 * The empty suffix is checked with `isFile`, not `existsSync`. A bare
 * `existsSync` returns true for a DIRECTORY, so deleting
 * `src/shared/contracts/index.ts` while leaving `src/shared/contracts/` behind
 * satisfied the gate — even though every `from '../shared/contracts'` in the
 * tree would then fail to resolve. A directory only counts when one of the
 * `/index.*` suffixes below finds a real file inside it.
 */
function resolvesFrom(fromFile, spec) {
  const base = resolve(dirname(join(ROOT, fromFile)), spec);
  return RESOLVE_AS.some((suffix) => {
    const candidate = base + suffix;
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const FRONTEND_FILES = [
  ...globOrFail('src/**/*.{ts,svelte}', 'the frontend import scan would check nothing'),
  ...globOrFail('tests/**/*.ts', 'the test-suite import scan would check nothing'),
];

/**
 * Anything that names a relative module.
 *
 * Written as "a quoted relative path in a module-loading position" rather than
 * as a grammar for `import`, because the narrow version missed forms this
 * codebase actually uses: side-effect imports (`import './x'`), `import`
 * statements broken across lines so `from` and the specifier are not adjacent,
 * `export … from`, and `vi.mock('./x')` — which is how half the test suite
 * names a module. A missed form is a silent hole in the gate.
 *
 * Over-matching is the safe direction: it reports a path that does not resolve,
 * which is a loud, inspectable failure, rather than skipping one that does not.
 */
const IMPORT_SPEC = /(?:\bfrom|\bimport|\brequire|\bvi\.(?:mock|doMock))\s*\(?\s*['"](\.[^'"]+)['"]/g;

/**
 * `new URL('./thing', import.meta.url)` — the bundler's other module reference.
 *
 * Not an import statement, and load-bearing: `services/compiler.ts` names the
 * compiler Web Worker this way, and that worker is what compiles every script.
 * A rename that missed it would produce an application that cannot open a
 * document — the exact class of break this gate exists to catch — while the
 * import scan reported everything resolved.
 */
const URL_SPEC = /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

/**
 * A `new URL` target may legitimately be a DIRECTORY.
 *
 * Unlike an import, this form is also used to build a base URL to resolve
 * other paths against — `new URL('../../styles/', import.meta.url)` in the
 * font-hash test, for instance. So this asks only that the path exists, with
 * no extension guessing: the specifier is used verbatim by the bundler and by
 * `readFileSync`, so a missing extension is not something either would fix.
 */
function urlTargetExists(fromFile, spec) {
  return existsSync(resolve(dirname(join(ROOT, fromFile)), spec));
}

/**
 * Strip comments before looking for imports.
 *
 * This codebase documents heavily and its comments quote module paths — the
 * barrel file's own header says «Import from '.../shared/contracts' rather than
 * from individual files», which the broadened matcher above read as an import
 * of a path with an ellipsis in it. Three separate checks in this change set
 * were first defeated by their own explanatory prose; the rule is the same
 * every time. `//` only counts at the start of a line so a `https://` survives.
 */
function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * The opt-out, for files that contain module source as DATA.
 *
 * There is exactly one shape this is for: a test that writes fixture source
 * files to a temporary directory. Those fixtures deliberately import modules
 * that do not exist — that is the whole point of the test — and the specifiers
 * are string contents rather than imports this file makes.
 *
 * A directive rather than a path allow-list, so the exemption travels with the
 * file and has to be written down where someone reading the file will see it.
 * It suppresses ONLY the import scan; every other check still applies.
 */
const IGNORE_IMPORTS = 'verify-repository:ignore-imports';

/**
 * Which files may use the directive.
 *
 * A bare substring test on the whole file was too blunt in two directions: any
 * occurrence anywhere — including inside generated data — silenced the scan,
 * and a file that opted out lost checking of its own REAL imports too. Naming
 * the file here means adding an exemption is a change to this list, reviewed
 * alongside the file that wants it, and every exemption is announced on stdout.
 */
const IGNORE_IMPORTS_ALLOWED = ['tests/integration/release-gates.test.ts'];

for (const rel of FRONTEND_FILES) {
  const raw = read(rel);
  if (raw === null) continue;

  if (raw.includes(IGNORE_IMPORTS)) {
    if (!IGNORE_IMPORTS_ALLOWED.includes(rel)) {
      fail(
        `${rel} declares ${IGNORE_IMPORTS}, but is not in the allow-list in this script. ` +
          `The directive is for files that write module SOURCE as data; add it deliberately.`,
      );
      continue;
    }
    console.log(`  (import scan skipped for ${rel} — it writes module source as fixture data)`);
    continue;
  }

  const source = withoutComments(raw);
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const spec = match[1];
    if (!spec) continue;
    checked += 1;
    if (!resolvesFrom(rel, spec)) fail(`${rel} imports "${spec}", which does not resolve`);
  }
  for (const match of source.matchAll(URL_SPEC)) {
    const spec = match[1];
    if (!spec) continue;
    checked += 1;
    if (!urlTargetExists(rel, spec)) {
      fail(`${rel} references "${spec}" via new URL(…, import.meta.url), which does not exist`);
    }
  }
}

/* ------------------------------------------------------------------ CSS */

for (const rel of globOrFail('src/**/*.css', 'the bundled-font scan would check nothing')) {
  const source = read(rel);
  if (source === null) continue;
  for (const match of source.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const target = match[1];
    if (/^(data:|https?:|\/)/.test(target)) continue;
    checked += 1;
    if (!existsSync(resolve(dirname(join(ROOT, rel)), target))) {
      fail(`${rel} references ${target}, which is absent — a bundled font is not optional`);
    }
  }
}

/* ------------------------------------------------------- Tauri resources */

// `posix.join` throughout: these are repository-relative names that end up in
// the report, so they read the same whichever platform produced it.
for (const icon of tauriConfRaw?.bundle?.icon ?? []) {
  requireNonEmpty(posix.join('src-tauri', icon), 'a bundle icon declared by tauri.conf.json');
}

/*
 * `bundle.resources` accepts an ARRAY of paths or a source→target MAP. The
 * array-only loop that used to be here would iterate a map's values, or throw
 * on it outright.
 *
 * A wildcard entry is expanded rather than skipped: a glob that matches nothing
 * is a resource declaration that ships nothing, which is exactly the silent
 * failure this gate is for.
 */
const declaredResources = tauriConfRaw?.bundle?.resources ?? [];
const resourcePaths = Array.isArray(declaredResources)
  ? declaredResources
  : Object.keys(declaredResources);
for (const resource of resourcePaths) {
  const target = typeof resource === 'string' ? resource : resource?.src;
  if (!target) continue;
  checked += 1;
  if (target.includes('*')) {
    if (globSync(posix.join('src-tauri', target), { cwd: ROOT }).length === 0) {
      fail(`tauri.conf.json declares resource glob "${target}", which matches nothing`);
    }
  } else {
    require_(posix.join('src-tauri', target), 'a bundle resource declared by tauri.conf.json');
  }
}

// The hardened runtime and the microphone entitlement both live in this file.
// A signed build with it missing fails at notarisation, hours later.
const entitlements = tauriConfRaw?.bundle?.macOS?.entitlements;
if (entitlements) {
  requireNonEmpty(
    posix.join('src-tauri', entitlements),
    'the macOS entitlements declared by tauri.conf.json — the microphone permission lives there',
  );
}

/** The frontend entry points Tauri window URLs point at. */
for (const html of ['control.html', 'stage.html', 'identify.html']) {
  require_(html, 'a Tauri window URL points directly at it');
}

/* ------------------------------------------------- Rust embedded inputs */

const RUST_FILES = [
  ...globOrFail('src-tauri/src/**/*.rs', 'the app workspace embed scan would check nothing'),
  ...globOrFail('crates/*/src/**/*.rs', 'the alignment workspace embed scan would check nothing'),
];

for (const rel of RUST_FILES) {
  const source = read(rel);
  if (source === null) continue;
  for (const match of source.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) {
    checked += 1;
    const target = resolve(dirname(join(ROOT, rel)), match[1]);
    if (!existsSync(target)) {
      fail(
        `${rel} embeds ${match[1]}, which is absent — this is a compile error the ` +
          `completeness check should name first`,
      );
    }
  }
  // `sqlx::migrate!()` with no argument defaults to `./migrations`, and that
  // form used to be invisible to this scan — a migration directory that had
  // been renamed would have gone unreported until the build failed.
  for (const match of source.matchAll(/sqlx::migrate!\(\s*(?:"([^"]+)"\s*)?\)/g)) {
    checked += 1;
    const declared = match[1] ?? './migrations';
    // `sqlx::migrate!` resolves against CARGO_MANIFEST_DIR, not the source file.
    const crateRoot = rel.startsWith('src-tauri/')
      ? 'src-tauri'
      : rel.split('/').slice(0, 2).join('/');
    const target = join(ROOT, crateRoot, declared);
    if (!existsSync(target)) fail(`${rel} embeds migrations from ${declared}, which is absent`);
    else if (globSync('*.sql', { cwd: target }).length === 0) {
      fail(`${rel} embeds migrations from ${declared}, which contains no .sql files`);
    }
  }
}

/* ------------------------------------------------------ generated pairs */

/*
 * Files that only mean something together. Each of these pairs already has a
 * Rust test asserting the two agree; this only asserts BOTH SIDES EXIST, so a
 * deletion is reported here as a missing input rather than as a mysteriously
 * absent test.
 */
const PAIRS = [
  ['src/shared/contracts/stage.ts', 'src-tauri/src/windows/mod.rs'],
  ['src/shared/contracts/audio.ts', 'src-tauri/src/speech/catalogue.rs'],
  ['src-tauri/models/catalogue.json', 'scripts/model-catalogue.mjs'],
];
for (const [a, b] of PAIRS) {
  require_(a, `it is asserted against ${b}`);
  require_(b, `it is asserted against ${a}`);
}

/* ------------------------------------------------------ legal documents */

for (const rel of globOrFail('legal/*.md', 'the legal-document scan would check nothing')) {
  requireNonEmpty(rel, 'a legal document');
}

/* ----------------------------------------------------------------- done */

if (problems.length > 0) {
  console.error(`Repository completeness FAILED — ${problems.length} of ${checked} references:\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log(`Repository completeness OK — ${checked} references resolve.`);
