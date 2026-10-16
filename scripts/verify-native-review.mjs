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
 * Usage:
 *   node scripts/verify-native-review.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'sbom/native-components.json';

const failures = [];

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
      if (component.reviewed === true) {
        reviewedCount += 1;
        continue;
      }
      const name = component.component ?? `components[${index}]`;
      const spdx = component.spdx ?? 'no SPDX id';
      failures.push(
        `${INVENTORY}: ${name} (${spdx}) is not reviewed — its licence is recorded from ` +
          `upstream and not confirmed against the build that ships. Set "reviewed": true ` +
          `once somebody has checked it.`,
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
