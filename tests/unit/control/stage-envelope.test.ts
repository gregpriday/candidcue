import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  buildStageEnvelope,
  buildStageRenderDocument,
  buildStageSettings,
} from '../../../src/control/services/stage-envelope';

const SOURCE = `# Welcome back

This is the opening paragraph with enough words to make several tokens.

[Take: Second take]

## Chapter two

Another paragraph follows here, and it also carries a full sentence.
`;

function compiled() {
  return compile(SOURCE, { scriptId: 'script-1' });
}

describe('stage envelope construction (spec §29.2 / §43.3)', () => {
  it('projects a compiled script into a hydration-ready render document', () => {
    const script = compiled();
    const doc = buildStageRenderDocument(script);

    expect(doc.schemaVersion).toBe(1);
    expect(doc.blocks.length).toBe(script.blocks.length);

    // Sentences are carried so the stage draws the phrase underlay (§16.2).
    expect(doc.sentences).toBeDefined();
    expect(doc.sentences!.length).toBe(script.sentences.length);
    expect(doc.sentences!.length).toBeGreaterThan(0);
    for (const sentence of doc.sentences!) {
      expect(sentence.endTokenIndex).toBeGreaterThanOrEqual(sentence.startTokenIndex);
      expect(sentence.blockId).toBeTruthy();
    }

    // tokenToNode covers every spoken token in order.
    expect(doc.tokenToNode.length).toBe(script.spokenTokens.length);
    doc.tokenToNode.forEach((entry, i) => {
      expect(entry.tokenIndex).toBe(script.spokenTokens[i]!.index);
      expect(entry.blockId).toBe(script.spokenTokens[i]!.blockId);
    });

    // Heading blocks keep their level hints for the stage renderer.
    const headings = doc.blocks.filter((b) => b.kind === 'heading');
    expect(headings.length).toBeGreaterThanOrEqual(2);
    for (const heading of headings) {
      expect(typeof heading.layoutHints?.level).toBe('number');
    }

    // Take markers surface as take/takeLabel layout hints on their block.
    const takeBlocks = doc.blocks.filter((b) => b.layoutHints?.take === true);
    expect(takeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(takeBlocks[0]!.layoutHints?.takeLabel).toBe('Second take');
  });

  it('builds a schema-valid session envelope the Rust validator accepts', () => {
    const script = compiled();
    const envelope = buildStageEnvelope({
      script,
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings({ fontSizePx: 72, mirrorX: true }),
    });

    // The exact fields publish_stage_document validates (windows/mod.rs).
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.sessionId).toBe('session-1');
    expect(envelope.stageGeneration).toBe(7);
    expect(envelope.scriptId).toBe('script-1');
    expect(envelope.sourceHash).toBe(script.sourceHash);
    expect(envelope.initialTokenIndex).toBe(0);
    expect(envelope.stageSettings.fontSizePx).toBe(72);
    expect(envelope.stageSettings.mirrorX).toBe(true);
    expect(envelope.renderDocument.sentences!.length).toBeGreaterThan(0);

    // Envelope must stay within the Rust 8 MB cap for realistic scripts.
    expect(JSON.stringify(envelope).length).toBeLessThan(8 * 1024 * 1024);
  });
});
