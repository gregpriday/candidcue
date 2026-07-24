/**
 * Deterministic command grammar (spec §33.6, catalogue §34). Parses
 * normalized command tokens (wake phrase already removed) into strict
 * `CommandAction`s without any model. Politeness filler is tolerated,
 * numbers may be digits or words, and navigation targets are fuzzy-matched
 * against the compiled navigation index.
 */
import type { CommandAction } from '../contracts/commands';
import type { NavigationTarget } from '../contracts/compiler';
import { parseNumberRun, tokenNumberValue } from '../tracking/normalize';

export interface CommandParseContext {
  navigationTargets: readonly NavigationTarget[];
  /** Optional deterministic phrase search (spec §34.2). */
  findPhrase?: (normalizedPhrase: string) => NavigationTarget[];
}

export interface ParsedCommand {
  kind: 'command';
  action: CommandAction;
  confidence: number;
  humanLabel: string;
  requiresConfirmation: boolean;
}

export type ParseResult =
  | ParsedCommand
  | { kind: 'unknown'; reason: string }
  | { kind: 'incomplete' };

const POLITE_PREFIXES: readonly (readonly string[])[] = [
  ['please'],
  ['could', 'you'],
  ['can', 'you'],
  ['would', 'you'],
  ['now'],
];

const ARTICLES = new Set(['the', 'a', 'an', 'my']);

function command(
  action: CommandAction,
  humanLabel: string,
  confidence = 0.95,
  requiresConfirmation = false,
): ParsedCommand {
  return { kind: 'command', action, confidence, humanLabel, requiresConfirmation };
}

function unknown(reason: string): ParseResult {
  return { kind: 'unknown', reason };
}

/** Strip politeness and leading articles (spec §33.6). */
function stripPoliteness(words: string[]): string[] {
  let out = [...words];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of POLITE_PREFIXES) {
      if (prefix.every((w, i) => out[i] === w)) {
        out = out.slice(prefix.length);
        changed = true;
      }
    }
  }
  while (out.length > 0 && out[out.length - 1] === 'please') out.pop();
  return out;
}

function dropArticles(words: readonly string[]): string[] {
  return words.filter((w) => !ARTICLES.has(w));
}

/**
 * Words that carry no meaning between "show/hide" and the thing being shown,
 * so "show me my stats" and "show stats" reach the same branch.
 */
const RAIL_FILLER_WORDS: ReadonlySet<string> = new Set(['me', 'my', 'the', 'us', 'our']);

/** Nouns the presenter might use for the Coaching Rail. */
const RAIL_NOUNS: ReadonlySet<string> = new Set([
  'stats',
  'statistics',
  'coaching',
  'coach',
  'rail',
  'metrics',
  'pace',
]);

/**
 * Does this phrase name the Coaching Rail? Deliberately conservative.
 *
 * "pace" alone is ambiguous — `set_scroll_speed` also concerns pace — so it
 * only counts when paired with an explicit rail noun ("pace stats"). A bare
 * "show pace" falls through to `unrecognized` rather than guessing, because a
 * wrong guess here silently changes what the presenter sees mid-take.
 *
 * Trailing words are ignored so "show me my stats please" still matches, but
 * an empty remainder does not: "show" alone is not a rail command.
 */
function isCoachingRailTarget(cleaned: readonly string[]): boolean {
  const words = cleaned.filter((w) => !RAIL_FILLER_WORDS.has(w));
  const head = words[0];
  if (head === undefined) return false;
  if (head === 'pace') return words[1] !== undefined && RAIL_NOUNS.has(words[1]);
  if (head === 'coaching' || head === 'coach') {
    // "show coaching" and "show coaching rail" both mean the rail; "show
    // coaching tips" does too. Any continuation is still the rail.
    return true;
  }
  return RAIL_NOUNS.has(head);
}

function amountOf(words: readonly string[], at: number): { value: number; length: number } {
  const word = words[at];
  if (word === 'a' || word === 'an' || word === 'one') return { value: 1, length: 1 };
  const run = parseNumberRun(words, at);
  return run ?? { value: 1, length: 0 };
}

function unitOf(word: string | undefined): 'sentence' | 'paragraph' | 'section' | undefined {
  switch (word) {
    case 'sentence':
    case 'sentences':
    case 'line':
    case 'lines':
      return 'sentence';
    case 'paragraph':
    case 'paragraphs':
      return 'paragraph';
    case 'section':
    case 'sections':
    case 'chapter':
    case 'chapters':
    case 'heading':
    case 'headings':
      return 'section';
    default:
      return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Target resolution (spec §34.2) — deterministic fuzzy label matching.
 * ------------------------------------------------------------------------- */

export interface TargetResolution {
  target?: NavigationTarget;
  score: number;
  ambiguous: boolean;
}

export function resolveNamedTarget(
  type: NavigationTarget['type'] | 'any_heading',
  words: readonly string[],
  context: CommandParseContext,
): TargetResolution {
  const phrase = dropArticles(words).join(' ').trim();
  const pool = context.navigationTargets.filter((t) =>
    type === 'any_heading' ? t.type === 'heading' : t.type === type,
  );
  if (pool.length === 0) return { score: 0, ambiguous: false };

  // Numeric reference: "chapter two" → label containing the number, else the
  // nth target of that type in document order.
  if (words.length >= 1) {
    const run = parseNumberRun(words, 0);
    if (run !== undefined && run.length === words.length) {
      const numberWords = new Set<string>([String(run.value)]);
      for (const [word, value] of Object.entries(numberDictionary())) {
        if (value === run.value) numberWords.add(word);
      }
      const byLabel = pool.filter((t) =>
        t.normalizedLabel.split(' ').some((w) => numberWords.has(w) || tokenNumberValue(w) === run.value),
      );
      if (byLabel.length === 1 && byLabel[0] !== undefined) {
        return { target: byLabel[0], score: 1, ambiguous: false };
      }
      const nth = pool[run.value - 1];
      if (nth !== undefined) return { target: nth, score: 0.9, ambiguous: byLabel.length > 1 };
      return { score: 0, ambiguous: false };
    }
  }

  if (phrase.length === 0) return { score: 0, ambiguous: false };

  const scored = pool
    .map((target) => ({ target, score: labelScore(phrase, target.normalizedLabel) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.target.tokenIndex - b.target.tokenIndex);

  const best = scored[0];
  if (best === undefined) return { score: 0, ambiguous: false };
  const second = scored[1];
  const ambiguous = second !== undefined && best.score - second.score < 0.1;
  return { target: best.target, score: best.score, ambiguous };
}

function labelScore(phrase: string, label: string): number {
  if (label === phrase) return 1;
  if (label.startsWith(phrase) || phrase.startsWith(label)) return 0.9;
  if (label.includes(phrase)) return 0.8;
  const phraseWords = new Set(phrase.split(' '));
  const labelWords = label.split(' ');
  if (labelWords.length === 0) return 0;
  let hits = 0;
  for (const word of labelWords) if (phraseWords.has(word)) hits++;
  const overlap = hits / Math.max(labelWords.length, phraseWords.size);
  return overlap >= 0.5 ? 0.5 + overlap * 0.25 : 0;
}

function numberDictionary(): Record<string, number> {
  return {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  };
}

/* ---------------------------------------------------------------------------
 * Main parser (spec §33.6 grammar, §34 catalogue).
 * ------------------------------------------------------------------------- */

export function parseCommand(rawTokens: readonly string[], context: CommandParseContext): ParseResult {
  const words = stripPoliteness(rawTokens.map((w) => w.toLowerCase()));
  if (words.length === 0) return { kind: 'incomplete' };
  const [head] = words;
  const rest = words.slice(1);

  switch (head) {
    /* §34.1 Transport ----------------------------------------------------- */
    case 'start':
    case 'begin':
      return command({ action: 'start' }, 'Start');
    case 'pause':
      return command({ action: 'pause' }, 'Pause');
    case 'resume':
    case 'continue':
      return command({ action: 'resume' }, 'Resume');
    case 'hard':
      if (rest[0] === 'pause') return command({ action: 'hard_pause' }, 'Hard pause');
      return unknown('unrecognized');
    case 'stop':
      return command({ action: 'stop' }, 'Stop');

    /* §34.2/§34.3 Navigation ---------------------------------------------- */
    case 'go':
    case 'jump':
    case 'navigate':
      return parseGo(rest, context);
    case 'goto':
      return parseGoTarget(rest, context);
    case 'find':
      return parsePhraseSearch(rest, context);
    case 'take': {
      // "take me back to where I started this take" (§34.3), or "take two"?
      if (rest[0] === 'me') return parseGo(rest.slice(1), context);
      return unknown('unrecognized');
    }
    case 'next':
      if (unitOf(rest[0]) === 'section' || rest.length === 0) {
        return command({ action: 'next_section' }, 'Next section');
      }
      return parseRelative('forward', words, context);
    case 'previous':
    case 'last':
      if (unitOf(rest[0]) === 'section') {
        return command({ action: 'previous_section' }, 'Previous section');
      }
      return parseRelative('backward', words, context);
    case 'back':
    case 'backward':
    case 'backwards':
      return parseRelative('backward', rest, context);
    case 'forward':
    case 'ahead':
      return parseRelative('forward', rest, context);
    case 'skip':
      // "skip forward two sentences" / "skip ahead a paragraph"
      if (rest[0] === 'forward' || rest[0] === 'ahead') return parseRelative('forward', rest.slice(1), context);
      if (rest[0] === 'back' || rest[0] === 'backward') return parseRelative('backward', rest.slice(1), context);
      return parseRelative('forward', rest, context);
    case 'restart':
    case 'redo':
      return parseRestart(rest);

    /* §34.7 Retake markers ------------------------------------------------- */
    case 'retake':
      return command({ action: 'retake' }, 'Retake');
    case 'mark':
      if (rest[0] === 'here' || rest[0] === 'this' || rest.length === 0) {
        return command({ action: 'mark_checkpoint' }, 'Mark here');
      }
      return unknown('unrecognized');

    /* §34.4 Display -------------------------------------------------------- */
    case 'make':
      return parseMake(dropArticles(rest));
    case 'set':
      return parseSet(dropArticles(rest));
    case 'bigger':
    case 'larger':
      return command({ action: 'adjust_font_size', deltaSteps: 1 }, 'Text bigger');
    case 'smaller':
      return command({ action: 'adjust_font_size', deltaSteps: -1 }, 'Text smaller');
    case 'widen':
      if (dropArticles(rest)[0] === 'margins') {
        return command({ action: 'adjust_margins', deltaPercent: 5 }, 'Widen margins');
      }
      return unknown('unrecognized');
    case 'narrow':
      if (dropArticles(rest)[0] === 'margins') {
        return command({ action: 'adjust_margins', deltaPercent: -5 }, 'Narrow margins');
      }
      return unknown('unrecognized');
    case 'wider':
      return command({ action: 'adjust_margins', deltaPercent: 5 }, 'Widen margins');
    case 'move':
      return parseMove(dropArticles(rest), context);
    case 'mirror':
    case 'flip':
      return command({ action: 'toggle_mirror', axis: 'x', value: true }, 'Mirror text');
    case 'unmirror':
      return command({ action: 'toggle_mirror', axis: 'x', value: false }, 'Unmirror text');
    case 'blank':
      return command({ action: 'blank_stage' }, 'Blank the stage');
    case 'unblank':
      return command({ action: 'unblank_stage' }, 'Show the script');
    case 'show': {
      const cleaned = dropArticles(rest);
      if (isCoachingRailTarget(cleaned)) {
        return command({ action: 'set_coaching_rail', visible: true }, 'Show coaching rail');
      }
      const what = cleaned[0];
      if (what === 'script' || what === 'text' || what === 'screen') {
        return command({ action: 'unblank_stage' }, 'Show the script');
      }
      if (what === 'cues') return command({ action: 'set_cue_visibility', visible: true }, 'Show cues');
      if (what === 'listener') return command({ action: 'set_listener', enabled: true }, 'Show Listener');
      return unknown('unrecognized');
    }
    case 'hide': {
      const cleaned = dropArticles(rest);
      if (isCoachingRailTarget(cleaned)) {
        return command({ action: 'set_coaching_rail', visible: false }, 'Hide coaching rail');
      }
      const what = cleaned[0];
      if (what === 'cues') return command({ action: 'set_cue_visibility', visible: false }, 'Hide cues');
      if (what === 'listener') return command({ action: 'set_listener', enabled: false }, 'Hide Listener');
      if (what === 'script' || what === 'text' || what === 'screen') {
        return command({ action: 'blank_stage' }, 'Blank the stage');
      }
      return unknown('unrecognized');
    }

    /* §34.5 Listener ------------------------------------------------------- */
    case 'turn': {
      const cleaned = dropArticles(rest);
      if (cleaned[0] === 'listener') {
        if (cleaned[1] === 'on') return command({ action: 'set_listener', enabled: true }, 'Listener on');
        if (cleaned[1] === 'off') return command({ action: 'set_listener', enabled: false }, 'Listener off');
        return { kind: 'incomplete' };
      }
      return unknown('unrecognized');
    }
    case 'dim': {
      const cleaned = dropArticles(rest);
      if (cleaned[0] === 'listener') {
        if (cleaned[1] === 'less') {
          return command({ action: 'adjust_listener_opacity', deltaPercent: 10 }, 'Dim Listener less');
        }
        return command({ action: 'adjust_listener_opacity', deltaPercent: -10 }, 'Dim Listener more');
      }
      return unknown('unrecognized');
    }

    /* §34.6 Scroll mode ---------------------------------------------------- */
    case 'use':
    case 'switch':
      return parseScrollMode(dropArticles(rest.filter((w) => w !== 'to')));
    case 'voice':
    case 'manual':
    case 'fixed':
      return parseScrollMode(words);
    case 'speed':
      if (rest[0] === 'up') return command({ action: 'adjust_scroll_speed', deltaPercent: 10 }, 'Speed up');
      return unknown('unrecognized');
    case 'slow':
      if (rest[0] === 'down' || rest.length === 0) {
        return command({ action: 'adjust_scroll_speed', deltaPercent: -10 }, 'Slow down');
      }
      return unknown('unrecognized');
    case 'faster':
      return command({ action: 'adjust_scroll_speed', deltaPercent: 10 }, 'Speed up');
    case 'slower':
      return command({ action: 'adjust_scroll_speed', deltaPercent: -10 }, 'Slow down');

    default:
      return unknown('unrecognized');
  }
}

/* --------------------------------------------------------------------------- */

function parseGo(rest: readonly string[], context: CommandParseContext): ParseResult {
  let words = [...rest];
  if (words[0] === 'back') {
    // "go back one sentence" / "go back to where I started this take"
    const afterBack = words.slice(1);
    if (afterBack[0] === 'to') {
      const text = afterBack.join(' ');
      if (text.includes('started') && text.includes('take')) {
        return command({ action: 'restart_unit', unit: 'take' }, 'Back to take start');
      }
      return parseGoTarget(afterBack.slice(1), context);
    }
    return parseRelative('backward', afterBack, context);
  }
  if (words[0] === 'forward' || words[0] === 'ahead') {
    return parseRelative('forward', words.slice(1), context);
  }
  if (words[0] === 'to') words = words.slice(1);
  return parseGoTarget(words, context);
}

function parseGoTarget(rest: readonly string[], context: CommandParseContext): ParseResult {
  const words = dropArticles(rest);
  const head = words[0];
  if (head === undefined) return { kind: 'incomplete' };

  if (head === 'beginning' || head === 'start' || head === 'top') {
    return goToTypedTarget('beginning', 'Go to the beginning', context);
  }
  if (head === 'end' || head === 'bottom') {
    return goToTypedTarget('end', 'Go to the end', context);
  }
  if (head === 'chapter' || head === 'section' || head === 'heading') {
    if (words.length === 1) return { kind: 'incomplete' };
    return goToNamed('any_heading', words.slice(1), context, 'Go to');
  }
  if (head === 'take') {
    if (words.length === 1) return { kind: 'incomplete' };
    return goToNamed('take', words.slice(1), context, 'Go to take');
  }
  if (head === 'phrase') {
    return parsePhraseSearch(words.slice(1), context);
  }
  // Bare label: try headings, then takes (§33.6 fuzzy target matching).
  const heading = resolveNamedTarget('any_heading', words, context);
  if (heading.target !== undefined && heading.score >= 0.8) {
    return command(
      { action: 'go_to_target', targetId: heading.target.id },
      `Go to "${heading.target.label}"`,
      0.8 * heading.score,
      heading.ambiguous,
    );
  }
  const take = resolveNamedTarget('take', words, context);
  if (take.target !== undefined && take.score >= 0.8) {
    return command(
      { action: 'go_to_target', targetId: take.target.id },
      `Go to take "${take.target.label}"`,
      0.8 * take.score,
      take.ambiguous,
    );
  }
  return parsePhraseSearch(words, context);
}

function goToTypedTarget(
  type: 'beginning' | 'end',
  label: string,
  context: CommandParseContext,
): ParseResult {
  const target = context.navigationTargets.find((t) => t.type === type);
  if (target !== undefined) {
    return command({ action: 'go_to_target', targetId: target.id }, label);
  }
  // Deterministic fallback: first/last known target.
  const sorted = [...context.navigationTargets].sort((a, b) => a.tokenIndex - b.tokenIndex);
  const fallback = type === 'beginning' ? sorted[0] : sorted[sorted.length - 1];
  if (fallback === undefined) return unknown('no_targets');
  return command({ action: 'go_to_target', targetId: fallback.id }, label, 0.85);
}

function goToNamed(
  type: 'any_heading' | 'take',
  words: readonly string[],
  context: CommandParseContext,
  verb: string,
): ParseResult {
  const resolution = resolveNamedTarget(type, words, context);
  if (resolution.target === undefined || resolution.score < 0.5) {
    return unknown('target_not_found');
  }
  return command(
    { action: 'go_to_target', targetId: resolution.target.id },
    `${verb} "${resolution.target.label}"`,
    Math.min(0.95, 0.6 + resolution.score * 0.35),
    resolution.ambiguous || resolution.score < 0.8, // §33.9 confirm ambiguous
  );
}

function parsePhraseSearch(words: readonly string[], context: CommandParseContext): ParseResult {
  const cleaned = dropArticles(words.filter((w) => w !== 'phrase'));
  if (cleaned.length === 0) return { kind: 'incomplete' };
  const phrase = cleaned.join(' ');
  const viaCallback = context.findPhrase?.(phrase) ?? [];
  const viaTargets = context.navigationTargets.filter(
    (t) => t.type === 'phrase' && (t.normalizedLabel === phrase || t.normalizedLabel.includes(phrase)),
  );
  const matches = [...viaCallback, ...viaTargets];
  const best = matches[0];
  if (best === undefined) return unknown('phrase_not_found');
  return command(
    { action: 'go_to_target', targetId: best.id },
    `Go to "${best.label}"`,
    matches.length === 1 ? 0.9 : 0.7,
    matches.length > 1, // §34.2: multiple matches → confirm/choose in control
  );
}

function parseRelative(
  direction: 'forward' | 'backward',
  words: readonly string[],
  _context: CommandParseContext,
): ParseResult {
  const cleaned = dropArticles(words.filter((w) => w !== 'by'));
  if (cleaned.length === 0) return { kind: 'incomplete' };
  const { value, length } = amountOf(cleaned, 0);
  const unit = unitOf(cleaned[length]);
  if (unit === undefined) return unknown('missing_unit');
  const amount = Math.max(1, Math.min(20, Math.round(value)));
  const label = `${direction === 'forward' ? 'Forward' : 'Back'} ${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return command({ action: 'move_relative', direction, amount, unit }, label);
}

function parseRestart(rest: readonly string[]): ParseResult {
  const cleaned = dropArticles(rest.filter((w) => w !== 'this' && w !== 'current'));
  const head = cleaned[0];
  if (head === undefined) return { kind: 'incomplete' };
  switch (head) {
    case 'sentence':
      return command({ action: 'restart_unit', unit: 'sentence' }, 'Restart sentence');
    case 'paragraph':
      return command({ action: 'restart_unit', unit: 'paragraph' }, 'Restart paragraph');
    case 'section':
    case 'chapter':
      return command({ action: 'restart_unit', unit: 'section' }, 'Restart section');
    case 'take':
      return command({ action: 'restart_unit', unit: 'take' }, 'Restart take');
    default:
      return unknown('unknown_restart_unit');
  }
}

function parseMake(words: readonly string[]): ParseResult {
  // "make the text bigger/smaller" (§34.4)
  const cleaned = words.filter((w) => w !== 'text' && w !== 'font' && w !== 'bit' && w !== 'little');
  const head = cleaned[0];
  if (head === undefined) return { kind: 'incomplete' };
  if (head === 'bigger' || head === 'larger') {
    return command({ action: 'adjust_font_size', deltaSteps: 1 }, 'Text bigger');
  }
  if (head === 'smaller') {
    return command({ action: 'adjust_font_size', deltaSteps: -1 }, 'Text smaller');
  }
  return unknown('unrecognized');
}

function parseSet(words: readonly string[]): ParseResult {
  // "set text to N points" / "set margins to N percent" /
  // "set speed to N words per minute" (§34.4/§34.6)
  const subject = words[0];
  if (subject === undefined) return { kind: 'incomplete' };
  const afterTo = (() => {
    const toIndex = words.indexOf('to');
    return toIndex >= 0 ? words.slice(toIndex + 1) : words.slice(1);
  })();
  const run = parseNumberRun(afterTo, 0);
  if (run === undefined) return { kind: 'incomplete' };
  const value = run.value;

  if (subject === 'text' || subject === 'font' || subject === 'size') {
    return command({ action: 'set_font_size', valuePx: value }, `Set text to ${value} points`);
  }
  if (subject === 'margins' || subject === 'margin') {
    return command({ action: 'set_margins', valuePercent: value }, `Set margins to ${value} percent`);
  }
  if (subject === 'speed') {
    return command(
      { action: 'set_scroll_speed', wordsPerMinute: value },
      `Set speed to ${value} words per minute`,
    );
  }
  return unknown('unrecognized');
}

function parseMove(words: readonly string[], context: CommandParseContext): ParseResult {
  // "move text higher/lower" → reading band (§34.4); "move forward two
  // sentences" → relative navigation.
  const cleaned = words.filter((w) => w !== 'text');
  const head = cleaned[0];
  if (head === undefined) return { kind: 'incomplete' };
  if (head === 'higher' || head === 'up') {
    return command({ action: 'adjust_reading_band', deltaPercent: -5 }, 'Move text higher');
  }
  if (head === 'lower' || head === 'down') {
    return command({ action: 'adjust_reading_band', deltaPercent: 5 }, 'Move text lower');
  }
  if (head === 'forward' || head === 'ahead') return parseRelative('forward', cleaned.slice(1), context);
  if (head === 'back' || head === 'backward' || head === 'backwards') {
    return parseRelative('backward', cleaned.slice(1), context);
  }
  return unknown('unrecognized');
}

function parseScrollMode(words: readonly string[]): ParseResult {
  const head = words[0];
  if (head === undefined) return { kind: 'incomplete' };
  if (head === 'voice') {
    return command({ action: 'set_scroll_mode', mode: 'voice' }, 'Voice follow');
  }
  if (head === 'manual') {
    return command({ action: 'set_scroll_mode', mode: 'manual' }, 'Manual mode');
  }
  if (head === 'fixed') {
    return command({ action: 'set_scroll_mode', mode: 'fixed' }, 'Fixed speed');
  }
  return unknown('unrecognized');
}
