/**
 * One vocabulary for a take (CCUX-001, CCUX-002), enforced at the source.
 *
 * The promises, and only these:
 *
 *  - presenter controls show movement STATE, and the engine's decision codes
 *    stay in Follow diagnostics, where a decision can be read beside its
 *    scores and timings (`follow-language.ts` owns that boundary);
 *  - every concept on each of the three axes has a name, in one module, and
 *    the places that show the session mode take it from there rather than
 *    writing their own.
 *
 * What the names ARE is not under test. This file used to keep a list of
 * retired button labels and the glossary's five current terms, so renaming a
 * control meant editing a regex here as well as the label. The glossary module
 * is the one place a label is written; changing it there is the whole change.
 */
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MICROPHONE_LABELS,
  MOVEMENT_LABELS,
  SESSION_MODE_LABELS,
  TAKE_STATE_LABELS,
} from '../../src/shared/take-vocabulary';

const REPO_ROOT = join(__dirname, '../..');

/**
 * Presenter-facing surfaces.
 *
 * `.ts` as well as `.svelte`, which the first version of this lint missed
 * entirely — the command registry, the shortcuts sheet and the status resolvers
 * are all plain TypeScript, and the stage dock's own "Follow my voice" survived
 * a rename that this rule was supposed to be enforcing.
 *
 * Diagnostics components are deliberately absent: they are where the engine's
 * vocabulary belongs.
 */
const ROUTINE_UI = [
  ...globSync('src/control/**/*.{svelte,ts}', { cwd: REPO_ROOT }),
  ...globSync('src/stage/**/*.{svelte,ts}', { cwd: REPO_ROOT }),
  ...globSync('src/shared/**/*.ts', { cwd: REPO_ROOT }),
].filter(
  (rel) =>
    !rel.includes('.test.') &&
    !/FollowDiagnostics\.svelte$/.test(rel) &&
    // The diagnostics copy module owns the decision table by contract.
    !/follow-language\.ts$/.test(rel),
);

/**
 * A file with its comments removed.
 *
 * The rule below is about what gets RENDERED, and the comments around these
 * components explain why the decision table was taken out of them. A lint that
 * failed on its own justification would be switched off within the week, so
 * the prose is stripped before the code is judged.
 */
function codeOf(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('engine reasoning stays in diagnostics', () => {
  it('scans a UI tree that is actually there', () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(ROUTINE_UI.length).toBeGreaterThan(20);
  });

  it('renders no decision-code table outside the diagnostics panel', () => {
    const offenders = ROUTINE_UI.filter((rel) => /FOLLOW_DECISION_LABELS/.test(codeOf(rel)));
    expect(
      offenders,
      'A component outside Follow diagnostics is rendering engine decision codes. ' +
        '"Local match confirmed" and "Possible jump — gathering evidence" describe internal ' +
        'reasoning that is re-tuned freely; the presenter is promised behaviour states. ' +
        'See the contract on FOLLOW_DECISION_LABELS in follow-language.ts.',
    ).toEqual([]);
  });

  /*
   * The diagnostics panel reaches the codes through `describeMovement`, which
   * is where they belong — with the scores and timings that make them mean
   * something. If that stops being true the rule above is guarding nothing.
   */
  it('keeps the codes reachable where they are useful', () => {
    const language = readFileSync(join(REPO_ROOT, 'src/control/lib/follow-language.ts'), 'utf8');
    expect(language).toMatch(/FOLLOW_DECISION_LABELS\[record\.decision\]/);
  });
});

describe('one name per concept', () => {
  it('names every state on every axis, in the glossary', () => {
    /*
     * The maps are typed `Record<Axis, string>`, so the compiler already
     * refuses a missing state. What it cannot refuse is a blank label or two
     * states on one axis sharing a name, which is the "three names for one
     * act" defect turned inside out: one name for two acts.
     */
    for (const [axis, labels] of Object.entries({
      TAKE_STATE_LABELS,
      MOVEMENT_LABELS,
      MICROPHONE_LABELS,
      SESSION_MODE_LABELS,
    })) {
      const values = Object.values(labels as Record<string, string>);
      expect(values.length, `${axis} defines no states`).toBeGreaterThan(1);
      for (const label of values) {
        expect(label.trim(), `${axis} has a blank label`).not.toBe('');
      }
      expect(new Set(values).size, `${axis} gives two states one name`).toBe(values.length);
    }
  });

  it('names the take mode from the glossary wherever it is shown', () => {
    // "Fixed speed" was the summary's word and "Roll at pace" the control's,
    // for the same take.
    for (const rel of ['src/control/components/SessionSummary.svelte', 'src/control/routes/Settings.svelte']) {
      expect(codeOf(rel), `${rel} must label the mode from take-vocabulary`).toMatch(
        /sessionModeLabel|SESSION_MODE_LABELS/,
      );
    }
  });
});
