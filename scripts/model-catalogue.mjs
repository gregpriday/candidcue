#!/usr/bin/env node
//
// Read `src-tauri/models/catalogue.json` and project one entry into a form a
// shell script can consume, or render its attribution notice.
//
// This exists so `fetch-stt-model.sh` and the Rust binary read the SAME
// catalogue. Rust gets it with `include_str!` + serde; bash cannot parse JSON
// on its own, and neither `jq` nor `python3` is a declared dependency of this
// repo — but node is, because pnpm and vite already require it.
//
// Output is NUL-delimited and is never shell source: the caller reads it with
// `read -r -d ''`, so a URL or a licence sentence containing quotes, spaces or
// `$` cannot become executable text.
//
//   node scripts/model-catalogue.mjs fields [--model ID | --language LANG]
//   node scripts/model-catalogue.mjs attribution [--model ID | --language LANG]
//   node scripts/model-catalogue.mjs validate
//
// `CANDIDCUE_MODEL_CATALOGUE` overrides the catalogue path (used by tests).
// `CANDIDCUE_MODEL_MIRROR` overrides `mirrorBaseUrl` (used to point a dev box
// at a mirror before the catalogue itself is switched over).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOGUE = resolve(REPO_ROOT, 'src-tauri/models/catalogue.json');
const SCHEMA_VERSION = 1;
const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  process.stderr.write(`model-catalogue: ${message}\n`);
  process.exit(1);
}

/**
 * No control characters, anywhere.
 *
 * This is load-bearing, not hygiene. Every string below is emitted into a
 * NUL-delimited stream that bash splits on NUL. JSON can encode a NUL as
 * `\u0000`, so one embedded in ANY field — a URL, a title, a model name —
 * becomes an extra delimiter, shifting every later field by one. That lets a
 * catalogue choose what bash reads as `FILE_COUNT`, and bash evaluates a value
 * used in arithmetic recursively, so a command substitution smuggled in there
 * would execute. The count check on the bash side is the second line of
 * defence; this is the first.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isCleanString(value) {
  return typeof value === 'string' && value.length > 0 && !CONTROL_CHARS.test(value);
}

/** A name that stays inside the model directory — no traversal, no absolute paths. */
function isSafeName(name) {
  return (
    isCleanString(name) && !name.startsWith('.') && !name.includes('/') && !name.includes('\\')
  );
}

function requireClean(value, where) {
  if (!isCleanString(value)) {
    fail(`${where} must be a non-empty string with no control characters`);
  }
}

/**
 * https, and parseable as a URL.
 *
 * Parsed rather than prefix-matched: `startsWith('https://')` happily accepts a
 * string with a NUL or a newline later in it, and those are exactly what must
 * not reach the NUL-delimited stream. There is no scheme exception for tests —
 * they put a fake `curl` on `PATH` instead, so this reader has no branch that
 * only test runs take.
 */
function requireHttps(url, where) {
  requireClean(url, where);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${where} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    fail(`${where} must be an https:// URL, got ${parsed.protocol}`);
  }
}

function load(cataloguePath) {
  let raw;
  try {
    raw = readFileSync(cataloguePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${cataloguePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${cataloguePath} is not valid JSON: ${error.message}`);
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `catalogue schemaVersion is ${parsed.schemaVersion}, this script understands ${SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    fail('catalogue has no models');
  }

  const seenIds = new Set();
  const seenDirs = new Set();
  for (const model of parsed.models) {
    if (!isSafeName(model.id)) fail(`model id ${JSON.stringify(model.id)} is not a safe name`);
    if (seenIds.has(model.id)) fail(`duplicate model id ${model.id}`);
    seenIds.add(model.id);

    if (!isSafeName(model.installDir)) {
      fail(`${model.id}: installDir ${JSON.stringify(model.installDir)} is not a safe name`);
    }
    if (seenDirs.has(model.installDir)) fail(`duplicate installDir ${model.installDir}`);
    seenDirs.add(model.installDir);

    requireClean(model.modelName, `${model.id}: modelName`);
    if (!Array.isArray(model.languages) || model.languages.length === 0) {
      fail(`${model.id}: languages must be a non-empty array`);
    }
    for (const language of model.languages) {
      requireClean(language, `${model.id}: language`);
    }

    const archive = model.archive;
    if (!archive || typeof archive !== 'object') fail(`${model.id}: missing archive`);
    if (!isSafeName(archive.fileName)) fail(`${model.id}: archive.fileName is not a safe name`);
    if (!isSafeName(archive.rootDir)) fail(`${model.id}: archive.rootDir is not a safe name`);
    if (!SHA256_RE.test(archive.sha256)) {
      fail(`${model.id}: archive.sha256 must be 64 lowercase hex characters`);
    }
    if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) {
      fail(`${model.id}: archive.bytes must be a positive integer`);
    }
    requireHttps(archive.upstreamUrl, `${model.id}: archive.upstreamUrl`);

    if (!Array.isArray(model.files) || model.files.length === 0) {
      fail(`${model.id}: files must be a non-empty array`);
    }
    const seenFiles = new Set();
    for (const file of model.files) {
      if (!isSafeName(file.name)) {
        fail(`${model.id}: file name ${JSON.stringify(file.name)} is not a safe name`);
      }
      if (seenFiles.has(file.name)) fail(`${model.id}: duplicate file ${file.name}`);
      seenFiles.add(file.name);
      if (!SHA256_RE.test(file.sha256)) {
        fail(`${model.id}: ${file.name}: sha256 must be 64 lowercase hex characters`);
      }
      if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
        fail(`${model.id}: ${file.name}: bytes must be a positive integer`);
      }
    }

    const attribution = model.attribution;
    if (!attribution || typeof attribution !== 'object') fail(`${model.id}: missing attribution`);
    for (const field of ['title', 'author']) {
      requireClean(attribution[field], `${model.id}: attribution.${field}`);
    }
    requireHttps(attribution.sourceUrl, `${model.id}: attribution.sourceUrl`);
    if (attribution.distributedVia !== null && attribution.distributedVia !== undefined) {
      requireHttps(attribution.distributedVia, `${model.id}: attribution.distributedVia`);
    }
    const license = attribution.license;
    if (!license || typeof license !== 'object') fail(`${model.id}: missing attribution.license`);
    for (const field of ['id', 'name']) {
      requireClean(license[field], `${model.id}: attribution.license.${field}`);
    }
    requireHttps(license.url, `${model.id}: attribution.license.url`);
    if (typeof attribution.modified !== 'boolean') {
      fail(`${model.id}: attribution.modified must be a boolean`);
    }
    if (attribution.licenseNote !== null && attribution.licenseNote !== undefined) {
      requireClean(attribution.licenseNote, `${model.id}: attribution.licenseNote`);
    }
    // A modification statement is a licence obligation under both Apache-2.0
    // and CC-BY-SA. Saying "modified" without saying what changed is not one.
    if (attribution.modified && !attribution.licenseNote) {
      fail(`${model.id}: attribution.modified is true but licenseNote does not say what changed`);
    }
  }

  if (!seenIds.has(parsed.defaultModelId)) {
    fail(`defaultModelId ${JSON.stringify(parsed.defaultModelId)} names no entry`);
  }

  return parsed;
}

function select(catalogue, { modelId, language }) {
  if (modelId && language) fail('pass --model or --language, not both');
  if (modelId) {
    const found = catalogue.models.find((m) => m.id === modelId);
    if (!found) fail(`no model with id ${modelId}`);
    return found;
  }
  if (language) {
    const matches = catalogue.models.filter((m) => m.languages.includes(language));
    if (matches.length === 0) fail(`no model covers language ${language}`);
    if (matches.length > 1) {
      fail(
        `language ${language} is covered by ${matches.map((m) => m.id).join(', ')} — pass --model`,
      );
    }
    return matches[0];
  }
  return catalogue.models.find((m) => m.id === catalogue.defaultModelId);
}

/**
 * Mirror URL for an entry, or '' when no mirror is configured.
 *
 * Content-addressed: the digest is in the path, so a given URL can only ever
 * name one set of bytes. That is the property the upstream release tag lacks.
 */
function mirrorUrl(catalogue, model) {
  const base = process.env.CANDIDCUE_MODEL_MIRROR || catalogue.mirrorBaseUrl;
  if (!base) return '';
  requireHttps(base, 'mirror base');
  return `${base.replace(/\/+$/, '')}/sha256/${model.archive.sha256}/${model.archive.fileName}`;
}

function emitFields(catalogue, model) {
  const out = [
    model.id,
    model.modelName,
    model.installDir,
    model.archive.fileName,
    model.archive.rootDir,
    model.archive.sha256,
    String(model.archive.bytes),
    mirrorUrl(catalogue, model),
    model.archive.upstreamUrl,
    String(model.files.length),
  ];
  for (const file of model.files) {
    out.push(file.name, file.sha256, String(file.bytes));
  }
  // Last line of defence on the framing. Validation above already rejects
  // control characters field by field; this catches anything a future field
  // forgets to run through `requireClean`, because the cost of one slipping
  // through is bash reading a delimiter where there should be data.
  for (const field of out) {
    if (CONTROL_CHARS.test(field)) {
      fail('refusing to emit a field containing a control character');
    }
  }
  // The mirror URL is legitimately empty when none is configured, so an empty
  // field is expected. Bash checks the total count against this header.
  process.stdout.write(out.join('\0') + '\0');
}

/**
 * The TASL notice — title, author, source, licence — plus the modification
 * statement. Deterministic: same catalogue in, byte-identical file out, which
 * is what lets a test assert the committed copy is not stale.
 */
function renderAttribution(model) {
  const a = model.attribution;
  const lines = [
    '<!-- Generated by scripts/model-catalogue.mjs from src-tauri/models/catalogue.json.',
    '     Edit the catalogue, then re-run `pnpm models:fetch`. Do not edit by hand. -->',
    '',
    '# Bundled speech recognition model',
    '',
    'CandidCue transcribes speech on-device using a model it does not own. This file',
    'travels with the model because redistribution requires the attribution to travel',
    'with it, and the upstream archive ships no licence file of its own.',
    '',
    'It lives inside the model directory deliberately: the model is fetched rather',
    'than committed (`pnpm models:fetch`), so a notice kept anywhere else would',
    'describe an artefact that may not be present, and would not reach a user who has',
    'only the installed app.',
    '',
    '## The model',
    '',
    `**${a.title}**`,
    '',
    `- Model: \`${model.modelName}\``,
    `- Languages: ${model.languages.join(', ')}`,
    `- Authors: ${a.author}`,
    `- Source: <${a.sourceUrl}>`,
  ];
  if (a.distributedVia) {
    lines.push(`- Distributed via: <${a.distributedVia}>, as \`${model.archive.rootDir}\``);
  }
  lines.push(
    `- **Licence: ${a.license.name}** (\`${a.license.id}\`) — <${a.license.url}>`,
    '',
    a.modified
      ? 'CandidCue redistributes these model weights **with modifications**.'
      : 'CandidCue redistributes these model weights **unmodified**.',
  );
  if (a.licenseNote) {
    lines.push('', a.licenseNote);
  }
  lines.push(
    '',
    '## Integrity',
    '',
    'The archive these files came from is pinned in the catalogue by SHA-256, and',
    'the fetch refuses to unpack bytes that do not match:',
    '',
    `- Archive: \`${model.archive.fileName}\``,
    `- SHA-256: \`${model.archive.sha256}\``,
    `- Size: ${model.archive.bytes} bytes`,
    '',
    '## The runtime',
    '',
    'Inference runs through **sherpa-onnx** (<https://github.com/k2-fsa/sherpa-onnx>),',
    'Apache-2.0, linked statically via the `sherpa-onnx` Rust crate, which in turn',
    'embeds **ONNX Runtime** (MIT).',
    '',
    '## Licence text',
    '',
    `The full text of the ${a.license.name} is at <${a.license.url}>.`,
    '',
    'A distributed build must include that text. If CandidCue grows a general',
    'third-party licence screen, this entry belongs in it; until then this file is',
    'the record, and it is bundled with the application.',
    '',
  );
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') options.modelId = argv[++i];
    else if (arg === '--language') options.language = argv[++i];
    else fail(`unknown argument ${arg}`);
  }
  if ('modelId' in options && !options.modelId) fail('--model needs a value');
  if ('language' in options && !options.language) fail('--language needs a value');
  return options;
}

const [command, ...rest] = process.argv.slice(2);
const catalogue = load(process.env.CANDIDCUE_MODEL_CATALOGUE || DEFAULT_CATALOGUE);

switch (command) {
  case 'fields':
    emitFields(catalogue, select(catalogue, parseArgs(rest)));
    break;
  case 'attribution':
    process.stdout.write(renderAttribution(select(catalogue, parseArgs(rest))));
    break;
  case 'validate':
    process.stdout.write(`catalogue ok: ${catalogue.models.length} models\n`);
    break;
  default:
    fail(`usage: model-catalogue.mjs fields|attribution|validate [--model ID | --language LANG]`);
}
