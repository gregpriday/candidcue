import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CompiledScript, SafeRenderNode } from '../contracts';
import { compile } from './compile';
import { bestOf, budgetMiss } from '../perf-budget';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../tests/fixtures/markdown/${name}`, import.meta.url)), 'utf8');

const OPTS = { scriptId: 'test-script' };
const basic = () => compile(fixture('basic.md'), OPTS);
const directives = () => compile(fixture('directives.md'), { ...OPTS, wakePhrases: ['CandidCue'] });
const media = () => compile(fixture('media.md'), OPTS);
const edge = () => compile(fixture('edge-cases.md'), OPTS);

function normalizedWords(script: CompiledScript): string[] {
  return script.spokenTokens.map((t) => t.normalized);
}

function flattenText(nodes: SafeRenderNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'link') out += flattenText(node.label);
    else if (node.type === 'table') {
      for (const row of node.rows) for (const cell of row) out += flattenText(cell) + ' ';
    }
  }
  return out;
}

describe('compile: §22 spoken-content semantics', () => {
  it('speaks paragraphs, list items, and blockquotes; skips headings by default', () => {
    const script = basic();
    const words = normalizedWords(script);
    expect(words).toContain('welcome');
    expect(words).toContain('losing'); // list item text
    expect(words).toContain('teleprompter'); // blockquote text
    // Headings are rendered but not spoken by default.
    expect(words).not.toContain('problem');
    const heading = script.blocks.find((b) => b.kind === 'heading');
    expect(heading).toBeDefined();
    expect(heading!.spoken).toBe(false);
  });

  it('speaks headings when readHeadings is enabled, with identical block ids', () => {
    const silent = basic();
    const withHeadings = compile(fixture('basic.md'), { ...OPTS, readHeadings: true });
    expect(normalizedWords(withHeadings)).toContain('problem');
    // Same token/block identity scheme across modes (§22.5): block ids equal.
    expect(withHeadings.blocks.map((b) => b.id)).toEqual(silent.blocks.map((b) => b.id));
  });

  it('speaks link labels, never URLs', () => {
    const words = normalizedWords(basic());
    expect(words).toContain('monitors');
    expect(words.join(' ')).not.toContain('https');
    const para = basic().blocks.find((b) =>
      b.renderNodes.some((n) => n.type === 'link'),
    );
    const link = para!.renderNodes.find((n) => n.type === 'link') as Extract<
      SafeRenderNode,
      { type: 'link' }
    >;
    expect(link.external).toBe(true);
    expect(link.href).toBe('https://example.com/monitors');
  });

  it('list markers and task checkboxes are omitted from speech', () => {
    const script = edge();
    const items = script.blocks.filter((b) => b.kind === 'list_item');
    expect(items.length).toBeGreaterThanOrEqual(2);
    const checked = items.find((b) => b.layoutHints?.['checked'] === true);
    expect(checked).toBeDefined();
    expect(normalizedWords(script)).toContain('recorder');
    expect(normalizedWords(script)).not.toContain('x');
  });

  it('fenced code and tables are never spoken; inline code is optional', () => {
    const script = media();
    const words = normalizedWords(script);
    expect(words).not.toContain('answer'); // fenced code
    expect(words).not.toContain('metric'); // table cell
    expect(words).not.toContain('span'); // inline code, default off
    const withCode = compile(fixture('media.md'), { ...OPTS, readInlineCode: true });
    expect(normalizedWords(withCode)).toContain('span');
  });

  it('image alt text is spoken only when explicitly enabled', () => {
    expect(normalizedWords(media())).not.toContain('pipeline');
    const withAlt = compile(fixture('media.md'), { ...OPTS, readImageAltText: true });
    expect(normalizedWords(withAlt)).toContain('pipeline');
  });

  it('drops HTML comments silently and blocks raw HTML with a warning', () => {
    const script = edge();
    expect(JSON.stringify(script.blocks)).not.toContain('This comment disappears');
    const htmlDiag = script.diagnostics.filter((d) => d.code === 'raw_html_blocked');
    expect(htmlDiag).toHaveLength(1);
    expect(htmlDiag[0]!.blocking).toBe(false);
    // The raw HTML renders as readable text, never as markup nodes.
    const rawBlock = script.blocks.find((b) =>
      flattenText(b.renderNodes).includes('Raw HTML must not pass through'),
    );
    expect(rawBlock).toBeDefined();
    expect(rawBlock!.spoken).toBe(false);
  });

  it('keeps strikethrough text spoken with a strike mark', () => {
    const script = compile('This is ~~gone~~ but spoken.', OPTS);
    expect(normalizedWords(script)).toContain('gone');
    const strike = script.blocks[0]!.renderNodes.find(
      (n) => n.type === 'text' && n.marks?.includes('strike'),
    );
    expect(strike).toBeDefined();
  });

  it('renders horizontal rules as non-spoken dividers', () => {
    const divider = basic().blocks.find((b) => b.kind === 'divider');
    expect(divider).toBeDefined();
    expect(divider!.spoken).toBe(false);
  });
});

describe('compile: §23 directives', () => {
  it('compiles [Cue: …] as a chip, excluded from speech, anchored to the next token', () => {
    const script = directives();
    const cue = script.cues.find((c) => c.label === 'smile and hold eye contact');
    expect(cue).toBeDefined();
    expect(cue!.cueType).toBe('cue');
    const block = script.blocks.find((b) => b.id === cue!.blockId)!;
    expect(cue!.anchorTokenIndex).toBe(block.startTokenIndex);
    expect(normalizedWords(script)).not.toContain('smile');
  });

  it('maps shorthand cues to built-in types', () => {
    const types = directives().cues.map((c) => c.cueType);
    expect(types).toContain('pause');
    expect(types).toContain('beat');
    expect(types).toContain('breathe');
  });

  it('anchors a mid-paragraph cue between the right tokens', () => {
    const script = directives();
    const beat = script.cues.find((c) => c.cueType === 'beat')!;
    const anchorToken = script.spokenTokens[beat.anchorTokenIndex]!;
    expect(anchorToken.normalized).toBe('in'); // "…a beat [Beat] in the middle…"
  });

  it('creates take navigation targets without touching the outline', () => {
    const script = directives();
    const takes = script.navigationTargets.filter((t) => t.type === 'take');
    expect(takes.map((t) => t.label)).toEqual(['Opening', 'Closing']);
    // Take markers are not outline chapters (§23.3).
    expect(JSON.stringify(script.outline)).not.toContain('Opening');
    // Closing take navigates to the first token of the following paragraph.
    const closing = takes[1]!;
    expect(script.spokenTokens[closing.tokenIndex]!.normalized).toBe('that');
  });

  it('compiles :::spoken into one token per spoken word at the visual range', () => {
    const script = directives();
    const override = script.blocks.find((b) => b.layoutHints?.['spokenOverride'] === true)!;
    expect(flattenText(override.renderNodes)).toBe('CandidCue v2.0');
    const tokens = script.spokenTokens.filter((t) => t.blockId === override.id);
    expect(tokens.map((t) => t.normalized)).toEqual([
      'candid', 'cue', 'version', 'two', 'point', 'oh',
    ]);
    // Source offsets point into the say: line of the original source.
    const source = fixture('directives.md');
    const first = tokens[0]!;
    expect(source.slice(first.source.utf16Start, first.source.utf16End)).toBe('Candid');
  });

  it('expands inline {say="…"} into one token per spoken word at the visual range', () => {
    const script = directives();
    const source = fixture('directives.md');
    // The engine pairs one transcript word with one script token, so
    // `API{say="A P I"}` must produce three alignable tokens rather than one
    // that no single spoken word can match (§23.4).
    const overrides = script.spokenTokens.filter((t) => t.overrideVisual === 'API');
    expect(overrides.map((t) => t.normalized)).toEqual(['a', 'p', 'i']);
    for (const token of overrides) {
      // Every token keeps the *visual* source range (§23.4).
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe('API');
    }
    // The {say=…} suffix never renders, and every token maps to the one
    // visual render node.
    const block = script.blocks.find((b) => b.id === overrides[0]!.blockId)!;
    expect(flattenText(block.renderNodes)).not.toContain('{say=');
    expect(flattenText(block.renderNodes)).toContain('API');
    const visualNode = block.renderNodes.find(
      (n) => n.type === 'text' && n.text === 'API',
    ) as Extract<SafeRenderNode, { type: 'text' }>;
    expect(visualNode.tokenIndexes).toEqual(overrides.map((t) => t.index));
  });

  it('renders :::silent content but excludes it from the spoken stream', () => {
    const script = directives();
    const silent = script.blocks.find((b) => b.kind === 'silent')!;
    expect(flattenText(silent.renderNodes)).toContain('Camera direction');
    expect(silent.spoken).toBe(false);
    expect(normalizedWords(script)).not.toContain('camera');
    expect(silent.layoutHints?.['innerKind']).toBe('paragraph');
  });

  it('renders :::stage as non-spoken stage_only content', () => {
    const script = directives();
    const stage = script.blocks.find((b) => b.kind === 'stage_only')!;
    expect(flattenText(stage.renderNodes)).toContain('Key result');
    expect(stage.spoken).toBe(false);
    expect(normalizedWords(script)).not.toContain('faster');
  });

  it('keeps :::literal-command spoken and suppresses collision warnings inside it', () => {
    const script = directives();
    const literal = script.blocks.find((b) => b.layoutHints?.['literalCommand'] === true)!;
    expect(literal.spoken).toBe(true);
    expect(normalizedWords(script)).toContain('chapter');
    expect(script.diagnostics.filter((d) => d.code === 'command_collision')).toHaveLength(0);
  });

  it('warns about wake-phrase collisions outside literal blocks', () => {
    const script = compile('Try saying Speaking Glass, go to the end, out loud.', OPTS);
    const collision = script.diagnostics.find((d) => d.code === 'command_collision');
    expect(collision).toBeDefined();
    expect(collision!.blocking).toBe(false);
    expect(collision!.suggestedAction).toBe('mark_literal_command');
  });

  it('no longer treats the former name, CandidCue, as the wake phrase', () => {
    const script = compile('Try saying CandidCue, go to the end, out loud.', OPTS);
    expect(script.diagnostics.filter((d) => d.code === 'command_collision')).toHaveLength(0);
  });

  it('a directive-only paragraph becomes a cue block', () => {
    const script = directives();
    const takeBlocks = script.blocks.filter((b) => b.kind === 'cue');
    expect(takeBlocks.length).toBeGreaterThanOrEqual(4); // 2 takes + [Pause] + [Breathe]
    for (const block of takeBlocks) expect(block.spoken).toBe(false);
  });
});

describe('compile: §23.8 directive error handling', () => {
  it('flags empty cue labels as non-blocking and empty takes as blocking', () => {
    const script = edge();
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_cue_empty', blocking: false }),
    );
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'directive_take_empty',
        blocking: true,
        severity: 'error',
        // One name for the marker everywhere (#304): Insert › Part Break, the
        // toolbar's "Insert part break" and the outline's parts.
        message: 'A part break ([Take: …]) needs a name to be a navigation target.',
      }),
    );
  });

  it('warns on duplicate take names', () => {
    expect(edge().diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'take_duplicate_name',
        // Names are compared folded, so the message carries the folded form.
        message: 'Part name "retry" is used 2 times; voice navigation will need an ordinal.',
      }),
    );
  });

  it('keeps unknown containers visible as source with a warning', () => {
    const script = edge();
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_unknown', blocking: false }),
    );
    const visible = script.blocks.find((b) =>
      flattenText(b.renderNodes).includes(':::mystery'),
    );
    expect(visible).toBeDefined();
  });

  it('compiles unclosed containers as normal text with a blocking diagnostic', () => {
    const script = compile(fixture('unclosed.md'), OPTS);
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_unclosed', blocking: true }),
    );
    expect(normalizedWords(script)).toContain('silent');
  });

  it('flags malformed :::spoken blocks as blocking', () => {
    const script = compile(':::spoken\nvisual: Only Visual\n:::\n', OPTS);
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_spoken_malformed', blocking: true }),
    );
  });

  it('directive source positions support "Open at error"', () => {
    const source = fixture('edge-cases.md');
    const script = edge();
    const diag = script.diagnostics.find((d) => d.code === 'directive_take_empty')!;
    expect(diag.source).toBeDefined();
    expect(source.slice(diag.source!.utf16Start, diag.source!.utf16End)).toBe('[Take:]');
  });
});

describe('compile: §25.2 stable identities', () => {
  it('preserves block and sentence ids when an unrelated paragraph is edited', () => {
    const original = fixture('basic.md');
    const edited = original.replace(
      'Welcome to the launch. Today we are announcing something special.',
      'A completely rewritten opening paragraph with different words.',
    );
    const a = compile(original, OPTS);
    const b = compile(edited, OPTS);
    // Compared positionally, not through a text-keyed Map: keying by rendered
    // text silently collapses duplicate blocks and would hide exactly the
    // identity-migration cases this suite exists to catch.
    expect(b.blocks).toHaveLength(a.blocks.length);
    for (let i = 0; i < a.blocks.length; i++) {
      const before = a.blocks[i]!;
      const after = b.blocks[i]!;
      expect(flattenText(after.renderNodes)).toBe(
        i === 1 ? 'A completely rewritten opening paragraph with different words.' : flattenText(before.renderNodes),
      );
      if (i === 1) expect(after.id).not.toBe(before.id);
      else expect(after.id).toBe(before.id);
    }
    // Sentence ids for untouched blocks also survive.
    const sentencesA = new Set(a.sentences.map((s) => s.id));
    const survivors = b.sentences.filter((s) => sentencesA.has(s.id));
    expect(survivors.length).toBe(b.sentences.length - 1); // only the rewritten paragraph changed
  });

  it('does not renumber later blocks when a paragraph is inserted above', () => {
    const original = fixture('basic.md');
    const inserted = original.replace(
      '## The Problem',
      'A brand new inserted paragraph before the section.\n\n## The Problem',
    );
    const a = compile(original, OPTS);
    const b = compile(inserted, OPTS);
    const laterIdsA = a.blocks.slice(2).map((blk) => blk.id);
    for (const id of laterIdsA) {
      expect(b.blocks.some((blk) => blk.id === id)).toBe(true);
    }
  });

  it('token indexes map back to exact source ranges', () => {
    const source = fixture('basic.md');
    const script = basic();
    // Every token in basic.md round-trips exactly. The old version of this
    // test accepted any non-negative range, which asserted nothing.
    for (const token of script.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
  });

  it('maps image alt-text tokens onto the alt text, not the "![" opener', () => {
    const source = 'Text before ![alt words](img.png) after.\n';
    const script = compile(source, { ...OPTS, readImageAltText: true });
    for (const token of script.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
    const alt = script.spokenTokens.find((t) => t.surface === 'alt')!;
    expect(source.slice(alt.source.utf16Start, alt.source.utf16End)).toBe('alt');
  });

  it('keeps exact source offsets across CRLF line endings and astral characters', () => {
    const source = fixture('basic.md').replace(/\n/g, '\r\n').replace('Welcome', '🎬 Welcome');
    const script = compile(source, OPTS);
    for (const token of script.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
  });

  it('gives duplicate headings distinct stable ids and ordinals', () => {
    const script = edge();
    const results = script.navigationTargets.filter(
      (t) => t.type === 'heading' && t.normalizedLabel === 'results',
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.ordinalWithinLabel).toBe(1);
    expect(results[1]!.ordinalWithinLabel).toBe(2);
    expect(results[0]!.blockId).not.toBe(results[1]!.blockId);
  });
});

describe('compile: sentences, outline, navigation', () => {
  it('segments paragraphs into sentence units with correct token spans', () => {
    const script = basic();
    const closing = script.sentences.filter((s) =>
      ['thanks for watching', 'visit'].some((p) => s.normalizedText.startsWith(p)) ||
      s.normalizedText.includes('mr smith'),
    );
    expect(closing.length).toBe(3);
    for (const sentence of script.sentences) {
      expect(sentence.endTokenIndex).toBeGreaterThanOrEqual(sentence.startTokenIndex);
      for (let i = sentence.startTokenIndex; i <= sentence.endTokenIndex; i++) {
        expect(script.spokenTokens[i]!.sentenceId).toBe(sentence.id);
      }
    }
  });

  it('treats each list item as one navigation unit even without punctuation', () => {
    const script = basic();
    const item = script.blocks.find(
      (b) => b.kind === 'list_item' && flattenText(b.renderNodes).includes('Losing your place'),
    )!;
    const itemSentences = script.sentences.filter((s) => s.blockId === item.id);
    expect(itemSentences).toHaveLength(1);
  });

  it('builds a nested outline from the heading hierarchy', () => {
    const script = basic();
    expect(script.outline).toHaveLength(1);
    const root = script.outline[0]!;
    expect(root.title).toBe('Product Launch Video');
    expect(root.children.map((c) => c.title)).toEqual(['The Problem', 'The Solution', 'Closing']);
    const solution = root.children[1]!;
    expect(solution.children.map((c) => c.title)).toEqual(['How it works']);
    // Sections span their children's tokens.
    expect(solution.endTokenIndex).toBeGreaterThanOrEqual(
      solution.children[0]!.endTokenIndex,
    );
  });

  it('creates a synthetic Opening section for content before the first heading', () => {
    const outline = edge().outline;
    expect(outline[0]!.title).toBe('Opening');
    expect(outline[0]!.blockId).toBe('');
  });

  it('creates a synthetic Script section when there are no headings', () => {
    const script = compile('Just one paragraph, no headings at all.', OPTS);
    expect(script.outline).toHaveLength(1);
    expect(script.outline[0]!.title).toBe('Script');
    expect(script.title).toBe('Script');
  });

  it('always exposes beginning and end targets', () => {
    const script = basic();
    expect(script.navigationTargets[0]!.type).toBe('beginning');
    expect(script.navigationTargets[script.navigationTargets.length - 1]!.type).toBe('end');
    expect(script.navigationTargets[script.navigationTargets.length - 1]!.tokenIndex).toBe(
      script.spokenTokens.length - 1,
    );
  });
});

describe('compile: §24 media', () => {
  it('represents local images as image blocks with asset entries', () => {
    const script = media();
    const imageBlock = script.blocks.find((b) => b.kind === 'image')!;
    expect(imageBlock.assetIds).toHaveLength(1);
    const asset = script.assets.find((a) => a.id === imageBlock.assetIds![0])!;
    expect(asset.kind).toBe('image');
    expect(asset.href).toBe('assets/pipeline.png');
    expect(asset.remote).toBe(false);
    expect(asset.blockId).toBe(imageBlock.id);
  });

  it('blocks remote images with an import_asset diagnostic', () => {
    const script = media();
    const diag = script.diagnostics.find((d) => d.code === 'remote_image_blocked')!;
    expect(diag.suggestedAction).toBe('import_asset');
    const remote = script.assets.find((a) => a.remote)!;
    expect(remote.href).toBe('https://example.com/chart.png');
  });

  it('compiles tables as structured non-spoken reference cards', () => {
    const script = media();
    const table = script.blocks.find((b) => b.kind === 'table')!;
    expect(table.spoken).toBe(false);
    expect(table.renderNodes).toHaveLength(1);
    const node = table.renderNodes[0] as Extract<SafeRenderNode, { type: 'table' }>;
    expect(node.type).toBe('table');
    expect(node.headerRow).toBe(true);
    expect(node.align).toEqual([null, 'right', 'right']);
    // Assert the real structure a renderer consumes, cell by cell, instead of
    // flattening everything to a string through a test-only helper.
    expect(node.rows).toHaveLength(3);
    expect(node.rows.map((row) => row.map((cell) => flattenText(cell)))).toEqual([
      ['Metric', 'Before', 'After'],
      ['Takes per video', '14', '3'],
      ['Editing hours', '6', '1.5'],
    ]);
    for (const row of node.rows) {
      for (const cell of row) {
        for (const cellNode of cell) expect(cellNode.type).toBe('text');
      }
    }
  });

  it('represents mermaid as a typed diagram block with raw source and cache hash', () => {
    const script = media();
    const diagram = script.blocks.find((b) => b.kind === 'diagram')!;
    expect(diagram.spoken).toBe(false);
    expect(diagram.layoutHints?.['language']).toBe('mermaid');
    expect(diagram.layoutHints?.['renderDeferred']).toBe(true);
    expect(String(diagram.layoutHints?.['contentHash'])).toMatch(/^[0-9a-f]{16}$/);
    expect(flattenText(diagram.renderNodes)).toContain('flowchart LR');
    const asset = script.assets.find((a) => a.kind === 'diagram')!;
    expect(asset.contentHash).toBe(diagram.layoutHints?.['contentHash']);
  });
});

describe('compile: §25.6 indexes, §25.7 weights, §21.8 statistics', () => {

  it('indexes take names for navigation', () => {
    const script = directives();
  });


  it('computes spoken word counts and duration from spoken tokens only', () => {
    const script = basic();
    expect(script.statistics.spokenWordCount).toBe(script.spokenTokens.length);
    expect(script.statistics.wordsPerMinute).toBe(130);
    expect(script.statistics.estimatedDurationSeconds).toBe(
      Math.round((script.spokenTokens.length / 130) * 60),
    );
    const fast = compile(fixture('basic.md'), { ...OPTS, wordsPerMinute: 220 });
    expect(fast.statistics.estimatedDurationSeconds).toBeLessThan(
      script.statistics.estimatedDurationSeconds,
    );
    // Clamped to the supported 70-220 range (§21.8).
    const clamped = compile(fixture('basic.md'), { ...OPTS, wordsPerMinute: 10_000 });
    expect(clamped.statistics.wordsPerMinute).toBe(220);
  });

  it('counts media and cue blocks', () => {
    const stats = media().statistics;
    expect(stats.imageCount).toBe(3); // local, remote, and reference image
    expect(stats.diagramCount).toBe(1);
    expect(stats.tableCount).toBe(1);
    const dStats = directives().statistics;
    expect(dStats.takeCount).toBe(2);
    expect(dStats.cueCount).toBe(4); // cue + pause + beat + breathe
    expect(dStats.nonSpokenBlockCount).toBeGreaterThanOrEqual(2); // silent + stage
  });
});

describe('compile: hostile index keys (§25.6)', () => {
  // Search indexes are plain records keyed by user text. With an inherited
  // Object.prototype, `record["constructor"] ??= []` sees the inherited
  // constructor function and never assigns, so `.push` throws and the whole
  // script fails to compile.
  const HOSTILE = [
    'constructor',
    '__proto__',
    'prototype',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ];

  it.each(HOSTILE)('compiles a script containing the word "%s"', (word) => {
    const script = compile(`# Title\n\nThe class ${word} accepts a value and ${word} again.\n`, OPTS);
    // Before the fix, "constructor" threw out of buildSearchIndexes and the
    // whole compile failed. Normalization may strip punctuation (__proto__ ->
    // "proto"), so assert on the token count rather than the literal word.
    expect(script.spokenTokens.length).toBe(9);
  });

});

describe('compile: §22.3 formatting never splits a spoken word', () => {
  it('joins source-adjacent runs into one spoken token', () => {
    const script = compile('**Candid**Cue is the product.', OPTS);
    expect(script.spokenTokens.map((t) => t.surface)).toEqual([
      'CandidCue',
      'is',
      'the',
      'product',
    ]);
  });

  it.each([
    ['**Candid**Cue', 'CandidCue'],
    ['Candid**Cue**', 'CandidCue'],
    ['*Candid*Cue', 'CandidCue'],
    ['~~Candid~~Cue', 'CandidCue'],
    ['Candid`Cue`', 'CandidCue'],
  ])('%s is one spoken word', (markup, expected) => {
    const script = compile(`${markup} ships.`, { ...OPTS, readInlineCode: true });
    expect(script.spokenTokens[0]!.surface).toBe(expected);
  });

  it('keeps a real space a real word boundary', () => {
    const script = compile('**Candid** Cue is the product.', OPTS);
    expect(script.spokenTokens.map((t) => t.surface)).toEqual([
      'Candid',
      'Cue',
      'is',
      'the',
      'product',
    ]);
  });

  /*
   * `wordTokens` is what the stage draws its word spans from, so what it has to
   * be right about is the correspondence with the words as SPLIT ON WHITESPACE
   * — including the words that are written and not spoken. It is asserted per
   * word rather than as a length, because a mapping of the right length that
   * named the wrong token would be worse than no mapping at all.
   */
  const wordTokensOf = (script: CompiledScript, blockIndex = 0) => {
    const node = script.blocks[blockIndex]!.renderNodes.find((n) => n.type === 'text') as Extract<
      SafeRenderNode,
      { type: 'text' }
    >;
    const surfaces = (node.wordTokens ?? []).map((index) =>
      index === null ? null : script.spokenTokens[index]!.surface,
    );
    return { words: node.text.split(/\s+/).filter(Boolean), node, surfaces };
  };

  it('maps every whitespace word to its token, and unspoken words to null', () => {
    const script = compile('Wait for it — like that.', OPTS);
    const { words, node, surfaces } = wordTokensOf(script);
    expect(node.wordTokens).toHaveLength(words.length);
    expect(surfaces).toEqual(['Wait', 'for', 'it', null, 'like', 'that']);
    // The older field keeps its own meaning: the tokens, not the words.
    expect(node.tokenIndexes).toHaveLength(5);
  });

  /*
   * The dangerous shape, and the reason the length check was never enough.
   *
   * "The cat/dog — bird sings." is five words and five tokens — "cat/dog" is
   * two, the dash is none — so the counts AGREE and zipping them looks sound.
   * It puts "dog" on the dash and shifts nothing back: a span anchored to a
   * word it is not, which is the one error class that can move the presenter's
   * position on the glass rather than merely fail to mark it.
   */
  it('does not anchor a word to a token that is not it when the counts happen to agree', () => {
    const script = compile('The cat/dog — bird sings.', OPTS);
    const { node, surfaces } = wordTokensOf(script);
    expect(node.tokenIndexes).toHaveLength(5);
    expect(node.text.split(/\s+/).filter(Boolean)).toHaveLength(5);
    expect(surfaces).toEqual(['The', 'cat', null, 'bird', 'sings']);
  });

  it('anchors a word said as several tokens at the word it is drawn as', () => {
    const script = compile('The API{say="a p i"} docs.', OPTS);
    const node = script.blocks[0]!.renderNodes.find(
      (n) => n.type === 'text' && n.text === 'API',
    ) as Extract<SafeRenderNode, { type: 'text' }>;
    expect(node.tokenIndexes).toHaveLength(3);
    expect(node.wordTokens).toEqual([node.tokenIndexes![0]]);
  });

  it('maps a spoken override word for word when the two sides count the same', () => {
    // A `:::spoken` block is the only override whose visual can be several
    // words, so it is the only route to the positional branch.
    const script = compile(':::spoken\nvisual: Alpha Beta\nsay: one two\n:::\n', OPTS);
    const { node, surfaces } = wordTokensOf(script);
    expect(node.text).toBe('Alpha Beta');
    expect(surfaces).toEqual(['one', 'two']);
  });

  it('anchors a mismatched spoken override at its first word and claims no more', () => {
    const script = compile(':::spoken\nvisual: Alpha Beta\nsay: one two three\n:::\n', OPTS);
    const { node, surfaces } = wordTokensOf(script);
    expect(node.tokenIndexes).toHaveLength(3);
    // Two words, three tokens, no honest correspondence: the first word takes
    // the first token and the second says nothing rather than guessing.
    expect(surfaces).toEqual(['one', null]);
  });

  it('maps a merged token onto every render node it spans', () => {
    const script = compile('**Candid**Cue ships.', OPTS);
    const merged = script.spokenTokens[0]!;
    const textNodes = script.blocks[0]!.renderNodes.filter(
      (n) => n.type === 'text',
    ) as Extract<SafeRenderNode, { type: 'text' }>[];
    expect(textNodes[0]!.text).toBe('Candid');
    expect(textNodes[0]!.marks).toEqual(['strong']);
    expect(textNodes[0]!.tokenIndexes).toContain(merged.index);
    expect(textNodes[1]!.tokenIndexes).toContain(merged.index);
    /*
     * And both halves anchor it as their own first word. The continuation's
     * slot is counted against the CONTINUATION's text, so getting it wrong
     * would put the merged word's anchor on "ships" — a word the presenter
     * reaches later, on the other side of a space.
     */
    expect(textNodes[0]!.wordTokens?.[0]).toBe(merged.index);
    expect(textNodes[1]!.wordTokens?.[0]).toBe(merged.index);
    expect(textNodes[1]!.wordTokens).toEqual([merged.index, script.spokenTokens[1]!.index]);
  });

  it('does not merge across a skipped, unspoken inline code span', () => {
    const script = compile('re`start`ing now.', OPTS); // readInlineCode off
    expect(script.spokenTokens.map((t) => t.surface)).toEqual(['re', 'ing', 'now']);
  });
});

describe('compile: §22.6 URL allowlist', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'blob:https://evil.example/x',
    '//evil.example/x',
    'JaVaScRiPt:alert(1)',
  ])('drops the link href %s with a diagnostic', (url) => {
    const script = compile(`[click](${url})`, OPTS);
    const link = script.blocks[0]!.renderNodes.find((n) => n.type === 'link') as Extract<
      SafeRenderNode,
      { type: 'link' }
    >;
    expect(link.href).toBeUndefined();
    expect(link.external).toBe(false);
    // The label stays visible and spoken (§22.2).
    expect(normalizedWords(script)).toContain('click');
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsafe_url_blocked', blocking: false }),
    );
    // The blocked URL survives only inside the diagnostic message that tells
    // the author what was removed — never in a renderable node or an asset.
    expect(JSON.stringify(script.blocks)).not.toContain('alert(1)');
    expect(JSON.stringify(script.assets)).not.toContain('alert(1)');
  });

  it.each(['https://example.com/x', 'http://example.com/x', 'mailto:a@example.com', 'assets/x.png'])(
    'keeps the allowed href %s',
    (url) => {
      const script = compile(`[click](${url})`, OPTS);
      const link = script.blocks[0]!.renderNodes.find((n) => n.type === 'link') as Extract<
        SafeRenderNode,
        { type: 'link' }
      >;
      expect(link.href).toBe(url);
      expect(script.diagnostics.some((d) => d.code === 'unsafe_url_blocked')).toBe(false);
    },
  );

  it('never registers an asset for an unsafe image URL and keeps the alt readable', () => {
    const script = compile('![Danger](javascript:alert(1))\n\n![Data](data:image/png;base64,AAA)', OPTS);
    expect(script.assets).toHaveLength(0);
    expect(script.statistics.imageCount).toBe(0);
    expect(flattenText(script.blocks[0]!.renderNodes)).toBe('Danger');
    expect(
      script.diagnostics.filter((d) => d.code === 'unsafe_url_blocked'),
    ).toHaveLength(2);
  });

  it('classifies remoteness by scheme, not by the presence of "://"', () => {
    const script = compile('![Chart](https://example.com/c.png)\n\n![Local](assets/l.png)', OPTS);
    const remote = script.assets.find((a) => a.alt === 'Chart')!;
    const local = script.assets.find((a) => a.alt === 'Local')!;
    expect(remote.remote).toBe(true);
    expect(local.remote).toBe(false);
  });
});

describe('compile: §22.1 escapes, entities, and reference links', () => {
  it('keeps an escaped bracket literal instead of compiling a cue', () => {
    const script = compile('Literal \\[Pause] stays put.', OPTS);
    expect(script.cues).toHaveLength(0);
    expect(flattenText(script.blocks[0]!.renderNodes)).toBe('Literal [Pause] stays put.');
    expect(normalizedWords(script)).toContain('pause');
  });

  it('treats a numeric entity as a literal character, not directive syntax', () => {
    // CommonMark says an entity produces the literal character; it is never
    // syntax. &#91;Beat&#93; must therefore stay text.
    const script = compile('Entity &#91;Beat&#93; stays put.', OPTS);
    expect(script.cues).toHaveLength(0);
    expect(flattenText(script.blocks[0]!.renderNodes)).toBe('Entity [Beat] stays put.');
  });

  it('still compiles a genuine unescaped directive in the same paragraph', () => {
    const script = compile('Escaped \\[Pause] but real [Beat] here.', OPTS);
    expect(script.cues.map((c) => c.cueType)).toEqual(['beat']);
  });

  it('keeps source offsets aligned through escapes and entities', () => {
    // Escapes and entities make the decoded text shorter than the source, so
    // offsets after them used to be clamped guesses. Every token now points
    // at the source characters that actually produced it.
    const source = 'A \\[literal] and an &amp; entity and a word.';
    const script = compile(source, OPTS);
    const at = (surface: string) => {
      const token = script.spokenTokens.find((t) => t.surface === surface)!;
      return source.slice(token.source.utf16Start, token.source.utf16End);
    };
    expect(at('literal')).toBe('literal');
    expect(at('entity')).toBe('entity');
    expect(at('word')).toBe('word');
    // The ampersand token spans the whole entity it was decoded from.
    expect(at('&')).toBe('&amp;');
  });

  it('resolves reference links through their definitions', () => {
    const script = compile(
      'See [the docs][d] for details.\n\n[d]: https://example.com/docs\n',
      OPTS,
    );
    const link = script.blocks[0]!.renderNodes.find((n) => n.type === 'link') as Extract<
      SafeRenderNode,
      { type: 'link' }
    >;
    expect(link.href).toBe('https://example.com/docs');
    expect(link.external).toBe(true);
    expect(flattenText(link.label)).toBe('the docs');
    // Not the literal bracket text the compiler used to emit.
    expect(flattenText(script.blocks[0]!.renderNodes)).not.toContain('[the docs]');
  });

  it('resolves reference images into real assets', () => {
    const script = media();
    const asset = script.assets.find((a) => a.alt === 'Reference chart')!;
    expect(asset).toBeDefined();
    expect(asset.href).toBe('assets/reference.png');
    expect(asset.remote).toBe(false);
    expect(asset.blockId).not.toBe('');
  });

  it('runs reference URLs through the same allowlist', () => {
    const script = compile('See [x][d].\n\n[d]: javascript:alert(1)\n', OPTS);
    const link = script.blocks[0]!.renderNodes.find((n) => n.type === 'link') as Extract<
      SafeRenderNode,
      { type: 'link' }
    >;
    expect(link.href).toBeUndefined();
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unsafe_url_blocked' }),
    );
  });

  it('leaves a truly undefined reference as literal bracket text', () => {
    const script = compile('See [the docs][nope] here.', OPTS);
    expect(flattenText(script.blocks[0]!.renderNodes)).toContain('[the docs]');
  });
});

describe('compile: §22.2 nested blocks keep spoken semantics', () => {
  it('never speaks fenced code nested in a blockquote', () => {
    const script = compile('> Quote text.\n>\n> ```\n> const answer = 42;\n> ```\n', OPTS);
    const words = normalizedWords(script);
    expect(words).toEqual(['quote', 'text']);
    expect(words).not.toContain('const');
    expect(words).not.toContain('answer');
    // It still renders, as a code run.
    expect(flattenText(script.blocks[0]!.renderNodes)).toContain('const answer = 42;');
  });

  it('never speaks a table nested in a list item, but keeps it structured', () => {
    const script = compile('- item text\n\n  | a | b |\n  | - | - |\n  | c | d |\n', OPTS);
    expect(normalizedWords(script)).toEqual(['item', 'text']);
    const item = script.blocks.find((b) => b.kind === 'list_item')!;
    const table = item.renderNodes.find((n) => n.type === 'table');
    expect(table).toBeDefined();
  });

  it('speaks nested headings only when readHeadings is on', () => {
    const source = '> Quote text.\n>\n> ## Nested heading\n';
    expect(normalizedWords(compile(source, OPTS))).toEqual(['quote', 'text']);
    const withHeadings = compile(source, { ...OPTS, readHeadings: true });
    expect(normalizedWords(withHeadings)).toContain('nested');
  });

  it('still speaks a nested list inside a blockquote', () => {
    const script = compile('> Quote text.\n>\n> - nested item\n', OPTS);
    expect(normalizedWords(script)).toEqual(['quote', 'text', 'nested', 'item']);
  });
});

describe('compile: §23.5-§23.7 container nesting', () => {
  it('keeps a :::spoken block spoken inside a :::stage container (§23.6)', () => {
    const script = compile(
      ':::stage\nKey result\n\n:::spoken\nvisual: v2.0\nsay: version two point oh\n:::\n\n:::\n',
      OPTS,
    );
    expect(script.diagnostics.filter((d) => d.code === 'directive_unclosed')).toHaveLength(0);
    expect(script.diagnostics.filter((d) => d.code === 'directive_stray_fence')).toHaveLength(0);
    const stage = script.blocks.find((b) => b.kind === 'stage_only')!;
    expect(flattenText(stage.renderNodes)).toContain('Key result');
    const override = script.blocks.find((b) => b.layoutHints?.['spokenOverride'] === true)!;
    expect(override.spoken).toBe(true);
    expect(normalizedWords(script)).toEqual(['version', 'two', 'point', 'oh']);
  });

  it('lets an enclosing :::silent silence a nested :::literal-command', () => {
    const script = compile(
      ':::silent\nA note.\n\n:::literal-command\nCandidCue, go to chapter one.\n:::\n\n:::\n',
      { ...OPTS, wakePhrases: ['CandidCue'] },
    );
    expect(script.spokenTokens).toHaveLength(0);
    for (const block of script.blocks) expect(block.spoken).toBe(false);
    expect(script.literalCommandRanges).toHaveLength(0);
  });

  it('reports only the genuinely unclosed container when others nest cleanly', () => {
    const script = compile(fixture('unclosed.md'), OPTS);
    const unclosed = script.diagnostics.filter((d) => d.code === 'directive_unclosed');
    expect(unclosed.map((d) => d.blocking)).toEqual([true, false, false]);
    expect(normalizedWords(script)).toContain('silent');
  });

  it('leaves a directive inside a fenced code block alone', () => {
    const script = edge();
    const fence = script.blocks.find(
      (b) => b.kind === 'code' && flattenText(b.renderNodes).includes(':::spoken'),
    )!;
    expect(fence).toBeDefined();
    expect(fence.spoken).toBe(false);
    expect(flattenText(fence.renderNodes)).toContain('[Take: InsideFence]');
    // No take target and no spoken override leaked out of the fence.
    expect(script.navigationTargets.some((t) => t.label === 'InsideFence')).toBe(false);
  });

  it('keeps a malformed but closed :::spoken block visible as source (§23.8)', () => {
    const script = compile('Before.\n\n:::spoken\nvisual: Only Visual\n:::\n\nAfter.\n', OPTS);
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_spoken_malformed', blocking: true }),
    );
    const card = script.blocks.find(
      (b) => b.layoutHints?.['directiveError'] === 'directive_spoken_malformed',
    )!;
    expect(card).toBeDefined();
    expect(card.spoken).toBe(false);
    // The authored text must not vanish from preview.
    expect(flattenText(card.renderNodes)).toContain('Only Visual');
    expect(script.blocks.map((b) => flattenText(b.renderNodes))[0]).toBe('Before.');
  });
});

describe('compile: §23.7 literal-command token ranges', () => {
  it('exports typed spoken-token ranges for literal-command blocks', () => {
    const script = directives();
    expect(script.literalCommandRanges).toHaveLength(1);
    const range = script.literalCommandRanges[0]!;
    const words = script.spokenTokens
      .slice(range.startTokenIndex, range.endTokenIndex + 1)
      .map((t) => t.normalized);
    expect(words).toEqual(['candidcue', 'go', 'to', 'chapter', 'one']);
    const block = script.blocks.find((b) => b.layoutHints?.['literalCommand'] === true)!;
    expect(range.startTokenIndex).toBe(block.startTokenIndex);
    expect(range.endTokenIndex).toBe(block.endTokenIndex);
  });

  it('is empty when no literal-command block exists', () => {
    expect(basic().literalCommandRanges).toEqual([]);
  });

  it('merges adjacent literal-command blocks into one range', () => {
    const script = compile(
      ':::literal-command\nCandidCue, go to chapter one.\n\nCandidCue, go to the end.\n:::\n',
      { ...OPTS, wakePhrases: ['CandidCue'] },
    );
    expect(script.literalCommandRanges).toHaveLength(1);
    expect(script.literalCommandRanges[0]!.startTokenIndex).toBe(0);
    expect(script.literalCommandRanges[0]!.endTokenIndex).toBe(script.spokenTokens.length - 1);
  });
});

describe('compile: §25.2 duplicate-block identity', () => {
  const dup = (source: string) => compile(source, OPTS);

  it('never hands one paragraph the identity of a deleted twin', () => {
    const both = dup('Alpha.\n\nSame text here.\n\nSame text here.\n\nOmega.\n');
    const ids = both.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Delete the FIRST of the two identical paragraphs.
    const after = dup('Alpha.\n\nSame text here.\n\nOmega.\n');
    const survivor = after.blocks.find((b) => flattenText(b.renderNodes) === 'Same text here.')!;
    // The survivor may legitimately get a fresh ID, but it must never inherit
    // the ID that belonged to the paragraph the user deleted.
    expect(survivor.id).not.toBe(ids[1]);
  });

  it('gives every member of a duplicate group a distinct id', () => {
    const script = dup('A.\n\nSame.\n\nB.\n\nSame.\n\nC.\n\nSame.\n');
    const ids = script.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports, rather than silently guesses, truly indistinguishable duplicates', () => {
    const script = dup('Same.\n\nSame.\n\nSame.\n\nSame.\n');
    expect(script.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'block_id_ambiguous', blocking: false }),
    );
    const ids = script.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not alias two long paragraphs that share a 500-character prefix', () => {
    const prefix = 'word '.repeat(200);
    const a = dup(`${prefix}alpha.\n`);
    const b = dup(`${prefix}beta.\n`);
    expect(a.blocks[0]!.id).not.toBe(b.blocks[0]!.id);
  });

  it('gives duplicate headings distinct outline ids without a document ordinal', () => {
    const script = edge();
    const outlineIds: string[] = [];
    const walk = (nodes: typeof script.outline) => {
      for (const node of nodes) {
        outlineIds.push(node.id);
        walk(node.children);
      }
    };
    walk(script.outline);
    expect(new Set(outlineIds).size).toBe(outlineIds.length);
    for (const id of outlineIds) expect(id).toMatch(/^h[0-9a-f]{16}$/);
  });
});

describe('compile: determinism, hashes, empty input, performance', () => {
  it('is deterministic', () => {
    const a = JSON.stringify(basic());
    const b = JSON.stringify(basic());
    expect(a).toBe(b);
  });

  it('changes sourceHash with content and settingsHash with options', () => {
    const a = basic();
    const b = compile(fixture('basic.md') + '\nExtra line.', OPTS);
    expect(a.sourceHash).not.toBe(b.sourceHash);
    const c = compile(fixture('basic.md'), { ...OPTS, readHeadings: true });
    expect(a.settingsHash).not.toBe(c.settingsHash);
  });

  it('compiles empty source to a valid empty script', () => {
    const script = compile('', OPTS);
    expect(script.blocks).toHaveLength(0);
    expect(script.spokenTokens).toHaveLength(0);
    expect(script.outline[0]!.title).toBe('Script');
    expect(script.statistics.spokenWordCount).toBe(0);
    expect(script.statistics.estimatedDurationSeconds).toBe(0);
    expect(script.navigationTargets.map((t) => t.type)).toEqual(['beginning', 'end']);
    // Diagnostics gate Go Live, and empty is what every new script now starts
    // as — so a blank document has to be clean, not merely well-formed.
    expect(script.diagnostics ?? []).toEqual([]);
  });

  it('compiles a representative 5,000-word script quickly (§25.8)', () => {
    // Representative, not a flat wall of identical paragraphs: headings,
    // lists, links, cues and — critically — several hundred directive
    // containers, so a per-block linear scan over container regions shows up
    // as O(blocks x containers) instead of hiding behind a region-free script.
    let source = '# Big Script\n\n';
    for (let i = 0; i < 170; i++) {
      source += `## Section ${i}\n\n`;
      source += `The quick brown fox jumps over the lazy dog while narrating demo ${i}.\n\n`;
      source += `[Cue: look up] Another sentence with a [link](https://example.com/${i}) in it.\n\n`;
      source += `- List item ${i} about recording takes\n- Second item ${i}\n\n`;
      source += `:::silent\nProduction note ${i}.\n:::\n\n`;
      source += `:::literal-command\nCandidCue, go to section ${i}.\n:::\n\n`;
    }
    // Fastest of several runs — see `bestOf`. A single measurement here was a
    // measurement of how busy the machine was.
    const run = bestOf(() => compile(source, OPTS));
    const script = run.value;
    expect(script.statistics.spokenWordCount).toBeGreaterThan(4800);
    expect(script.blocks.length).toBeGreaterThan(1000);
    // Spec §25.8 targets 100 ms on a 2024 laptop; 400 ms leaves headroom for
    // slower CI while still failing loudly on a quadratic regression (the
    // pre-fix container lookup blew past this).
    expect(budgetMiss('5,000-word compile', run, 400)).toBeNull();
  });
});

describe('compile: a leading byte-order mark (#247)', () => {
  // Windows editors save "UTF-8 with BOM". remark skips the mark; the scanners
  // and every source slice used to see it, so line one stopped meaning anything.
  const BOM = '﻿';

  it.each([':::stage', ':::silent'])('keeps a %s block that opens on line one out of speech', (fence) => {
    const source = `${fence}\nWalk to the whiteboard.\n:::\n\nHello everyone.\n`;
    const plain = compile(source, OPTS);
    const marked = compile(BOM + source, OPTS);
    expect(normalizedWords(marked)).toEqual(normalizedWords(plain));
    expect(normalizedWords(marked)).toHaveLength(2);
    expect(marked.blocks.map((b) => b.kind)).toEqual(plain.blocks.map((b) => b.kind));
    expect(marked.diagnostics.map((d) => d.code)).toEqual(plain.diagnostics.map((d) => d.code));
    expect(marked.diagnostics.map((d) => d.code)).not.toContain('directive_stray_fence');
  });

  it('maps the first token onto the real document, mark included', () => {
    const source = `${BOM}Hello world.`;
    const [hello] = compile(source, OPTS).spokenTokens;
    expect(hello!.source).toEqual({ utf16Start: 1, utf16End: 6 });
    expect(source.slice(hello!.source.utf16Start, hello!.source.utf16End)).toBe('Hello');
  });

  it('maps every token, a line-one heading included, onto the original source', () => {
    const source = `${BOM}# Quarterly update\n\nHello everyone, thanks for **coming** today.\n`;
    for (const readHeadings of [false, true]) {
      const script = compile(source, { ...OPTS, readHeadings });
      const plain = compile(source.slice(1), { ...OPTS, readHeadings });
      expect(normalizedWords(script)).toEqual(normalizedWords(plain));
      for (const token of script.spokenTokens) {
        expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
      }
      // Exactly one character later than the same script without the mark.
      expect(script.spokenTokens.map((t) => t.source.utf16Start)).toEqual(
        plain.spokenTokens.map((t) => t.source.utf16Start + 1),
      );
    }
  });

  it('gives the text the same identity with or without the mark', () => {
    // The editor can hold a pasted mark the saved file does not, and the take
    // compiles the saved file. The stale-editor gate compares these two hashes
    // and would otherwise refuse the take as "changed after it was prepared".
    const body = ':::stage\nWalk to the whiteboard.\n:::\n\nHello everyone.\n';
    const plain = compile(body, OPTS).sourceHash;
    expect(compile(BOM + body, OPTS).sourceHash).toBe(plain);
    expect(compile(BOM + BOM + body, OPTS).sourceHash).toBe(plain);
    expect(compile(body.replace('Hello', 'Hullo'), OPTS).sourceHash).not.toBe(plain);
  });

  it('does not shift twice when front matter blanks the mark with it', () => {
    const body = ['---', 'coach:', '  mode: minimal', '---', '', 'All good here.', ''].join('\n');
    const plain = compile(body, OPTS);
    const marked = compile(BOM + body, OPTS);
    expect(marked.blocks.map((b) => b.kind)).toEqual(['paragraph']);
    expect(marked.diagnostics).toEqual([]);
    expect(normalizedWords(marked)).toEqual(normalizedWords(plain));
    for (const token of marked.spokenTokens) {
      expect((BOM + body).slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
    expect(marked.spokenTokens.map((t) => t.source.utf16Start)).toEqual(
      plain.spokenTokens.map((t) => t.source.utf16Start + 1),
    );
  });
});

describe('compile: a leading `coach:` block stays hidden (#208)', () => {
  // The retired coaching rail read a `coach:` front-matter block, and scripts
  // written for it still open with one. The block must stay off the glass and
  // out of the spoken stream with nothing reported about it — and only that
  // block: a leading `---` without the key is ordinary Markdown, as it always
  // was, so a script that opens with a rule keeps its rule.
  const BOM = '﻿';
  const kinds = (script: CompiledScript) => script.blocks.map((b) => b.kind);
  const lines = (...rows: string[]) => [...rows, '', 'Hello world.', ''].join('\n');

  it.each([
    ['a mapping', lines('---', 'coach:', '  mode: studio', '  style: calm', '  target_wpm: [130, 165]', '---')],
    ['a scalar', lines('---', 'coach: off', '---')],
    ['an empty key', ['---', 'coach:', '---', 'Hello world.', ''].join('\n')],
    ['other keys beside it', lines('---', 'title: Launch', 'coach:', '  mode: minimal', '---')],
    ['a `...` closer', lines('---', 'coach:', '  mode: minimal', '...')],
    ['spaces after the delimiters', lines('--- ', 'coach:', '  mode: minimal', '---  ')],
    ['CRLF line endings', lines('---', 'coach:', '  mode: minimal', '---').replace(/\n/g, '\r\n')],
    ['a byte-order mark', `${BOM}${lines('---', 'coach:', '  mode: minimal', '---')}`],
    [
      'a byte-order mark and CRLF together',
      `${BOM}${lines('---', 'coach:', '  mode: minimal', '---').replace(/\n/g, '\r\n')}`,
    ],
    ['a space before the colon', lines('---', 'coach :', '  mode: minimal', '---')],
    ['a tab before the colon', lines('---', 'coach\t:', '  mode: minimal', '---')],
    ['a tab after the colon', lines('---', 'coach:\toff', '---')],
    [
      'values the coaching parser used to reject',
      lines('---', 'coach:', '  mode: turbo', '  target_wpm: fast', '  filler_detection: wide', '---'),
    ],
  ])('hides %s', (_name, source) => {
    const script = compile(source, OPTS);
    expect(kinds(script)).toEqual(['paragraph']);
    expect(flattenText(script.blocks[0]!.renderNodes)).toBe('Hello world.');
    expect(script.diagnostics).toEqual([]);
    expect(normalizedWords(script)).toEqual(['hello', 'world']);
    for (const token of script.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
  });

  // Headings are not spoken by default, so the words alone could not tell a
  // hidden block from one that became a heading; the block kinds can.
  const heading = ['divider', 'heading', 'paragraph'];
  it('compiles exactly as the same script with the block blanked by hand', () => {
    // Everything but the source hash: blocks, render nodes, token numbering,
    // sentence ids, navigation. The block holds a container fence and an
    // astral character, and a real container follows it.
    const front = ['---', 'coach:', '  style: calm 🎙️', '  mode: studio', ':::silent', '---', ''].join('\n');
    const body = [
      '# Opening',
      '',
      'Hello **everyone**, and welcome. This is the *first* take.',
      '',
      ':::silent',
      'Not read aloud.',
      ':::',
      '',
      '- One item.',
      '- <!-- cc:pace 150-190 --> Two items.',
      '',
    ].join('\n');
    const withoutHash = ({ sourceHash: _hash, ...rest }: CompiledScript) => rest;
    const legacy = compile(front + body, OPTS);
    const blanked = compile(front.replace(/[^\r\n]/g, ' ') + body, OPTS);
    expect(withoutHash(legacy)).toEqual(withoutHash(blanked));
    expect(legacy.diagnostics).toEqual([]);
    expect(normalizedWords(legacy).join(' ')).toBe(
      'hello everyone and welcome this is the first take one item two items',
    );
  });

  it.each([
    [
      'only the first closer ends it',
      lines('---', 'coach: off', '---', '', 'Visible prose.', '', '---'),
      ['paragraph', 'divider', 'paragraph'],
      ['visible', 'prose', 'hello', 'world'],
    ],
    ['a document that is nothing but the block', '---\ncoach:\n---\n', [], []],
    ['the block without a final newline', '---\ncoach:\n---', [], []],
  ])('hides no more than the block when %s', (_name, source, expectedKinds, words) => {
    const script = compile(source, OPTS);
    expect(kinds(script)).toEqual(expectedKinds);
    expect(script.diagnostics).toEqual([]);
    expect(normalizedWords(script)).toEqual(words);
  });

  it('puts the keys of an unrecognised block on the glass, as it always did', () => {
    const script = compile(lines('---', 'coaching_off_key:', '  mode: studio', '---'), OPTS);
    const keys = script.blocks.find((b) => b.kind === 'heading');
    expect(flattenText(keys?.renderNodes ?? [])).toContain('mode: studio');
  });

  it.each([
    ['no `coach:` key', lines('---', 'coaching_off_key:', '  mode: studio', '---'), heading, ['hello', 'world']],
    ['a longer key', lines('---', 'coach_x:', '  mode: studio', '---'), heading, ['hello', 'world']],
    ['a `...` opener', lines('...', 'coach: off', '---'), ['heading', 'paragraph'], ['hello', 'world']],
    ['a lone rule', '---\n', ['divider'], []],
    ['an indented key', lines('---', '  coach:', '    style: calm', '---'), heading, ['hello', 'world']],
    ['a capitalised key', lines('---', 'Coach:', '  style: calm', '---'), heading, ['hello', 'world']],
    ['a blank line before it', `\n${lines('---', 'coach:', '  style: calm', '---')}`, heading, ['hello', 'world']],
    [
      'no closing line',
      lines('---', 'coach:', '  style: calm'),
      ['divider', 'paragraph', 'paragraph'],
      ['coach', 'style', 'calm', 'hello', 'world'],
    ],
    [
      'the key after the block closes',
      lines('---', 'title: Launch', '---', '', 'coach: off'),
      ['divider', 'heading', 'paragraph', 'paragraph'],
      ['coach', 'off', 'hello', 'world'],
    ],
    [
      'a rule, a heading and a rule',
      lines('---', '# Heading', '---'),
      ['divider', 'heading', 'divider', 'paragraph'],
      ['hello', 'world'],
    ],
    [
      'a rule, the text and a rule',
      lines('---', '', 'Note: something', '', '---'),
      ['divider', 'paragraph', 'divider', 'paragraph'],
      ['note', 'something', 'hello', 'world'],
    ],
  ])('renders a leading block with %s as Markdown', (_name, source, expectedKinds, words) => {
    const script = compile(source, OPTS);
    expect(kinds(script)).toEqual(expectedKinds);
    expect(script.diagnostics).toEqual([]);
    expect(normalizedWords(script)).toEqual(words);
  });

  it('no longer reports a coaching result at all', () => {
    const script = compile(lines('---', 'coach:', '  mode: minimal', '---'), OPTS);
    expect('coaching' in script).toBe(false);
  });
});

describe('compile: words past the first line of a quote or wrapped list item (#251)', () => {
  // remark strips each continuation line's `> ` or indent out of the text it
  // hands over, and the mapping back onto the source used to give up there and
  // guess: every word after line one landed early by the prefix width, more so
  // on every line, and From here picked the wrong sentence.

  /** Every spoken word must read back out of the source at the range it claims. */
  function expectWordsAt(source: string, words: string[]): CompiledScript {
    const script = compile(source, OPTS);
    expect(normalizedWords(script)).toEqual(words);
    for (const token of script.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
    return script;
  }

  const CASES: [string, string, string[]][] = [
    ['a two-line quote', '> First line here,\n> second line two.\n', ['first', 'line', 'here', 'second', 'line', 'two']],
    ['a three-line quote', '> Then we go.\n> On and on.\n> Until we finish.\n', ['then', 'we', 'go', 'on', 'and', 'on', 'until', 'we', 'finish']],
    ['a wrapped list item', '- This item wraps\n  onto two lines.\n', ['this', 'item', 'wraps', 'onto', 'two', 'lines']],
    ['a wrapped ordered item', '1. One item\n   wraps here.\n', ['one', 'item', 'wraps', 'here']],
    ['a deeper continuation indent', '- Deep item\n    continues.\n', ['deep', 'item', 'continues']],
    ['a quote inside a list item', '- > Quoted in\n  > a list item.\n', ['quoted', 'in', 'a', 'list', 'item']],
    ['a list inside a quote', '> - Listed in\n>   a quote.\n', ['listed', 'in', 'a', 'quote']],
    ['a nested quote', '> > Deeply quoted\n> > words here.\n', ['deeply', 'quoted', 'words', 'here']],
    ['loosely spaced nested markers', '>  > Loose nested\n>  > markers.\n', ['loose', 'nested', 'markers']],
    ['a quote without the space', '>Tight quote\n>marker here.\n', ['tight', 'quote', 'marker', 'here']],
    ['a tab after the marker', '>\tTabbed quote\n>\tcontinues.\n', ['tabbed', 'quote', 'continues']],
    ['a tab-indented list item', '-\tTabbed item\n\tcontinues.\n', ['tabbed', 'item', 'continues']],
    ['a lazy continuation', '> Lazy quote\ncontinues bare.\n', ['lazy', 'quote', 'continues', 'bare']],
    ['blanks before a soft break', 'Trailing space \nthen a tab\t\nthen more.\n', ['trailing', 'space', 'then', 'a', 'tab', 'then', 'more']],
    ['an indented plain continuation', 'Indented\n   continuation\n\t lines.\n', ['indented', 'continuation', 'lines']],
    ['formatting across a quoted line', '> One *two\n> three* four.\n', ['one', 'two', 'three', 'four']],
    ['a link across a quoted line', '> See [the two\n> docs](https://example.com) now.\n', ['see', 'the', 'two', 'docs', 'now']],
    ['an indented line that keeps a marker', '> Plain\n>     >kept marker.\n', ['plain', 'kept', 'marker']],
    ['an unquoted line that keeps a marker', 'Plain\n    > kept marker.\n', ['plain', 'kept', 'marker']],
    ['an entity for a leading space', '> One\n> &#32; two.\n', ['one', 'two']],
    ['an entity for a newline', '> One&#10;\n> two.\n', ['one', 'two']],
  ];

  it.each(CASES)('maps every word of %s onto its own characters', (_name, source, words) => {
    expectWordsAt(source, words);
  });

  it.each(['\r\n', '\r'])('keeps the same mapping with %j line endings', (ending) => {
    for (const [, source, words] of CASES) {
      expectWordsAt(source.replace(/\n/g, ending), words);
    }
  });

  it('maps a quote that opens on a byte-order mark', () => {
    expectWordsAt('﻿> Quoted first\n> and second.\n', ['quoted', 'first', 'and', 'second']);
  });

  it('starts every sentence of a long quote on its own first word', () => {
    // The issue's script: From here with the caret on line nine offered
    // sentence ten.
    const numbers = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const lines = numbers.map((n) => `Sentence number ${n} of the quoted testimonial.`);
    const source = lines.map((line) => `> ${line}\n`).join('');
    const script = compile(source, OPTS);
    expect(script.sentences).toHaveLength(10);
    script.sentences.forEach((sentence, i) => {
      const { utf16Start, utf16End } = sentence.source;
      expect(utf16Start).toBe(source.indexOf(lines[i]!));
      expect(source.slice(utf16Start, utf16End)).toBe(lines[i]!.slice(0, -1));
    });
    const caret = source.indexOf('testimonial', source.indexOf('number nine'));
    const picked = script.sentences.filter((s) => s.source.utf16Start <= caret).at(-1)!;
    expect(picked.normalizedText).toContain('number nine');
  });

  it('compiles a directive on a later line, at its own range', () => {
    for (const source of ['> First line.\n> [Pause] Then the next.\n', '- First line\n  [Pause] then the next.\n']) {
      const script = compile(source, OPTS);
      expect(script.cues.map((c) => c.cueType)).toEqual(['pause']);
      const [cue] = script.cues;
      expect(source.slice(cue!.source.utf16Start, cue!.source.utf16End)).toBe('[Pause]');
      expect(script.spokenTokens[cue!.anchorTokenIndex]!.normalized).toBe('then');
      expect(normalizedWords(script)).not.toContain('pause');
    }
  });

  it('ends a directive before the blanks a soft break drops', () => {
    const source = '> First [Beat] \n> next line.\n';
    const [cue] = compile(source, OPTS).cues;
    expect(source.slice(cue!.source.utf16Start, cue!.source.utf16End)).toBe('[Beat]');
  });

  it('keeps an escaped or entity bracket on a later line as text', () => {
    // The real [Breathe] beside them proves the line mapped: a failed map
    // would suppress every directive and pass the escapes for the wrong reason.
    const source = '> First line.\n> \\[Pause] and &#91;Beat&#93; stay, [Breathe] next.\n';
    const script = compile(source, OPTS);
    expect(script.cues.map((c) => c.cueType)).toEqual(['breathe']);
    const [cue] = script.cues;
    expect(source.slice(cue!.source.utf16Start, cue!.source.utf16End)).toBe('[Breathe]');
    expect(script.spokenTokens[cue!.anchorTokenIndex]!.normalized).toBe('next');
    expect(normalizedWords(script)).toEqual(expect.arrayContaining(['pause', 'beat']));
  });

  it('reads an escaped backslash before a bracket as literal syntax', () => {
    // `\\[Pause]` is an escaped backslash and then a real directive; a third
    // backslash escapes the bracket again.
    for (const prefix of ['', '> First line.\n> ']) {
      const real = `${prefix}\\\\[Pause] then on.\n`;
      const [cue] = compile(real, OPTS).cues;
      expect(cue?.cueType).toBe('pause');
      expect(real.slice(cue!.source.utf16Start, cue!.source.utf16End)).toBe('[Pause]');
      expect(compile(`${prefix}\\\\\\[Pause] then on.\n`, OPTS).cues).toHaveLength(0);
    }
  });

  it('ends a lone carriage-return line even when an entity newline follows', () => {
    // The value reads "One\r\n[Pause] two." and looks like CRLF; the source
    // says the `\r` ended the line and the `\n` came from `&#10;`.
    const source = '> One\r> &#10;[Pause] two.\r';
    const script = expectWordsAt(source, ['one', 'two']);
    const [cue] = script.cues;
    expect(cue?.cueType).toBe('pause');
    expect(source.slice(cue!.source.utf16Start, cue!.source.utf16End)).toBe('[Pause]');
  });

  it('maps a take marker after an escaped marker on a later line', () => {
    const source = '> First\n> \\>kept [Take: Intro] next.\n';
    const script = expectWordsAt(source, ['first', 'kept', 'next']);
    const take = script.cues.find((c) => c.cueType === 'take')!;
    expect(source.slice(take.source.utf16Start, take.source.utf16End)).toBe('[Take: Intro]');
    expect(script.spokenTokens[take.anchorTokenIndex]!.normalized).toBe('next');
    expect(script.navigationTargets.some((t) => t.type === 'take' && t.label === 'Intro')).toBe(true);
  });

  it('maps a quoted heading that spans lines when headings are read', () => {
    const source = '> Title first\n> title second\n> ---\n';
    const script = compile(source, { ...OPTS, readHeadings: true });
    expect(normalizedWords(script)).toEqual(['title', 'first', 'title', 'second']);
    for (const token of script.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
  });

  it('stays linear on a continuation line that keeps a long run of markers', () => {
    // Trying every start inside the run, longest first, re-matched the run
    // once per start: quadratic in its length. Spaced, so the run is many
    // short words rather than one huge one, which is slow for other reasons.
    const line = `>     ${'> '.repeat(10_000)}last word.\n`;
    const source = `> First\n${line}${line}${line}`;
    const run = bestOf(() => compile(source, OPTS));
    expect(normalizedWords(run.value)).toEqual(['first', 'last', 'word', 'last', 'word', 'last', 'word']);
    for (const token of run.value.spokenTokens) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe(token.surface);
    }
    expect(budgetMiss('long kept-marker run', run, 250)).toBeNull();
  });

  it.each([
    ['entities', `${'&amp; '.repeat(8_000)}last word.`],
    ['dropped trailing blanks', `last word.${'\t'.repeat(8_000)}`],
  ])('stays fast when %s leave a long kept-marker run room to retry', (_name, tail) => {
    // Both make the source line longer than the text it decodes to, so the
    // length bound alone leaves every marker in the run as a candidate start.
    const source = `> First\n>     ${'> '.repeat(8_000)}${tail}\n> after.\n`;
    const run = bestOf(() => compile(source, OPTS));
    expect(normalizedWords(run.value)).toEqual(expect.arrayContaining(['last', 'word', 'after']));
    expect(budgetMiss('long kept-marker run with slack', run, 250)).toBeNull();
  });

  it('maps a spoken alias on a later line onto its visual word', () => {
    const source = '> Our new\n> API{say="a p i"} ships.\n';
    const script = compile(source, OPTS);
    const overrides = script.spokenTokens.filter((t) => t.overrideVisual === 'API');
    expect(overrides.map((t) => t.normalized)).toEqual(['a', 'p', 'i']);
    for (const token of overrides) {
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe('API');
    }
  });

  it('joins a word across formatting on a later line, as on the first', () => {
    // `Candid` ends a text node that started on line one; only an exact map
    // lets it join the bold `Cue` after it.
    const quoted = compile('> One line\n> and Candid**Cue** today.\n', OPTS);
    const single = compile('and Candid**Cue** today.\n', OPTS);
    expect(normalizedWords(quoted).slice(2)).toEqual(normalizedWords(single));
    expect(normalizedWords(quoted)).toContain('candidcue');
  });
});

/*
 * Footnotes parse and are not rendered. They used to be dropped with nothing to
 * say so — the one construct whose text vanished silently, where every other
 * unrendered node becomes readable source with an `unsupported_syntax` warning.
 * They are still not rendered; the loss is now reported, and nothing else moves.
 */
describe('compile: footnotes are reported, not silently lost', () => {
  const footnoted = 'Revenue grew[^q3] last quarter.\n\n[^q3]: Unaudited figures.\n';

  function footnoteWarnings(script: CompiledScript) {
    return script.diagnostics.filter(
      (d) => d.code === 'unsupported_syntax' && /footnote/i.test(d.message),
    );
  }

  it('warns once per footnote, without blocking, and says what is lost', () => {
    const script = compile(footnoted, OPTS);
    const warnings = footnoteWarnings(script);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning!.severity).toBe('warning');
    expect(warning!.blocking).toBe(false);
    expect(warning!.message).toContain('[^q3]');
    expect(warning!.message).toMatch(/not shown or read/);
    // It points at the definition, where the lost text is.
    const { utf16Start, utf16End } = warning!.source!;
    expect(footnoted.slice(utf16Start, utf16End)).toBe('[^q3]: Unaudited figures.');
  });

  it('warns once for a footnote however many times it is cited', () => {
    const cited = 'One[^a] and two[^a] and three[^a].\n\n[^a]: The note.\n';
    expect(footnoteWarnings(compile(cited, OPTS))).toHaveLength(1);
    const two = 'One[^a] and two[^b].\n\n[^a]: First.\n\n[^b]: Second.\n';
    expect(footnoteWarnings(compile(two, OPTS))).toHaveLength(2);
  });

  it('warns about a footnote defined inside a quote or a list item', () => {
    expect(footnoteWarnings(compile('> Quoted[^n].\n>\n> [^n]: Nested.\n', OPTS))).toHaveLength(1);
    expect(footnoteWarnings(compile('- Listed[^n].\n\n  [^n]: Nested.\n', OPTS))).toHaveLength(1);
  });

  it('changes nothing it compiles: the same words, blocks and render as without the footnote', () => {
    const script = compile(footnoted, OPTS);
    const plain = compile('Revenue grew last quarter.\n', OPTS);
    expect(normalizedWords(script)).toEqual(['revenue', 'grew', 'last', 'quarter']);
    expect(normalizedWords(script)).toEqual(normalizedWords(plain));
    expect(script.blocks.map((b) => b.kind)).toEqual(['paragraph']);
    expect(flattenText(script.blocks[0]!.renderNodes)).toBe('Revenue grew last quarter.');
    expect(JSON.stringify(script.blocks)).not.toContain('Unaudited');
  });

  it('says nothing about a script without one', () => {
    expect(footnoteWarnings(compile('Revenue grew last quarter.\n', OPTS))).toEqual([]);
    // `[^x]` with no definition is not a footnote to the parser: it is text.
    expect(footnoteWarnings(compile('Revenue grew[^x] last quarter.\n', OPTS))).toEqual([]);
  });
});
