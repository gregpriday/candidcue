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
 *
 * They also pin the shape the panel took so that many notes stay readable:
 * one heading per rule with a count, the advice given once per rule rather
 * than on every row, and rows that quote the words they are about. And the
 * way back — Escape from the editor returns to the note that was followed, or
 * to the next one of its kind once the author has fixed it.
 */
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const { container, rerender } = render(ScriptLintPanel, { props: { findings, ongoto } });
  return { container, rerender, ongoto };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

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
    expect(text(container.querySelector('summary'))).toBe('2 reading notes');
  });

  it('counts one note in the singular', () => {
    const { container } = panel([finding()]);
    expect(text(container.querySelector('summary'))).toBe('1 reading note');
  });

  it('never announces itself', () => {
    // Advice arriving 90 ms after a keystroke must not interrupt a screen
    // reader mid-word. Nothing here is live, and nothing here is an alert.
    const { container } = panel([finding({ severity: 'warn' })]);
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('gathers the notes under one heading per rule, in a fixed order, each with a count', () => {
    // Handed in document order, with the sentence first: the headings still
    // come out in the panel's own order, so they never swap places while the
    // author works through them.
    const { container } = panel([
      finding({ code: 'very-long-sentence', line: 3 }),
      finding({ code: 'long-paragraph', line: 12 }),
      finding({ code: 'long-paragraph', line: 30 }),
    ]);
    const rules = [...container.querySelectorAll('.rule')];
    expect(rules.map((rule) => text(rule.querySelector('.rule-name')))).toEqual([
      'Long paragraphs',
      'Long sentence',
    ]);
    expect(rules.map((rule) => text(rule.querySelector('.count')))).toEqual(['2', '1']);
    expect(rules.map((rule) => rule.querySelectorAll('.finding').length)).toEqual([2, 1]);
  });

  it('opens on the inventory: every rule closed, unless there is only one note', () => {
    // A shot list's twenty-five missing full stops must not be pushed below the
    // fold by the one long sentence beside them.
    const many = panel([
      finding({ code: 'very-long-sentence', line: 3 }),
      finding({ code: 'no-terminal-punctuation', line: 5 }),
      finding({ code: 'no-terminal-punctuation', line: 7 }),
    ]);
    const rules = [...many.container.querySelectorAll<HTMLDetailsElement>('details.rule')];
    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.open)).toEqual([false, false]);

    const one = panel([finding()]);
    expect(one.container.querySelector<HTMLDetailsElement>('details.rule')?.open).toBe(true);
  });

  it('quotes the words, the line and the length, and gives the advice once per rule', () => {
    const { container } = panel([
      finding({ line: 12, excerpt: 'Here is the short version. You write…', words: 96 }),
      finding({ line: 30, excerpt: 'The recogniser is a small streaming model…', words: 181 }),
    ]);
    const rows = [...container.querySelectorAll('.finding')];
    expect(rows).toHaveLength(2);
    expect(text(rows[0]?.querySelector('.excerpt'))).toBe('Here is the short version. You write…');
    expect(text(rows[0]?.querySelector('.where'))).toContain('line 12');
    expect(text(rows[0]?.querySelector('.where'))).toContain('96 words');
    expect(text(rows[1]?.querySelector('.excerpt'))).toBe('The recogniser is a small streaming model…');

    // The action belongs to the rule, not to each place it applies to.
    const actions = [...container.querySelectorAll('.action')];
    expect(actions).toHaveLength(1);
    expect(text(actions[0])).toBe('Split it with a blank line at a natural pause.');
    for (const row of rows) expect(row.querySelector('.action')).toBeNull();

    // And the reason is there for whoever asks, folded away.
    const why = container.querySelector<HTMLDetailsElement>('details.why');
    expect(why?.open).toBe(false);
    expect(text(why?.querySelector('summary'))).toBe('Why this helps');
    expect(text(why?.querySelector('.why-text'))).toMatch(/paragraph/i);
  });

  it('names every rule it can be handed', () => {
    // The rule map is total over `ScriptLintCode`, so a new rule cannot ship
    // without a heading — this pins that none of the current four render blank.
    const { container } = panel([
      finding({ code: 'long-paragraph' }),
      finding({ code: 'very-long-sentence' }),
      finding({ code: 'all-caps-run' }),
      finding({ code: 'no-terminal-punctuation' }),
    ]);
    const names = [...container.querySelectorAll('.rule-name')].map((el) => text(el));
    expect(names).toHaveLength(4);
    for (const name of names) expect(name).toBeTruthy();
    expect(new Set(names).size).toBe(4);
  });

  it('raises its voice with contrast, not with a colour that means stop', () => {
    const { container } = panel([finding({ severity: 'info' }), finding({ severity: 'warn' })]);
    const rows = [...container.querySelectorAll('.finding')];
    expect(rows[0]?.classList.contains('firm')).toBe(false);
    expect(rows[1]?.classList.contains('firm')).toBe(true);
    /*
     * And that step of contrast is ALL severity is allowed to buy. Asserting
     * the absence of a `.danger`/`.pill` class would have been a line that
     * cannot fail — those names appear nowhere in this component whatever it
     * renders. Comparing the two rows against each other is the assertion with
     * something to lose: no added word, no badge, no extra element and no other
     * class on the severe one. A script that reads long is not a script that is
     * broken.
     */
    expect(rows[1]?.textContent).toBe(rows[0]?.textContent);
    expect(rows[1]?.querySelectorAll('*').length).toBe(rows[0]?.querySelectorAll('*').length);
    const others = (row: Element | undefined) =>
      [...(row?.classList ?? [])].filter((name) => name !== 'firm').sort();
    expect(others(rows[1])).toEqual(others(rows[0]));
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

/*
 * The way back from the text. A note is followed into the editor; Escape there
 * returns focus to the list. The editor here is a stand-in carrying the class
 * the panel looks for, which is all the panel knows about CodeMirror.
 */
describe('coming back from the editor', () => {
  let editor: HTMLTextAreaElement | null = null;

  function editorField(): HTMLTextAreaElement {
    const host = document.createElement('div');
    host.className = 'cm-editor';
    editor = document.createElement('textarea');
    host.append(editor);
    document.body.append(host);
    return editor;
  }

  function pressEscape(target: HTMLElement): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }

  afterEach(() => {
    editor?.closest('.cm-editor')?.remove();
    editor = null;
  });

  it('Escape in the editor returns focus to the note that was followed', async () => {
    const { container } = panel([
      finding({ code: 'very-long-sentence', line: 7 }),
      finding({ code: 'very-long-sentence', line: 25 }),
    ]);
    const rows = container.querySelectorAll<HTMLButtonElement>('.finding');
    rows[1]?.click();
    const field = editorField();
    field.focus();

    pressEscape(field);
    await vi.waitFor(() => expect(document.activeElement).toBe(rows[1]));
    expect(rows[1]?.classList.contains('current')).toBe(true);
  });

  it('once the note is fixed, Escape comes back to the next one of its kind', async () => {
    const fixed = finding({ code: 'no-terminal-punctuation', line: 19 });
    const next = finding({ code: 'no-terminal-punctuation', line: 29 });
    const { container, rerender, ongoto } = panel([fixed, next]);
    container.querySelectorAll<HTMLButtonElement>('.finding')[0]?.click();
    const field = editorField();
    field.focus();

    // The author types the full stop; the next compile no longer reports it.
    await rerender({ findings: [{ ...next }], ongoto });
    pressEscape(field);

    await vi.waitFor(() => {
      const focused = document.activeElement as HTMLElement | null;
      expect(focused?.dataset['note']).toBe('no-terminal-punctuation:29:1');
    });
  });

  it('leaves Escape alone once focus has gone anywhere but the editor', async () => {
    const { container } = panel([finding(), finding({ line: 30 })]);
    const rows = container.querySelectorAll<HTMLButtonElement>('.finding');
    rows[0]?.click();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();

    const field = editorField();
    field.focus();
    pressEscape(field);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(field);
    elsewhere.remove();
  });
});
