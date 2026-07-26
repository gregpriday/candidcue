import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  buildStageEnvelope,
  buildStageRenderDocument,
  buildStageSettings,
} from '../../../src/control/services/stage-envelope';
import {
  defaultFollowingSettings,
  resolveFollowProfile,
} from '../../../src/control/lib/follow-profiles';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts';
import { stageFollowProfile } from '../../../src/stage/motion';

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

/*
 * B4 — the Follow feel (§47.1) was fully resolved on the control side and never
 * left it: `resolveFollowProfile` produced a real profile that no field of any
 * stage payload carried, so every feel produced identical motion.
 *
 * These assert the FIRST seam of that wire: the envelope — the validated
 * document path, the same one the script travels — carries the resolved
 * profile. They are written so that deleting the `followProfile` line from
 * `buildStageEnvelope` fails them, not merely so that `resolveFollowProfile`
 * returns something.
 */
describe('follow feel reaches the stage envelope (§47.1 → §55)', () => {
  function envelopeFor(feel: 'calm' | 'balanced' | 'responsive') {
    return buildStageEnvelope({
      script: compiled(),
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings(),
      following: { ...defaultFollowingSettings(), feel },
    });
  }

  it('carries the resolved profile for a non-default feel', () => {
    const responsive = envelopeFor('responsive');
    expect(responsive.followProfile).toBeDefined();
    expect(responsive.followProfile).toEqual(
      resolveFollowProfile({ ...defaultFollowingSettings(), feel: 'responsive' }),
    );
  });

  it('makes each feel a genuinely different profile on the wire', () => {
    const calm = envelopeFor('calm').followProfile!;
    const balanced = envelopeFor('balanced').followProfile!;
    const responsive = envelopeFor('responsive').followProfile!;

    // §47.1: calmer = lower natural frequency and catch-up; responsive = higher.
    expect(calm.motion.naturalFrequency).toBeLessThan(balanced.motion.naturalFrequency);
    expect(responsive.motion.naturalFrequency).toBeGreaterThan(
      balanced.motion.naturalFrequency,
    );
    expect(calm.motion.catchUpMultiplier).toBeLessThan(responsive.motion.catchUpMultiplier);
    // Balanced is the identity on the family profile.
    expect(balanced).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE);

    // §47.1 safety: a feel may never weaken section safety or retake evidence.
    for (const profile of [calm, responsive]) {
    }
  });

  it('sends a profile the stage will actually accept', () => {
    // The two halves of the wire have to agree about the version, or the stage
    // silently drops back to its default and the feel is inert again — one
    // layer further along, and invisible.
    const sent = envelopeFor('responsive').followProfile!;
    expect(stageFollowProfile(sent)).toBe(sent);
  });

  it('omits the profile when no follow settings were supplied', () => {
    const envelope = buildStageEnvelope({
      script: compiled(),
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings(),
    });
    expect(envelope.followProfile).toBeUndefined();
    // …and the stage answers that with its own default rather than nothing.
    expect(stageFollowProfile(envelope.followProfile)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });
});
