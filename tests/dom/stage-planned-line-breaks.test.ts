/**
 * The plan reaches the glass.
 *
 * `wrap-plan.ts` decides where the lines end and `line-break/` decides why, and
 * both are covered in node. This is the join neither of them can test: whether
 * the renderer turns a chosen token into a break the browser will honour, and —
 * more importantly — whether it does so without disturbing the token anchors
 * the whole motion path is measured from.
 *
 * jsdom has no canvas, so nothing here plans anything. The plan is injected,
 * which is the right shape for this test anyway: it is about the renderer's
 * half of the contract.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import BlockView from '../../src/stage/renderer/BlockView.svelte';
import InlineNodes from '../../src/stage/renderer/InlineNodes.svelte';
import type { CompiledBlock, SafeRenderNode } from '../../src/shared/contracts';

const nodes: SafeRenderNode[] = [
  {
    type: 'text',
    text: 'one two three four five six',
    tokenIndexes: [0, 1, 2, 3, 4, 5],
  },
];

function inline(breakAfterTokens: ReadonlySet<number> | null) {
  return render(InlineNodes, { props: { nodes, breakAfterTokens } });
}

function block(kind: CompiledBlock['kind'], breakAfterTokens: ReadonlySet<number> | null) {
  const compiled: CompiledBlock = {
    id: 'b1',
    kind,
    renderNodes: nodes,
    source: { utf16Start: 0, utf16End: 0 },
    spoken: true,
  };
  return render(BlockView, {
    props: { block: compiled, zone: 'current', breakAfterTokens },
  });
}

/** The tokens that have a break drawn immediately after them. */
function brokenAfter(container: HTMLElement): number[] {
  const out: number[] = [];
  for (const br of Array.from(container.querySelectorAll('br'))) {
    const previous = br.previousElementSibling;
    const token = previous?.getAttribute('data-t');
    if (token !== null && token !== undefined) out.push(Number(token));
  }
  return out;
}

describe('drawing a planned break', () => {
  it('ends the line after each token the plan named', () => {
    const { container } = inline(new Set([1, 3]));
    expect(brokenAfter(container)).toEqual([1, 3]);
  });

  it('draws nothing at all without a plan', () => {
    const { container } = inline(null);
    expect(container.querySelectorAll('br')).toHaveLength(0);
  });

  it('draws nothing for an empty plan', () => {
    const { container } = inline(new Set());
    expect(container.querySelectorAll('br')).toHaveLength(0);
  });

  /*
   * The invariant the motion path rests on. Every token keeps its `data-t`
   * anchor and its text: the measurement pass reads those rects to build the
   * line map, and a breaker that dropped or renamed one would move the reader's
   * position in the script.
   */
  it('leaves every token anchor and its text exactly where they were', () => {
    const plain = inline(null);
    const planned = inline(new Set([1, 3]));
    const anchors = (c: HTMLElement) =>
      Array.from(c.querySelectorAll('[data-t]')).map((el) => [
        el.getAttribute('data-t'),
        el.textContent,
      ]);
    expect(anchors(planned.container)).toEqual(anchors(plain.container));
    expect(anchors(planned.container)).toHaveLength(6);
  });

  it('marks its breaks so they can be told from an authored one', () => {
    const { container } = inline(new Set([2]));
    const br = container.querySelector('br');
    expect(br?.getAttribute('data-planned-break')).toBe('1');
  });

  it('keeps the spoken text intact, break or no break', () => {
    const plain = inline(null).container.textContent?.replace(/\s+/g, ' ').trim();
    const planned = inline(new Set([1, 3])).container.textContent?.replace(/\s+/g, ' ').trim();
    expect(planned).toBe(plain);
    expect(planned).toBe('one two three four five six');
  });
});

describe('which blocks take a plan', () => {
  it.each(['paragraph', 'list_item', 'blockquote'] as const)(
    'draws planned breaks in a %s, which is prose the presenter reads',
    (kind) => {
      const { container } = block(kind, new Set([2]));
      expect(brokenAfter(container)).toEqual([2]);
    },
  );

  /*
   * A code block is preformatted and a table is a reference card laid out in
   * cells. Both reach `InlineNodes` by a path that is never handed a plan, so
   * English phrase rules cannot reach text that is not a sentence.
   */
  it('leaves a code block to lay itself out', () => {
    const { container } = block('code', new Set([2]));
    expect(container.querySelectorAll('br')).toHaveLength(0);
  });

  /*
   * A heading renders at 1.05em-1.3em by level, or at the secondary floor when
   * compact, and `wrap-plan.ts` declines every one of those sizes. So a heading
   * token can never be in the set, and handing the set to the heading branch
   * would only have worked because compiler token indexes happen to be unique
   * across the whole script — which is not a property this join should rest on.
   */
  it('leaves a heading to lay itself out', () => {
    const { container } = block('heading', new Set([2]));
    expect(container.querySelectorAll('br')).toHaveLength(0);
  });
});
