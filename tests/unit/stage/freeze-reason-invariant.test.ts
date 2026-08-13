/**
 * §16.6: the stage has ONE frozen reason, and that is only safe while control
 * never sends the other one.
 *
 * `stageState.ts` records the gap in prose: a stage already frozen by a
 * `freeze` directive keeps that reason when control dies, so the control loss
 * is hidden — the glass stays still and says nothing, which is the exact
 * symptom the disclosure exists to remove. Representing both at once needs two
 * independent flags, because they recover differently: a heartbeat must lift a
 * control loss and must NOT lift a freeze somebody asked for.
 *
 * That change buys nothing today, because the state is unreachable: the only
 * producer of a `freeze` directive in the tree is `src/stage/preview.ts`, a dev
 * tool with no control window to lose. So the decision was to keep one flag and
 * rely on the invariant — and an invariant nothing checks is a comment.
 *
 * This is the check. If control ever gains a `freeze` directive, this test
 * fails and points at the state model that has to be split first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'node:fs';
import {
  initialStageState,
  stageReducer,
  type StageAppState,
} from '../../../src/stage/renderer/stageState';

const REPO_ROOT = join(__dirname, '../../..');

describe('production control emits no freeze directive', () => {
  /*
   * Source-level, and it has to be: what is being asserted is that a certain
   * message is never CONSTRUCTED anywhere in the control window. No runtime
   * test can prove a negative over every path through a route.
   */
  const CONTROL_SOURCES = globSync('src/control/**/*.{ts,svelte}', { cwd: REPO_ROOT }).filter(
    (rel) => !rel.includes('.test.'),
  );

  it('scans a control window that is actually there', () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(CONTROL_SOURCES.length).toBeGreaterThan(20);
  });

  it('constructs no freeze directive anywhere in control', () => {
    const offenders: string[] = [];
    for (const rel of CONTROL_SOURCES) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
      /*
       * The directive is a tagged union, so `kind: 'freeze'` is the only way
       * to build one. Quoting styles vary; comments discussing the directive
       * legitimately mention the word "freeze" and must not trip this, which
       * is why the shape rather than the word is matched.
       */
      if (/kind\s*:\s*['"`]freeze['"`]/.test(source)) offenders.push(rel);
    }
    expect(
      offenders,
      'Control has gained a freeze directive. Before this can ship, split the stage\'s ' +
        'single `frozenReason` into independent flags — a directive freeze and a control ' +
        'loss recover differently, and one field cannot hold both. See stageState.ts.',
    ).toEqual([]);
  });

  /*
   * The other half of the invariant, from the stage's side: this is what
   * actually goes wrong if the rule above is broken. Asserted so the failure
   * above has a demonstrated consequence rather than an argued one.
   */
  it('demonstrates why: a directive freeze swallows a control loss', () => {
    const live: StageAppState = { ...initialStageState(), phase: 'live' };

    const lostAlone = stageReducer(live, { type: 'control_lost' });
    expect(lostAlone.frozen).toBe(true);
    expect(lostAlone.frozenReason, 'on its own, a control loss is disclosed').toBe('control_lost');

    /*
     * No envelope on `live`, so the generation guard passes the directive
     * through — which is what a preview driver's freeze looks like here.
     */
    const frozenByDirective = stageReducer(live, {
      type: 'directive',
      stageGeneration: 0,
      directive: { kind: 'freeze', frozen: true },
    });
    expect(frozenByDirective.frozenReason).toBe('directive');

    const lostWhileFrozen = stageReducer(frozenByDirective, { type: 'control_lost' });
    expect(
      lostWhileFrozen.frozenReason,
      'the control loss is invisible — this is the gap the invariant holds shut',
    ).toBe('directive');
  });
});
