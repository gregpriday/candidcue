/**
 * The privacy promise that rests on call-site discipline, made checkable.
 *
 * `diagnostics/logging.rs` redacts home paths and URL queries on the way into
 * a support bundle, and is honest that it CANNOT tell script text from any
 * other prose — there is no pattern for "a sentence the user wrote". So the
 * defence against a script or a transcript reaching a log is that nobody logs
 * one, and the readiness review's P1-07 asked for exactly this: a narrow rule
 * over the highest-risk call sites rather than a convention people remember.
 *
 * That is what this is. It does not try to be a scrubber. It refuses the one
 * mistake that actually happens — reaching for the variable that holds the
 * user's words while writing a log line about something going wrong with them.
 */
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../..');

/**
 * Bindings whose CONTENTS are the user's own words, or could be.
 *
 * Names, not types, because this reads source rather than compiling it. That
 * makes it a tripwire rather than a proof — which is the honest description of
 * any lint over prose — and it is aimed at the names this codebase actually
 * uses for these things.
 */
const FORBIDDEN_BINDING =
  /\b(script_text|script_body|scriptText|scriptBody|transcript_text|transcriptText|spoken_text|spokenText|utterance|markdown|compiled_text|body_text)\b/;

/**
 * A name that reads like user content but is not.
 *
 * `script_id` is a UUID, `transcript_retained` is a boolean, `markdown_path`
 * is a path the redactor already handles. Listing them keeps the rule narrow
 * enough that nobody is tempted to switch it off.
 */
const ALLOWED = /\b(script_id|scriptId|markdown_path|markdownPath|transcript_retained|transcriptRetained|markdown_error|has_markdown)\b/;

interface Site {
  file: string;
  line: number;
  text: string;
}

/** Every logging call in a set of files, as single lines with their context. */
function loggingSites(files: string[], call: RegExp): Site[] {
  const sites: Site[] = [];
  for (const rel of files) {
    const lines = readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!call.test(line)) return;
      /*
       * A macro invocation can wrap across lines, so the two following lines
       * come along. Cheap, and it catches the multi-line `tracing::warn!(`
       * form that is most of the interesting ones.
       */
      const text = lines.slice(index, index + 3).join(' ');
      sites.push({ file: rel, line: index + 1, text });
    });
  }
  return sites;
}

describe('nothing logs the user’s words', () => {
  const RUST = globSync('src-tauri/src/**/*.rs', { cwd: REPO_ROOT }).concat(
    globSync('crates/*/src/**/*.rs', { cwd: REPO_ROOT }),
  );

  it('scans a tree that is actually there', () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(RUST.length).toBeGreaterThan(30);
  });

  it('logs no binding that holds script or transcript text', () => {
    const sites = loggingSites(RUST, /tracing::(info|warn|error|debug|trace)!/);
    expect(sites.length, 'the scan found no logging at all').toBeGreaterThan(20);

    const offenders = sites.filter((site) => {
      const stripped = site.text.replace(new RegExp(ALLOWED, 'g'), '');
      return FORBIDDEN_BINDING.test(stripped);
    });
    expect(
      offenders.map((site) => `${site.file}:${site.line}`),
      'A log line is reaching for the user\'s own words. Support bundles are exported and ' +
        'sent to a stranger, and the redactor cannot tell a script from any other prose — ' +
        'it only handles paths and URLs. Log an id, a count or a state instead.',
    ).toEqual([]);
  });

  /*
   * The frontend half. Client traces travel in the same bundle, and
   * `diagnostics-format.ts` is where they are shaped.
   */
  it('logs no user text from the control window either', () => {
    const frontend = globSync('src/control/**/*.{ts,svelte}', { cwd: REPO_ROOT })
      .concat(globSync('src/stage/**/*.{ts,svelte}', { cwd: REPO_ROOT }))
      .filter((rel) => !rel.includes('.test.'));
    expect(frontend.length).toBeGreaterThan(20);

    const sites = loggingSites(frontend, /\b(recordTrace|console\.(log|warn|error|info))\b/);
    const offenders = sites.filter((site) => {
      const stripped = site.text.replace(new RegExp(ALLOWED, 'g'), '');
      return FORBIDDEN_BINDING.test(stripped);
    });
    expect(offenders.map((site) => `${site.file}:${site.line}`)).toEqual([]);
  });

  /*
   * And the promise the bundle UI makes about itself. If the exclusion copy
   * stops naming what is excluded, users lose the one statement they can check
   * the archive against.
   */
  it('still tells the user what a support bundle leaves out', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/control/lib/diagnostics-format.ts'), 'utf8');
    for (const excluded of [/script/i, /transcript/i, /audio/i]) {
      expect(source, `the exclusion copy must name ${excluded}`).toMatch(excluded);
    }
  });

  /*
   * And does not promise more than the tests above can support.
   *
   * The rule this file enforces is a tripwire over call sites, not a filter:
   * `redact_log_line` handles paths, URLs and device names and says outright
   * that it cannot recognise prose. "A bundle never includes script text" is
   * therefore a stronger claim than anything here proves, and it was on screen
   * for a year. Absolutes about the DATABASE or a RECORDING are fine — the
   * bundle writer copies diagnostics.json, recovery reports and allow-listed
   * log files, and neither of those is one of them.
   */
  it('claims a design about the user’s words, not a guarantee', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/control/lib/diagnostics-format.ts'), 'utf8');
    const copy = /SUPPORT_BUNDLE_EXCLUSIONS\s*=\s*([\s\S]*?);\n/.exec(source)?.[1] ?? '';
    expect(copy.length, 'SUPPORT_BUNDLE_EXCLUSIONS could not be read').toBeGreaterThan(80);

    expect(
      copy,
      'The exclusion copy promises that a bundle NEVER carries the user\'s own ' +
        'words. Nothing in this file or in diagnostics/logging.rs can establish ' +
        'that — the redactor handles paths and URLs and cannot recognise prose. ' +
        'Say what the bundle is designed to leave out, and tell the reader to ' +
        'look before they send it.',
    ).not.toMatch(/\bnever\b[^.]*\b(script|transcript|prose|words)/i);

    expect(
      copy,
      'The copy no longer tells the user to look at the bundle before sending ' +
        'it. That sentence is what makes the weaker promise honest rather than ' +
        'merely vaguer, and `reveal_support_bundle` exists to serve it.',
    ).toMatch(/\b(reveal|read|review|look)\b/i);
  });
});
