/**
 * The list marker: what each item carries, and how much of the line it takes.
 *
 * Asserted over hints the REAL compiler produced as well as hand-built ones,
 * because the case worth catching is the two drifting apart — a hint renamed in
 * `compile.ts` would leave every list on the glass a column of bullets again,
 * with nothing on screen looking broken.
 */
import { describe, expect, it } from 'vitest';
import { compile } from './markdown';
import {
  LIST_DEPTH_INDENT_EM,
  LIST_NUMBER_DIGIT_EM,
  MAX_LIST_DEPTH,
  listInsetEm,
  listMarker,
  listMarkerGeometry,
} from './list-marker';

/** Layout hints as the compiled block carries them. */
type Hints = Record<string, string | number | boolean>;

function itemsOf(source: string) {
  return compile(source, { scriptId: 'list-marker' }).blocks.filter((b) => b.kind === 'list_item');
}

describe('the marker a compiled list item carries', () => {
  it('numbers an ordered list from where the author started it', () => {
    const items = itemsOf('3. Plug in the panel.\n4. Open the app.\n5. Press Present.\n');
    expect(items.map((b) => listMarker(b.layoutHints))).toEqual([
      { kind: 'number', label: '3.', depth: 0 },
      { kind: 'number', label: '4.', depth: 0 },
      { kind: 'number', label: '5.', depth: 0 },
    ]);
  });

  it('keeps a bullet for an unordered list', () => {
    const [item] = itemsOf('- Works offline.\n');
    expect(listMarker(item!.layoutHints)).toEqual({ kind: 'bullet', label: '', depth: 0 });
  });

  it('draws a task as its state, ticked or not', () => {
    const items = itemsOf('- [x] Ship the recorder.\n- [ ] Write the docs.\n');
    expect(items.map((b) => listMarker(b.layoutHints))).toEqual([
      { kind: 'task', label: '', checked: true, depth: 0 },
      { kind: 'task', label: '', checked: false, depth: 0 },
    ]);
  });

  it('lets a task beat its number', () => {
    const [item] = itemsOf('1. [x] Ship it.\n');
    expect(listMarker(item!.layoutHints)).toMatchObject({ kind: 'task', checked: true });
  });

  it('carries the nesting, whichever kinds of list are nested', () => {
    const items = itemsOf(['1. Prepare.', '   - Charge the mic.', '     1. Check the level.', '2. Record.', ''].join('\n'));
    expect(items.map((b) => listMarker(b.layoutHints))).toEqual([
      { kind: 'number', label: '1.', depth: 0 },
      { kind: 'bullet', label: '', depth: 1 },
      { kind: 'number', label: '1.', depth: 2 },
      { kind: 'number', label: '2.', depth: 0 },
    ]);
  });

  it('adds no spoken token for any marker', () => {
    // The compiler's own contract, restated where the markers are made: a
    // numbered task list speaks only its words.
    const script = compile('1. [x] Ship it.\n2. Then rest.\n', { scriptId: 'list-marker' });
    expect(script.spokenTokens.map((t) => t.normalized)).toEqual(['ship', 'it', 'then', 'rest']);
  });
});

describe('hints it cannot trust', () => {
  it('falls back to a top-level bullet, as the stage always drew', () => {
    for (const hints of [
      undefined,
      {},
      { ordered: 'yes' },
      { ordered: true },
      { ordered: true, index: 1.5 },
      { ordered: true, index: -1 },
      { ordered: true, index: Number.MAX_VALUE },
    ]) {
      expect(listMarker(hints as never)).toEqual({ kind: 'bullet', label: '', depth: 0 });
    }
  });

  it('reads a depth that is not a whole non-negative number as the top level', () => {
    for (const depth of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'two']) {
      expect(listMarker({ depth } as never).depth).toBe(0);
    }
    expect(listMarker({ depth: 2.7 }).depth).toBe(2);
  });

  it('stops indenting past the deepest drawn level', () => {
    expect(listMarker({ depth: MAX_LIST_DEPTH + 3 }).depth).toBe(MAX_LIST_DEPTH);
  });

  it('numbers from zero when the author did', () => {
    expect(listMarker({ ordered: true, index: 0, depth: 0 }).label).toBe('0.');
  });
});

describe('how much of the line a marker takes', () => {
  it('keeps the bullet the stage has always drawn', () => {
    // A 0.28em dot, 0.55em from the text: an unordered list looks as it did.
    const geometry = listMarkerGeometry(listMarker({ ordered: false, index: 1, depth: 0 }));
    expect(geometry).toMatchObject({ indentEm: 0, markerEm: 0.28, gapEm: 0.55 });
    expect(geometry.insetEm).toBeCloseTo(0.83, 10);
  });

  it('gives every number up to two digits the same column', () => {
    // So the text of item 10 starts where the text of item 9 does.
    const nine = listInsetEm({ ordered: true, index: 9, depth: 0 });
    for (const index of [0, 1, 10, 42, 99]) {
      expect(listInsetEm({ ordered: true, index, depth: 0 }), String(index)).toBe(nine);
    }
    expect(nine).toBeGreaterThan(listInsetEm({ ordered: false, index: 9, depth: 0 }));
  });

  it('widens the column a digit at a time past two, so no label outgrows it', () => {
    // `2024.` opening a sentence is a list item to the parser. A label wider
    // than its column would hang off the window's edge and be clipped.
    const at = (index: number) =>
      listMarkerGeometry(listMarker({ ordered: true, index, depth: 0 })).markerEm;
    expect(at(100) - at(99)).toBeCloseTo(LIST_NUMBER_DIGIT_EM, 10);
    expect(at(2024) - at(99)).toBeCloseTo(2 * LIST_NUMBER_DIGIT_EM, 10);
    expect(at(123456789) - at(99)).toBeCloseTo(7 * LIST_NUMBER_DIGIT_EM, 10);
  });

  it('sums its parts, which is the number the planner reads', () => {
    const cases: Hints[] = [
      { ordered: false, index: 1, depth: 0 },
      { ordered: true, index: 12, depth: 1 },
      { ordered: false, index: 1, depth: 3, checked: true },
    ];
    for (const hints of cases) {
      const geometry = listMarkerGeometry(listMarker(hints));
      expect(geometry.insetEm).toBeCloseTo(geometry.indentEm + geometry.markerEm + geometry.gapEm, 10);
      expect(listInsetEm(hints)).toBe(geometry.insetEm);
    }
  });

  it('indents each level of nesting by the same step', () => {
    const at = (depth: number) => listMarkerGeometry(listMarker({ depth })).indentEm;
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(LIST_DEPTH_INDENT_EM);
    expect(at(2)).toBe(2 * LIST_DEPTH_INDENT_EM);
    expect(at(MAX_LIST_DEPTH + 1)).toBe(MAX_LIST_DEPTH * LIST_DEPTH_INDENT_EM);
  });

  it('puts a nested item\'s text to the right of its parent\'s, for every pair of kinds', () => {
    const kinds: Hints[] = [
      { ordered: false, index: 1 },
      { ordered: true, index: 10 },
      { ordered: false, index: 1, checked: false },
    ];
    for (const parent of kinds) {
      for (const child of kinds) {
        const outer = listInsetEm({ ...parent, depth: 0 });
        const inner = listInsetEm({ ...child, depth: 1 });
        expect(inner, `${JSON.stringify(child)} under ${JSON.stringify(parent)}`).toBeGreaterThan(outer);
      }
    }
  });
});
