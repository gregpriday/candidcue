#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md, or refuse.
 *
 * The release workflow used to publish a fixed sentence — "Signed and
 * notarised. Checksums, SBOMs and build provenance are attached." — for every
 * release. True, and useless to anyone deciding whether to install it: the
 * supported macOS versions, the English-only following, the separate model
 * download and the manual-update policy are all things a user needs before
 * they download, and none of them were anywhere near the download.
 *
 * Writing the notes in the repository puts them under the same review as the
 * code they describe. Making the workflow READ them makes an unwritten section
 * a failed release rather than a published one nobody documented.
 *
 * Usage:
 *   node scripts/release-notes.mjs v1.0.0            — print the section
 *   node scripts/release-notes.mjs v1.0.0 --check    — verify only, print nothing
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

function fail(message) {
  console.error(`Release notes FAILED:\n\n  ${message}\n`);
  process.exit(1);
}

const [tag, ...flags] = process.argv.slice(2);
if (!tag) {
  console.error('Usage: node scripts/release-notes.mjs <tag> [--check]');
  process.exit(1);
}
const checkOnly = flags.includes('--check');

let source;
try {
  source = readFileSync(CHANGELOG, 'utf8');
} catch (error) {
  fail(`CHANGELOG.md could not be read — ${error.message}`);
}

/*
 * Split on `## ` headings at the start of a line. Not a regex over the whole
 * file: a `## ` inside a fenced code block would be a heading to a naive
 * pattern, and release notes are exactly the kind of document that quotes
 * shell commands.
 */
const lines = source.split('\n');
const sections = [];
let current = null;
let inFence = false;
for (const line of lines) {
  if (/^\s*```/.test(line)) inFence = !inFence;
  const heading = inFence ? null : line.match(/^## +(\S+)\s*$/);
  if (heading) {
    current = { title: heading[1], body: [] };
    sections.push(current);
  } else if (current) {
    current.body.push(line);
  }
}

/*
 * A release candidate reads the section for the release it is a candidate FOR.
 *
 * `v1.0.0-rc.2` looks for `## v1.0.0-rc.2` and then for `## v1.0.0`. Demanding
 * a section per RC would mean rewriting the same notes for every candidate,
 * and the point of an RC is that it is meant to be the release — the notes it
 * ships under are the ones being proofread. An RC that genuinely needs its own
 * wording can still have its own section; that one wins.
 */
const releaseTag = tag.replace(/-.*$/, '');
const wanted =
  sections.find((section) => section.title === tag) ??
  sections.find((section) => section.title === releaseTag);

if (!wanted) {
  const known = sections.map((section) => section.title);
  fail(
    `CHANGELOG.md has no "## ${tag}" section` +
      (releaseTag === tag ? '' : ` and no "## ${releaseTag}" to fall back to`) +
      `.\n\n` +
      `  It has: ${known.length > 0 ? known.join(', ') : '(no version sections at all)'}\n\n` +
      `  Add the section and commit it before tagging. A release nobody described\n` +
      `  is a download page that cannot say what changed.`,
  );
}

const body = wanted.body.join('\n').trim();

/*
 * Anti-vacuity. An empty section, or a stub someone left to fill in later,
 * satisfies "the section exists" while publishing nothing — which is the
 * failure this gate was written to prevent, arriving through the front door.
 */
if (body.length < 80) {
  fail(`the "## ${tag}" section is empty or too short to be release notes.`);
}
const stub = body.match(/\b(TODO|TBD|FIXME|XXX|coming soon)\b/i);
if (stub) {
  fail(`the "## ${tag}" section still contains "${stub[0]}".`);
}

if (checkOnly) {
  console.log(
    wanted.title === tag
      ? `Release notes OK — "## ${tag}" is present and written.`
      : `Release notes OK — ${tag} is a candidate for ${wanted.title} and reads its "## ${wanted.title}" section.`,
  );
} else {
  process.stdout.write(`${body}\n`);
}
