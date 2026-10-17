/**
 * A reading window shows the document; a teleprompter take keeps its glass.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * Three changes to what the stage draws, each paired with the case it must
 * leave alone:
 *
 *  1. a reading window shows images, tables, code and diagrams in full rather
 *     than as one-line chips — and a prompter take still draws the chip;
 *  2. a heading in a reading window is a heading: never `.unspoken`, never the
 *     compact take label, with room above it — and on the prompter, in a take
 *     or in practice, a heading renders exactly as it did;
 *  3. a list item draws its real marker (a number, a box, a dot) and its
 *     nesting, in every mode, without the marker becoming a word.
 *
 * jsdom resolves no stylesheets and lays nothing out, so these are claims about
 * classes, attributes and inline geometry. What the browser then draws from
 * them — that the text sits where the line planner planned it — is
 * `tests/e2e/browser/planned-line-breaks.spec.ts`.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it } from 'vitest';
import BlockView from '../../src/stage/renderer/BlockView.svelte';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import type { CompiledBlock, StageRenderDocument, StageSettings } from '../../src/shared/contracts';
import { LIST_DEPTH_INDENT_EM, listMarker, listMarkerGeometry } from '../../src/shared/list-marker';
import { PERFORMANCE_CUE_LABELS, type PerformanceMode } from '../../src/shared/performance-view';

/** Layout hints as the compiled block carries them. */
type Hints = Record<string, string | number | boolean>;

function heading(spoken: boolean, level = 1): CompiledBlock {
  return {
    id: `h${level}`,
    kind: 'heading',
    spoken,
    renderNodes: spoken
      ? [{ type: 'text', text: 'Pricing', tokenIndexes: [0] }]
      : [{ type: 'text', text: 'Pricing' }],
    ...(spoken ? { startTokenIndex: 0, endTokenIndex: 0 } : {}),
    layoutHints: { level },
    source: { utf16Start: 0, utf16End: 0 },
  };
}

function listItem(layoutHints: CompiledBlock['layoutHints'], id = 'li'): CompiledBlock {
  return {
    id,
    kind: 'list_item',
    spoken: true,
    startTokenIndex: 4,
    endTokenIndex: 6,
    renderNodes: [{ type: 'text', text: 'Charge the mic', tokenIndexes: [4, 5, 6] }],
    layoutHints,
    source: { utf16Start: 0, utf16End: 0 },
  };
}

function block(
  compiled: CompiledBlock,
  props: { reader?: boolean; performanceMode?: PerformanceMode } = {},
) {
  const { container } = render(BlockView, {
    props: { block: compiled, zone: 'future', ...props },
  });
  const root = container.querySelector<HTMLElement>('[data-block-id]');
  if (!root) throw new Error('BlockView rendered no block');
  return root;
}

/** Every way a teleprompter draws a block, for the parity checks. */
const PROMPTER: { name: string; performanceMode: PerformanceMode }[] = [
  { name: 'a take', performanceMode: 'take' },
  { name: 'practice or a Diagnostic Take', performanceMode: 'rehearsal' },
];

describe('a heading in a reading window', () => {
  it('is not quieted as unspoken, and is never the compact take label', () => {
    // Both modes, although a reading window only ever arrives as `rehearsal`:
    // the reader treatment must not depend on which projection it came with.
    for (const performanceMode of ['take', 'rehearsal'] as const) {
      const root = block(heading(false), { reader: true, performanceMode });
      expect(root.classList.contains('unspoken'), performanceMode).toBe(false);
      expect(root.classList.contains('reader-heading'), performanceMode).toBe(true);
      expect(root.querySelector('.heading')?.classList.contains('compact'), performanceMode).toBe(false);
      // Still zoned like every other block: readable is not the same as current.
      expect(root.classList.contains('zone-future')).toBe(true);
    }
  });

  it('keeps its level, which is what sizes it and spaces it', () => {
    for (const level of [1, 2, 3, 6]) {
      const root = block(heading(false, level), { reader: true, performanceMode: 'rehearsal' });
      expect(root.querySelector('.heading')?.getAttribute('data-level')).toBe(String(level));
      expect(root.getAttribute('data-heading-level')).toBe(String(level));
    }
  });

  it('reads the same whether or not following listens for it', () => {
    const spoken = block(heading(true), { reader: true, performanceMode: 'rehearsal' });
    const silent = block(heading(false), { reader: true, performanceMode: 'rehearsal' });
    for (const root of [spoken, silent]) {
      expect(root.className.replace(/svelte-\S+/g, '').trim().split(/\s+/).sort()).toEqual(
        ['block', 'k-heading', 'reader-heading', 'zone-future'].sort(),
      );
    }
    // Only the spoken one anchors its word for the follower.
    expect(spoken.querySelectorAll('[data-t]')).toHaveLength(1);
    expect(silent.querySelectorAll('[data-t]')).toHaveLength(0);
  });

  it('keeps a hidden cue in its place, so being first means being first in the document', () => {
    // `.reader-heading:not(:first-child)` reads the document position off the
    // DOM. A hidden cue that rendered nothing would let the heading under it be
    // first at the top of the window and not first once a spacer replaced it.
    const cue: CompiledBlock = {
      id: 'cue',
      kind: 'cue',
      spoken: false,
      renderNodes: [{ type: 'cue', cueType: 'beat', label: 'Beat' }],
      source: { utf16Start: 0, utf16End: 0 },
    };
    const inReader = render(BlockView, {
      props: { block: cue, zone: 'future', showCues: false, reader: true },
    }).container;
    const held = inReader.querySelector('.hidden-block');
    expect(held?.hasAttribute('hidden')).toBe(true);
    expect(held?.textContent).toBe('');
    // Holds the place and nothing else: not a block the stage measures.
    expect(inReader.querySelector('[data-block-id]')).toBeNull();

    // The prompter draws nothing at all, as it always has.
    const onPrompter = render(BlockView, {
      props: { block: cue, zone: 'future', showCues: false },
    }).container;
    expect(onPrompter.querySelector('.hidden-block')).toBeNull();
    expect(onPrompter.textContent?.trim()).toBe('');
  });

  it('leaves every other unspoken block quiet', () => {
    const silentParagraph: CompiledBlock = {
      id: 'silent',
      kind: 'silent',
      spoken: false,
      renderNodes: [{ type: 'text', text: 'Producer note.' }],
      source: { utf16Start: 0, utf16End: 0 },
    };
    const root = block(silentParagraph, { reader: true, performanceMode: 'rehearsal' });
    expect(root.classList.contains('unspoken')).toBe(true);
    expect(root.classList.contains('reader-heading')).toBe(false);
  });
});

describe('a heading on the prompter is exactly what it was', () => {
  for (const { name, performanceMode } of PROMPTER) {
    it(`in ${name}`, () => {
      const unspoken = block(heading(false), { performanceMode });
      expect(unspoken.classList.contains('unspoken')).toBe(true);
      expect(unspoken.classList.contains('reader-heading')).toBe(false);
      expect(unspoken.hasAttribute('data-heading-level')).toBe(false);
      expect(unspoken.querySelector('.heading')?.classList.contains('compact')).toBe(
        performanceMode === 'take',
      );

      const spoken = block(heading(true), { performanceMode });
      expect(spoken.classList.contains('unspoken')).toBe(false);
      expect(spoken.classList.contains('reader-heading')).toBe(false);
      expect(spoken.querySelector('.heading')?.classList.contains('compact')).toBe(false);
    });
  }
});

describe('a list item draws its real marker, in every mode', () => {
  const MODES = [
    { reader: true, performanceMode: 'rehearsal' as const },
    { reader: false, performanceMode: 'take' as const },
    { reader: false, performanceMode: 'rehearsal' as const },
  ];

  function marker(root: HTMLElement): HTMLElement {
    const found = root.querySelector<HTMLElement>('.list-item > .marker');
    if (!found) throw new Error('no marker drawn');
    return found;
  }

  it('numbers an ordered item with the number the author gave it', () => {
    for (const mode of MODES) {
      const root = block(listItem({ ordered: true, index: 3, depth: 0 }), mode);
      const drawn = marker(root);
      expect(drawn.classList.contains('number')).toBe(true);
      expect(drawn.textContent).toBe('3.');
      expect(root.querySelector('.list-item')?.getAttribute('data-marker')).toBe('number');
    }
  });

  it('draws a task as a box, ticked or not, with no glyph in it', () => {
    for (const checked of [true, false]) {
      const root = block(listItem({ ordered: false, index: 1, depth: 0, checked }));
      const drawn = marker(root);
      expect(drawn.classList.contains('checkbox')).toBe(true);
      expect(drawn.classList.contains('checked')).toBe(checked);
      expect(drawn.getAttribute('data-checked')).toBe(String(checked));
      expect(drawn.textContent).toBe('');
    }
  });

  it('keeps the dot for an unordered item', () => {
    const drawn = marker(block(listItem({ ordered: false, index: 1, depth: 0 })));
    expect(drawn.classList.contains('bullet')).toBe(true);
    expect(drawn.textContent).toBe('');
  });

  it('indents by its depth, at the geometry the line planner reads', () => {
    const cases: Hints[] = [
      { ordered: false, index: 1, depth: 0 },
      { ordered: true, index: 12, depth: 1 },
      { ordered: false, index: 1, depth: 2, checked: false },
    ];
    for (const hints of cases) {
      const root = block(listItem(hints));
      const row = root.querySelector<HTMLElement>('.list-item')!;
      const geometry = listMarkerGeometry(listMarker(hints));
      expect(row.style.paddingLeft).toBe(`${geometry.indentEm}em`);
      expect(row.style.columnGap).toBe(`${geometry.gapEm}em`);
      expect(marker(root).style.width).toBe(`${geometry.markerEm}em`);
      expect(row.getAttribute('data-depth')).toBe(String(hints.depth));
    }
    expect(
      block(listItem({ ordered: false, index: 1, depth: 2 })).querySelector<HTMLElement>('.list-item')!
        .style.paddingLeft,
    ).toBe(`${2 * LIST_DEPTH_INDENT_EM}em`);
  });

  it('never makes the marker a word: hidden from assistive tech and carrying no token', () => {
    const cases: Hints[] = [
      { ordered: true, index: 3, depth: 0 },
      { ordered: false, index: 1, depth: 0, checked: true },
      { ordered: false, index: 1, depth: 1 },
    ];
    for (const hints of cases) {
      const root = block(listItem(hints));
      const drawn = marker(root);
      expect(drawn.getAttribute('aria-hidden')).toBe('true');
      expect(drawn.hasAttribute('data-t')).toBe(false);
      expect(drawn.querySelector('[data-t]')).toBeNull();
      // Exactly the item's own tokens are anchored, all inside the text, in order.
      const anchored = Array.from(root.querySelectorAll('[data-t]'));
      expect(anchored.map((el) => el.getAttribute('data-t'))).toEqual(['4', '5', '6']);
      expect(anchored.every((el) => el.closest('.list-body') !== null)).toBe(true);
      expect(anchored.map((el) => el.textContent).join(' ')).toBe('Charge the mic');
    }
  });

  it('still hands its text the planned breaks', () => {
    const { container } = render(BlockView, {
      props: {
        block: listItem({ ordered: true, index: 2, depth: 1 }),
        zone: 'current',
        breakAfterTokens: new Set([5]),
      },
    });
    const br = container.querySelector('.list-body br[data-planned-break]');
    expect(br?.previousElementSibling?.getAttribute('data-t')).toBe('5');
  });
});

/*
 * The projection, through the mounted script layer: the one place the reading
 * context and the projection meet.
 */
describe('what a reading window shows in place of a chip', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1240,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 800,
    });
  });

  const doc = {
    schemaVersion: 1,
    title: 'Reader content',
    blocks: [
      {
        id: 'p1',
        kind: 'paragraph',
        spoken: true,
        startTokenIndex: 0,
        endTokenIndex: 2,
        renderNodes: [{ type: 'text', text: 'Here are numbers.', tokenIndexes: [0, 1, 2] }],
        source: { utf16Start: 0, utf16End: 0 },
      },
      {
        id: 't1',
        kind: 'table',
        spoken: false,
        renderNodes: [
          {
            type: 'table',
            headerRow: true,
            align: [null, null],
            rows: [
              [[{ type: 'text', text: 'Plan' }], [{ type: 'text', text: 'Price' }]],
              [[{ type: 'text', text: 'Pro' }], [{ type: 'text', text: '12' }]],
            ],
          },
        ],
        source: { utf16Start: 0, utf16End: 0 },
      },
      {
        id: 'p2',
        kind: 'paragraph',
        spoken: true,
        startTokenIndex: 3,
        endTokenIndex: 5,
        renderNodes: [{ type: 'text', text: 'That is it.', tokenIndexes: [3, 4, 5] }],
        source: { utf16Start: 0, utf16End: 0 },
      },
    ],
    tokenToNode: [0, 1, 2, 3, 4, 5].map((tokenIndex) => ({
      tokenIndex,
      blockId: tokenIndex < 3 ? 'p1' : 'p2',
      nodeKey: '',
    })),
    assets: {},
  } as unknown as StageRenderDocument;

  function settings(overrides: Partial<StageSettings> = {}): StageSettings {
    return {
      schemaVersion: 1,
      themeId: 'stage-dark',
      background: '#000000',
      foreground: '#f5f3ef',
      fontFamilyId: 'system-sans',
      fontSizePx: 64,
      lineHeight: 1.32,
      letterSpacingEm: 0,
      columnWidthPercent: 68,
      readingBandCenterPercent: 38,
      readingBandHalfHeightPercent: 4,
      pastOpacity: 0.42,
      futureOpacity: 0.92,
      currentUnderlayOpacity: 0.1,
      mirrorX: false,
      mirrorY: false,
      showCues: true,
      stageAcknowledgements: true,
      reducedMotion: false,
      paragraphSpacingEm: 0.7,
      ...overrides,
    };
  }

  function mount(stageSettings: StageSettings) {
    return render(ScriptLayer, {
      props: {
        doc,
        settings: stageSettings,
        sessionId: 's',
        sessionGeneration: 1,
        stageGeneration: 1,
        scriptCompileHash: 'hash',
      },
    });
  }

  it('draws the table itself in a reading window', () => {
    const { container } = mount(settings({ readingContext: 'reader' }));
    const table = container.querySelector('[data-block-id="t1"]');
    expect(table?.querySelector('table')).not.toBeNull();
    expect(table?.textContent).toContain('Pro');
    expect(container.querySelector('[data-performance-cue]')).toBeNull();
    expect(container.textContent).not.toContain(PERFORMANCE_CUE_LABELS.table);
  });

  it('still draws the chip in a teleprompter take', () => {
    for (const readingContext of [undefined, 'prompter'] as const) {
      const { container, unmount } = mount(settings(readingContext ? { readingContext } : {}));
      const table = container.querySelector('[data-block-id="t1"]');
      expect(table?.querySelector('table'), String(readingContext)).toBeNull();
      expect(table?.querySelector('[data-performance-cue="table"]'), String(readingContext)).not.toBeNull();
      unmount();
    }
  });

  it('anchors the same spoken tokens either way', () => {
    const anchors = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-t]')).map((el) => el.getAttribute('data-t'));
    const reader = mount(settings({ readingContext: 'reader' }));
    const readerAnchors = anchors(reader.container);
    reader.unmount();
    const prompter = mount(settings());
    expect(anchors(prompter.container)).toEqual(readerAnchors);
    expect(readerAnchors).toEqual(['0', '1', '2', '3', '4', '5']);
  });
});

describe('reference content in a reading window', () => {
  const table: CompiledBlock = {
    id: 'tbl',
    kind: 'table',
    renderNodes: [{ type: 'text', text: 'Month Storm days' }],
    source: { utf16Start: 0, utf16End: 0 },
    spoken: false,
  };
  const silent: CompiledBlock = {
    id: 'note',
    kind: 'silent',
    renderNodes: [{ type: 'text', text: 'Producer note' }],
    source: { utf16Start: 0, utf16End: 0 },
    spoken: false,
  };

  it('reads at the zone opacity, not the quiet annotation treatment', () => {
    // A reading window shows the table as part of the document; at 0.45 over
    // its own card its text fell well under readable contrast.
    const root = block(table, { reader: true, performanceMode: 'rehearsal' });
    expect(root.classList.contains('unspoken')).toBe(false);
    expect(root.classList.contains('reader-content')).toBe(true);
    expect(root.classList.contains('zone-future')).toBe(true);
  });

  it('keeps annotations quiet in a reading window', () => {
    const root = block(silent, { reader: true, performanceMode: 'rehearsal' });
    expect(root.classList.contains('unspoken')).toBe(true);
    expect(root.classList.contains('reader-content')).toBe(false);
  });

  it('leaves every prompter projection exactly as it was', () => {
    for (const { name, performanceMode } of PROMPTER) {
      const root = block(table, { performanceMode });
      expect(root.classList.contains('unspoken'), name).toBe(true);
      expect(root.classList.contains('reader-content'), name).toBe(false);
    }
  });
});
