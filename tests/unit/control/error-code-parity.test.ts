/**
 * Every error code that crosses the IPC boundary has authored copy — and every
 * piece of authored copy names a code that can actually occur.
 *
 * The 1.0 readiness review found the two sides drifted in BOTH directions, and
 * both are user-visible failures:
 *
 *  - Rust minted `DATABASE_CORRUPT`, `STT_MODEL_INSUFFICIENT_SPACE`,
 *    `STT_LANGUAGE_CHANGE_BLOCKED` and a dozen more that appeared nowhere in
 *    `APP_ERROR_CODES`. The frontend had no entry for them, so the presenter
 *    got a generic fallback on precisely the failures that most need
 *    explaining — "a language could not be installed" instead of "there is not
 *    enough free space, and nothing was downloaded".
 *
 *  - The copy registry still carried `REALTIME_CONNECT_FAILED`,
 *    `REALTIME_PROVIDER_ERROR` and `REALTIME_CONFIG_REJECTED`, which told a
 *    presenter to check their firewall or VPN about a hosted transcription
 *    service that no longer exists. Transcription is on-device. Copy for an
 *    impossible failure is worse than no copy: it sends someone to look at
 *    their network for a problem in their microphone.
 *
 * This reads the RUST SOURCES rather than a hand-kept list, so a code minted in
 * a new `AppError::structured` call fails here on the commit that adds it.
 */
import { readFileSync, globSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_ERROR_CODES } from '../../../src/shared/contracts/errors';

const ROOT = resolve(__dirname, '../../..');

/**
 * What this test CANNOT see, stated rather than left as an assumption.
 *
 * The matcher below reads string literals. A code assembled from a constant or
 * returned by a helper is invisible to it — `net.rs` builds its URL-refusal
 * codes from `HopLabels` fields, for instance. Those are declared and covered
 * today, and nothing checks that they stay so.
 *
 * Widening the matcher to "any SCREAMING_SNAKE literal in Rust" was tried and
 * is worse: it sweeps in event names (`STAGE_MOTION_REPORT`), header names and
 * enum labels, and the allow-list needed to suppress them becomes the thing
 * that rots. A narrow matcher with a stated blind spot beats a broad one whose
 * exceptions nobody maintains.
 *
 * If a code ever needs to be built rather than written, add it to
 * `APP_ERROR_CODES` and give it copy in the same commit — the two tests below
 * that compare the registries against each other will keep it honest from
 * there.
 */

/** Every stable code Rust can put on the wire. */
function rustCodes(): Set<string> {
  const found = new Set<string>();
  for (const rel of globSync('src-tauri/src/**/*.rs', { cwd: ROOT })) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    /*
     * `AppError::structured("CODE", …)` is the one constructor that mints a
     * stable code, plus the `code()` match arms in errors.rs that map the
     * enum variants. Both are matched on the literal, because a code that
     * reaches the frontend is always a literal somewhere.
     */
    /*
     * Both spellings of the constructor. A verification pass found the narrow
     * `AppError::structured(` version evadable by `Self::structured(` — which
     * the constructors inside `errors.rs` already use, so the evasion was not
     * hypothetical.
     */
    for (const match of source.matchAll(
      /(?:AppError|Self)::structured\(\s*"([A-Z][A-Z0-9_]*)"/g,
    )) {
      found.add(match[1]!);
    }

    /*
     * And every literal inside `code()`, which is the other place a code is
     * minted. Taken from the whole FUNCTION BODY rather than from `=> "…"`
     * arms: the two NETWORK codes are returned from inside an `if`, so an
     * arm-shaped matcher missed them, and any future arm written that way
     * would be missed too.
     */
    if (rel.endsWith('errors.rs')) {
      const start = source.indexOf('pub fn code(&self)');
      if (start !== -1) {
        // To the next `pub fn`, so this reads one function and not the file.
        const after = source.indexOf('\n    pub fn ', start + 1);
        const body = source.slice(start, after === -1 ? undefined : after);
        for (const match of body.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) {
          found.add(match[1]!);
        }
      }
    }
  }
  return found;
}

/** The keys of `ERROR_COPY`, read from source so the map stays private. */
function authoredCopy(): Set<string> {
  const source = readFileSync(join(ROOT, 'src/control/services/errors.ts'), 'utf8');
  const start = source.indexOf('const ERROR_COPY');
  const body = source.slice(start, source.indexOf('\n};', start));
  return new Set([...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!));
}

describe('the error registry and the code that raises errors agree', () => {
  it('finds a plausible number of codes in Rust — this test is not vacuous', () => {
    /*
     * Anti-vacuity first, and it earns its place: every assertion below is a
     * set difference, and a regex that stopped matching would make all of them
     * pass by comparing nothing against nothing.
     */
    expect(rustCodes().size).toBeGreaterThan(20);
    expect(authoredCopy().size).toBeGreaterThan(20);
    expect(APP_ERROR_CODES.length).toBeGreaterThan(20);
  });

  it('declares every code Rust can mint', () => {
    const declared = new Set<string>(APP_ERROR_CODES);
    const undeclared = [...rustCodes()].filter((code) => !declared.has(code)).sort();
    expect(
      undeclared,
      'these codes cross the boundary but are not in APP_ERROR_CODES, so the frontend ' +
        'cannot recognise them',
    ).toEqual([]);
  });

  it('has authored copy for every declared code', () => {
    const copy = authoredCopy();
    const uncovered = APP_ERROR_CODES.filter((code) => !copy.has(code)).sort();
    expect(
      uncovered,
      'these codes have no authored copy, so the user gets the generic fallback on ' +
        'exactly the failures that most need explaining',
    ).toEqual([]);
  });

  it('carries no copy for a code that cannot occur', () => {
    /*
     * The other direction, and the one that let "check whether a firewall or
     * VPN is blocking it" survive the removal of the hosted recogniser. Copy
     * for an impossible failure sends someone to look in the wrong place.
     */
    const declared = new Set<string>(APP_ERROR_CODES);
    const orphaned = [...authoredCopy()].filter((code) => !declared.has(code)).sort();
    expect(orphaned, 'these have copy but are not codes anything can raise').toEqual([]);
  });

  it('describes no hosted transcription service', () => {
    /*
     * Structural rather than a list. Transcription runs on this machine: there
     * is no connection to open, no provider to be down and no account to
     * check. Copy that says otherwise is not merely stale — it is a diagnosis
     * pointing away from the actual fault.
     */
    const source = readFileSync(join(ROOT, 'src/control/services/errors.ts'), 'utf8');
    const copyOnly = source.slice(
      source.indexOf('const ERROR_COPY'),
      source.indexOf('\n};', source.indexOf('const ERROR_COPY')),
    );
    // Comments explain what was removed and why; the strings are the claims.
    const strings = [...copyOnly.matchAll(/'([^']{20,})'/g)].map((m) => m[1]!).join(' ');

    expect(strings, 'no API key: the app holds no secrets').not.toMatch(/API key/i);
    expect(strings, 'no account to check').not.toMatch(/\baccount\b/i);
    expect(strings, 'no quota to exceed').not.toMatch(/\bquota\b/i);
    expect(strings, 'no transcription connection to open').not.toMatch(
      /transcription connection/i,
    );
    expect(strings, 'no provider to report anything').not.toMatch(/\bprovider\b/i);
  });
});
