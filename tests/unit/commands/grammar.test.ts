import { describe, expect, it } from 'vitest';
import type { NavigationTarget } from '../../../src/shared/contracts/compiler';
import { parseCommand, type CommandParseContext } from '../../../src/shared/commands/grammar';
import { ALLOWED_ACTIONS } from '../../../src/shared/commands/schema';
import { mulberry32, randomInt, randomWord } from '../helpers/rand';

function target(
  id: string,
  type: NavigationTarget['type'],
  label: string,
  tokenIndex: number,
): NavigationTarget {
  return { id, type, label, normalizedLabel: label.toLowerCase(), tokenIndex, blockId: 'b' };
}

const context: CommandParseContext = {
  navigationTargets: [
    target('nav-begin', 'beginning', 'Beginning', 0),
    target('nav-end', 'end', 'End', 500),
    target('nav-h1', 'heading', 'Welcome', 1),
    target('nav-h2', 'heading', 'The Kaleidoscope Demo', 120),
    target('nav-h3', 'heading', 'Closing Thoughts', 400),
    target('nav-h4', 'heading', 'Chapter Two', 200),
    target('nav-t1', 'take', 'Intro Take', 10),
    target('nav-t2', 'take', 'Two', 210),
    target('nav-p1', 'phrase', 'pricing close', 300),
  ],
};

function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
}

function parse(text: string) {
  return parseCommand(words(text), context);
}

function expectAction(text: string, expected: Record<string, unknown>): void {
  const result = parse(text);
  expect(result.kind, `"${text}" → ${JSON.stringify(result)}`).toBe('command');
  if (result.kind === 'command') {
    expect(result.action).toMatchObject(expected);
  }
}

describe('deterministic grammar — §34 catalogue', () => {
  it('§34.1 transport', () => {
    expectAction('start', { action: 'start' });
    expectAction('begin', { action: 'start' });
    expectAction('pause', { action: 'pause' });
    expectAction('resume', { action: 'resume' });
    expectAction('hard pause', { action: 'hard_pause' });
    expectAction('stop', { action: 'stop' });
    expectAction('please pause', { action: 'pause' }); // polite filler (§33.6)
    expectAction('could you pause please', { action: 'pause' });
  });

  it('§34.2 absolute navigation', () => {
    expectAction('go to the beginning', { action: 'go_to_target', targetId: 'nav-begin' });
    expectAction('go to the start', { action: 'go_to_target', targetId: 'nav-begin' });
    expectAction('go to the top', { action: 'go_to_target', targetId: 'nav-begin' });
    expectAction('go to the end', { action: 'go_to_target', targetId: 'nav-end' });
    expectAction('go to the bottom', { action: 'go_to_target', targetId: 'nav-end' });
    expectAction('go to chapter closing thoughts', { action: 'go_to_target', targetId: 'nav-h3' });
    expectAction('go to section welcome', { action: 'go_to_target', targetId: 'nav-h1' });
    expectAction('go to heading kaleidoscope demo', { action: 'go_to_target', targetId: 'nav-h2' });
    expectAction('go to chapter two', { action: 'go_to_target', targetId: 'nav-h4' });
    expectAction('go to chapter 2', { action: 'go_to_target', targetId: 'nav-h4' });
    expectAction('go to take intro take', { action: 'go_to_target', targetId: 'nav-t1' });
    expectAction('find pricing close', { action: 'go_to_target', targetId: 'nav-p1' });
    expectAction('go to phrase pricing close', { action: 'go_to_target', targetId: 'nav-p1' });
  });

  it('§34.3 relative navigation', () => {
    expectAction('next chapter', { action: 'next_section' });
    expectAction('next section', { action: 'next_section' });
    expectAction('previous chapter', { action: 'previous_section' });
    expectAction('previous section', { action: 'previous_section' });
    expectAction('back one sentence', {
      action: 'move_relative', direction: 'backward', amount: 1, unit: 'sentence',
    });
    expectAction('forward two sentences', {
      action: 'move_relative', direction: 'forward', amount: 2, unit: 'sentence',
    });
    expectAction('back a paragraph', {
      action: 'move_relative', direction: 'backward', amount: 1, unit: 'paragraph',
    });
    expectAction('go back three paragraphs', {
      action: 'move_relative', direction: 'backward', amount: 3, unit: 'paragraph',
    });
    expectAction('restart this sentence', { action: 'restart_unit', unit: 'sentence' });
    expectAction('restart this paragraph', { action: 'restart_unit', unit: 'paragraph' });
    expectAction('restart this section', { action: 'restart_unit', unit: 'section' });
    expectAction('restart this chapter', { action: 'restart_unit', unit: 'section' });
    expectAction('restart this take', { action: 'restart_unit', unit: 'take' });
    expectAction('take me back to where i started this take', {
      action: 'restart_unit', unit: 'take',
    });
  });

  it('§34.4 display', () => {
    expectAction('make the text bigger', { action: 'adjust_font_size', deltaSteps: 1 });
    expectAction('make the text smaller', { action: 'adjust_font_size', deltaSteps: -1 });
    expectAction('set the text to 48 points', { action: 'set_font_size', valuePx: 48 });
    expectAction('set text to forty two points', { action: 'set_font_size', valuePx: 42 });
    expectAction('widen the margins', { action: 'adjust_margins', deltaPercent: 5 });
    expectAction('narrow the margins', { action: 'adjust_margins', deltaPercent: -5 });
    expectAction('set margins to 12 percent', { action: 'set_margins', valuePercent: 12 });
    expectAction('move the text higher', { action: 'adjust_reading_band', deltaPercent: -5 });
    expectAction('move the text lower', { action: 'adjust_reading_band', deltaPercent: 5 });
    expectAction('mirror the text', { action: 'toggle_mirror', axis: 'x', value: true });
    expectAction('unmirror the text', { action: 'toggle_mirror', axis: 'x', value: false });
    expectAction('blank the screen', { action: 'blank_stage' });
    expectAction('show the script', { action: 'unblank_stage' });
    expectAction('hide cues', { action: 'set_cue_visibility', visible: false });
    expectAction('show cues', { action: 'set_cue_visibility', visible: true });
  });

  it('§34.5 listener', () => {
    expectAction('turn the listener on', { action: 'set_listener', enabled: true });
    expectAction('turn listener off', { action: 'set_listener', enabled: false });
    expectAction('show the listener', { action: 'set_listener', enabled: true });
    expectAction('hide the listener', { action: 'set_listener', enabled: false });
    expectAction('dim the listener more', { action: 'adjust_listener_opacity', deltaPercent: -10 });
    expectAction('dim the listener less', { action: 'adjust_listener_opacity', deltaPercent: 10 });
  });

  it('§34.6 scroll mode', () => {
    expectAction('use voice follow', { action: 'set_scroll_mode', mode: 'voice' });
    expectAction('use manual mode', { action: 'set_scroll_mode', mode: 'manual' });
    expectAction('use fixed speed', { action: 'set_scroll_mode', mode: 'fixed' });
    expectAction('switch to manual mode', { action: 'set_scroll_mode', mode: 'manual' });
    expectAction('speed up', { action: 'adjust_scroll_speed', deltaPercent: 10 });
    expectAction('slow down', { action: 'adjust_scroll_speed', deltaPercent: -10 });
    expectAction('set the speed to 140 words per minute', {
      action: 'set_scroll_speed', wordsPerMinute: 140,
    });
  });

  it('§34.7 retake markers', () => {
    expectAction('retake', { action: 'retake' });
    expectAction('mark here', { action: 'mark_checkpoint' });
  });

  it('§34.8 unsupported requests return unknown', () => {
    for (const text of [
      'rewrite this paragraph',
      'send an email to my manager',
      'what is the weather today',
      'order me a pizza',
    ]) {
      const result = parse(text);
      expect(result.kind, text).toBe('unknown');
    }
  });

  it('flags ambiguous duplicate targets for confirmation (§33.9)', () => {
    const ambiguous: CommandParseContext = {
      navigationTargets: [
        target('a', 'heading', 'Pricing Overview', 10),
        target('b', 'heading', 'Pricing Overview', 300),
      ],
    };
    const result = parseCommand(words('go to chapter pricing overview'), ambiguous);
    expect(result.kind).toBe('command');
    if (result.kind === 'command') {
      expect(result.requiresConfirmation).toBe(true);
    }
  });

  it('unknown targets are reported, not invented', () => {
    const result = parse('go to chapter nonexistent nonsense');
    expect(result.kind).toBe('unknown');
  });

  it('never returns an out-of-schema action on fuzzed input (§55.3 property)', () => {
    const rand = mulberry32(31337);
    const vocabulary = [
      'go', 'to', 'the', 'set', 'make', 'text', 'margins', 'chapter', 'take',
      'back', 'forward', 'sentence', 'paragraph', 'section', 'restart',
      'listener', 'speed', 'up', 'down', 'mirror', 'blank', 'show', 'hide',
      'two', 'seven', '15', 'percent', 'points', 'words', 'per', 'minute',
      'please', 'banana', 'xylophone',
    ];
    for (let trial = 0; trial < 400; trial++) {
      const length = randomInt(rand, 0, 10);
      const tokens = Array.from({ length }, () =>
        rand() < 0.15 ? randomWord(rand, 1, 8) : vocabulary[randomInt(rand, 0, vocabulary.length - 1)] ?? 'x',
      );
      const result = parseCommand(tokens, context);
      expect(['command', 'unknown', 'incomplete']).toContain(result.kind);
      if (result.kind === 'command') {
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

describe('coaching rail visibility — "CandidCue, show me my stats"', () => {
  it('recognises the natural phrasings for showing the rail', () => {
    for (const phrase of [
      'show me my stats',
      'show my stats',
      'show stats',
      'show the stats',
      'show me my statistics',
      'show coaching',
      'show the coaching rail',
      'show me my metrics',
      'show pace stats',
    ]) {
      expectAction(phrase, { action: 'set_coaching_rail', visible: true });
    }
  });

  it('recognises the phrasings for hiding it', () => {
    for (const phrase of ['hide my stats', 'hide stats', 'hide the coaching rail', 'hide coaching']) {
      expectAction(phrase, { action: 'set_coaching_rail', visible: false });
    }
  });

  it('does not shadow the display commands that share the show/hide verbs', () => {
    // The rail branch runs first, so these prove it is selective rather than
    // greedy. Without that, "show cues" would have started toggling the rail.
    expectAction('show the script', { action: 'unblank_stage' });
    expectAction('show cues', { action: 'set_cue_visibility', visible: true });
    expectAction('show listener', { action: 'set_listener', enabled: true });
    expectAction('hide cues', { action: 'set_cue_visibility', visible: false });
    expectAction('hide listener', { action: 'set_listener', enabled: false });
    expectAction('hide the script', { action: 'blank_stage' });
  });

  it('refuses to guess on a bare "show pace", which is ambiguous with scroll speed', () => {
    // `set_scroll_speed` is also "pace". A wrong guess here silently changes
    // what the presenter sees mid-take, so no answer is the correct answer.
    expect(parse('show pace').kind).toBe('unknown');
  });

  it('carries no positional field — coaching may never move the script', () => {
    const result = parse('show me my stats');
    expect(result.kind).toBe('command');
    if (result.kind !== 'command') return;
    // The advisory-only rule (coaching spec §2.1) is enforced by the action
    // having nowhere to put a position. If someone adds one, this fails.
    expect(Object.keys(result.action).sort()).toEqual(['action', 'visible']);
    expect(result.requiresConfirmation).toBe(false);
  });
});
