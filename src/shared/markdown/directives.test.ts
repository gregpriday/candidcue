import { describe, expect, it } from 'vitest';
import {
  ContainerIndex,
  classifyBracketDirective,
  resolveContainerSemantics,
  scanContainers,
} from './directives';

describe('classifyBracketDirective (spec §23.2/§23.3)', () => {
  it('recognizes cue directives case-insensitively and preserves user text', () => {
    expect(classifyBracketDirective('Cue: smile and hold eye contact')).toEqual({
      kind: 'cue',
      cueType: 'cue',
      label: 'smile and hold eye contact',
    });
    expect(classifyBracketDirective('CUE: Hold Up The Device')).toEqual({
      kind: 'cue',
      cueType: 'cue',
      label: 'Hold Up The Device',
    });
  });

  it('recognizes shorthand cues', () => {
    expect(classifyBracketDirective('Pause')).toMatchObject({ kind: 'cue', cueType: 'pause' });
    expect(classifyBracketDirective('beat')).toMatchObject({ kind: 'cue', cueType: 'beat' });
    expect(classifyBracketDirective('BREATHE')).toMatchObject({ kind: 'cue', cueType: 'breathe' });
  });

  it('recognizes take markers', () => {
    expect(classifyBracketDirective('Take: Opening')).toEqual({ kind: 'take', name: 'Opening' });
    expect(classifyBracketDirective('take: the second try')).toEqual({
      kind: 'take',
      name: 'the second try',
    });
  });

  it('flags empty cue labels as malformed but non-blocking', () => {
    expect(classifyBracketDirective('Cue:')).toMatchObject({ kind: 'malformed', blocking: false });
  });

  it('flags empty take names as blocking (ambiguous navigation, §23.8)', () => {
    expect(classifyBracketDirective('Take:')).toMatchObject({ kind: 'malformed', blocking: true });
  });

  it('leaves ordinary bracket text alone', () => {
    expect(classifyBracketDirective('external monitors')).toEqual({ kind: 'none' });
    expect(classifyBracketDirective('Todo: fix later')).toEqual({ kind: 'none' });
  });

  it('does not mistake inherited object properties for directives', () => {
    expect(classifyBracketDirective('constructor')).toEqual({ kind: 'none' });
    expect(classifyBracketDirective('__proto__')).toEqual({ kind: 'none' });
    expect(classifyBracketDirective('Constructor: x')).toEqual({ kind: 'none' });
  });
});

describe('scanContainers (spec §23.4-§23.7)', () => {
  it('masks fences with equal-length whitespace so offsets survive', () => {
    const source = 'before\n\n:::silent\nhidden note\n:::\n\nafter';
    const { maskedSource, regions } = scanContainers(source);
    expect(maskedSource.length).toBe(source.length);
    expect(maskedSource.indexOf('hidden note')).toBe(source.indexOf('hidden note'));
    expect(maskedSource).not.toContain(':::');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ kind: 'silent', closed: true });
  });

  it('reads a fence on line one past a leading byte-order mark, offsets intact (#247)', () => {
    const source = '\uFEFF:::stage\r\nWalk to the whiteboard.\r\n:::\r\n\r\nHello everyone.';
    const { maskedSource, regions, diagnostics } = scanContainers(source);
    expect(diagnostics).toEqual([]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ kind: 'stage', closed: true, start: 1 });
    // Equal-length masking, and the mark itself is left for the parser.
    expect(maskedSource.length).toBe(source.length);
    expect(maskedSource.charCodeAt(0)).toBe(0xfeff);
    expect(maskedSource).not.toContain(':::');
    expect(maskedSource.indexOf('Hello')).toBe(source.indexOf('Hello'));
  });

  it('parses spoken override fields with source ranges', () => {
    const source = ':::spoken\nvisual: CandidCue v2.0\nsay: Candid Cue version two point oh\n:::\n';
    const { regions, maskedSource } = scanContainers(source);
    expect(regions[0]?.spoken).toBeDefined();
    const spoken = regions[0]!.spoken!;
    expect(spoken.visual).toBe('CandidCue v2.0');
    expect(spoken.say).toBe('Candid Cue version two point oh');
    expect(source.slice(spoken.sayRange[0], spoken.sayRange[1])).toBe(
      'Candid Cue version two point oh',
    );
    // Non-Markdown body is fully blanked.
    expect(maskedSource).not.toContain('visual:');
  });

  it('reports malformed spoken blocks as blocking errors', () => {
    const { diagnostics, regions } = scanContainers(':::spoken\nvisual: only visual\n:::\n');
    expect(regions[0]?.spoken).toBeUndefined();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_spoken_malformed', blocking: true }),
    );
  });

  it('reports unclosed containers and leaves content compiling normally', () => {
    const { diagnostics, maskedSource, regions } = scanContainers(
      ':::silent\nstill visible text\n',
    );
    expect(regions).toHaveLength(0);
    expect(maskedSource).toContain('still visible text');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_unclosed', blocking: true }),
    );
  });

  it('treats unknown container names as readable source with a warning (§22.7)', () => {
    const { diagnostics, maskedSource } = scanContainers(':::mystery\ntext\n:::\n');
    expect(maskedSource).toContain(':::mystery');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_unknown', blocking: false }),
    );
  });

  it('warns on stray closing fences', () => {
    const { diagnostics } = scanContainers('text\n\n:::\n');
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'directive_stray_fence' }),
    );
  });

  it('is case-insensitive on the directive name', () => {
    const { regions } = scanContainers(':::SILENT\nnote\n:::\n');
    expect(regions[0]).toMatchObject({ kind: 'silent' });
  });

  it('nests containers with a stack instead of ending the outer one (§23.6)', () => {
    const source =
      ':::stage\nKey result\n\n:::spoken\nvisual: v2.0\nsay: version two\n:::\n\n:::\n';
    const { regions, diagnostics } = scanContainers(source);
    expect(diagnostics).toEqual([]);
    expect(regions.map((r) => r.kind)).toEqual(['stage', 'spoken']);
    // Sorted outermost-first, and the inner region sits inside the outer one.
    expect(regions[1]!.start).toBeGreaterThan(regions[0]!.start);
    expect(regions[1]!.end).toBeLessThan(regions[0]!.end);
    expect(regions[0]!.spoken).toBeUndefined();
    expect(regions[1]!.spoken?.say).toBe('version two');
  });

  it('composes nested semantics innermost-out', () => {
    const source = ':::silent\nnote\n\n:::literal-command\nCandidCue, go.\n:::\n\n:::\n';
    const { regions } = scanContainers(source);
    const index = new ContainerIndex(regions);
    const inner = index.at(source.indexOf('CandidCue, go.'))!;
    expect(inner.kind).toBe('literal-command');
    // Suppression from an enclosing container still applies.
    expect(resolveContainerSemantics(inner)).toEqual({
      silent: true,
      stage: false,
      literalCommand: true,
    });
  });

  it('ignores ::: lines inside a fenced code block', () => {
    const source =
      '```markdown\n:::spoken\nvisual: fenced\nsay: fenced\n:::\n[Take: Inside]\n```\n\nAfter.\n';
    const { regions, diagnostics, maskedSource } = scanContainers(source);
    expect(regions).toEqual([]);
    expect(diagnostics).toEqual([]);
    // The fenced example survives verbatim — it used to be blanked out, which
    // gutted the code card AND emitted a phantom spoken override.
    expect(maskedSource).toBe(source);
  });

  it('ignores ::: lines inside a tilde fence and honours fence lengths', () => {
    const source = '~~~\n:::silent\nnote\n:::\n~~~\n';
    expect(scanContainers(source).regions).toEqual([]);
    const nested = '````\n```\n:::silent\nnote\n:::\n```\n````\n';
    expect(scanContainers(nested).regions).toEqual([]);
  });

  it('still scans containers after a fence closes', () => {
    const source = '```\ncode\n```\n\n:::silent\nnote\n:::\n';
    const { regions } = scanContainers(source);
    expect(regions.map((r) => r.kind)).toEqual(['silent']);
  });

  it('reports unclosed containers in document order', () => {
    const { diagnostics } = scanContainers(':::silent\na\n\n:::stage\nb\n');
    const unclosed = diagnostics.filter((d) => d.code === 'directive_unclosed');
    expect(unclosed.map((d) => d.source?.line)).toEqual([1, 4]);
    expect(unclosed.map((d) => d.blocking)).toEqual([true, false]);
  });
});

describe('ContainerIndex (spec §25.8)', () => {
  it('answers document-order lookups without rescanning every region', () => {
    let source = '';
    const offsets: number[] = [];
    for (let i = 0; i < 200; i++) {
      offsets.push(source.length + `:::silent\n`.length);
      source += `:::silent\nnote ${i}\n:::\n\nParagraph ${i}.\n\n`;
    }
    const { regions } = scanContainers(source);
    expect(regions).toHaveLength(200);
    const index = new ContainerIndex(regions);
    for (let i = 0; i < offsets.length; i++) {
      expect(index.at(offsets[i]!)!.kind).toBe('silent');
      // Between two containers there is no region at all.
      expect(index.at(source.indexOf(`Paragraph ${i}.`))).toBeUndefined();
    }
  });
});
