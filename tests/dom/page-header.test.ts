/**
 * PageHeader.svelte — the heading, the edit that has to be abandonable, and the
 * metadata row that has to hold its height.
 *
 * Three defects met in the heading and none of them is visible from the
 * outside: with `editableTitle` set, the `<h1>` was REPLACED by an `<input>`,
 * so the Editor — the screen an operator lives in — had no level-one heading
 * at all and heading navigation skipped straight over it. The edit could not be
 * cancelled. And clearing the field committed nothing while leaving the header
 * showing a blank, so the screen reported a title the script never had.
 *
 * All three are structural rather than visual, which is why they survived: the
 * header looked right in every screenshot.
 *
 * The metadata row is the fourth. The editor's metadata line is derived from
 * the COMPILE, not from the document, so it lands after the text does and
 * leaves again the moment a script is emptied. While the row was conditional,
 * each of those was a ~20px change in the header's height — and the insert
 * toolbar sits directly beneath it, which is why the jump was most visible
 * there (issue #140). Reserving the row is opt-in, so the cases below also pin
 * the default: a header that never gains or loses metadata does not carry an
 * empty row it will never use.
 */
import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import PageHeader from '../../src/control/components/PageHeader.svelte';

function renderHeader(props: Record<string, unknown> = {}) {
  return render(PageHeader, { props: { title: 'Panel talk', ...props } });
}

const headings = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('h1'),
];

const titleInput = (container: HTMLElement): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>('.title-input');
  expect(input, 'the editable header must render an input').not.toBeNull();
  return input!;
};

/** Blur the way a browser does — the commit runs off the input's own event. */
function blur(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  flushSync();
}

function press(input: HTMLInputElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  flushSync();
  return event;
}

describe('PageHeader — the heading', () => {
  it('renders exactly one level-one heading when the title is static', () => {
    const { container, getByRole } = renderHeader();
    expect(headings(container)).toHaveLength(1);
    // By ROLE, not by tag: an h1 that is aria-hidden or role="presentation" is
    // not a heading, and a tag-only assertion cannot tell the difference.
    expect(getByRole('heading', { level: 1, name: 'Panel talk' })).toBeDefined();
  });

  it('still exposes a level-one heading when the title is editable', () => {
    const { container, getByRole } = renderHeader({ editableTitle: true });
    // This is the defect: the editable branch used to render no h1 whatsoever.
    expect(headings(container), 'an editable title must not cost the page its h1').toHaveLength(1);
    expect(
      getByRole('heading', { level: 1 }),
      'the heading must still be reachable as a heading',
    ).toBeDefined();
  });

  it('names the editable heading after the SAVED title, not the draft', () => {
    const { container, getByRole } = renderHeader({ editableTitle: true });

    // Dirty the draft first — with an untouched input the two are identical and
    // naming the heading after either would pass.
    const input = titleInput(container);
    input.value = 'Half-typed nonsen';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    expect(headings(container)[0]?.getAttribute('aria-label')).toBe('Panel talk');
    expect(getByRole('heading', { level: 1, name: 'Panel talk' })).toBeDefined();
  });

  it('keeps the input reachable and labelled inside the heading', () => {
    const { container, getByLabelText } = renderHeader({ editableTitle: true });
    const input = getByLabelText('Script title') as HTMLInputElement;
    expect(input.value).toBe('Panel talk');
    expect(headings(container)[0]?.contains(input)).toBe(true);
  });
});

describe('PageHeader — committing an edit', () => {
  it('reports a changed title once, trimmed', () => {
    const ontitlechange = vi.fn();
    const { container } = renderHeader({ editableTitle: true, ontitlechange });
    const input = titleInput(container);

    input.value = '  Keynote  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    blur(input);

    expect(ontitlechange).toHaveBeenCalledTimes(1);
    expect(ontitlechange).toHaveBeenCalledWith('Keynote');
  });

  it('says nothing when the title comes back unchanged', () => {
    const ontitlechange = vi.fn();
    const { container } = renderHeader({ editableTitle: true, ontitlechange });
    blur(titleInput(container));
    expect(ontitlechange).not.toHaveBeenCalled();
  });

  it('Enter commits by blurring rather than submitting anything', () => {
    const ontitlechange = vi.fn();
    const { container } = renderHeader({ editableTitle: true, ontitlechange });
    const input = titleInput(container);
    input.focus();

    input.value = 'Keynote';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    press(input, 'Enter');

    expect(document.activeElement).not.toBe(input);
    expect(ontitlechange).toHaveBeenCalledWith('Keynote');
  });
});

describe('PageHeader — abandoning an edit', () => {
  it('Escape restores the saved title and reports nothing', async () => {
    const ontitlechange = vi.fn();
    const { container } = renderHeader({ editableTitle: true, ontitlechange });
    const input = titleInput(container);
    input.focus();

    input.value = 'Half-typed nonsen';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    const event = press(input, 'Escape');
    await tick();

    expect(ontitlechange, 'an abandoned edit saves nothing').not.toHaveBeenCalled();
    expect(titleInput(container).value).toBe('Panel talk');
    // An editable header can sit inside a Dialog, whose window-level handler
    // reads a loose Escape as "close me" — so the key must not travel.
    expect(event.defaultPrevented).toBe(true);
  });

  it('an emptied field falls back to the saved title instead of showing a blank', async () => {
    const ontitlechange = vi.fn();
    const { container } = renderHeader({ editableTitle: true, ontitlechange });
    const input = titleInput(container);

    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    blur(input);
    await tick();

    expect(ontitlechange, 'an empty name is not a name').not.toHaveBeenCalled();
    expect(
      titleInput(container).value,
      'the header must not go on showing a name nothing saved',
    ).toBe('Panel talk');
  });

  it('a rename from elsewhere overwrites even a dirty draft', async () => {
    const { container, rerender } = renderHeader({ editableTitle: true });

    // Dirty the input first. Against a clean one the old `value={title}` markup
    // passes too, so this is what actually exercises the derived re-seeding.
    const input = titleInput(container);
    input.value = 'Half-typed nonsen';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    await rerender({ title: 'Renamed on disk', editableTitle: true });
    await tick();
    expect(titleInput(container).value).toBe('Renamed on disk');
  });
});

describe('PageHeader — focus treatment', () => {
  it('the back control is a small control, so it keeps the accent ring', () => {
    const { container } = renderHeader({ onback: () => {} });
    expect(container.querySelector('.back')?.getAttribute('data-focus')).toBe('control');
  });

  it('the title input takes the quiet edge — it is a surface, not a control', () => {
    const { container } = renderHeader({ editableTitle: true });
    // No opt-in marker: tokens.css gives an unmarked input the quiet treatment.
    expect(titleInput(container).getAttribute('data-focus')).toBeNull();
  });
});

describe('the page header metadata row', () => {
  it('renders no row at all when there is no metadata and none is expected', () => {
    const { container } = render(PageHeader, { props: { title: 'Settings' } });
    expect(container.querySelector('.meta')).toBeNull();
  });

  it('renders the metadata when it has some, without being asked to reserve space', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Calibrate this display', meta: 'Studio Display' },
    });
    expect(container.querySelector('.meta')?.textContent).toBe('Studio Display');
  });

  it('holds an empty row when space is reserved and there is nothing to say yet', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Launch keynote', reserveMetaSpace: true },
    });
    const row = container.querySelector('.meta');
    expect(row).not.toBeNull();
    expect(row?.textContent).toBe('');
  });

  it('keeps the reserved empty row out of the accessibility tree', () => {
    // Height is a layout concern. A blank line is not something to announce.
    const { container } = render(PageHeader, {
      props: { title: 'Launch keynote', reserveMetaSpace: true },
    });
    expect(container.querySelector('.meta')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('announces the metadata once it arrives', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Launch keynote', meta: '412 words · 2m 45s · 3 cues', reserveMetaSpace: true },
    });
    const row = container.querySelector('.meta');
    expect(row?.textContent).toBe('412 words · 2m 45s · 3 cues');
    expect(row?.getAttribute('aria-hidden')).toBeNull();
  });

  it('reserves the same row height whether or not the metadata has landed', async () => {
    /*
     * The actual invariant. jsdom does not lay out, so this asserts the two
     * states resolve to the same CSS-declared height rather than measuring —
     * both take `min-height` from the one `.meta` rule, and the empty row
     * exists so that rule applies to it.
     */
    const empty = render(PageHeader, {
      props: { title: 'Launch keynote', reserveMetaSpace: true },
    });
    const filled = render(PageHeader, {
      props: { title: 'Launch keynote', meta: '412 words', reserveMetaSpace: true },
    });
    const emptyRow = empty.container.querySelector('.meta');
    const filledRow = filled.container.querySelector('.meta');
    expect(emptyRow).not.toBeNull();
    expect(filledRow).not.toBeNull();
    expect(emptyRow?.tagName).toBe(filledRow?.tagName);
    expect(emptyRow?.className).toBe(filledRow?.className);
  });
});
