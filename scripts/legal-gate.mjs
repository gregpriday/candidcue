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

if (failures.length > 0) {
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
  console.error('CandidCue must not ship a paid build until this exits 0.');
  process.exit(1);
}

console.log('');
console.log('legal gate PASSED — no unresolved placeholders, no drafting markers.');
