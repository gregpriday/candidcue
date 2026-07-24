import { describe, expect, it } from 'vitest';
import type { CommandAction } from '../../../src/shared/contracts/commands';
import type { NavigationTarget } from '../../../src/shared/contracts/compiler';
import {
  ALLOWED_ACTIONS,
  decideExecution,
  validateCommandAction,
  type ExecutionState,
} from '../../../src/shared/commands/schema';
import {
  buildLunaRequest,
  CONTROL_CANDIDCUE_FUNCTION,
  validateLunaResult,
} from '../../../src/shared/commands/luna';
import { DEFAULT_COMMAND_BOUNDS } from '../../../src/shared/commands/settings';
import { mulberry32, pick, randomInt, randomWord } from '../helpers/rand';

const targets: NavigationTarget[] = [
  { id: 'nav-h1', type: 'heading', label: 'Welcome', normalizedLabel: 'welcome', tokenIndex: 0, blockId: 'b0' },
  { id: 'nav-h2', type: 'heading', label: 'Pricing', normalizedLabel: 'pricing', tokenIndex: 90, blockId: 'b5' },
];
const validationContext = { navigationTargets: targets, bounds: DEFAULT_COMMAND_BOUNDS };

const idleState: ExecutionState = {
  hardPaused: false,
  takeInProgress: false,
  confirmStopDuringTake: true,
};

describe('validateCommandAction (§33.8, §34.4)', () => {
  it('clamps numeric settings into configured bounds', () => {
    const font = validateCommandAction({ action: 'set_font_size', valuePx: 9999 }, validationContext);
    expect(font).toMatchObject({ ok: true, action: { valuePx: DEFAULT_COMMAND_BOUNDS.fontSizeMaxPx } });
    const margins = validateCommandAction({ action: 'set_margins', valuePercent: -10 }, validationContext);
    expect(margins).toMatchObject({ ok: true, action: { valuePercent: 0 } });
    const wpm = validateCommandAction({ action: 'set_scroll_speed', wordsPerMinute: 10 }, validationContext);
    expect(wpm).toMatchObject({ ok: true, action: { wordsPerMinute: DEFAULT_COMMAND_BOUNDS.scrollWpmMin } });
  });

  it('rejects non-finite values and nonexistent targets', () => {
    expect(
      validateCommandAction({ action: 'set_font_size', valuePx: Number.NaN }, validationContext).ok,
    ).toBe(false);
    expect(
      validateCommandAction({ action: 'go_to_target', targetId: 'nav-missing' }, validationContext).ok,
    ).toBe(false);
    expect(
      validateCommandAction({ action: 'go_to_target', targetId: 'nav-h2' }, validationContext).ok,
    ).toBe(true);
  });
});

describe('decideExecution (§33.9, §34.1, G.8)', () => {
  it('executes immediate-class commands', () => {
    for (const action of [
      { action: 'pause' },
      { action: 'next_section' },
      { action: 'toggle_mirror', axis: 'x' },
      { action: 'blank_stage' },
      { action: 'set_listener', enabled: true },
    ] as CommandAction[]) {
      expect(decideExecution(action, idleState, false)).toEqual({ decision: 'execute' });
    }
  });

  it('rejects resume while hard-paused — the microphone is closed (§34.1)', () => {
    const result = decideExecution({ action: 'resume' }, { ...idleState, hardPaused: true }, false);
    expect(result).toEqual({ decision: 'reject', reason: 'hard_paused' });
  });

  it('confirms stop while a take is in progress (§33.9)', () => {
    const during = decideExecution(
      { action: 'stop' },
      { ...idleState, takeInProgress: true },
      false,
    );
    expect(during.decision).toBe('confirm');
    const idle = decideExecution({ action: 'stop' }, idleState, false);
    expect(idle.decision).toBe('execute');
  });

  it('routes ambiguous targets to confirmation (§33.9)', () => {
    const result = decideExecution({ action: 'go_to_target', targetId: 'nav-h2' }, idleState, true);
    expect(result.decision).toBe('confirm');
  });

  it('rejects unknown actions', () => {
    expect(decideExecution({ action: 'unknown' }, idleState, false).decision).toBe('reject');
  });
});

describe('Luna interface (§33.7–§33.8)', () => {
  const candidate = {
    id: 'cmd-1-1',
    sessionGeneration: 1,
    contextRevision: 3,
    itemIds: ['i1'],
    rawTranscript: 'candid cue do the thing',
    normalizedTranscript: 'do the thing',
    wakeAlias: 'candid cue',
    wakeConfidence: 1,
    scriptCollisionScore: 0.1,
    createdAtMs: 0,
  };

  it('builds a bounded request without unrelated transcript (§33.12)', () => {
    const request = buildLunaRequest({
      candidate,
      scrollMode: 'voice',
      position: { blockId: 'b0', sentenceId: 's0', tokenIndex: 5 },
      navigationTargets: targets,
      outline: [{ level: 1, title: 'Welcome' }],
      bounds: DEFAULT_COMMAND_BOUNDS,
    });
    expect(request.commandText).toBe('do the thing');
    expect(request.schema).toBe(CONTROL_CANDIDCUE_FUNCTION);
    expect(request.nearbyTargets.length).toBeLessThanOrEqual(12);
    expect(request.instruction).toContain('unknown');
    expect(request.contextRevision).toBe(3);
  });

  it('maps a go_to_target label back onto a real target', () => {
    const result = validateLunaResult(
      {
        action: 'go_to_target',
        target_type: 'heading',
        target_value: 'pricing',
        confidence: 0.9,
        requires_confirmation: false,
      },
      { navigationTargets: targets },
    );
    expect(result).toMatchObject({ ok: true, action: { action: 'go_to_target', targetId: 'nav-h2' } });
  });

  it('rejects nonexistent targets rather than inventing them (§33.7)', () => {
    const result = validateLunaResult(
      {
        action: 'go_to_target',
        target_type: 'heading',
        target_value: 'a chapter that does not exist anywhere',
        confidence: 0.9,
        requires_confirmation: false,
      },
      { navigationTargets: targets },
    );
    expect(result.ok).toBe(false);
  });

  it('rejects out-of-range confidence and unknown fields', () => {
    expect(
      validateLunaResult(
        { action: 'pause', confidence: 2, requires_confirmation: false },
        { navigationTargets: targets },
      ).ok,
    ).toBe(false);
    expect(validateLunaResult(null, { navigationTargets: targets }).ok).toBe(false);
    expect(validateLunaResult('pause', { navigationTargets: targets }).ok).toBe(false);
  });

  it('fuzzed Luna responses never validate into out-of-schema actions (§55.3 property)', () => {
    const rand = mulberry32(2026);
    const actionPool = [
      ...CONTROL_CANDIDCUE_FUNCTION.parameters.properties.action.enum,
      'delete_everything',
      'sudo',
      '',
    ];
    for (let trial = 0; trial < 300; trial++) {
      const raw: Record<string, unknown> = {
        action: rand() < 0.9 ? pick(rand, actionPool) : randomInt(rand, 0, 5),
        confidence: rand() < 0.8 ? rand() * (rand() < 0.9 ? 1 : 5) : 'high',
        requires_confirmation: rand() < 0.8 ? rand() < 0.5 : 'yes',
      };
      if (rand() < 0.6) raw.target_value = rand() < 0.5 ? randomWord(rand, 2, 10) : 'pricing';
      if (rand() < 0.6) raw.direction = pick(rand, ['forward', 'backward', 'up', 'down', 'sideways', null]);
      if (rand() < 0.6) raw.amount = rand() < 0.8 ? randomInt(rand, -5, 500) : Number.NaN;
      if (rand() < 0.6) raw.unit = pick(rand, ['sentence', 'paragraph', 'section', 'lightyear', null]);
      const result = validateLunaResult(raw, { navigationTargets: targets });
      if (result.ok) {
        expect(ALLOWED_ACTIONS.has(result.action.action)).toBe(true);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        for (const value of Object.values(result.action)) {
          if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });
});
