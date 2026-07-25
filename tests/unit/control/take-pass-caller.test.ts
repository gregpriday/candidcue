/**
 * `beginTakePass` existed, was tested, and had no production caller.
 *
 * That is this project's signature defect, and it is invisible to an ordinary
 * suite: the coaching lane's own tests called the method directly and passed,
 * while in the running app a retake opened a new pass in the take history and
 * the rail carried on counting the discarded one — so the filler tile showed a
 * number belonging to two takes at once.
 *
 * A behavioural test cannot catch this on its own, because the behaviour is
 * correct *when something calls it*. What has to be asserted is that something
 * in production does. These are source assertions for exactly that reason.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const STORE = source('../../../src/control/stores/session.ts');
const CONTROLLER = source('../../../src/control/services/coaching-session.ts');

/** Strip comments, so a mention in prose can never satisfy a call-site check. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the coaching take pass advances with the take history', () => {
  it('is called from the session store, not only from tests', () => {
    expect(
      /\bbeginTakePass\s*\(/.test(code(STORE)),
      'session.ts must call beginTakePass — without a caller a retake leaves the ' +
        'rail counting the take the presenter just discarded',
    ).toBe(true);
  });

  it('advances it on a retake, next to the take-history advance', () => {
    // The two must move together. Asserting only that the call exists would
    // pass if it were wired to session start, where it does nothing.
    const restart = code(STORE).slice(code(STORE).indexOf('function restartParagraph'));
    const body = restart.slice(0, restart.indexOf('\n}'));
    expect(body).toMatch(/beginTake\s*\(/);
    expect(body).toMatch(/beginTakePass\s*\(/);
  });

  it('passes an ordinal rather than a minted id', () => {
    // The three lanes agreed before only because each open-coded the same
    // template literal, which is what let them drift. The store must not spell
    // a take-pass id of its own.
    expect(code(STORE)).not.toMatch(/takePassId:\s*`\$\{sessionId\}/);
    expect(code(STORE)).toMatch(/takePassIdFor\s*\(/);
  });

  it('mints through the shared function on the controller side too', () => {
    expect(code(CONTROLLER)).toMatch(/takePassIdFor\s*\(/);
    expect(code(CONTROLLER)).not.toMatch(/`\$\{[^`]*sessionId[^`]*\}:\$\{/);
  });

  it('guards the guard: the symbols these assertions rely on still exist', () => {
    // If `beginTakePass` is renamed, every assertion above would pass
    // vacuously against a store that no longer advances anything.
    expect(CONTROLLER).toMatch(/\bbeginTakePass\s*\(passOrdinal: number\)/);
    expect(STORE.length).toBeGreaterThan(1000);
    expect(CONTROLLER.length).toBeGreaterThan(1000);
  });
});
