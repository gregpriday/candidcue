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
import { FOCUSABLE_SELECTOR, nextTrapFocus } from '../../src/control/components/dialog-focus';
import { isMacPlatform, SHORTCUT_OWNERSHIP } from '../../src/control/lib/shortcuts';
import { COMMANDS, COMMAND_IDS, formatAccelerator } from '../../src/control/lib/commands';

/* jsdom is not a platform, so the modifier is read the same way the dialog
   reads it rather than assumed to be the Mac one. */
const mod = isMacPlatform() ? '⌘' : 'Ctrl+';

/** Render the dialog and hand back its panel — required, so a component that
    rendered nothing fails loudly instead of every text assertion passing on ''. */
function open(): HTMLElement {
  render(ShortcutsDialog, { props: { open: true, onclose: () => {} } });
  const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!panel) throw new Error('the dialog did not render');
  return panel;
}

function tables(): HTMLTableElement[] {
  return [...document.querySelectorAll('table')];
}

/** The group name alone — the caption also carries an optional note. */
function captionOf(table: HTMLTableElement): string {
  return table.querySelector('caption .group')?.textContent?.trim() ?? '';
}

/** The rows under a group caption, as `[action, keys]` pairs. */
function groupRows(caption: string): Array<[string, string]> {
  const table = tables().find((t) => captionOf(t) === caption);
  if (!table) throw new Error(`no group captioned "${caption}"`);
  return [...table.querySelectorAll('tbody tr')].map((tr) => {
    const cells = tr.querySelectorAll('td');
    return [cells[0]?.textContent?.trim() ?? '', cells[1]?.textContent?.trim() ?? ''];
  });
}

/**
 * Every `action → group caption` claim the rendered page makes.
 *
 * Read off `data-actions` rather than counted, because a count is not the
 * invariant. Losing one row and duplicating another keeps the total identical
 * while leaving a command undocumented — which is this issue's own failure mode,
 * and would be a poor thing for this file to be blind to.
 */
function renderedClaims(): string[] {
  const claims: string[] = [];
  for (const table of tables()) {
    const caption = captionOf(table);
    for (const tr of table.querySelectorAll('tbody tr')) {
      const actions = tr.getAttribute('data-actions');
      // Bold and Italic are the editor's own keys, and the arrows, page keys
      // and wheel are the stage's; none of them carries an action.
      if (!actions) continue;
      for (const action of actions.split(' ')) claims.push(`${action} → ${caption}`);
    }
  }
  return claims.sort();
}

function labelsIn(caption: string): string[] {
  return groupRows(caption).map(([action]) => action);
}

describe('the shortcuts reference is grouped by the screen that answers each key', () => {
  it('heads every group with a caption and two column headers', () => {
    open();
    /*
     * More than four tables now: the menu commands are listed first, one table
     * per menu, derived from the registry (§6.1). The count is not asserted
     * here — it moves whenever a command gains a key, which is exactly the
     * change this page is supposed to absorb without an edit. What every table
     * still owes is a caption and two scoped column headers.
     */
    expect(tables().length).toBeGreaterThanOrEqual(4);
    for (const table of tables()) {
      expect(captionOf(table)).toBeTruthy();
      const headers = [...table.querySelectorAll('thead th')];
      expect(headers.length).toBe(2);
      // The complaint was that the table had no header cells at all; `scope`
      // is what makes them mean "column" to a screen reader rather than just
      // being bold text.
      expect(headers.map((th) => th.getAttribute('scope'))).toEqual(['col', 'col']);
      // The menu tables head their first column "Command"; the screen-scoped
      // ones head it "Action". Both are the same kind of thing to a reader.
      expect(headers[0]?.textContent?.trim()).toMatch(/^(Action|Command)$/);
      expect(headers[1]?.textContent?.trim()).toBe('Shortcut');
    }
  });

  it('names the screen groups in the order the app is used', () => {
    open();
    // The screens that answer nothing are named in the component but drop out
    // here, because a table headed "Settings" with no rows says the opposite of
    // what is true.
    //
    // The MENU tables come first now (see the section below), so this asserts
    // the tail — the screen-scoped groups — rather than the whole page.
    const captions = tables().map(captionOf);
    expect(captions.slice(-4)).toEqual(['Everywhere', 'Library', 'Editor', 'During a take']);
  });

  it('puts each key under the screen that actually answers it', () => {
    open();
    // The only genuinely app-wide command.
    expect(labelsIn('Everywhere')).toEqual(['Keyboard Shortcuts']);

    expect(labelsIn('Library')).toContain('New Script');
    /* The Library's search field is reached with ⌘F through `edit.find`, which
       is a MENU command and so appears in the Edit table rather than here — the
       change that freed ⌘K for Insert › Link. */
    expect(labelsIn('Library')).not.toContain('Open quick search');
    expect(labelsIn('Library')).not.toContain('Save');

    expect(labelsIn('Editor')).toContain('Save');
    expect(labelsIn('Editor')).not.toContain('New Script');

    // Present has two owners, so it is honestly listed under both.
    expect(labelsIn('Library')).toContain('Present');
    expect(labelsIn('Editor')).toContain('Present');

    const live = labelsIn('During a take');
    expect(live).toContain('Start / Pause / Resume');
    expect(live).toContain('Blank stage');
    expect(live).toContain('End the take and close the stage');
    expect(labelsIn('Library')).not.toContain('Blank stage');
  });

  it('no longer annotates rows by hand now the caption says where they work', () => {
    const panel = open();
    expect(panel.textContent).not.toContain('(during Live)');
  });

  /*
   * The drift guard, and the reason this file exists at all.
   *
   * The failure this whole change is about is a command and its help going out
   * of step. So the page is checked against `SHORTCUT_OWNERSHIP` claim by claim
   * rather than by counting rows: a command with no row, a command printed under
   * a screen that does not answer it, and a command printed twice are three
   * different mistakes, and a total only notices when they fail to cancel out.
   */
  it('prints every command under exactly the screens that answer it', () => {
    open();
    const CAPTION: Record<string, string> = {
      global: 'Everywhere',
      library: 'Library',
      editor: 'Editor',
      live: 'During a take',
      welcome: 'Welcome',
      settings: 'Settings',
      calibrate: 'Calibrate',
    };
    const expected: string[] = [];
    for (const [action, ownership] of Object.entries(SHORTCUT_OWNERSHIP)) {
      const scopes = ownership === 'global' ? ['global'] : [...ownership];
      for (const scope of scopes) expected.push(`${action} → ${CAPTION[scope]}`);
    }
    expect(renderedClaims()).toEqual(expected.sort());
  });

  /*
   * A row that documents a pair — back/forward, previous/next — is one line for
   * two commands, and only honest while both work in the same place. If one of
   * them ever gained an owner the other lacks, the row would quietly follow the
   * narrower of the two and the wider command would go undocumented on the
   * screen it had just been given.
   */
  it('keeps paired rows to commands that share a screen', () => {
    open();
    for (const table of document.querySelectorAll('table')) {
      for (const tr of table.querySelectorAll('tbody tr')) {
        const actions = (tr.getAttribute('data-actions') ?? '').split(' ').filter(Boolean);
        if (actions.length < 2) continue;
        const owners = actions.map((a) =>
          JSON.stringify(SHORTCUT_OWNERSHIP[a as keyof typeof SHORTCUT_OWNERSHIP]),
        );
        expect(new Set(owners).size, `row "${actions.join(' ')}" spans screens`).toBe(1);
      }
    }
  });

  it('lists nothing twice inside one group', () => {
    open();
    for (const caption of ['Everywhere', 'Library', 'Editor', 'During a take']) {
      const labels = labelsIn(caption);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  /*
   * Opening on the end of a scrolled list is the bug a footer button causes: the
   * shell focuses the first control it finds, and Done is past four tables.
   */
  it('opens with focus at the top rather than on the button past the list', () => {
    const panel = open();
    const intro = panel.querySelector('.intro');
    expect(document.activeElement).toBe(intro);
    // And it stays out of the Tab order, so Done is still the first stop.
    expect(intro?.getAttribute('tabindex')).toBe('-1');
  });

  /*
   * Opening on a line that Tab cannot reach is only safe while the trap knows
   * it. jsdom has no native Tab, so what is asserted is the decision the trap
   * makes — computed off the real panel the way Dialog.svelte computes it, and
   * from the element that really has focus.
   *
   * Before this was guarded, the intro was inside the panel and outside the
   * ring, so it matched neither end of a one-stop ring and the trap returned
   * `null`. The browser then took the key, and Shift+Tab left an
   * `aria-modal="true"` panel for the page behind the scrim.
   */
  it('still traps Tab from a line that is not itself a Tab stop', () => {
    const panel = open();
    const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    const active = document.activeElement as HTMLElement | null;
    // The premise: focus is in the panel, and it is not one of the stops.
    expect(panel.contains(active)).toBe(true);
    expect(focusables).not.toContain(active);
    // Done is the whole ring, so it is where both directions have to land.
    expect(focusables.map((el) => el.textContent?.trim())).toEqual(['Done']);
    expect(nextTrapFocus(focusables, active, false, panel.contains(active))).toBe(focusables[0]);
    expect(nextTrapFocus(focusables, active, true, panel.contains(active))).toBe(focusables[0]);
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

  /*
   * The stage's own movement keys. `StageApp.svelte` answers them on its own
   * window and they never reach the resolver, so the ownership table cannot
   * list them — and the page was silent about the most ordinary thing a reader
   * does with a keyboard. Listed beside the other ways of moving through the
   * script, and carrying no action, like the editor's own keys.
   */
  it('lists the stage’s own movement keys with the take’s keys', () => {
    open();
    const rows = groupRows('During a take');
    expect(rows).toContainEqual(['Move the script one line', '↑ / ↓']);
    expect(rows).toContainEqual(['Move the script about a screen', 'Page Up / Page Down']);
    // A gesture is written out, not drawn as a cap.
    expect(rows).toContainEqual(['Scroll the script', 'Mouse wheel or trackpad']);
    const wheel = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('Scroll the script'),
    )!;
    expect(wheel.querySelector('kbd')).toBeNull();
    expect(wheel.querySelector('.keys')?.getAttribute('aria-label')).toBe('Mouse wheel or trackpad');

    // Next to sentence and section, not after the stage's settings.
    const labels = labelsIn('During a take');
    expect(labels.indexOf('Move the script one line')).toBe(labels.indexOf('Previous / next section') + 1);

    // Only keys the stage answers: there is no Home or End.
    const text = rows.map(([, keys]) => keys).join(' ');
    expect(text).not.toMatch(/\bHome\b|\bEnd\b/);

    // And they stand down while a control has the keyboard, which the group's
    // note has to say rather than leave to the four keys it used to name.
    const caption = tables().find((t) => captionOf(t) === 'During a take')!.querySelector('caption');
    expect(caption?.textContent).toMatch(/the arrows and the page keys do nothing while/);
  });

  it('names the presentation-mode key for the switch it makes', () => {
    open();
    const labels = labelsIn('During a take');
    expect(labels).toContain('Switch between reading window and teleprompter');
    expect(labels).not.toContain('Full display / reading window');
  });
});


/**
 * The menu half of the page, and the guarantee that it cannot drift.
 *
 * §6.1's rule is that one definition feeds every surface. THIS DIALOG's menu
 * tables read `COMMANDS`, and these tests are what make that a fact rather than
 * an intention: a command that gains an accelerator appears here without
 * anybody editing this file, and one whose accelerator changes changes here
 * too.
 *
 * The native menu does not read it — it is Rust, and writes the same ids,
 * labels and accelerators out again. What holds the two together is
 * `menu_accelerators_match_the_typescript_registry`, which compares the two
 * accelerator sets in BOTH directions.
 *
 * The transport rows below the menu tables are hand-written, from
 * `SHORTCUT_OWNERSHIP` — those keys have no menu item to be an accelerator for.
 * The duplicate-chord test covers BOTH halves, which is how the ⌘K collision
 * between Insert › Link and the Library's quick search was found.
 */
describe('the shortcuts reference lists the menu commands from the registry', () => {
  function commandRows(): Map<string, string> {
    const rows = new Map<string, string>();
    for (const row of document.querySelectorAll('tr[data-command]')) {
      const id = row.getAttribute('data-command') ?? '';
      const keys = row.querySelector('.keys')?.textContent?.trim() ?? '';
      rows.set(id, keys);
    }
    return rows;
  }

  it('prints every command that has a key, and no command that has none', () => {
    open();
    const rendered = commandRows();
    const expected = COMMAND_IDS.filter((id) => COMMANDS[id].accelerator !== undefined);

    expect([...rendered.keys()].sort()).toEqual([...expected].sort());
    // Anti-vacuity: a page that rendered nothing would satisfy a subset check.
    expect(expected.length).toBeGreaterThan(15);
  });

  it('prints each key exactly as the registry spells it for this platform', () => {
    open();
    const mac = isMacPlatform();
    for (const [id, keys] of commandRows()) {
      const command = COMMANDS[id as (typeof COMMAND_IDS)[number]];
      expect(keys, `${id} is printed as "${keys}"`).toBe(
        formatAccelerator(command.accelerator!, mac),
      );
    }
  });

  it('groups the commands under the menu their id names', () => {
    open();
    const captions = tables().map(captionOf);
    // Every menu that has at least one accelerator gets a table, headed with the
    // menu's own name — so somebody who saw the key in the menu bar can find it
    // again here under the same word.
    expect(captions).toContain('File menu');
    expect(captions).toContain('Edit menu');
    expect(captions).toContain('Insert menu');
    expect(captions).toContain('View menu');
  });

  it('never advertises one chord for two different things, anywhere on the page', () => {
    /*
     * EVERY row, not just the ones derived from the registry.
     *
     * The page is the app's promise about its own keyboard, and the one way it
     * can lie without any single row being wrong is by printing the same chord
     * twice. Menu accelerators are claimed by the OS whether or not the item is
     * enabled, so a duplicate is not a cosmetic clash — one of the two simply
     * never fires, and the one that loses is always the non-menu half.
     *
     * This used to read `tr[data-command]` only, which is exactly why it was
     * silent while Insert › Link and the Library's quick search both printed
     * ⌘K: the conflict lived ACROSS the two halves of the page, so neither half
     * on its own looked wrong. Reading every row is what makes the assertion
     * about the app's keyboard rather than about one table.
     *
     * A chord may repeat when both rows name the SAME thing — the Editor table
     * lists Bold and Italic as keys CodeMirror answers locally, and the Insert
     * menu lists the same two commands. That is one key with one meaning
     * described twice, which is the opposite of the defect.
     */
    open();
    const seen = new Map<string, { label: string; ids: string[] }>();
    let chords = 0;
    for (const row of document.querySelectorAll('tbody tr')) {
      const label = row.querySelector('.action')?.textContent?.trim() ?? '';
      const cell = row.querySelector('.keys')?.textContent?.trim() ?? '';
      /* A row is either a menu command or a screen row that declares which menu
         commands it is the same key as. Either way, the ids it owns. */
      const ids = [
        row.getAttribute('data-command') ?? '',
        ...(row.getAttribute('data-mirrors') ?? '').split(' '),
      ].filter(Boolean);
      /* Pair rows print two chords in one cell ("Alt+← / Alt+→"); each half is
         its own claim on the keyboard. */
      for (const keys of cell.split(' / ').map((k) => k.trim())) {
        if (keys === '') continue;
        chords += 1;
        const previous = seen.get(keys);
        if (previous !== undefined) {
          /* Case and a trailing ellipsis are menu house style, not a different
             meaning: the File menu says "New Script", the app's own buttons say
             "New script", and Find is "Find…" in a menu. */
          const same = (a: string) => a.toLowerCase().replace(/…$/, '').trim();
          const sameName = same(previous.label) === same(label);
          const sameCommand = ids.some((id) => previous.ids.includes(id));
          expect(
            sameName || sameCommand,
            `${keys} is on both "${previous.label}" and "${label}"`,
          ).toBe(true);
          continue;
        }
        seen.set(keys, { label, ids });
      }
    }
    // Anti-vacuity: a page that rendered no tables would pass an empty loop.
    expect(chords).toBeGreaterThan(30);
  });
});
