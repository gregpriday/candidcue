#!/usr/bin/env node
/**
 * The one place the application version is decided, and the gate that keeps
 * every other copy of it honest.
 *
 * `package.json` is canonical. Three files derive from it:
 *
 *   - `src-tauri/Cargo.toml`        — the crate the bundle is built from
 *   - `src-tauri/tauri.conf.json`   — CFBundleShortVersionString on macOS
 *   - `src/shared/version.ts`       — what the frontend shows when Rust is absent
 *
 * Before this existed the three manifests carried `0.1.0` independently and the
 * frontend carried two more hard-coded copies, so "what version is this?" had
 * five answers that nothing forced to agree. The diagnostics bundle, the
 * database support metadata, the legal receipt and the artifact name each read
 * one of them.
 *
 * Usage:
 *   node scripts/version.mjs check      — exit 1 on any disagreement
 *   node scripts/version.mjs set 1.2.3  — rewrite every consumer
 *   node scripts/version.mjs print      — print the canonical version
 *   node scripts/version.mjs tag v1.2.3 — exit 1 unless the tag names this version
 *
 * The internal crates under `crates/` are DELIBERATELY not synced: cc-align,
 * cc-stt and cc-bench are libraries with no public version surface. The check
 * asserts that rule below rather than silently ignoring them, so promoting one
 * to a published crate has to be a decision someone makes on purpose.
 */

import { accessSync, constants, globSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Repository-relative paths, spelled with `/` on every platform.
 *
 * `globSync` answers in the platform's separator, so on Windows it yields
 * `src\shared\markdown\compile.ts` — which matches no entry written below, so
 * the COMPILER_VERSION exemption silently stopped applying and the committed
 * tree failed its own check. Splitting on `sep` is the identity on macOS and
 * Linux, where a backslash is a legal filename character and not a separator.
 */
const repoGlob = (pattern) => globSync(pattern, { cwd: ROOT }).map((rel) => rel.split(sep).join('/'));

const PACKAGE_JSON = join(ROOT, 'package.json');
const CARGO_TOML = join(ROOT, 'src-tauri', 'Cargo.toml');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');
const VERSION_TS = join(ROOT, 'src', 'shared', 'version.ts');

/**
 * Semver, including a prerelease tail like `-rc.1`.
 *
 * No build metadata: the macOS bundle short version string rejects `+`.
 *
 * Stricter than "digits, dots and a tail". A looser pattern accepted `01.2.3`,
 * `1.2.3-01`, `1.2.3-rc.` and `1.2.3-rc..1` — all invalid semver, and the sort
 * of value that produces a bundle version nobody can compare against the next
 * one. Numeric identifiers may not have leading zeroes; every dot-separated
 * prerelease identifier must be non-empty.
 */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** The `version = "…"` of the `[package]` table, not of whichever dependency
 *  happens to sit first in the file. */
const CARGO_VERSION = /(^\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/m;
const TAURI_VERSION = /("version"\s*:\s*")([^"]+)(")/;
const PACKAGE_VERSION = /("version"\s*:\s*")([^"]+)(")/;
const TS_VERSION = /(export const APP_VERSION = ')([^']+)(')/;

const read = (path) => readFileSync(path, 'utf8');

/**
 * Read a file, or record why not.
 *
 * A gate that dies with an ENOENT stack trace has told the operator less than
 * a gate that says "src-tauri/Cargo.toml is missing". Every input here is
 * required, so unreadable is always a failure — the only question is whether
 * it is a legible one.
 */
function readOrRecord(path, label, problems) {
  try {
    return read(path);
  } catch (error) {
    problems.push(`${label}: could not be read — ${error.message}`);
    return null;
  }
}

function canonicalVersion(problems) {
  return topLevelJsonVersion(PACKAGE_JSON, 'package.json', problems);
}

/**
 * The top-level `version` of a JSON file, read by PARSING it.
 *
 * `/"version"\s*:\s*"…"/` finds the first textual match anywhere in the file,
 * which is the intended property in both manifests today and is not guaranteed
 * to stay that way: a plugin or build-config object gaining an earlier nested
 * `"version"` would make `check` compare the wrong property — and pass — while
 * the real bundle version sat stale. Parsing asks the question directly.
 */
function topLevelJsonVersion(path, label, problems) {
  const raw = readOrRecord(path, label, problems);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(`${label} is not valid JSON — ${error.message}`);
    return null;
  }
  if (typeof parsed?.version !== 'string') {
    problems.push(`${label} has no top-level string "version" property.`);
    return null;
  }
  return parsed.version;
}

function consumers(problems) {
  const cargo = readOrRecord(CARGO_TOML, 'src-tauri/Cargo.toml', problems);
  return [
    {
      label: 'src-tauri/Cargo.toml',
      version: cargo === null ? null : cargo.match(CARGO_VERSION)?.[2],
    },
    {
      label: 'src-tauri/tauri.conf.json',
      version: topLevelJsonVersion(TAURI_CONF, 'src-tauri/tauri.conf.json', problems),
    },
    {
      label: 'src/shared/version.ts',
      version: (() => {
        const raw = readOrRecord(VERSION_TS, 'src/shared/version.ts', problems);
        return raw === null ? null : raw.match(TS_VERSION)?.[2];
      })(),
    },
  ];
}

/**
 * Versions in product source that are deliberately NOT the application version.
 *
 * Each entry has to name the declaration, so adding one is a sentence someone
 * wrote rather than a pattern someone widened.
 */
const INDEPENDENT_VERSIONS = [
  {
    file: 'src/shared/markdown/compile.ts',
    declaration: 'COMPILER_VERSION',
    why: 'the compiled-document cache key — it changes when the compiler output changes, not when the app ships',
  },
];

/**
 * Version literals that product code should not contain.
 *
 * Deliberately narrow: a quoted bare `x.y.z` in a `.ts`/`.svelte` file under
 * `src/`, excluding the generated `version.ts` and test files, which
 * legitimately assert against fixed versions. The quote has to hug the digits,
 * which is what keeps dependency ranges (`^6.20.3`) and CSS out of it.
 *
 * Comment lines are skipped. The rule is about what the app REPORTS, and prose
 * explaining why a literal was removed is the opposite of the defect — a check
 * that fires on its own postmortem teaches people to delete the postmortem.
 */
function strayVersionLiterals(problems) {
  const found = [];
  const files = repoGlob('src/**/*.{ts,svelte}');
  let examined = 0;

  for (const rel of files) {
    if (rel.endsWith('version.ts') || rel.includes('.test.')) continue;
    examined += 1;
    const allowed = INDEPENDENT_VERSIONS.filter((entry) => entry.file === rel);
    const source = readOrRecord(join(ROOT, rel), rel, problems);
    if (source === null) continue;
    source.split('\n').forEach((line, index) => {
      const trimmed = line.trimStart();
      if (/^(\*|\/\/|\/\*|<!--)/.test(trimmed)) return;
      const match = line.match(/['"`](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)['"`]/);
      if (!match) return;
      if (allowed.some((entry) => line.includes(entry.declaration))) return;
      found.push({ file: rel, line: index + 1, text: match[1] });
    });
  }

  /*
   * A scan that EXAMINED nothing reports no violations, which is
   * indistinguishable from a clean tree.
   *
   * The count is of files actually inspected, not of glob matches: the glob
   * necessarily matches `src/shared/version.ts`, which this scan then skips
   * because it is the one file allowed to hold a literal. Counting matches
   * would make a tree containing only that file look like a scan that ran.
   */
  if (examined === 0) {
    problems.push(
      'the stray-literal scan examined no files under src/ — the scan is broken, not the tree clean.',
    );
  }

  return found;
}

/**
 * The internal crates are supposed to stay on their own line. Drifting one to
 * the app version means someone started treating it as public.
 *
 * A manifest whose version this cannot read is a FAILURE, not a pass. The
 * comparison used to be `undefined !== canonical`, which quietly accepted
 * every form the regex does not cover — a single-quoted `version = '1.0.0'`,
 * or `version.workspace = true` inheriting from `crates/Cargo.toml`'s
 * `[workspace.package]`, which already exists and would be the natural way to
 * introduce exactly this drift.
 */
function internalCrateDrift(canonical, problems) {
  const drifted = [];
  const manifests = repoGlob('crates/*/Cargo.toml');
  if (manifests.length === 0) {
    problems.push('no crates/*/Cargo.toml matched — the internal-crate check scanned nothing.');
    return drifted;
  }

  /*
   * `version.workspace = true` is resolved against the workspace root, so an
   * inherited version is compared rather than skipped. Read LAZILY: a tree
   * whose crates all declare their own version has no reason to need the
   * workspace manifest, and demanding it would make this check fail on trees
   * that are perfectly fine.
   */
  let workspaceVersion;
  const resolveWorkspaceVersion = () => {
    if (workspaceVersion !== undefined) return workspaceVersion;
    const root = readOrRecord(join(ROOT, 'crates/Cargo.toml'), 'crates/Cargo.toml', problems);
    workspaceVersion =
      root?.match(/^\[workspace\.package\][^[]*?\nversion\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
    return workspaceVersion;
  };

  for (const rel of manifests) {
    if (rel === 'crates/Cargo.toml') continue; // the workspace root declares no package
    const source = readOrRecord(join(ROOT, rel), rel, problems);
    if (source === null) continue;

    const packageTable = source.match(/^\[package\]([^[]*)/m)?.[1];
    if (packageTable === undefined) {
      problems.push(`${rel} declares no [package] table — the internal-crate check cannot read it.`);
      continue;
    }

    let version = packageTable.match(/\nversion\s*=\s*["']([^"']+)["']/)?.[1];
    if (version === undefined && /\nversion\s*\.\s*workspace\s*=\s*true/.test(packageTable)) {
      version = resolveWorkspaceVersion() ?? undefined;
      if (version === undefined) {
        problems.push(
          `${rel} inherits its version from the workspace, but crates/Cargo.toml declares no ` +
            `[workspace.package] version — the internal-crate check cannot resolve it.`,
        );
        continue;
      }
    }

    if (version === undefined) {
      problems.push(
        `${rel}: could not read a package version — the internal-crate check must not pass ` +
          `a manifest it failed to parse.`,
      );
      continue;
    }

    if (version === canonical) drifted.push(rel);
  }
  return drifted;
}

function check() {
  const problems = [];
  const canonical = canonicalVersion(problems);

  if (canonical === undefined || canonical === null) {
    if (problems.length === 0) problems.push('package.json declares no version.');
  } else if (!SEMVER.test(canonical)) {
    problems.push(
      `package.json version "${canonical}" is not a bundle-safe semver ` +
        `(major.minor.patch with an optional -prerelease tail, no + build metadata).`,
    );
  }

  for (const { label, version } of consumers(problems)) {
    if (version === null) continue; // already reported as unreadable
    if (version === undefined) {
      problems.push(`${label}: no version found to compare — the file shape changed.`);
    } else if (version !== canonical) {
      problems.push(`${label}: "${version}" but package.json says "${canonical}".`);
    }
  }

  for (const stray of strayVersionLiterals(problems)) {
    problems.push(
      `${stray.file}:${stray.line}: hard-coded version literal "${stray.text}" — ` +
        `import APP_VERSION from src/shared/version.ts instead.`,
    );
  }

  for (const rel of internalCrateDrift(canonical, problems)) {
    problems.push(
      `${rel} is versioned as the application (${canonical}). The internal crates keep ` +
        `their own line; if that is changing on purpose, update this check too.`,
    );
  }

  if (problems.length > 0) {
    console.error('Version sync FAILED:\n');
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error(`\nRun \`pnpm version:set ${canonical}\` to bring every consumer back in line.`);
    process.exit(1);
  }

  console.log(`Version sync OK — every consumer reports ${canonical}.`);
}

/**
 * The tag names the version the artifact will actually report.
 *
 * `v1.0.0` building source version `1.0.0-rc.2` is the release defect that
 * cannot be undone after the fact: the download page, the checksum record, the
 * support request and the About box would each name a different thing, and the
 * artifact is already signed and notarised by the time anybody notices. The
 * workflow runs this BEFORE the build, so the run fails in twenty seconds
 * rather than after a notarisation round trip.
 *
 * Deliberately strict about the shape as well as the value. A `v*` tag is what
 * triggers the release workflow, so `v1.0` and `vfinal` reach here too — and a
 * gate that only compared the tail would let `release-v1.0.0` through as a
 * release of 1.0.0. The tag must be exactly `v` followed by the version.
 */
function tag(name) {
  const problems = [];
  const canonical = canonicalVersion(problems);
  if (problems.length > 0 || !canonical) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }

  if (name !== `v${canonical}`) {
    console.error(`Tag/version mismatch — nothing may be released from this pair.\n`);
    console.error(`  tag:            ${name}`);
    console.error(`  source version: ${canonical}`);
    console.error(`  expected tag:   v${canonical}\n`);
    /*
     * The advice has to be worth following. "Run version:set <tag>" is only
     * sensible when the tag actually names a version — suggesting
     * `version:set release-v1.0.0` for a misnamed tag sends the operator to a
     * second failure with the first one still unexplained.
     */
    const named = name.startsWith('v') ? name.slice(1) : null;
    if (named === null) {
      console.error('A release tag is `v` followed by the version, with nothing else around it.');
    } else if (SEMVER.test(named)) {
      console.error(
        `Either tag the commit v${canonical}, or run \`pnpm version:set ${named}\` and commit ` +
          `that before tagging.`,
      );
    } else {
      console.error(
        `"${named}" is not a bundle-safe semver, so no source version could ever match this ` +
          `tag. Tag the commit v${canonical}.`,
      );
    }
    process.exit(1);
  }

  /*
   * Every consumer, not only package.json. The tag agreeing with the canonical
   * file while tauri.conf.json lags is the same defect one file further down —
   * and tauri.conf.json is the one the bundle actually reports.
   */
  check();
  console.log(`Tag ${name} matches the source version.`);
}

function set(next) {
  if (!SEMVER.test(next)) {
    console.error(
      `"${next}" is not a bundle-safe semver. Use major.minor.patch with an optional ` +
        `-prerelease tail (for example 1.0.0 or 1.0.0-rc.1).`,
    );
    process.exit(1);
  }

  /*
   * Read and rewrite EVERYTHING before writing ANYTHING.
   *
   * Writing as it went meant a missing or unwritable later file left the tree
   * half-bumped — package.json on the new version, `version.ts` on the old —
   * which is precisely the split this script exists to make impossible, now
   * produced by the script itself. This is not atomic against a crash between
   * the writes, and it does not need to be: it removes the failure mode that
   * actually occurs (a file that is absent or unreadable), and `check` catches
   * anything stranger on the next run.
   */
  const rewrites = [
    { path: PACKAGE_JSON, label: 'package.json', pattern: PACKAGE_VERSION, json: true },
    { path: CARGO_TOML, label: 'src-tauri/Cargo.toml', pattern: CARGO_VERSION, json: false },
    { path: TAURI_CONF, label: 'src-tauri/tauri.conf.json', pattern: TAURI_VERSION, json: true },
    { path: VERSION_TS, label: 'src/shared/version.ts', pattern: TS_VERSION, json: false },
  ];

  const problems = [];
  const pending = [];
  for (const { path, label, pattern, json } of rewrites) {
    const source = readOrRecord(path, label, problems);
    if (source === null) continue;
    if (!pattern.test(source)) {
      problems.push(`${label}: no version declaration matched — the file shape changed.`);
      continue;
    }
    const rewritten = source.replace(pattern, `$1${next}$3`);

    /*
     * For JSON, check the result rather than trusting the regex.
     *
     * `"version": "…"` is matched textually and takes the FIRST occurrence. If
     * a nested object ever gains an earlier `"version"`, that replace rewrites
     * the wrong property — silently, and in the file whose value becomes the
     * macOS bundle version. Re-parsing and asserting the TOP-LEVEL property is
     * what makes that a refusal instead of a corrupted manifest.
     */
    if (json) {
      try {
        const parsed = JSON.parse(rewritten);
        if (parsed?.version !== next) {
          problems.push(
            `${label}: the rewrite did not set the top-level "version" (it now reads ` +
              `${JSON.stringify(parsed?.version)}). Something else in the file matched first.`,
          );
          continue;
        }
      } catch (error) {
        problems.push(`${label}: the rewrite produced invalid JSON — ${error.message}`);
        continue;
      }
    }

    // Writability, before anything is written. The read succeeding does not
    // mean the write will, and a read-only later consumer is exactly how a
    // half-bumped tree happens.
    try {
      accessSync(path, constants.W_OK);
    } catch (error) {
      problems.push(`${label}: not writable — ${error.message}`);
      continue;
    }

    pending.push({ path, label, next: rewritten });
  }

  if (problems.length > 0) {
    console.error('Version set FAILED — nothing was written:\n');
    for (const problem of problems) console.error(`  • ${problem}`);
    process.exit(1);
  }

  for (const { path, next: contents } of pending) writeFileSync(path, contents, 'utf8');

  console.log(`Version set to ${next} in package.json, Cargo.toml, tauri.conf.json, version.ts.`);
  console.log('Run `cargo update -p candidcue --manifest-path src-tauri/Cargo.toml` to refresh the lockfile.');
}

const [command, argument] = process.argv.slice(2);
switch (command) {
  case 'check':
    check();
    break;
  case 'set':
    if (!argument) {
      console.error('Usage: node scripts/version.mjs set <version>');
      process.exit(1);
    }
    set(argument);
    break;
  case 'print': {
    const problems = [];
    const version = canonicalVersion(problems);
    if (problems.length > 0 || !version) {
      for (const problem of problems) console.error(problem);
      process.exit(1);
    }
    console.log(version);
    break;
  }
  case 'tag':
    if (!argument) {
      console.error('Usage: node scripts/version.mjs tag <tag-name>');
      process.exit(1);
    }
    tag(argument);
    break;
  default:
    console.error('Usage: node scripts/version.mjs <check|set <version>|print|tag <tag-name>>');
    process.exit(1);
}
