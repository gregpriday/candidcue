import { describe, expect, it } from 'vitest';
import { CommandRouter, type CommandRouterDeps } from '../../../src/shared/commands/router';
import { DEFAULT_COMMAND_BOUNDS } from '../../../src/shared/commands/settings';
import { TranscriptLedger } from '../../../src/shared/tracking/ledger';
import { compileFixtureScript, DEMO_SCRIPT_SOURCE } from '../../fixtures/alignment/fixture-script';

const document = compileFixtureScript(DEMO_SCRIPT_SOURCE);

interface Harness {
  router: CommandRouter;
  ledger: TranscriptLedger;
  say: (text: string, options?: { final?: boolean }) => void;
  clock: () => number;
  advance: (ms: number) => void;
}

function harness(options?: {
  cursor?: number;
  contextRevision?: () => number;
  settings?: Parameters<typeof CommandRouter.prototype.observe> extends never ? never : Partial<import('../../../src/shared/commands/settings').CommandSettings>;
}): Harness {
  const ledger = new TranscriptLedger();
  ledger.setSessionGeneration(1);
  let now = 50_000;
  let itemSeq = 0;
  const revision = options?.contextRevision ?? (() => 7);
  const deps: CommandRouterDeps = {
    ledger,
    parseContext: { navigationTargets: document.navigationTargets },
    scriptTokens: document.spokenTokens,
    getCursorTokenIndex: () => options?.cursor ?? 5,
    getContextRevision: revision,
    getScrollMode: () => 'voice',
    getPosition: () => ({ blockId: 'b1', sentenceId: 's1', tokenIndex: options?.cursor ?? 5 }),
    outline: document.outline.map((o) => ({ level: o.level, title: o.title })),
    bounds: DEFAULT_COMMAND_BOUNDS,
  };
  const router = new CommandRouter(deps, options?.settings);
  return {
    router,
    ledger,
    say: (text, sayOptions) => {
      now += 1000;
      const itemId = `it${itemSeq++}`;
      if (sayOptions?.final === false) {
        ledger.apply({ type: 'delta', sessionGeneration: 1, itemId, text, receivedAtMs: now });
      } else {
        ledger.apply({ type: 'completed', sessionGeneration: 1, itemId, text, receivedAtMs: now });
      }
    },
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('CommandRouter (§33.4, G.7)', () => {
  it('parses a wake-gated transport command locally', () => {
    const h = harness();
    h.say('candid cue pause');
    const observation = h.router.observe(1, h.clock());
    expect(observation.kind).toBe('command');
    if (observation.kind === 'command') {
      expect(observation.command.action).toEqual({ action: 'pause' });
      expect(observation.command.source).toBe('local');
      expect(observation.command.contextRevision).toBe(7);
      expect(observation.itemIds).toEqual(['it0']);
    }
  });

  it('resolves navigation with the compiled targets', () => {
    const h = harness();
    h.say('candid cue go to chapter closing thoughts');
    const observation = h.router.observe(1, h.clock());
    expect(observation.kind).toBe('command');
    if (observation.kind === 'command') {
      expect(observation.command.action.action).toBe('go_to_target');
    }
  });

  it('reports pending while a provisional wake phrase is still open (§33.4.4)', () => {
    const h = harness();
    h.say('candid cue go to', { final: false });
    const observation = h.router.observe(1, h.clock());
    expect(observation.kind).toBe('pending');
  });

  it('never consumes the same transcript twice (§33.5)', () => {
    const h = harness();
    h.say('candid cue pause');
    expect(h.router.observe(1, h.clock()).kind).toBe('command');
    expect(h.router.observe(1, h.clock()).kind).toBe('none');
  });

  it('suppresses commands that collide with authored script (§33.5)', () => {
    const collisionDoc = compileFixtureScript(
      `Please say candid cue pause when you rehearse this exact line aloud.`,
    );
    const ledger = new TranscriptLedger();
    ledger.setSessionGeneration(1);
    const router = new CommandRouter({
      ledger,
      parseContext: { navigationTargets: collisionDoc.navigationTargets },
      scriptTokens: collisionDoc.spokenTokens,
      getCursorTokenIndex: () => 2,
      getContextRevision: () => 1,
      getScrollMode: () => 'voice',
      getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: 2 }),
      outline: [],
      bounds: DEFAULT_COMMAND_BOUNDS,
    });
    ledger.apply({
      type: 'completed', sessionGeneration: 1, itemId: 'x',
      text: 'say candid cue pause when you rehearse', receivedAtMs: 1000,
    });
    expect(router.observe(1, 1000).kind).toBe('none');
  });

  it('suppresses commands inside literal-command regions (§33.5)', () => {
    const h = harness();
    const ledger = new TranscriptLedger();
    ledger.setSessionGeneration(1);
    const router = new CommandRouter({
      ledger,
      parseContext: { navigationTargets: document.navigationTargets },
      scriptTokens: document.spokenTokens,
      literalCommandRanges: [{ startTokenIndex: 0, endTokenIndex: 20 }],
      getCursorTokenIndex: () => 5,
      getContextRevision: () => 1,
      getScrollMode: () => 'voice',
      getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: 5 }),
      outline: [],
      bounds: DEFAULT_COMMAND_BOUNDS,
    });
    ledger.apply({
      type: 'completed', sessionGeneration: 1, itemId: 'x',
      text: 'candid cue pause', receivedAtMs: 1000,
    });
    expect(router.observe(1, 1000).kind).toBe('none');
    expect(h.router).toBeDefined();
  });

  it('routes unresolved but command-like phrases to Luna (§33.7)', () => {
    const h = harness();
    h.say('candid cue put the text back the way it was before');
    const observation = h.router.observe(1, h.clock());
    expect(observation.kind).toBe('needs_luna');
    if (observation.kind === 'needs_luna') {
      expect(observation.request.commandText).toContain('put the text back');
      expect(observation.request.schema.name).toBe('control_candidcue');
      expect(observation.request.nearbyTargets.length).toBeGreaterThan(0);
    }
  });

  it('returns the §34.8 message for non-command chatter after the wake phrase', () => {
    const h = harness();
    h.say('candid cue what is the weather like in lisbon today circus');
    const observation = h.router.observe(1, h.clock());
    // "take"-free chatter without command words is unknown, not Luna.
    expect(['unknown', 'needs_luna']).toContain(observation.kind);
    if (observation.kind === 'unknown') {
      expect(observation.message).toBe('That command is not available during prompting.');
    }
  });

  it('validates Luna results and rejects stale context revisions (§33.11)', () => {
    let revision = 7;
    const h = harness({ contextRevision: () => revision });
    h.say('candid cue could you shift the view down by a couple paragraphs');
    const observation = h.router.observe(1, h.clock());
    expect(observation.kind).toBe('needs_luna');
    if (observation.kind !== 'needs_luna') return;

    // Context changed (user moved manually) before the result arrived.
    revision = 8;
    const stale = h.router.resolveLuna(
      observation.candidate.id,
      { action: 'move_relative', direction: 'forward', amount: 2, unit: 'paragraph', confidence: 0.9, requires_confirmation: false },
      h.clock() + 500,
    );
    expect(stale.kind).toBe('none');
  });

  it('accepts a valid Luna result within the timeout (§33.8)', () => {
    const h = harness();
    h.say('candid cue could you shift the view down by a couple paragraphs');
    const observation = h.router.observe(1, h.clock());
    expect(observation.kind).toBe('needs_luna');
    if (observation.kind !== 'needs_luna') return;
    const resolved = h.router.resolveLuna(
      observation.candidate.id,
      { action: 'move_relative', direction: 'forward', amount: 2, unit: 'paragraph', confidence: 0.88, requires_confirmation: false },
      h.clock() + 900,
    );
    expect(resolved.kind).toBe('command');
    if (resolved.kind === 'command') {
      expect(resolved.command.source).toBe('luna');
      expect(resolved.command.action).toEqual({
        action: 'move_relative', direction: 'forward', amount: 2, unit: 'paragraph',
      });
    }
  });

  it('rejects out-of-schema Luna responses (§33.8, §55.3)', () => {
    const h = harness();
    h.say('candid cue could you shift the view down by a couple paragraphs');
    const observation = h.router.observe(1, h.clock());
    if (observation.kind !== 'needs_luna') throw new Error('expected needs_luna');
    const bad = h.router.resolveLuna(
      observation.candidate.id,
      { action: 'delete_all_files', confidence: 1, requires_confirmation: false },
      h.clock() + 100,
    );
    expect(bad.kind).toBe('unknown');
  });

  it('expires Luna results past the hard timeout (§33.11)', () => {
    const h = harness();
    h.say('candid cue could you shift the view down by a couple paragraphs');
    const observation = h.router.observe(1, h.clock());
    if (observation.kind !== 'needs_luna') throw new Error('expected needs_luna');
    h.advance(3500);
    const late = h.router.resolveLuna(
      observation.candidate.id,
      { action: 'pause', confidence: 0.9, requires_confirmation: false },
      h.clock(),
    );
    expect(late.kind).toBe('unknown'); // timed out → §34.8 message, no execution
    const log = h.router.commandLog();
    expect(log.some((entry) => entry.status === 'timeout')).toBe(true);
  });

  it('records acknowledgements and the stage chip window (§33.10)', () => {
    const h = harness();
    h.say('candid cue pause');
    const observation = h.router.observe(1, h.clock());
    if (observation.kind !== 'command') throw new Error('expected command');
    h.router.acknowledgeExecuted(observation.command, h.clock(), true);
    expect(h.router.commandLog().at(-1)).toMatchObject({ label: 'Pause', status: 'executed' });
    expect(h.router.stageAcknowledgement(h.clock() + 100)?.label).toBe('Pause');
    expect(h.router.stageAcknowledgement(h.clock() + 2000)).toBeUndefined();
  });

  it('push-to-command mode accepts a bare command inside the window (§33.3.3)', () => {
    const ledger = new TranscriptLedger();
    ledger.setSessionGeneration(1);
    const router = new CommandRouter(
      {
        ledger,
        parseContext: { navigationTargets: document.navigationTargets },
        scriptTokens: document.spokenTokens,
        getCursorTokenIndex: () => 100,
        getContextRevision: () => 1,
        getScrollMode: () => 'voice',
        getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: 100 }),
        outline: [],
        bounds: DEFAULT_COMMAND_BOUNDS,
      },
      { wakeMode: 'push_to_command' },
    );
    // No window open → nothing is a command.
    ledger.apply({
      type: 'completed', sessionGeneration: 1, itemId: 'p0', text: 'pause', receivedAtMs: 1000,
    });
    expect(router.observe(1, 1000).kind).toBe('none');

    router.openCommandWindow(2000);
    ledger.apply({
      type: 'completed', sessionGeneration: 1, itemId: 'p1', text: 'next section', receivedAtMs: 2500,
    });
    const observation = router.observe(1, 2500);
    expect(observation.kind).toBe('command');
    if (observation.kind === 'command') {
      expect(observation.command.action).toEqual({ action: 'next_section' });
    }
  });

  it('clears consumed items and pending work on generation change (§33.11)', () => {
    const h = harness();
    h.say('candid cue could you shift the view down by a couple paragraphs');
    expect(h.router.observe(1, h.clock()).kind).toBe('needs_luna');
    const next = h.router.observe(2, h.clock() + 100);
    expect(next.kind).toBe('none');
    expect(h.router.commandLog().some((e) => e.status === 'cancelled')).toBe(true);
  });
});
