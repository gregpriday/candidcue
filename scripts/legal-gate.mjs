#!/usr/bin/env node
// The release gate for legal/PLACEHOLDERS.md.
//
// This is NOT part of `pnpm test`, and it is EXPECTED TO FAIL until the
// placeholders are resolved. It exists so that "no unresolved placeholders" is
// a thing a machine checks before the first paid build ships, rather than a
// procedure someone remembers to run.
//
// It also refuses to pass vacuously. A gate whose success condition is "the
// search found nothing" passes just as quietly when the search is broken, when
// a document has been deleted, or when the register it compares against is
// empty. Each of those is a failure here, with a reason.
//
//   node scripts/legal-gate.mjs      # or: pnpm legal:check

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The four documents that get published. These are also the ones held to the
// no-drafting-marker rule and the minimum-size rule.
const LEGAL_DOCS = [
  'LICENSE',
  'legal/EULA.md',
  'legal/PRIVACY_POLICY.md',
  'legal/REFUND_POLICY.md'
];

// Everything a surviving @@LEGAL_...@@ token must not reach.
const TOKEN_SCANNED = [
  ...LEGAL_DOCS,
  'README.md',
  'package.json',
  'src-tauri/tauri.conf.json',
  '.github/SECURITY.md'
];

// The register that names every token. Excluded from the token scan on
// purpose: naming them is its job.
const REGISTER = 'legal/PLACEHOLDERS.md';

// A published document is never this short. The number is a floor against
// emptied or truncated files, not a quality bar.
const MIN_DOC_BYTES = 500;

const TOKEN_RE = /@@LEGAL_[A-Z0-9_]+@@/g;
const DRAFTING_RE = /\b(TODO|TBD|FIXME|example\.com)\b/i;
const DECLARED_RE = /`(LEGAL_[A-Z0-9_]+)`/g;

const failures = [];
const checked = [];

function fail(message) {
  failures.push(message);
}

const unreadable = new Set();

function readOrNull(relPath) {
  try {
    return readFileSync(join(repoRoot, relPath), 'utf8');
  } catch (error) {
    // Report each unreadable file once, however many scans want to read it.
    if (!unreadable.has(relPath)) {
      unreadable.add(relPath);
      fail(
        `${relPath}: listed in the gate's file set but cannot be read ` +
          `(${error.code ?? error.message}) — the scans below prove nothing about it.`
      );
    }
    return null;
  }
}

function sizeOrNull(relPath) {
  try {
    return statSync(join(repoRoot, relPath)).size;
  } catch {
    return null;
  }
}

// --- anti-vacuity: the documents must actually be there, and be documents ---

for (const doc of LEGAL_DOCS) {
  const bytes = sizeOrNull(doc);
  if (bytes === null) {
    fail(`${doc}: missing. A deleted document passes every search below in silence.`);
    continue;
  }
  if (bytes < MIN_DOC_BYTES) {
    fail(`${doc}: only ${bytes} bytes (minimum ${MIN_DOC_BYTES}). An emptied document passes every search below in silence.`);
    continue;
  }
  checked.push(`${doc} (${bytes} bytes)`);
}

// --- anti-vacuity: the register must still yield tokens ---

const registerText = readOrNull(REGISTER);
let declaredCount = 0;
if (registerText !== null) {
  const declared = new Set();
  for (const match of registerText.matchAll(DECLARED_RE)) declared.add(match[1]);
  declaredCount = declared.size;
  if (declaredCount === 0) {
    fail(
      `${REGISTER}: declares no LEGAL_* tokens. Either the register was emptied or the ` +
        `match pattern has rotted — in both cases the scans below prove nothing.`
    );
  } else {
    checked.push(`${REGISTER} (${declaredCount} tokens declared)`);
  }
}

// --- the gate proper: no surviving placeholder tokens ---

let tokenHits = 0;
for (const relPath of TOKEN_SCANNED) {
  const text = readOrNull(relPath);
  if (text === null) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const matches = lines[i].match(TOKEN_RE);
    if (!matches) continue;
    tokenHits += matches.length;
    fail(`${relPath}:${i + 1}: unresolved placeholder ${[...new Set(matches)].join(', ')}`);
  }
}

// --- the gate proper: no drafting markers left in the published documents ---

for (const doc of LEGAL_DOCS) {
  const text = readOrNull(doc);
  if (text === null) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(DRAFTING_RE);
    if (!match) continue;
    fail(`${doc}:${i + 1}: drafting marker "${match[0]}" left in a published document`);
  }
}

// --- report ---

console.log('legal gate — checked:');
for (const line of checked) console.log(`  ok   ${line}`);
console.log(`  scanned ${TOKEN_SCANNED.length} files for @@LEGAL_*@@ tokens`);
console.log(`  scanned ${LEGAL_DOCS.length} published documents for TODO/TBD/FIXME/example.com`);

/*
 * The native components, whose licences nobody has confirmed yet.
 *
 * `sherpa-onnx-sys` links a prebuilt archive that is not one project: it
 * carries ONNX Runtime, kaldi, KISS FFT, sentencepiece, PortAudio,
 * piper-phonemize and eSpeak NG, on at least four licences, and the archive
 * ships no licence metadata of its own. One of them — eSpeak NG — is copyleft,
 * which is a question about what CandidCue legally IS rather than a notices
 * chore. `sbom/native-components.json` records each with a `reviewed` flag.
 *
 * It belongs in THIS gate rather than in `notices:check` because it is the
 * same shape as an unresolved placeholder: a fact only a person can settle, on
 * a schedule that should not redden every push. `notices:check` stays a
 * staleness check and stays green.
 */
const NATIVE_COMPONENTS = 'sbom/native-components.json';
const nativeSource = readOrNull(NATIVE_COMPONENTS);
if (nativeSource === null) {
  failures.push(`${NATIVE_COMPONENTS}: could not be read — the native licence review cannot run.`);
} else {
  let parsed = null;
  try {
    parsed = JSON.parse(nativeSource);
  } catch (error) {
    failures.push(`${NATIVE_COMPONENTS}: is not valid JSON — ${error.message}`);
  }
  const components = parsed?.components;
  if (!Array.isArray(components) || components.length === 0) {
    if (parsed !== null) {
      failures.push(`${NATIVE_COMPONENTS}: declares no components — the review scanned nothing.`);
    }
  } else {
    const unreviewed = components.filter((component) => component.reviewed !== true);
    for (const component of unreviewed) {
      failures.push(
        `${NATIVE_COMPONENTS}: ${component.component} (${component.spdx}) is an unresolved ` +
          `placeholder — its licence is recorded from upstream and not confirmed against the ` +
          `build that ships. Set "reviewed": true once somebody has checked it.`,
      );
    }
    console.log(
      `  reviewed ${components.length - unreviewed.length} of ${components.length} statically ` +
        `linked native components`,
    );
  }
}

// Two different kinds of failure, with two different exit codes.
//
// `release-verify.mjs --allow-legal-failure` lets a DEVELOPMENT build past the
// expected pre-release state: the scan ran, everything it needed was readable,
// and the only thing wrong is that the business has not supplied the values
// yet. That is exit 2.
//
// Everything else — a missing document, an emptied one, a drafting marker, an
// unreadable file, an empty register — is exit 1 and is NOT suppressible. Those
// mean the gate itself is broken or a published document has been damaged, and
// suppressing them would let a build ship on the strength of a check that never
// really ran. Before this split, one flag hid both.
const PLACEHOLDER_FAILURE = 2;
const BROKEN_GATE = 1;

if (failures.length > 0) {
  const placeholderFailures = failures.filter((line) => line.includes('unresolved placeholder'));
  const onlyPlaceholders = placeholderFailures.length === failures.length && tokenHits > 0;

  console.error('');
  console.error(`legal gate FAILED — ${failures.length} problem${failures.length === 1 ? '' : 's'}:`);
  for (const line of failures) console.error(`  ${line}`);
  console.error('');
  if (tokenHits > 0) {
    console.error(
      `${tokenHits} placeholder token${tokenHits === 1 ? '' : 's'} still unresolved. ` +
        `This is expected before release — see ${REGISTER} for what each one needs.`
    );
  }
  if (!onlyPlaceholders) {
    console.error(
      'At least one failure is NOT an unresolved placeholder, so this is a broken gate or a ' +
        'damaged document rather than the expected pre-release state. It cannot be suppressed.'
    );
  }
  console.error('CandidCue must not ship a paid build until this exits 0.');
  process.exit(onlyPlaceholders ? PLACEHOLDER_FAILURE : BROKEN_GATE);
}

console.log('');
console.log('legal gate PASSED — no unresolved placeholders, no drafting markers.');
