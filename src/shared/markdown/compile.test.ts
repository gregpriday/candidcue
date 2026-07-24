import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CompiledScript, SafeRenderNode } from '../contracts';
import { TOKEN_FLAGS } from '../contracts';
import { compile } from './compile';

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

  it('compiles :::spoken with say-text tokens at weight 1.65 carrying visual aliases', () => {
    const script = directives();
    const override = script.blocks.find((b) => b.layoutHints?.['spokenOverride'] === true)!;
    expect(flattenText(override.renderNodes)).toBe('CandidCue v2.0');
    const tokens = script.spokenTokens.filter((t) => t.blockId === override.id);
    expect(tokens.map((t) => t.normalized)).toEqual([
      'candid', 'cue', 'version', 'two', 'point', 'oh',
    ]);
    for (const token of tokens) {
      expect(token.weight).toBe(1.65);
      expect(token.flags & TOKEN_FLAGS.DIRECTIVE_ALIAS).toBeTruthy();
    }
    // Source offsets point into the say: line of the original source.
    const source = fixture('directives.md');
    const first = tokens[0]!;
    expect(source.slice(first.source.utf16Start, first.source.utf16End)).toBe('Candid');
  });

  it('expands inline {say="…"} into one token per spoken word at the visual range', () => {
    const script = directives();
    const source = fixture('directives.md');
    // The tracker pairs one transcript word with one script token, so
    // `API{say="A P I"}` must produce three alignable tokens, not one token
    // carrying "a p i" as an unmatched alias (§23.4).
    const overrides = script.spokenTokens.filter((t) => t.overrideVisual === 'API');
    expect(overrides.map((t) => t.normalized)).toEqual(['a', 'p', 'i']);
    for (const token of overrides) {
      expect(token.flags & TOKEN_FLAGS.DIRECTIVE_ALIAS).toBeTruthy();
      expect(token.weight).toBe(1.65);
      // Every token keeps the *visual* source range (§23.4).
      expect(source.slice(token.source.utf16Start, token.source.utf16End)).toBe('API');
    }
    // The visual form is an alias on the first token only — attaching it to
    // all three would let one spoken "API" match any of them.
    expect(overrides[0]!.aliases).toContain('api');
    expect(overrides[1]!.aliases).not.toContain('api');
    expect(overrides[2]!.aliases).not.toContain('api');
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
    const script = compile('Try saying CandidCue, go to the end, out loud.', OPTS);
    const collision = script.diagnostics.find((d) => d.code === 'command_collision');
    expect(collision).toBeDefined();
    expect(collision!.blocking).toBe(false);
    expect(collision!.suggestedAction).toBe('mark_literal_command');
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
      expect.objectContaining({ code: 'directive_take_empty', blocking: true, severity: 'error' }),
    );
  });

  it('warns on duplicate take names', () => {
    expect(edge().diagnostics).toContainEqual(
      expect.objectContaining({ code: 'take_duplicate_name' }),
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

  it('weights stopwords at 0.35, proper nouns at 1.5, overrides at 1.65', () => {
    const script = basic();
    const the = script.spokenTokens.find((t) => t.normalized === 'the')!;
    expect(the.weight).toBe(0.35);
    const smith = script.spokenTokens.find((t) => t.surface === 'Smith')!;
    expect(smith.flags & TOKEN_FLAGS.PROPER_NOUN).toBeTruthy();
    expect(smith.weight).toBe(1.5);
    const faq = script.spokenTokens.find((t) => t.surface === 'FAQ')!;
    expect(faq.flags & TOKEN_FLAGS.PROPER_NOUN).toBeTruthy();
    const numeric = script.spokenTokens.find((t) => t.normalized === '42')!;
    expect(numeric.flags & TOKEN_FLAGS.NUMBER).toBeTruthy();
    expect(numeric.aliases).toContain('forty two');
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
    compile(source, OPTS); // warm-up
    const started = performance.now();
    const script = compile(source, OPTS);
    const elapsed = performance.now() - started;
    expect(script.statistics.spokenWordCount).toBeGreaterThan(4800);
    expect(script.blocks.length).toBeGreaterThan(1000);
    // Spec §25.8 targets 100 ms on a 2024 laptop; 400 ms leaves headroom for
    // slower CI while still failing loudly on a quadratic regression (the
    // pre-fix container lookup blew past this).
    expect(elapsed).toBeLessThan(400);
  });
});
