import { describe, expect, it } from 'vitest';
import { classifyBracketDirective, scanContainers } from './directives';

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
});
