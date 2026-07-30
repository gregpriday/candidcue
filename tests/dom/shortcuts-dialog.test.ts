/**
 * ShortcutsDialog.svelte — what the help promises, against what the keyboard does.
 *
 * The dialog used to render one flat table of keys with no header cells, and
 * with "(during Live)" typed by hand onto four of the thirteen rows that needed
 * it. Everything else read as app-wide, so the page promised the whole take
 * transport on the Library and the Editor — and the resolver swallowed those
 * keys everywhere to keep the promise (issue #128).
 *
 * The assertions that matter here are the ones a pure test of the ownership
 * table cannot make: that the rendered page groups by that table, and that no
 * command is left undocumented. A correct `SHORTCUT_OWNERSHIP` and a dialog
 * that ignores it would be exactly the drift this is meant to catch.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ShortcutsDialog from '../../src/control/components/ShortcutsDialog.svelte';
import { isMacPlatform, SHORTCUT_OWNERSHIP } from '../../src/control/lib/shortcuts';

/* jsdom is not a platform, so the modifier is read the same way the dialog
   reads it rather than assumed to be the Mac one. */
const mod = isMacPlatform() ? '⌘' : 'Ctrl+';

function open() {
  render(ShortcutsDialog, { props: { open: true, onclose: () => {} } });
  return [...document.querySelectorAll('table')];
}

/** The rows under a group caption, as `[action, keys]` pairs. */
function groupRows(caption: string): Array<[string, string]> {
  const table = [...document.querySelectorAll('table')].find((t) =>
    // The caption also carries an optional note, so match its first line.
    t.querySelector('caption')?.textContent?.trim().startsWith(caption),
  );
  if (!table) throw new Error(`no group captioned "${caption}"`);
  return [...table.querySelectorAll('tbody tr')].map((tr) => {
    const cells = tr.querySelectorAll('td');
    return [cells[0]?.textContent?.trim() ?? '', cells[1]?.textContent?.trim() ?? ''];
  });
}

function labelsIn(caption: string): string[] {
  return groupRows(caption).map(([action]) => action);
}

describe('the shortcuts reference is grouped by the screen that answers each key', () => {
  it('heads every group with a caption and two column headers', () => {
    const tables = open();
    expect(tables.length).toBe(4);
    for (const table of tables) {
      expect(table.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      const headers = [...table.querySelectorAll('thead th')];
      expect(headers.length).toBe(2);
      // The complaint was that the table had no header cells at all; `scope`
      // is what makes them mean "column" to a screen reader rather than just
      // being bold text.
      expect(headers.map((th) => th.getAttribute('scope'))).toEqual(['col', 'col']);
      expect(headers.map((th) => th.textContent?.trim())).toEqual(['Action', 'Shortcut']);
    }
  });

  it('names the four groups in the order the app is used', () => {
    const tables = open();
    const captions = tables.map((t) => t.querySelector('caption')?.textContent?.trim() ?? '');
    expect(captions[0]).toBe('Everywhere');
    expect(captions[1]).toBe('Library');
    expect(captions[2]?.startsWith('Editor')).toBe(true);
    expect(captions[3]).toBe('During a take');
  });

  it('puts each key under the screen that actually answers it', () => {
    open();
    // The only genuinely app-wide command.
    expect(labelsIn('Everywhere')).toEqual(['Command help']);

    expect(labelsIn('Library')).toContain('New script');
    expect(labelsIn('Library')).toContain('Open quick search');
    expect(labelsIn('Library')).not.toContain('Save');

    expect(labelsIn('Editor')).toContain('Save');
    expect(labelsIn('Editor')).not.toContain('New script');

    // Present has two owners, so it is honestly listed under both.
    expect(labelsIn('Library')).toContain('Present current script');
    expect(labelsIn('Editor')).toContain('Present current script');

    const live = labelsIn('During a take');
    expect(live).toContain('Start / Pause / Resume');
    expect(live).toContain('Blank stage');
    expect(live).toContain('End the take and close the stage');
    expect(labelsIn('Library')).not.toContain('Blank stage');
  });

  it('no longer annotates rows by hand now the caption says where they work', () => {
    open();
    const body = document.querySelector('.panel')?.textContent ?? '';
    expect(body).not.toContain('(during Live)');
  });

  /*
   * The drift guard.
   *
   * The failure this whole change is about is a command and its help going out
   * of step. A new `ShortcutAction` with no row here would be a key that works
   * and is documented nowhere; a row naming a command that no longer exists
   * stops compiling. Counting rows against the table is what turns "we
   * remembered this time" into something the suite enforces.
   */
  it('documents every command exactly once', () => {
    open();
    const documented = [
      ...labelsIn('Everywhere'),
      ...labelsIn('Library'),
      ...labelsIn('Editor'),
      ...labelsIn('During a take'),
    ];
    const actionCount = Object.keys(SHORTCUT_OWNERSHIP).length;
    /*
     * Four rows document a pair each (back/forward, previous/next chapter,
     * larger/smaller stage text, slower/faster), Present is deliberately shown
     * twice because two screens answer it, and Bold and Italic are the editor's
     * own keys rather than entries in the table.
     */
    const PAIRED_ROWS = 4;
    const PRESENT_SHOWN_TWICE = 1;
    const EDITOR_LOCAL_ROWS = 2;
    expect(documented.length).toBe(
      actionCount - PAIRED_ROWS + PRESENT_SHOWN_TWICE + EDITOR_LOCAL_ROWS,
    );
    // And nothing is listed twice inside one group.
    for (const caption of ['Everywhere', 'Library', 'Editor', 'During a take']) {
      const labels = labelsIn(caption);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('gives the editor its formatting keys, marked as needing the text focused', () => {
    open();
    const rows = groupRows('Editor');
    expect(rows).toContainEqual(['Bold', `${mod}B`]);
    expect(rows).toContainEqual(['Italic', `${mod}I`]);
    const caption = [...document.querySelectorAll('caption')].find((c) =>
      c.textContent?.trim().startsWith('Editor'),
    );
    expect(caption?.textContent).toContain('while the script text has focus');
  });
});
