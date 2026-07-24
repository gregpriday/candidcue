/**
 * Control-side preview renderer (spec §13.2). A compiled `table` block had no
 * case in either RenderBlocks or RenderNodes, so it rendered as an empty
 * paragraph — the whole reference card silently missing from the preview.
 *
 * Rendered with `svelte/server`; the project's vitest environment is node.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import RenderBlocks from '../../../src/control/components/RenderBlocks.svelte';
import RenderNodes from '../../../src/control/components/RenderNodes.svelte';
import { compile } from '../../../src/shared/markdown';

const media = compile(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/markdown/media.md', import.meta.url)),
    'utf8',
  ),
  { scriptId: 'media' },
);

const tableBlock = media.blocks.find((b) => b.kind === 'table');

function text(html: string): string {
  return html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('preview table rendering', () => {
  it('the fixture really produces a structured table block', () => {
    expect(tableBlock).toBeDefined();
    expect(tableBlock!.renderNodes[0]?.type).toBe('table');
  });

  it('renders header cells and body rows', () => {
    const html = render(RenderBlocks, { props: { blocks: [tableBlock!] } }).body;
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(text(html)).toContain('Metric');
    expect(text(html)).toContain('Takes per video');
    expect(text(html)).toContain('1.5');
  });

  it('does not nest the table inside a paragraph (invalid HTML)', () => {
    const html = render(RenderBlocks, { props: { blocks: [tableBlock!] } }).body;
    const tableAt = html.indexOf('<table');
    const paraAt = html.indexOf('<p class="para');
    expect(tableAt).toBeGreaterThan(-1);
    expect(paraAt).toBe(-1);
  });

  it('carries the compiler alignment through to the cells', () => {
    const html = render(RenderNodes, {
      props: { nodes: [tableBlock!.renderNodes[0]!] },
    }).body;
    expect(html).toContain('text-align: right');
  });

  it('still shows a missing image as a readable reference', () => {
    const imageBlock = media.blocks.find((b) => b.kind === 'image')!;
    const html = render(RenderBlocks, { props: { blocks: [imageBlock] } }).body;
    expect(text(html)).toContain('Pipeline overview');
  });
});
