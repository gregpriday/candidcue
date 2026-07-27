/**
 * The reading-notes panel stays advisory.
 *
 * `lintScriptSource` had no importer at all, which is the persisted-but-never-
 * read defect in its purest form: four rules, a full test suite, and nothing on
 * screen. Wiring it up is only half the job — the other half is that a lint in
 * a teleprompter must never acquire the manners of a linter. These assert the
 * restraint, because that is the part a future change would quietly lose:
 * silence when there is nothing to say, no announcement, no colour that means
 * stop, and a click that goes to the author's own text.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ScriptLintPanel from '../../src/control/components/ScriptLintPanel.svelte';
import type { ScriptLintFinding } from '../../src/control/lib/script-lint';

function finding(over: Partial<ScriptLintFinding> = {}): ScriptLintFinding {
  return {
    code: 'long-paragraph',
    severity: 'info',
    line: 12,
    column: 1,
    length: 340,
    message: 'This paragraph runs to 96 spoken words.',
    hint: 'A blank line at the next natural pause splits it in two.',
    ...over,
  };
}

function panel(findings: ScriptLintFinding[], ongoto = vi.fn()) {
  const { container } = render(ScriptLintPanel, { props: { findings, ongoto } });
  return { container, ongoto };
}

describe('the reading-notes panel', () => {
  it('renders nothing at all when the script is clean', () => {
    // A standing "0 notes" row is an accusation the script is being marked.
    const { container } = panel([]);
    expect(container.querySelector('.lint')).toBeNull();
    expect(container.textContent?.trim()).toBe('');
  });

  it('opens collapsed, carrying only a count', () => {
    const { container } = panel([finding(), finding({ line: 30 })]);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toContain('2 notes');
  });

  it('counts one note in the singular', () => {
    const { container } = panel([finding()]);
    expect(container.querySelector('summary')?.textContent).toContain('1 note on how this reads');
    expect(container.querySelector('summary')?.textContent).not.toContain('1 notes');
  });

  it('never announces itself', () => {
    // Advice arriving 90 ms after a keystroke must not interrupt a screen
    // reader mid-word. Nothing here is live, and nothing here is an alert.
    const { container } = panel([finding({ severity: 'warn' })]);
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows the note, the hint and the line it is about', () => {
    const { container } = panel([finding({ line: 12 })]);
    const row = container.querySelector('.finding');
    expect(row?.textContent).toContain('Long paragraph');
    expect(row?.textContent).toContain('line 12');
    expect(row?.textContent).toContain('This paragraph runs to 96 spoken words.');
    expect(row?.textContent).toContain('A blank line at the next natural pause');
  });

  it('names every rule it can be handed', () => {
    // The label map is total over `ScriptLintCode`, so a new rule cannot ship
    // without a name — this pins that none of the current four render blank.
    const { container } = panel([
      finding({ code: 'long-paragraph' }),
      finding({ code: 'very-long-sentence' }),
      finding({ code: 'all-caps-run' }),
      finding({ code: 'no-terminal-punctuation' }),
    ]);
    const labels = [...container.querySelectorAll('.label')].map((el) => el.textContent?.trim());
    expect(labels).toHaveLength(4);
    for (const label of labels) expect(label).toBeTruthy();
    expect(new Set(labels).size).toBe(4);
  });

  it('raises its voice with contrast, not with a colour that means stop', () => {
    const { container } = panel([finding({ severity: 'info' }), finding({ severity: 'warn' })]);
    const labels = [...container.querySelectorAll('.label')];
    expect(labels[0]?.classList.contains('firm')).toBe(false);
    expect(labels[1]?.classList.contains('firm')).toBe(true);
    /*
     * And that step of contrast is ALL severity is allowed to buy. Asserting
     * the absence of a `.danger`/`.pill` class would have been a line that
     * cannot fail — those names appear nowhere in this component whatever it
     * renders. Comparing the two rows against each other is the assertion with
     * something to lose: no added word, no badge, no extra element on the
     * severe one. A script that reads long is not a script that is broken.
     */
    const rows = [...container.querySelectorAll('.finding')];
    expect(rows[1]?.textContent).toBe(rows[0]?.textContent);
    expect(rows[1]?.querySelectorAll('*').length).toBe(rows[0]?.querySelectorAll('*').length);
    expect(rows[1]?.className).toBe(rows[0]?.className);
  });

  it('hands back the row that was clicked, whole', () => {
    // Every row is asserted, not just the first: a panel that always handed
    // back `findings[0]` passed a single-row check, and "the note I clicked
    // took me to a different note's paragraph" is the failure this row exists
    // to prevent. The findings are compared whole because the caller needs
    // `column` and `length` as well as `line` — it scrolls the flagged run into
    // view, not just the line the run starts on.
    const first = finding({ line: 12, column: 5, length: 340 });
    const second = finding({ code: 'very-long-sentence', line: 40, column: 9, length: 210 });
    const { container, ongoto } = panel([first, second]);
    const rows = container.querySelectorAll<HTMLButtonElement>('.finding');
    expect(rows).toHaveLength(2);
    rows[0]?.click();
    rows[1]?.click();
    expect(ongoto.mock.calls.map((call) => call[0])).toEqual([first, second]);
  });

  it('survives two rules landing on the same line', () => {
    // Keyed `{#each}` would throw on a duplicate key, in the middle of somebody
    // typing. A long paragraph whose last sentence is also long does exactly
    // this, and a crash in the editor is not an acceptable price for advice.
    const { container } = panel([
      finding({ code: 'long-paragraph', line: 12, column: 1 }),
      finding({ code: 'very-long-sentence', line: 12, column: 1 }),
    ]);
    expect(container.querySelectorAll('.finding')).toHaveLength(2);
  });
});
