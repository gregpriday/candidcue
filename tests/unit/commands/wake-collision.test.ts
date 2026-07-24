import { describe, expect, it } from 'vitest';
import { findWake, collectCommandPhrase } from '../../../src/shared/commands/wake';
import {
  scoreScriptCollision,
  scanScriptForWakeCollisions,
} from '../../../src/shared/commands/collision';
import { resolveCommandSettings } from '../../../src/shared/commands/settings';
import type { LedgerToken } from '../../../src/shared/tracking/types';
import { compileFixtureScript } from '../../fixtures/alignment/fixture-script';

const settings = resolveCommandSettings();

function tokens(text: string, itemId = 'i1', startMs?: number): LedgerToken[] {
  return text.split(/\s+/).map((word, index) => ({
    itemId,
    indexInItem: index,
    surface: word,
    normalized: word,
    final: true,
    filler: false,
    content: true,
    ...(startMs !== undefined
      ? { startMs: startMs + index * 200, endMs: startMs + index * 200 + 180 }
      : {}),
  }));
}

describe('wake detection (§33.2–§33.4, G.7)', () => {
  it('finds the wake alias at an item start', () => {
    const tail = tokens('candid cue pause');
    const wake = findWake(tail, settings);
    expect(wake).toBeDefined();
    expect(wake?.alias).toBe('candid cue');
    expect(wake?.startIndex).toBe(0);
    expect(wake?.endIndex).toBe(2);
    expect(wake?.atBoundary).toBe(true);
  });

  it('accepts the single-token and approved variant aliases (§33.2)', () => {
    expect(findWake(tokens('candidcue stop'), settings)?.alias).toBe('candidcue');
    expect(findWake(tokens('candid q stop'), settings)?.alias).toBe('candid q');
    expect(findWake(tokens('candy cue stop'), settings)?.alias).toBe('candy cue');
  });

  it('reports no boundary for a mid-item wake with no pause', () => {
    const tail = tokens('reading along and candid cue appears mid sentence', 'i1', 1000);
    const wake = findWake(tail, settings);
    expect(wake).toBeDefined();
    expect(wake?.atBoundary).toBe(false);
  });

  it('honors a pause gap as a boundary (§33.4.2)', () => {
    const tail = [...tokens('some words', 'i1', 1000)];
    const wakeTokens = tokens('candid cue pause', 'i1', 5000);
    wakeTokens.forEach((t, i) => (t.indexInItem = tail.length + i));
    const combined = [...tail, ...wakeTokens];
    const wake = findWake(combined, settings);
    expect(wake?.atBoundary).toBe(true);
  });

  it('double gate requires the literal token "command" (§33.3.2)', () => {
    const gated = resolveCommandSettings({ wakeMode: 'double_gate' });
    expect(findWake(tokens('candid cue pause'), gated)).toBeUndefined();
    const wake = findWake(tokens('candid cue command pause'), gated);
    expect(wake).toBeDefined();
    expect(wake?.endIndex).toBe(3); // command tokens start after the gate
  });

  it('collects the command phrase and contributing item ids (§33.4.3)', () => {
    const tail = tokens('candid cue go to chapter one');
    const wake = findWake(tail, settings);
    expect(wake).toBeDefined();
    if (wake === undefined) return;
    const phrase = collectCommandPhrase(tail, wake, settings, () => true);
    expect(phrase.tokens.map((t) => t.normalized)).toEqual(['go', 'to', 'chapter', 'one']);
    expect(phrase.itemIds).toEqual(['i1']);
    expect(phrase.final).toBe(true);
  });

  it('caps command length (§33.4.3)', () => {
    const longTail = tokens(
      'candid cue ' + Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '),
    );
    const wake = findWake(longTail, settings);
    if (wake === undefined) throw new Error('wake not found');
    const phrase = collectCommandPhrase(longTail, wake, settings, () => false);
    expect(phrase.tokens.length).toBe(settings.maxCommandTokens);
    expect(phrase.closed).toBe(true);
  });
});

describe('script collision suppression (§33.5)', () => {
  const document = compileFixtureScript(
    `# Demo

Say candid cue pause right there in the middle of the script and keep reading calmly.

Totally unrelated content about gardening and weather patterns for the afternoon segment.`,
  );

  it('scores an authored wake+command phrase as a collision near the cursor', () => {
    const phrase = tokens('candid cue pause');
    const nearAuthored = scoreScriptCollision({
      phraseTokens: phrase,
      scriptTokens: document.spokenTokens,
      cursorTokenIndex: 4, // inside the authored sentence
    });
    expect(nearAuthored.score).toBeGreaterThanOrEqual(0.62);

    const farAway = scoreScriptCollision({
      phraseTokens: tokens('go to the beginning'),
      scriptTokens: document.spokenTokens,
      cursorTokenIndex: 4,
    });
    expect(farAway.score).toBeLessThan(0.62);
  });

  it('flags literal-command regions', () => {
    const result = scoreScriptCollision({
      phraseTokens: tokens('candid cue pause'),
      scriptTokens: document.spokenTokens,
      cursorTokenIndex: 5,
      literalCommandRanges: [{ startTokenIndex: 2, endTokenIndex: 10 }],
    });
    expect(result.inLiteralRegion).toBe(true);
  });

  it('preparation scan finds authored wake aliases followed by command verbs', () => {
    const collisions = scanScriptForWakeCollisions(document.spokenTokens, settings);
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]?.followedByCommandVerb).toBe(true);
  });
});
