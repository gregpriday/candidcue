#!/usr/bin/env node
/**
 * The installer must ship zero speech-model bytes.
 *
 * This is a product decision (§152) with three separate consequences, which is
 * why it deserves a gate rather than a comment:
 *
 *   - **Size.** The x-asr 480 ms graphs are ~161 MB. A DMG that quietly grew by
 *     that much would be noticed; one that grew by a single stray `.onnx`
 *     during a refactor would not.
 *   - **Licensing.** The recogniser's licence is not Speaking Glass's licence. The
 *     model is downloaded in-app with its attribution written beside it; a
 *     model inside the bundle would be redistribution under a different set of
 *     obligations, decided by accident.
 *   - **Truthfulness.** "The installer contains no model weights" is a claim
 *     the privacy copy and the release notes both make.
 *
 * The path from "correct" to "wrong" is one line: an entry added to
 * `bundle.resources` in `tauri.conf.json`, or a developer's
 * `src-tauri/models/` tree — which `pnpm models:fetch` fills and which nothing
 * is supposed to read — being picked up by a widened glob.
 *
 * Usage:
 *   node scripts/verify-no-model-weights.mjs [bundle-root]
 *
 * With no argument it checks the declared bundle configuration, which is the
 * check that works before anything is built. Given a built `.app` it also walks
 * the actual payload, which is the check that catches a build script.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * A path inside the bundle, relative to its root and spelled with `/`.
 *
 * Every rule below is written against the bundle's own layout —
 * `Contents/Info.plist`, `Contents/MacOS/<executable>`, a library's basename
 * after the last `/` — and `relative` answers in the platform's separator. On
 * Windows a perfectly valid `.app` therefore failed the layout check, and the
 * runtime libraries lost their exemption. Splitting on `sep` is the identity on
 * macOS, where this normally runs.
 */
const inBundle = (root, path) => relative(root, path).split(sep).join('/');

const problems = [];

/** Report an unreadable input rather than dying with a stack trace. */
function readJson(path, why) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`could not read ${why} (${path}): ${error.message}`);
    return null;
  }
}

/** Extensions that are model weights by definition, not by size. */
const WEIGHT_EXTENSIONS = ['.onnx', '.ort', '.bin', '.pt', '.safetensors', '.tflite'];

/** A file this big inside an installer is a payload, whatever it is called. */
const SUSPICIOUS_BYTES = 8 * 1024 * 1024;

/**
 * The ONNX runtime is not a model, and it is legitimately large.
 *
 * Matched on the BASENAME against an exact list, not by substring anywhere in
 * the path. A substring test on `sherpa|onnxruntime` exempted every file whose
 * path merely mentioned them from every size rule at once — so
 * `Contents/Resources/sherpa-model.data` at 161 MB, which is exactly the thing
 * this script exists to catch, was waved through by the check designed to let
 * the runtime past.
 *
 * Each entry carries its own ceiling, so the runtime growing to model size is
 * still a failure.
 */
const RUNTIME_LIBRARIES = [
  { name: 'libonnxruntime.dylib', ceilingBytes: 80 * 1024 * 1024 },
  { name: 'libsherpa-onnx-c-api.dylib', ceilingBytes: 40 * 1024 * 1024 },
  { name: 'libsherpa-onnx-cxx-api.dylib', ceilingBytes: 40 * 1024 * 1024 },
];

/**
 * The one file that is legitimately large: the app itself.
 *
 * A Tauri release binary embeds the whole compiled frontend and statically
 * links the ONNX runtime, so ~27 MB is normal and the general size rule would
 * only ever fire on it. It is exempt from the SIZE rule, not from the
 * extension rule, and it gets a ceiling of its own — a model linked INTO the
 * executable is the one way weights could ship while every other check passes,
 * and the smallest catalogue model is an order of magnitude above this.
 */
const MAIN_EXECUTABLE = /^Contents\/MacOS\/[^/]+$/;
const MAIN_EXECUTABLE_CEILING_BYTES = 120 * 1024 * 1024;

/* ------------------------------------------ what the configuration declares */

const conf = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'the Tauri bundle configuration');

/*
 * `bundle.resources` is not the only way to put files in a Tauri bundle, and
 * checking it alone would have made this gate a check on one spelling of the
 * mistake. Every payload mechanism Tauri 2 offers on macOS is asserted empty.
 *
 * `resources` also accepts a source→target MAP as well as an array; the map
 * form used to reach a `for…of` over an object and throw.
 */
const PAYLOAD_DECLARATIONS = [
  { path: ['bundle', 'resources'], why: 'files copied into Contents/Resources' },
  { path: ['bundle', 'externalBin'], why: 'sidecar executables copied into the bundle' },
  { path: ['bundle', 'macOS', 'files'], why: 'arbitrary files placed inside the .app' },
  { path: ['bundle', 'macOS', 'frameworks'], why: 'frameworks copied into Contents/Frameworks' },
];

/**
 * The only things allowed into the bundle, by DESTINATION name, each with the
 * reason it is there.
 *
 * This list is the ONLY prose about why `bundle.resources` is not empty.
 * `tauri.conf.json` cannot carry it: Tauri's bundle schema rejects unknown
 * keys, so a `_comment` beside the entries fails the build rather than
 * explaining it. (The `assetProtocol.scope` block does carry one, which is why
 * that looks like an option here and is not.)
 *
 * This is the allow-list the message below has always told people to add to.
 * It is deliberately a list of exact names rather than a pattern: the failure
 * this gate exists to catch is one entry added to `bundle.resources`, and a
 * pattern is how "one entry" becomes "a glob that also matched the models
 * directory". Every entry here is text.
 *
 * Anything not on this list is a failure, whether or not it looks like a model
 * — the gate is "the bundle contains what we decided it contains", and model
 * weights are the consequence, not the rule.
 */
const ALLOWED_BUNDLE_RESOURCES = new Map([
  [
    'THIRD_PARTY_NOTICES.md',
    'the licence disclosure, which has to be answerable from the app rather than the repository',
  ],
  [
    'LICENSE-fonts.txt',
    'the SIL OFL, whose text must travel with the font binaries that are in the bundle',
  ],
  [
    'LICENSE.txt',
    "Speaking Glass's own MIT licence, whose notice must travel with every copy of the software",
  ],
]);

/** Bytes a text notice cannot plausibly exceed. A model is not 2 MB of prose. */
const NOTICE_CEILING_BYTES = 2 * 1024 * 1024;

for (const { path, why } of PAYLOAD_DECLARATIONS) {
  const declared = path.reduce((node, key) => (node == null ? node : node[key]), conf);
  if (declared == null) continue;
  const count = Array.isArray(declared) ? declared.length : Object.keys(declared).length;
  if (count === 0) continue;

  /*
   * Only `bundle.resources` may be non-empty, and only in the MAP form.
   * The array form gives Tauri the destination name, which means an entry
   * could land under an allowed name by accident of its source path; the map
   * states both halves, so the allow-list is checked against what actually
   * appears in `Contents/Resources`.
   */
  const isResources = path.join('.') === 'bundle.resources';
  if (isResources && !Array.isArray(declared)) {
    for (const [source, destination] of Object.entries(declared)) {
      if (!ALLOWED_BUNDLE_RESOURCES.has(destination)) {
        problems.push(
          `tauri.conf.json copies ${JSON.stringify(source)} into the bundle as ` +
            `${JSON.stringify(destination)}, which is not allow-listed in this script. ` +
            `A stock build ships zero model bytes (§152) and only the notices it was ` +
            `decided to ship. Add it here with a reason, or take it out of the bundle.`,
        );
        continue;
      }
      /*
       * An allow-listed DESTINATION does not make the SOURCE safe, and this is
       * where the whole allow-list would have leaked.
       *
       * Tauri resolves a map source three ways (tauri-utils `resources.rs`):
       * a plain file copies to the destination; a GLOB copies every match into
       * it; and a DIRECTORY is walked, preserving its structure underneath.
       * So `{"models": "THIRD_PARTY_NOTICES.md"}` puts the entire models tree
       * in the bundle under an allow-listed name — and a size ceiling never
       * fires, because `statSync` on a directory reports the inode, a couple
       * of hundred bytes. Only a single regular file may be allow-listed.
       */
      if (/[*?[\]]/.test(source)) {
        problems.push(
          `tauri.conf.json copies ${JSON.stringify(source)} into the bundle as ${destination}. ` +
            `A glob copies every match under one name — an allow-listed notice is one named file.`,
        );
        continue;
      }
      const from = join(ROOT, 'src-tauri', source);
      if (!existsSync(from)) {
        problems.push(`tauri.conf.json copies ${source} into the bundle, and it does not exist.`);
        continue;
      }
      const stats = statSync(from);
      if (!stats.isFile()) {
        problems.push(
          `tauri.conf.json copies ${JSON.stringify(source)} into the bundle as ${destination}, ` +
            `and it is not a regular file. Tauri WALKS a directory source, so this would copy ` +
            `everything beneath it under an allow-listed name.`,
        );
        continue;
      }
      if (stats.size > NOTICE_CEILING_BYTES) {
        problems.push(
          `${source} is ${stats.size} bytes, copied into the bundle as ${destination}. An ` +
            `allow-listed notice is text; something this large is not the file that was ` +
            `allow-listed.`,
        );
      }
    }
    continue;
  }

  problems.push(
    `tauri.conf.json declares ${path.join('.')} (${why}): ${JSON.stringify(declared)}. ` +
      `Every payload declaration is empty by design — a stock build ships zero model ` +
      `bytes (§152). If something genuinely belongs in the bundle, allow-list it in ` +
      `this script with a reason.`,
  );
}

/* --------------------------------------------- what a built bundle contains */

/**
 * Every file under a directory, INCLUDING hidden ones.
 *
 * `globSync('**‌/*')` was what this used, and glob does not match dot-prefixed
 * entries by default — so a `.app` containing `Contents/Resources/.model.onnx`
 * satisfied the layout check and exited 0 having never looked at the model.
 * A gate whose blind spot is "name the file with a leading dot" is not a gate.
 *
 * Symlinks are recorded but not followed: a link out of the bundle is reported
 * rather than silently walked, because what ships is the link, and where it
 * points is not something this script can vouch for.
 */
function walk(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // An unreadable directory is unexamined payload, not empty payload.
      problems.push(`${inBundle(root, dir) || '.'} could not be listed: ${error.message}`);
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(
          `${inBundle(root, full)} is a symlink — this script cannot vouch for what a ` +
            `shipped link resolves to. Resolve it in the build or allow-list it here.`,
        );
      } else if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  }
  return found;
}

const bundleRoot = process.argv[2];
let inspected = 0;

if (bundleRoot) {
  /*
   * A "bundle" that is not a bundle must FAIL, not pass with nothing found.
   *
   * This script previously accepted any path that existed: pointed at a
   * regular file, or an empty directory, or a path whose glob matched
   * nothing, it printed "OK" having inspected zero files. That is the exact
   * shape of a check that goes green forever after a build step is renamed —
   * and the claim it prints ("the installer contains no model weights") would
   * then be made on the strength of having looked at nothing.
   */
  if (!existsSync(bundleRoot)) {
    console.error(`No such bundle: ${bundleRoot}`);
    process.exit(1);
  }
  if (!statSync(bundleRoot).isDirectory()) {
    console.error(`Not a bundle directory: ${bundleRoot}`);
    process.exit(1);
  }

  const files = walk(bundleRoot);
  inspected = files.length;

  // A macOS application bundle always has these. Requiring them means a path
  // that is a directory but not an app — a stale `target/`, a wrong argument,
  // a build that produced nothing — is reported rather than waved through.
  const REQUIRED_LAYOUT = [
    { label: 'Contents/Info.plist', matches: (rel) => rel === 'Contents/Info.plist' },
    { label: 'Contents/MacOS/<executable>', matches: (rel) => MAIN_EXECUTABLE.test(rel) },
  ];
  const relatives = files.map((file) => inBundle(bundleRoot, file));
  for (const { label, matches } of REQUIRED_LAYOUT) {
    if (!relatives.some(matches)) {
      problems.push(
        `${bundleRoot} does not look like a macOS application bundle: no ${label} — ` +
          `refusing to report "no model weights" about a payload this script cannot see.`,
      );
    }
  }

  for (const file of files) {
    const rel = inBundle(bundleRoot, file);
    const lower = rel.toLowerCase();

    if (WEIGHT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      problems.push(`${rel} is a model weight file and must not be in the bundle`);
      continue;
    }

    let size;
    try {
      size = statSync(file).size;
    } catch (error) {
      // Unreadable is not clean. A payload this script cannot measure is a
      // payload it cannot vouch for.
      problems.push(`${rel} could not be measured: ${error.message}`);
      continue;
    }

    /*
     * The ONNX runtime is not a model, and it belongs in the bundle.
     *
     * Matched on the BASENAME against an exact list. The previous test was
     * `/onnxruntime|sherpa/i` against the whole path, which exempted anything
     * whose path merely mentioned them — including a hypothetical
     * `Contents/Resources/sherpa-model.data` of any size, which is precisely
     * the payload this script exists to catch.
     */
    const runtime = RUNTIME_LIBRARIES.find((library) => library.name === rel.split('/').pop());
    if (runtime) {
      if (size > runtime.ceilingBytes) {
        problems.push(
          `${rel} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${(
            runtime.ceilingBytes /
            1024 /
            1024
          ).toFixed(0)} MB expected for this runtime library — large enough to be carrying weights.`,
        );
      }
      continue;
    }

    if (MAIN_EXECUTABLE.test(rel)) {
      if (size > MAIN_EXECUTABLE_CEILING_BYTES) {
        problems.push(
          `${rel} is ${(size / 1024 / 1024).toFixed(1)} MB. The main executable is expected to ` +
            `be tens of megabytes; this is model-sized, which would mean weights were linked in.`,
        );
      }
      continue;
    }

    if (size > SUSPICIOUS_BYTES) {
      problems.push(
        `${rel} is ${(size / 1024 / 1024).toFixed(1)} MB — too large for anything this ` +
          `installer is supposed to contain. If it is legitimate, name it in this script.`,
      );
    }
  }

  console.log(`Inspected ${files.length} files in ${bundleRoot}.`);
}

if (problems.length > 0) {
  console.error('\nModel-weight check FAILED:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

// The claim is scoped to what was actually examined. Without a bundle path
// this script has read a configuration file and nothing else, and saying "the
// installer contains no model weights" on that basis is the overclaim the
// zero-file pass used to make.
console.log(
  bundleRoot
    ? `Model-weight check OK — ${inspected} files inspected; the bundle declares and contains no model weights.`
    : 'Model-weight check OK — the bundle CONFIGURATION declares no model resources. ' +
        'Pass a built .app to also inspect the payload.',
);
