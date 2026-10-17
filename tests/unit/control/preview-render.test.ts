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
import type { PreviewImages } from '../../../src/control/lib/preview-images';

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

  it('still shows an image as a readable reference without image information', () => {
    const imageBlock = media.blocks.find((b) => b.kind === 'image')!;
    const html = render(RenderBlocks, { props: { blocks: [imageBlock] } }).body;
    expect(text(html)).toContain('Pipeline overview');
    expect(html).not.toContain('<img');
  });
});

/*
 * Images (#250). Every image used to render as `[Image: alt]`, so one whose
 * file was missing looked exactly like one that worked, and the only way to see
 * the picture was to start a take.
 */
describe('preview image rendering', () => {
  const pipeline = media.assets.find((a) => a.href === 'assets/pipeline.png')!;
  const remote = media.assets.find((a) => a.remote)!;
  const pipelineBlock = media.blocks.find((b) => b.id === pipeline.blockId)!;
  const remoteBlock = media.blocks.find((b) => b.id === remote.blockId)!;

  function renderImage(images: PreviewImages, block = pipelineBlock): string {
    return render(RenderBlocks, { props: { blocks: [block], images } }).body;
  }

  it('the fixture has a local and a remote image block', () => {
    expect(pipelineBlock.kind).toBe('image');
    expect(remoteBlock.kind).toBe('image');
  });

  it('draws a resolved image from the url Rust gave, not the authored path', () => {
    const html = renderImage({
      [pipeline.id]: { status: 'resolved', url: 'asset://localhost/pipeline.png' },
    });
    expect(html).toMatch(/<img[^>]*src="asset:\/\/localhost\/pipeline\.png"/);
    expect(html).toMatch(/<img[^>]*alt="Pipeline overview"/);
    expect(html).toMatch(/<img[^>]*draggable="false"/);
    expect(html).not.toContain('src="assets/pipeline.png"');
    expect(text(html)).not.toContain('Image not found');
  });

  it('draws a standalone image as a figure, not inside a paragraph', () => {
    const html = renderImage({
      [pipeline.id]: { status: 'resolved', url: 'asset://localhost/pipeline.png' },
    });
    expect(html).toContain('class="figure');
    expect(html).not.toContain('<p class="para');
  });

  it('marks a missing image as missing, with its alt text', () => {
    const html = renderImage({ [pipeline.id]: { status: 'missing', href: pipeline.href } });
    expect(html).not.toContain('<img');
    expect(html).toContain('data-image-state="missing"');
    expect(text(html)).toContain('Image not found');
    expect(text(html)).toContain('Pipeline overview');
    expect(html).toContain('title="assets/pipeline.png"');
  });

  it('names the missing file when the image has no alt text', () => {
    const bare = compile('![](assets/unnamed.png)', { scriptId: 'media' });
    const asset = bare.assets[0]!;
    const html = render(RenderBlocks, {
      props: {
        blocks: bare.blocks,
        images: { [asset.id]: { status: 'missing', href: asset.href } },
      },
    }).body;
    expect(text(html)).toContain('Image not found assets/unnamed.png');
  });

  it('does not claim a file is missing while the lookup is pending or after it failed', () => {
    const pending = renderImage({ [pipeline.id]: { status: 'pending' } });
    expect(pending).toContain('data-image-state="pending"');
    expect(text(pending)).toContain('Loading image');
    expect(text(pending)).not.toContain('not found');

    const failed = renderImage({ [pipeline.id]: { status: 'error' } });
    expect(failed).toContain('data-image-state="error"');
    expect(text(failed)).toContain('Image could not be loaded');
    expect(text(failed)).not.toContain('not found');
  });

  it('labels a remote image and never loads it', () => {
    const html = renderImage({ [remote.id]: { status: 'remote' } }, remoteBlock);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.com');
    expect(text(html)).toContain('Remote image not shown');
    expect(text(html)).toContain('Remote chart');
  });

  it('reaches an image inside a table cell or a link label', () => {
    const nested = compile(
      [
        '| Chart |',
        '|---|',
        '| ![In a cell](assets/cell.png) |',
        '',
        'See [![In a link](assets/link.png)](https://example.com) here.',
      ].join('\n'),
      { scriptId: 'media' },
    );
    const images: PreviewImages = {};
    for (const asset of nested.assets) {
      images[asset.id] = { status: 'resolved', url: `asset://localhost/${asset.alt}.png` };
    }
    const html = render(RenderBlocks, { props: { blocks: nested.blocks, images } }).body;
    expect(html).toContain('src="asset://localhost/In a cell.png"');
    expect(html).toContain('src="asset://localhost/In a link.png"');
  });
});
