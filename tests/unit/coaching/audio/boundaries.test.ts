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
    return out;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...typeScriptFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

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
