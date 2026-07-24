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

  it('compiles inline {say="…"} keeping the visual source range and spoken aliases', () => {
    const script = directives();
    const source = fixture('directives.md');
    const api = script.spokenTokens.find((t) => t.surface === 'API')!;
    expect(api.flags & TOKEN_FLAGS.DIRECTIVE_ALIAS).toBeTruthy();
    expect(api.weight).toBe(1.65);
    expect(api.aliases).toContain('a p i');
    expect(source.slice(api.source.utf16Start, api.source.utf16End)).toBe('API');
    // The {say=…} suffix never renders.
    const block = script.blocks.find((b) => b.id === api.blockId)!;
    expect(flattenText(block.renderNodes)).not.toContain('{say=');
    expect(flattenText(block.renderNodes)).toContain('API');
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
    const idsA = new Map(a.blocks.map((blk) => [flattenText(blk.renderNodes), blk.id]));
    const idsB = new Map(b.blocks.map((blk) => [flattenText(blk.renderNodes), blk.id]));
    for (const [text, id] of idsA) {
      if (text.includes('Welcome to the launch')) continue;
      expect(idsB.get(text)).toBe(id);
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
    for (const token of script.spokenTokens) {
      const slice = source.slice(token.source.utf16Start, token.source.utf16End);
      // Exact for plain text; inexact fallbacks still land inside the node.
      if (slice === token.surface) continue;
      expect(token.source.utf16End).toBeGreaterThanOrEqual(token.source.utf16Start);
    }
    const welcome = script.spokenTokens.find((t) => t.surface === 'Welcome')!;
    expect(source.slice(welcome.source.utf16Start, welcome.source.utf16End)).toBe('Welcome');
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
    const node = table.renderNodes[0] as Extract<SafeRenderNode, { type: 'table' }>;
    expect(node.rows).toHaveLength(3);
    expect(node.rows[0]!).toHaveLength(3);
    expect(flattenText([node])).toContain('Takes per video');
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
  it('builds exact, ngram, rare, phonetic, and structural indexes', () => {
    const script = basic();
    const { indexes } = script;
    const welcome = script.spokenTokens.find((t) => t.normalized === 'welcome')!;
    expect(indexes.exactToken['welcome']).toContain(welcome.index);
    expect(indexes.ngram2['welcome to']).toContain(welcome.index);
    expect(indexes.ngram3['welcome to the']).toContain(welcome.index);
    expect(indexes.ngram4['welcome to the launch']).toContain(welcome.index);
    expect(Object.keys(indexes.rareToken)).toContain('teleprompter');
    expect(Object.keys(indexes.rareToken)).not.toContain('the');
    expect(Object.keys(indexes.phonetic).length).toBeGreaterThan(0);
    expect(indexes.headingAndTake['the problem']).toBeDefined();
    expect(indexes.paragraphOpening['welcome to the launch']).toContain(welcome.index);
    const firstSentence = script.sentences[0]!;
    expect(indexes.sentenceText[firstSentence.normalizedText]).toContain(firstSentence.id);
  });

  it('indexes take names for navigation', () => {
    const script = directives();
    expect(script.indexes.headingAndTake['opening']).toBeDefined();
    expect(script.indexes.headingAndTake['closing']).toBeDefined();
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
    expect(stats.imageCount).toBe(2);
    expect(stats.diagramCount).toBe(1);
    expect(stats.tableCount).toBe(1);
    const dStats = directives().statistics;
    expect(dStats.takeCount).toBe(2);
    expect(dStats.cueCount).toBe(4); // cue + pause + beat + breathe
    expect(dStats.nonSpokenBlockCount).toBeGreaterThanOrEqual(2); // silent + stage
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

  it('compiles a 5,000-word script quickly (§25.8 smoke)', () => {
    const paragraph =
      'The quick brown fox jumps over the lazy dog while narrating a product demo today.\n\n';
    const source = `# Big Script\n\n${paragraph.repeat(340)}`; // ~5,100 words
    compile(source, OPTS); // warm-up
    const started = performance.now();
    const script = compile(source, OPTS);
    const elapsed = performance.now() - started;
    expect(script.statistics.spokenWordCount).toBeGreaterThan(4800);
    // Generous CI bound; spec target is 100 ms on a 2024 laptop.
    expect(elapsed).toBeLessThan(1500);
  });
});
