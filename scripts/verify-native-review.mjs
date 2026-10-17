#!/usr/bin/env node
/**
 * A release must not ship a native library whose licence nobody has confirmed.
 *
 * `sherpa-onnx-sys` links a prebuilt archive that is not one project: it
 * carries ONNX Runtime, kaldi, KISS FFT, sentencepiece, PortAudio,
 * piper-phonemize and eSpeak NG, on at least four licences, and the archive
 * ships no licence metadata of its own. One of them — eSpeak NG — is copyleft,
 * which is a question about what CandidCue legally IS rather than a notices
 * chore. `sbom/native-components.json` records each with a `reviewed` flag,
 * and this refuses while any of them is not `true`.
 *
 * It is a step of `release-verify.mjs` that only a full run reaches, and CI
 * never names it: confirming a licence is a fact only a person can settle, on
 * a schedule that should not redden every push. A tagged release runs the full
 * plan, so it cannot get past this. `notices:check` stays a staleness check
 * and stays green — the daggers it renders on unreviewed rows are disclosure,
 * not enforcement.
 *
 * It also refuses to pass vacuously. "No unreviewed component found" is just
 * as true of an inventory that could not be read, does not parse, or lists
 * nothing, so each of those is a failure with a reason.
 *
 * And a flag is not a review. `reviewed: true` counts only beside a `source`
 * naming the repository and the tag or commit that was read, because a
 * licence is a fact about one revision of one repository — the eight this
 * gate first refused were recorded from project front pages, and three of
 * those pages were not even the code the archive was built from.
 *
 * Usage:
 *   node scripts/verify-native-review.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'sbom/native-components.json';

const failures = [];

/**
 * The provenance fields a review cannot do without, named when unusable. A
 * missing, null or array `source` names both: there is nothing to read them from.
 * generate-notices.mjs keeps its own copy of this check, because each script
 * runs alone in the gates' scratch-tree tests.
 */
function provenanceProblems(provenance) {
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['source.repository', 'source.revision'];
  }
  const problems = [];
  let url = null;
  try {
    url = new URL(provenance.repository);
  } catch {
    // Not a URL at all; reported below with the rest.
  }
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    problems.push('source.repository');
  }
  if (typeof provenance.revision !== 'string' || provenance.revision.trim() === '') {
    problems.push('source.revision');
  }
  return problems;
}

let source = null;
try {
  source = readFileSync(join(repoRoot, INVENTORY), 'utf8');
} catch (error) {
  failures.push(
    `${INVENTORY}: could not be read (${error.code ?? error.message}) — the native licence ` +
      `review cannot run.`,
  );
}

let parsed;
if (source !== null) {
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    failures.push(`${INVENTORY}: is not valid JSON — ${error.message}`);
  }
}

let reviewedCount = 0;
let componentCount = 0;
if (failures.length === 0) {
  // `JSON.parse('null')` succeeds, and the gate this replaced reported nothing
  // for it — an inventory of `null` passed in silence.
  const components =
    parsed !== null && typeof parsed === 'object' ? parsed.components : undefined;
  if (!Array.isArray(components) || components.length === 0) {
    failures.push(`${INVENTORY}: declares no components — the review would check nothing.`);
  } else {
    componentCount = components.length;
    for (const [index, component] of components.entries()) {
      if (component === null || typeof component !== 'object' || Array.isArray(component)) {
        failures.push(`${INVENTORY}: components[${index}] is not an object.`);
        continue;
      }
      const name = component.component ?? `components[${index}]`;
      const spdx = component.spdx ?? 'no SPDX id';
      if (component.reviewed === true) {
        const missing = provenanceProblems(component.source);
        if (missing.length === 0) {
          reviewedCount += 1;
        } else {
          failures.push(
            `${INVENTORY}: ${name} (${spdx}) is marked reviewed but has no usable ` +
              `${missing.join(' or ')} — a review has to say which source it read. Record ` +
              `the repository and the tag or commit the build pinned.`,
          );
        }
        continue;
      }
      failures.push(
        `${INVENTORY}: ${name} (${spdx}) is not reviewed — its licence is recorded from ` +
          `upstream and not confirmed against the build that ships. Set "reviewed": true ` +
          `once somebody has checked it, with the source they read.`,
      );
    }
  }
}

if (componentCount > 0) {
  console.log(
    `native licence review: ${reviewedCount} of ${componentCount} statically linked native ` +
      `components reviewed`,
  );
}

if (failures.length > 0) {
  console.error('');
  console.error(
    `native licence review FAILED — ${failures.length} problem${failures.length === 1 ? '' : 's'}:`,
  );
  for (const line of failures) console.error(`  ${line}`);
  console.error('');
  console.error('A release cannot ship until every statically linked native component is reviewed.');
  process.exit(1);
}

console.log('native licence review PASSED.');
