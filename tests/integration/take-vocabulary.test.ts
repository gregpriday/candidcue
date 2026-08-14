/**
 * One vocabulary for a take (CCUX-001, CCUX-002), enforced at the source.
 *
 * ---------------------------------------------------------------------------
 * WHY A LINT AND NOT A CONVENTION
 * ---------------------------------------------------------------------------
 * `follow-language.ts` has carried an explicit contract since it was written:
 * the engine's decision codes are diagnostics vocabulary and must not become
 * user-facing copy. `FollowStatePanel` rendered them in a "Doing" row anyway,
 * during takes, for however long it took somebody to read both files at once.
 * A contract stated in prose beside the thing it governs is not enough, because
 * the violation happens in a different file.
 *
 * The same failure produced three names for one act — "Pause following" in the
 * control panel, "Follow my voice" on the stage dock, "Fixed speed" in the
 * summary — because each was written where it was rendered.
 *
 * So both rules are checked. They are narrow on purpose: broad copy lints get
 * switched off.
 */
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    // The module that DEFINES the vocabulary must name the retired labels in
    // order to say what replaced them.
    !/take-vocabulary\.ts$/.test(rel) &&
    // The diagnostics copy module owns the decision table by contract.
    !/follow-language\.ts$/.test(rel),
);

/**
 * A file with its comments removed.
 *
 * Every rule below is about what gets RENDERED, and every one of these renames
 * is explained in a comment beside the control it renamed. A lint that failed
 * on its own justification would be switched off within the week, so the prose
 * is stripped before the code is judged.
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
  const VOCABULARY = join(REPO_ROOT, 'src/shared/take-vocabulary.ts');

  /**
   * Labels that were retired because they named the same act twice, or named
   * the engine's job rather than the user's.
   *
   * Matched as whole quoted labels, not loose words: "Pause following" is
   * retired, but a comment explaining WHY it was retired must stay legal or the
   * reasoning has nowhere to live. Hence the quote anchors.
   */
  const RETIRED: Array<{ label: string; instead: string }> = [
    { label: 'Pause following', instead: 'Hold text' },
    { label: 'Resume following', instead: 'Follow voice' },
    { label: 'Re-find me here', instead: 'Set my place' },
    { label: 'Nudge back', instead: 'Previous sentence' },
    { label: 'Nudge forward', instead: 'Next sentence' },
    // The two the header cites as the motivating examples, which the first
    // version of this list did not actually contain — so the live StageDock
    // regression it was written about passed.
    { label: 'Follow my voice', instead: 'Follow voice' },
    { label: 'Fixed speed', instead: 'Roll at pace' },
    { label: 'End session', instead: 'End take' },
    { label: 'End Session', instead: 'End Take' },
  ];

  /*
   * WHAT THIS MATCHER CAN AND CANNOT DO.
   *
   * It matches a retired label as an element's whole text (`>Label<`) or as a
   * whole quoted string. That catches the way these labels are actually
   * written, and it is trivially evaded by a template literal, a concatenation
   * or an imported constant. That is accepted rather than papered over: the
   * rule exists to catch the ordinary regression — somebody typing the old
   * words back in — not to defeat somebody working around it. A lexer would
   * catch more and would also be a second parser to maintain.
   */
  it('uses no retired label as rendered copy', () => {
    const offenders: string[] = [];
    for (const rel of ROUTINE_UI) {
      const code = codeOf(rel);
      for (const { label, instead } of RETIRED) {
        if (code.includes(`>${label}<`) || code.includes(`'${label}'`) || code.includes(`"${label}"`)) {
          offenders.push(`${rel}: "${label}" — say "${instead}"`);
        }
      }
    }
    expect(
      offenders,
      'A retired label is being rendered. The vocabulary lives in take-vocabulary.ts so the ' +
        'stage, the control panel and the summary cannot drift into three names for one act.',
    ).toEqual([]);
  });

  it('keeps the glossary itself complete', () => {
    const source = readFileSync(VOCABULARY, 'utf8');
    for (const term of ['Follow voice', 'Hold text', 'Roll at pace', 'Set my place', 'Listening']) {
      expect(source, `the glossary must define ${term}`).toContain(term);
    }
    /*
     * All THREE axes, actually defined.
     *
     * The module's header claims a take/movement/microphone split, and the
     * first version jumped straight to movement — the take axis was described
     * and never written, so the header was documentation of an intention.
     */
    for (const axis of [/TakeState/, /MovementMode/, /MicrophoneState/, /SESSION_MODE_LABELS/]) {
      expect(source).toMatch(axis);
    }
  });

  it('names the take mode from the glossary wherever it is shown', () => {
    // "Fixed speed" was the summary's word and "Roll at pace" the control's,
    // for the same take.
    for (const rel of ['src/control/components/SessionSummary.svelte', 'src/control/routes/Settings.svelte']) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(source, `${rel} must label the mode from take-vocabulary`).toMatch(
        /sessionModeLabel|SESSION_MODE_LABELS/,
      );
    }
  });
});
