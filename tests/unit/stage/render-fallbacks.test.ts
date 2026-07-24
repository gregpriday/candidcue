/**
 * Stage renderer coverage for the two node kinds that used to disappear:
 *
 *  - an image whose asset never resolved was omitted from the DOM entirely,
 *    so a missing file looked identical to a script that never had one;
 *  - a `table` block fell through to the inline-node presenter, which has no
 *    `table` case, so a compiled table rendered as an empty card.
 *
 * Rendered with `svelte/server` so the real component markup is asserted (the
 * project's vitest environment is node — there is no DOM to mount into).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import BlockView from '../../../src/stage/renderer/BlockView.svelte';
import InlineNodes from '../../../src/stage/renderer/InlineNodes.svelte';
import { compile } from '../../../src/shared/markdown';
import type { CompiledBlock, SafeRenderNode } from '../../../src/shared/contracts';

const media = compile(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/markdown/media.md', import.meta.url)),
    'utf8',
  ),
  { scriptId: 'media' },
);

function block(kind: CompiledBlock['kind']): CompiledBlock {
  const found = media.blocks.find((b) => b.kind === kind);
  if (!found) throw new Error(`fixture has no ${kind} block`);
  return found;
}

function renderBlock(target: CompiledBlock, assets: Record<string, { url: string; mime: string }> = {}): string {
  return render(BlockView, {
    props: { block: target, zone: 'current', assets },
  }).body;
}

/**
 * Visible text only. The stage wraps every word in its own token-anchored
 * span, so a phrase never appears contiguously in the raw markup.
 */
function text(html: string): string {
  return html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('stage image fallback', () => {
  it('shows the alt text when a block image has no resolved asset', () => {
    const html = renderBlock(block('image'));
    expect(text(html)).toContain('Pipeline overview');
    expect(html).not.toContain('<img');
  });

  it('renders the image itself once the asset resolves', () => {
    const image = block('image');
    const assetId = image.assetIds?.[0];
    expect(assetId).toBeTruthy();
    const html = renderBlock(image, { [assetId!]: { url: 'blob:x', mime: 'image/png' } });
    expect(html).toContain('<img');
    expect(html).toContain('blob:x');
  });

  it('falls back to alt text for an inline image node too', () => {
    const nodes: SafeRenderNode[] = [{ type: 'image', assetId: 'missing', alt: 'Quarterly chart' }];
    const html = render(InlineNodes, { props: { nodes } }).body;
    expect(text(html)).toContain('Quarterly chart');
    expect(html).not.toContain('<img');
  });

  it('never renders an empty element when alt text is also missing', () => {
    const nodes: SafeRenderNode[] = [{ type: 'image', assetId: 'missing', alt: '' }];
    const html = render(InlineNodes, { props: { nodes } }).body;
    expect(text(html)).toContain('Image unavailable');
  });
});

describe('stage table rendering', () => {
  it('renders a compiled table as real rows, not an empty card', () => {
    const html = renderBlock(block('table'));
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(text(html)).toContain('Metric');
    expect(text(html)).toContain('Takes per video');
    expect(text(html)).toContain('1.5');
  });

  it('keeps the column alignment the compiler derived', () => {
    const html = renderBlock(block('table'));
    expect(html).toContain('text-align: right');
  });

  it('renders a table node reached through the inline presenter', () => {
    const tableNode = block('table').renderNodes[0]!;
    const html = render(InlineNodes, { props: { nodes: [tableNode] } }).body;
    expect(html).toContain('<table');
    expect(text(html)).toContain('Editing hours');
  });
});
