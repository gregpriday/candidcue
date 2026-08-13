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

/*
 * The tag shape is checked HERE as well as by `version.mjs tag`.
 *
 * The workflow runs them in that order, so relying on it would be safe today
 * and only today — and the prerelease fallback below splits on the first
 * hyphen, which is correct for semver and nonsense for anything else:
 * `v-company-1.0.0` would fall back to looking for a section called `v`. A
 * gate that depends on another gate having run first is one workflow edit away
 * from not being a gate.
 */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
if (!tag.startsWith('v') || !SEMVER.test(tag.slice(1))) {
  fail(`"${tag}" is not a release tag. A release tag is \`v\` followed by a semver version.`);
}

let source;
try {
  source = readFileSync(CHANGELOG, 'utf8');
} catch (error) {
  fail(`CHANGELOG.md could not be read — ${error.message}`);
}

/*
 * Split on `## ` headings at the start of a line.
 *
 * Not a regex over the whole file. Release notes are exactly the kind of
 * document that quotes shell commands and HTML, and both can contain a line
 * that looks like a heading:
 *
 *   - inside a fenced code block. Fences are ``` or ~~~, at least three
 *     characters, and a fence closes only on the SAME character at at least
 *     the opening length — so a ``` inside a ~~~~ block does not end it. A
 *     naive `startsWith('```')` toggle got both of those wrong, and getting
 *     them wrong in the accepting direction publishes a code sample as
 *     release notes.
 *   - inside an HTML comment, which is how a draft section gets parked.
 *
 * A heading with trailing text (`## v1.0.0 — First release`) is a real heading
 * and takes the first token as its title. Ignoring it, as the first version
 * did, was worse than not finding it: it did not TERMINATE the section above
 * either, so one version's notes silently absorbed the next one's.
 */
const lines = source.split('\n');
const sections = [];
let current = null;
let fence = null; // { char, length } while inside a fenced block
let inComment = false;

for (const line of lines) {
  if (inComment) {
    if (line.includes('-->')) inComment = false;
    if (current) current.body.push(line);
    continue;
  }

  if (fence) {
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
    if (current) current.body.push(line);
    continue;
  }

  // An indented four spaces or more is a code block, not a fence.
  const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (open) {
    fence = { char: open[1][0], length: open[1].length };
    if (current) current.body.push(line);
    continue;
  }

  if (/<!--/.test(line) && !/-->/.test(line)) {
    inComment = true;
    if (current) current.body.push(line);
    continue;
  }

  const heading = line.match(/^## +(\S+)/);
  if (heading) {
    current = { title: heading[1], body: [] };
    sections.push(current);
  } else if (current) {
    current.body.push(line);
  }
}

const duplicate = sections.find(
  (section, index) => sections.findIndex((other) => other.title === section.title) !== index,
);
if (duplicate) {
  fail(
    `CHANGELOG.md has more than one "## ${duplicate.title}" section. Which one a release ` +
      `publishes would be an accident of ordering.`,
  );
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
 *
 * Measured on the PROSE, not the raw text. A section that is one long HTML
 * comment, or nothing but a code fence, clears a raw character count while
 * rendering as an empty release page — so comments, fenced blocks and Markdown
 * punctuation come out before the length is taken.
 */
const prose = body
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1.*$/gm, '')
  .replace(/^[#>\s*_-]+$/gm, '')
  .trim();
if (prose.length < 120) {
  fail(
    `the "## ${wanted.title}" section renders as ${prose.length} characters of prose — ` +
      `that is not release notes.`,
  );
}

/*
 * A tripwire, and honest about being one. A determined stub can be written in
 * words this does not list; what it catches is the ordinary case — a section
 * copied forward with its placeholders still in it.
 */
const stub = prose.match(/\b(TODO|T\.?B\.?D\.?|FIXME|XXX|coming soon|placeholder|draft)\b/i);
if (stub) {
  fail(`the "## ${wanted.title}" section still contains "${stub[0]}".`);
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
