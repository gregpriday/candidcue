/**
 * Architectural boundaries, enforced rather than documented.
 *
 * `vad.ts` states a rule in prose: the two VADs in this codebase must never
 * both be asked whether the presenter is speaking. `LocalVad`
 * (control/services/audio) owns transport endpointing and the level meter;
 * `SpeechClock` (shared/coaching/audio) owns every coaching-visible timing
 * claim. A comment cannot stop the next person from wiring a `VadEvent` into a
 * pace analyzer, so the rule is checked here instead.
 *
 * These tests read source text. That is unusual, and it is the point: the
 * failure they guard against is an *import*, which no behavioural test can see.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const COACHING_DIR = join(ROOT, 'src/shared/coaching');
const TRANSPORT_DIRS = [
  join(ROOT, 'src/control/services/realtime'),
  join(ROOT, 'src/control/services/audio'),
];

function typeScriptFiles(directory: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // A missing directory is not "no offenders" — it is a scan that never ran.
    // Swallowing it silently is how a rename turns every rule below into a
    // vacuous pass over zero files, which is a guard that reports success
    // precisely when it has stopped working.
    throw new Error(
      `boundaries.test.ts cannot scan ${directory}. If the directory moved, ` +
        'update the constant; do not let the scan pass over nothing.',
    );
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...typeScriptFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The guard on the guard.
 *
 * Every rule below is of the form "collect offenders, expect none", which is
 * satisfied just as well by scanning zero files as by scanning a clean
 * codebase. These assertions make the difference visible: they fail if a
 * directory constant goes stale, before the rules quietly stop being enforced.
 */
describe('the boundary scan is actually scanning something', () => {
  it('finds a substantial number of coaching modules', () => {
    const files = typeScriptFiles(COACHING_DIR);
    expect(files.length).toBeGreaterThan(30);
    // …and specifically the audio lane, which is what most of the rules are
    // about. A subdirectory rename would keep the count up and still skip it.
    expect(files.some((file) => file.includes('/coaching/audio/vad.ts'))).toBe(true);
    expect(files.some((file) => file.includes('/coaching/coach/tip-policy.ts'))).toBe(true);
  });

  it('finds files in every transport directory it claims to check', () => {
    for (const directory of TRANSPORT_DIRS) {
      expect(typeScriptFiles(directory).length, directory).toBeGreaterThan(0);
    }
  });

  it('throws rather than returning empty for a directory that is not there', () => {
    expect(() => typeScriptFiles(join(ROOT, 'src/shared/coaching/does-not-exist'))).toThrow(
      /cannot scan/,
    );
  });
});

/** Strip comments so prose describing a rule is not mistaken for breaking it. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the two VADs stay separated (§12.5)', () => {
  it('no coaching module imports the transport VAD or its events', () => {
    const offenders: string[] = [];
    for (const file of typeScriptFiles(COACHING_DIR)) {
      const code = codeOf(file);
      if (/services\/audio\/vad|\bLocalVad\b|\bVadEvent\b/.test(code)) {
        offenders.push(file.replace(`${ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no transport module consumes SpeechInterval or the coaching audio package', () => {
    const offenders: string[] = [];
    for (const directory of TRANSPORT_DIRS) {
      for (const file of typeScriptFiles(directory)) {
        const code = codeOf(file);
        if (/\bSpeechInterval\b|coaching\/audio/.test(code)) {
          offenders.push(file.replace(`${ROOT}/`, ''));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('§5.3 one capture, multiple consumers', () => {
  it('no coaching module can open a microphone', () => {
    const offenders: string[] = [];
    for (const file of typeScriptFiles(COACHING_DIR)) {
      const code = codeOf(file);
      if (/getUserMedia|navigator\.mediaDevices|requestMicrophoneAccess/.test(code)) {
        offenders.push(file.replace(`${ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('§12.3 nothing in the analysis path can reach the speakers', () => {
  it('no coaching module connects anything to an AudioContext destination', () => {
    const offenders: string[] = [];
    for (const file of typeScriptFiles(COACHING_DIR)) {
      const code = codeOf(file);
      if (/\.destination\b/.test(code)) offenders.push(file.replace(`${ROOT}/`, ''));
    }
    expect(offenders).toEqual([]);
  });
});

describe('§5.2 the shared layer does not depend on a window', () => {
  it('no coaching module imports from src/control or src/stage', () => {
    const offenders: string[] = [];
    for (const file of typeScriptFiles(COACHING_DIR)) {
      const code = codeOf(file);
      if (/from\s+['"][^'"]*(?:\/|^)(?:control|stage)\//.test(code)) {
        offenders.push(file.replace(`${ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
