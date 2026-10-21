/**
 * The script syntax reference: every construct Speaking Glass adds to Markdown, with
 * one example each and what it does on the glass and to following (#305).
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXAMPLES CARRY THEIR OWN OUTCOMES
 * ---------------------------------------------------------------------------
 * A help page about a dialect is a second description of that dialect, and the
 * first one is the compiler. Nothing reads this file to compile a script, so
 * nothing would notice if the two disagreed — a renamed directive, a container
 * that changed meaning, a cue label that grew a word — until a user typed what
 * the reference told them to and got something else.
 *
 * So every displayed `example` states what compiling it produces (`expect`):
 * the words following listens for, the text left on the glass, the cues, the
 * diagnostics, the parts, and what a take swaps in for media. Every claim a
 * `notes` line makes about another form is a `case` with its own source and
 * outcome. `syntax-reference.test.ts` compiles all of them with the real
 * `compile()` and fails on any difference, and it also fails when the compiler
 * gains a container, a shorthand cue, a take-time label or a diagnostic this
 * file does not account for.
 *
 * The reference page shows the asserted facts rather than retelling them: the
 * words following listens for are `expect.spoken`, and what a case breaks is
 * read from its own `blocking`. The glass itself is drawn by compiling the
 * example, so the page cannot show a look the compiler does not produce.
 *
 * What a test cannot read is prose. `glass` and `following` are kept to a line
 * each so there is little in them to go stale. Syntax inside prose sits in
 * backticks, which the page sets as code.
 *
 * The retired coaching syntax is deliberately absent; it is being removed, and
 * documenting it would invite new scripts to depend on it.
 */
import type { CompiledBlock, CompileOptions } from '../contracts';
import { PERFORMANCE_CUE_LABELS } from '../performance-view';

/** What compiling a piece of source produces. Every field is optional; a field given is asserted exactly. */
export interface SyntaxOutcome {
  /** Compile options beyond the defaults the app uses. */
  options?: Pick<CompileOptions, 'readHeadings'>;
  /** The normalized spoken tokens, in order: what following listens for. */
  spoken?: string[];
  /** The visible text, whitespace collapsed, cue markers left out. */
  shown?: string;
  /** The cue markers drawn on the glass, in order. */
  cues?: Array<{ cueType: string; label: string }>;
  /** Diagnostic codes, in order. An empty list asserts the source is clean. */
  diagnostics?: string[];
  /** Whether any diagnostic stops the script being presented. */
  blocking?: boolean;
  /** The compiled block kinds, in order. */
  blockKinds?: CompiledBlock['kind'][];
  /** The labels of the parts the Present menu offers. */
  parts?: string[];
  /** The one-line cues a take draws in place of media, in order. */
  takeCues?: string[];
}

/** A variant the reader is told about but not shown as the main example. */
export interface SyntaxCase extends SyntaxOutcome {
  /** What this case proves, for the test's name. */
  what: string;
  source: string;
  /**
   * Another way to write the construct, named in a word or two. The page
   * offers it beside the example, drawn and copied the same way, so a case
   * with a `variant` also asserts `spoken`.
   */
  variant?: string;
  /**
   * What goes wrong, in the reader's words, for a case that raises a
   * diagnostic. The page says whether it warns or stops the script being
   * presented from `blocking`, so a case with a `problem` asserts `blocking`.
   */
  problem?: string;
}

export interface SyntaxEntry {
  id: string;
  title: string;
  /** Script source, shown exactly as written. */
  example: string;
  /** What the presenter sees, beside the example drawn as a take draws it. */
  glass: string;
  /** What following does with it, beside the words it listens for. */
  following: string;
  /** The example's own name among the entry's `variant` cases, when it has any. */
  form?: string;
  /** Rules for writing it, a sentence each. */
  notes?: readonly string[];
  /**
   * Words a writer might search with that the entry's own text does not
   * contain: what they want to do rather than what the construct is called.
   */
  keywords?: readonly string[];
  /** Asserted against `example`. */
  expect: SyntaxOutcome;
  /** Each claim `notes` makes, proved on its own source. */
  cases?: SyntaxCase[];
}

export interface SyntaxGroup {
  id: string;
  title: string;
  /** Said once for every entry in the group, rather than in each. */
  note?: string;
  entries: SyntaxEntry[];
}

/** Where the heading switch lives, named as the Settings window names it. */
export const READ_HEADINGS_SETTING = {
  section: 'General',
  label: 'Follow headings as spoken lines',
} as const;

const READ_HEADINGS_PATH = `Settings › ${READ_HEADINGS_SETTING.section} › ${READ_HEADINGS_SETTING.label}`;

const SKIPPED = 'Following moves straight past it.';

export const SYNTAX_REFERENCE: readonly SyntaxGroup[] = [
  {
    id: 'cues',
    title: 'Cues',
    entries: [
      {
        id: 'cue',
        title: 'Cue',
        example: '[Cue: look at the lens] Welcome back.',
        glass: 'A note to yourself, drawn where you wrote it.',
        following: 'The cue is skipped.',
        keywords: ['note', 'direction', 'reminder', 'camera', 'lens', 'smile', 'gesture'],
        expect: {
          spoken: ['welcome', 'back'],
          shown: 'Welcome back.',
          cues: [{ cueType: 'cue', label: 'look at the lens' }],
          diagnostics: [],
        },
        cases: [
          {
            what: 'an empty cue is shown as source and warns',
            problem: 'A cue with no label, `[Cue:]`, stays on the page as typed.',
            source: '[Cue:] Welcome back.',
            spoken: ['welcome', 'back'],
            shown: '[Cue:] Welcome back.',
            cues: [],
            diagnostics: ['directive_cue_empty'],
            blocking: false,
          },
        ],
      },
      {
        id: 'shorthand-cues',
        title: 'Pause, Beat, Breathe',
        example: 'First point. [Beat] Second point. [Pause] Last one. [Breathe]',
        glass: 'A short marker, drawn where you wrote it.',
        following: 'The markers are skipped.',
        notes: ['The names are not case-sensitive: `[beat]` works too.'],
        keywords: ['wait', 'rest', 'breath', 'gap', 'silence', 'timing'],
        expect: {
          spoken: ['first', 'point', 'second', 'point', 'last', 'one'],
          cues: [
            { cueType: 'beat', label: 'Beat' },
            { cueType: 'pause', label: 'Pause' },
            { cueType: 'breathe', label: 'Breathe' },
          ],
          diagnostics: [],
        },
        cases: [
          {
            what: 'shorthand names are case-insensitive',
            source: 'Hold on. [beat]',
            spoken: ['hold', 'on'],
            cues: [{ cueType: 'beat', label: 'beat' }],
            diagnostics: [],
          },
          {
            what: 'a cue on a line of its own is a cue block',
            source: 'Hold on.\n\n[Pause]\n\nCarry on.',
            blockKinds: ['paragraph', 'cue', 'paragraph'],
            cues: [{ cueType: 'pause', label: 'Pause' }],
          },
        ],
      },
    ],
  },
  {
    id: 'parts',
    title: 'Parts',
    entries: [
      {
        id: 'take',
        title: 'Part break',
        example: '[Take: Opening]\n\nWelcome to the show.\n\n[Take: Demo]\n\nHere is how it works.',
        glass: 'Each part name, as a marker.',
        following:
          'The names are skipped. The Present menu can start each part on its own.',
        notes: [
          'Part breaks with words after them win over headings.',
          'Without any, the biggest headings divide the script, and text before the first one is an opening part.',
          'A script that comes out as one part is not divided.',
          'A `---` line only draws a divider.',
        ],
        keywords: ['split', 'section', 'chapter', 'segment', 'divide', 'present menu'],
        expect: {
          spoken: ['welcome', 'to', 'the', 'show', 'here', 'is', 'how', 'it', 'works'],
          cues: [
            { cueType: 'take', label: 'Opening' },
            { cueType: 'take', label: 'Demo' },
          ],
          parts: ['Opening', 'Demo'],
          diagnostics: [],
        },
        cases: [
          {
            what: 'with no part breaks, the biggest headings divide the script',
            source: '# Opening\n\nWelcome to the show.\n\n# Demo\n\nHere is how it works.',
            parts: ['Opening', 'Demo'],
            diagnostics: [],
          },
          {
            what: 'the biggest headings need not be top-level ones',
            source: '## Opening\n\nWelcome to the show.\n\n## Demo\n\nHere is how it works.',
            parts: ['Opening', 'Demo'],
          },
          {
            what: 'one biggest heading over smaller ones makes no parts',
            source: '# Launch\n\n## Opening\n\nWelcome to the show.\n\n## Demo\n\nHere is how it works.',
            parts: [],
          },
          {
            what: 'text before the first heading is an opening part',
            source: 'Welcome back.\n\n## Demo\n\nHere is how it works.',
            parts: ['Opening', 'Demo'],
          },
          {
            what: 'a part break with nothing after it does not replace the headings',
            source: '# One\n\nFirst words.\n\n# Two\n\nSecond words.\n\n[Take: End]',
            parts: ['One', 'Two'],
          },
          {
            what: 'part breaks win over headings',
            source: '# Launch\n\n[Take: Opening]\n\nWelcome to the show.\n\n# Demo\n\nHere is how it works.\n\n[Take: Close]\n\nThanks for watching.',
            parts: ['Opening', 'Close'],
          },
          {
            what: 'a --- line is a divider, not a part break',
            source: 'Welcome to the show.\n\n---\n\nHere is how it works.',
            blockKinds: ['paragraph', 'divider', 'paragraph'],
            parts: [],
            diagnostics: [],
          },
          {
            what: 'a part break without a name blocks presenting',
            problem: 'A part break with no name, `[Take:]`.',
            source: '[Take:]\n\nWelcome to the show.',
            spoken: ['welcome', 'to', 'the', 'show'],
            diagnostics: ['directive_take_empty'],
            blocking: true,
          },
          {
            what: 'two parts with one name warn',
            problem: 'Two parts with the same name.',
            source: '[Take: Intro]\n\nWelcome to the show.\n\n[Take: Intro]\n\nHere is how it works.',
            diagnostics: ['take_duplicate_name'],
            blocking: false,
          },
        ],
      },
    ],
  },
  {
    id: 'spoken',
    title: 'Show one thing, say another',
    entries: [
      {
        id: 'say-alias',
        title: 'Spoken form of a word',
        example: 'The API{say="A P I"} is fast.',
        glass: 'Only the word before the braces.',
        following: 'The `say` words stand in for the word.',
        notes: [
          'It covers the single word right before the brace.',
          "The quotes must be double quotes: `{say='…'}` stays on the page as typed.",
          'For anything longer, use a spoken block.',
        ],
        keywords: ['pronounce', 'pronunciation', 'acronym', 'abbreviation', 'alias', 'read as', 'sounds like'],
        expect: {
          spoken: ['the', 'a', 'p', 'i', 'is', 'fast'],
          shown: 'The API is fast.',
          diagnostics: [],
        },
        cases: [
          {
            what: 'an empty spoken form warns',
            problem: 'An empty spoken form, `{say=""}`.',
            source: 'The API{say=""} is fast.',
            diagnostics: ['directive_say_empty'],
            blocking: false,
          },
          {
            what: 'single quotes are not a spoken form',
            source: "The API{say='A P I'} is fast.",
            shown: "The API{say='A P I'} is fast.",
            diagnostics: [],
          },
        ],
      },
      {
        id: 'spoken-block',
        title: 'Spoken block',
        example: ':::spoken\nvisual: Q3 revenue: $4.2M\nsay: third quarter revenue was four point two million\n:::',
        glass: 'Only the `visual:` line.',
        following: 'The `say:` line stands in for the `visual:` line.',
        notes: ['Both lines are needed.'],
        keywords: ['pronounce', 'numbers', 'figures', 'money', 'currency', 'read as', 'sounds like'],
        expect: {
          spoken: ['third', 'quarter', 'revenue', 'was', 'four', 'point', 'two', 'million'],
          shown: 'Q3 revenue: $4.2M',
          diagnostics: [],
        },
        cases: [
          {
            what: 'a spoken block without a say: line blocks presenting',
            problem: 'A spoken block missing a line, which then shows as typed.',
            source: ':::spoken\nvisual: Q3 revenue: $4.2M\n:::',
            spoken: [],
            shown: ':::spoken visual: Q3 revenue: $4.2M :::',
            diagnostics: ['directive_spoken_malformed'],
            blocking: true,
          },
        ],
      },
    ],
  },
  {
    id: 'unspoken',
    title: 'Notes for you',
    entries: [
      {
        id: 'silent',
        title: 'Silent block',
        example: ':::silent\nCut to the screen recording here.\n:::',
        glass: 'Shown quietly, set apart from the script.',
        following: SKIPPED,
        keywords: ['note', 'private', 'comment', 'direction', 'reminder', 'unspoken', 'quiet'],
        expect: {
          spoken: [],
          shown: 'Cut to the screen recording here.',
          blockKinds: ['silent'],
          diagnostics: [],
        },
      },
      {
        id: 'stage',
        title: 'Stage block',
        example: ':::stage\n| Plan | Price |\n| --- | --- |\n| Pro | 12 |\n:::',
        glass:
          'Shown quietly, and a table, image, code or diagram inside one stays in full during a take.',
        following: SKIPPED,
        keywords: ['note', 'private', 'slide', 'figure', 'stat', 'unspoken', 'glance'],
        expect: {
          spoken: [],
          shown: 'Plan Price Pro 12',
          blockKinds: ['stage_only'],
          takeCues: [],
          diagnostics: [],
        },
        cases: [
          {
            what: 'a stage block holds any text for you',
            source: ':::stage\nKey result: **42% faster**\n:::',
            spoken: [],
            shown: 'Key result: 42% faster',
            blockKinds: ['stage_only'],
            diagnostics: [],
          },
        ],
      },
      {
        id: 'nesting',
        title: 'Nesting and closing',
        example:
          ':::stage\nSlide four.\n\n:::spoken\nvisual: $4.2M\nsay: four point two million\n:::\n:::',
        glass: 'Each block keeps its own look inside another.',
        following:
          'An outer silent or stage block keeps everything inside it unspoken, except a spoken block.',
        notes: [
          'A bare `:::` closes the block opened most recently.',
          'Fence lines start at the beginning of a line.',
        ],
        keywords: ['nest', 'inside', 'close', 'closing', 'end', 'fence', 'colons'],
        expect: {
          spoken: ['four', 'point', 'two', 'million'],
          shown: 'Slide four. $4.2M',
          diagnostics: [],
        },
        cases: [
          {
            what: 'an outer silent block wins over what is inside it',
            source: ':::silent\nIntro notes.\n\n:::literal-command\nThanks for trying Speaking Glass.\n:::\n:::',
            spoken: [],
            diagnostics: [],
          },
          {
            what: 'a bare ::: closes the inner block first',
            source: ':::literal-command\n:::stage\nInner note.\n:::\nRead this aloud.\n:::',
            spoken: ['read', 'this', 'aloud'],
            shown: 'Inner note. Read this aloud.',
            diagnostics: [],
          },
          {
            what: 'an unclosed stage block warns',
            problem: 'Any other block left open.',
            source: ':::stage\nKey result.',
            diagnostics: ['directive_unclosed'],
            blocking: false,
          },
          {
            what: 'an unclosed silent block blocks presenting',
            problem: 'A silent or spoken block left open.',
            source: ':::silent\nKey result.',
            diagnostics: ['directive_unclosed'],
            blocking: true,
          },
          {
            what: 'an unknown block name is reported and kept as text',
            problem: 'An unknown block name, like `:::aside`.',
            source: ':::aside\nKey result.\n:::',
            diagnostics: ['directive_unknown'],
            blocking: false,
          },
          {
            what: 'a ::: with nothing open is reported',
            problem: 'A `:::` with no block open.',
            source: 'Key result.\n\n:::',
            diagnostics: ['directive_stray_fence'],
            blocking: false,
          },
        ],
      },
    ],
  },
  {
    id: 'literal',
    title: 'Plain text',
    entries: [
      {
        id: 'literal-command',
        title: 'Wake phrase read aloud',
        example: ':::literal-command\nThanks for trying Speaking Glass.\n:::',
        glass: 'Shown like any other text.',
        following:
          'Read as normal, and the editor stops warning that Speaking Glass is the wake phrase.',
        keywords: ['wake word', 'command', 'read aloud', 'brand', 'product name'],
        expect: {
          spoken: ['thanks', 'for', 'trying', 'speaking', 'glass'],
          shown: 'Thanks for trying Speaking Glass.',
          diagnostics: [],
        },
        cases: [
          {
            what: 'the same sentence outside the block warns',
            problem: 'The same sentence outside the block.',
            source: 'Thanks for trying Speaking Glass.',
            diagnostics: ['command_collision'],
            blocking: false,
          },
        ],
      },
      {
        id: 'escape',
        title: 'Brackets as text',
        example: 'Type \\[Pause] to add a pause.',
        glass: 'The brackets as written, without the backslash.',
        following: 'Read as ordinary words.',
        notes: [
          'A backslash before the bracket keeps any directive as plain text.',
          'Brackets that are not directives, like `[sic]`, are plain text already.',
        ],
        keywords: ['escape', 'backslash', 'literal', 'square brackets', 'plain'],
        expect: {
          spoken: ['type', 'pause', 'to', 'add', 'a', 'pause'],
          shown: 'Type [Pause] to add a pause.',
          cues: [],
          diagnostics: [],
        },
        cases: [
          {
            what: 'brackets that are not a directive are ordinary text',
            source: 'He said it [sic] twice.',
            shown: 'He said it [sic] twice.',
            cues: [],
            diagnostics: [],
          },
        ],
      },
    ],
  },
  {
    id: 'media',
    title: 'Images, tables, code and diagrams',
    note: 'In a teleprompter take, each of these becomes a one-line cue. A reading window, the preview, practice and a Diagnostic Take show them in full.',
    entries: [
      {
        id: 'image',
        title: 'Image',
        example: '![Product shot](images/product.png)',
        glass: 'On a line of its own, this cue in a take.',
        following: SKIPPED,
        notes: ['Images must be files added to the script.'],
        keywords: ['picture', 'photo', 'screenshot', 'png', 'media', 'file'],
        expect: {
          spoken: [],
          blockKinds: ['image'],
          takeCues: [PERFORMANCE_CUE_LABELS.image],
          diagnostics: [],
        },
        cases: [
          {
            what: 'a remote image is not loaded',
            problem: 'A web address, which is not loaded.',
            source: '![Product shot](https://example.com/product.png)',
            diagnostics: ['remote_image_blocked'],
            blocking: false,
          },
        ],
      },
      {
        id: 'table',
        title: 'Table',
        example: '| Plan | Price |\n| --- | --- |\n| Pro | 12 |',
        glass: 'This cue in a take.',
        following: SKIPPED,
        keywords: ['grid', 'rows', 'columns', 'data', 'pipes', 'media'],
        expect: {
          spoken: [],
          blockKinds: ['table'],
          takeCues: [PERFORMANCE_CUE_LABELS.table],
          diagnostics: [],
        },
      },
      {
        id: 'code',
        title: 'Code',
        example: '```js\nconsole.log("hello");\n```',
        glass: 'This cue in a take.',
        following: SKIPPED,
        keywords: ['snippet', 'program', 'backticks', 'fence', 'demo', 'media'],
        expect: {
          spoken: [],
          blockKinds: ['code'],
          takeCues: [PERFORMANCE_CUE_LABELS.code],
          diagnostics: [],
        },
      },
      {
        id: 'diagram',
        title: 'Diagram',
        example: '```mermaid\ngraph LR\n  Idea --> Script\n```',
        glass: 'This cue in a take. Elsewhere, its source is what shows.',
        following: SKIPPED,
        notes: ['A `mermaid` fence marks a diagram.'],
        keywords: ['chart', 'flowchart', 'graph', 'media'],
        expect: {
          spoken: [],
          blockKinds: ['diagram'],
          takeCues: [PERFORMANCE_CUE_LABELS.diagram],
          diagnostics: [],
        },
      },
    ],
  },
  {
    id: 'markdown',
    title: 'Markdown',
    entries: [
      {
        id: 'heading',
        title: 'Heading',
        example: '# Pricing\n\nIt starts at twelve dollars.',
        glass: 'A quiet label on the glass. A reading window and the preview show it as a heading.',
        following: `The heading is skipped, unless ${READ_HEADINGS_PATH} is on when the take starts.`,
        keywords: ['title', 'section', 'headline', 'hash'],
        expect: {
          spoken: ['it', 'starts', 'at', 'twelve', 'dollars'],
          blockKinds: ['heading', 'paragraph'],
          diagnostics: [],
        },
        cases: [
          {
            what: 'headings are spoken with the setting on',
            source: '# Pricing\n\nIt starts at twelve dollars.',
            options: { readHeadings: true },
            spoken: ['pricing', 'it', 'starts', 'at', 'twelve', 'dollars'],
          },
        ],
      },
      {
        id: 'text',
        title: 'Text, lists and links',
        example: '- Works **offline**\n- Read [the guide](https://example.com) first',
        form: 'List',
        glass: 'Your formatting. Links are not clickable on the glass.',
        following: 'A link is read by its text, never its address.',
        notes: [
          'Emphasis and quotes are read like any other text.',
          'Text between backticks is shown as code but not spoken.',
          'An HTML comment, `<!-- like this -->`, is a note to yourself that appears nowhere.',
        ],
        keywords: ['bold', 'italic', 'emphasis', 'list', 'bullet', 'url', 'quote', 'formatting', 'comment', 'inline code'],
        expect: {
          spoken: ['works', 'offline', 'read', 'the', 'guide', 'first'],
          shown: 'Works offline Read the guide first',
          blockKinds: ['list_item', 'list_item'],
          diagnostics: [],
        },
        cases: [
          {
            what: 'emphasis is read',
            variant: 'Italic',
            source: 'Read it *slowly*.',
            spoken: ['read', 'it', 'slowly'],
            shown: 'Read it slowly.',
            diagnostics: [],
          },
          {
            what: 'a quote is read',
            variant: 'Quote',
            source: '> Teleprompters should listen.',
            spoken: ['teleprompters', 'should', 'listen'],
            blockKinds: ['blockquote'],
          },
          {
            what: 'inline code is shown but not spoken',
            variant: 'Inline code',
            source: 'Run `npm install` first.',
            spoken: ['run', 'first'],
            shown: 'Run npm install first.',
            diagnostics: [],
          },
          {
            what: 'an HTML comment appears nowhere',
            source: 'Welcome back.\n\n<!-- slow down here -->\n\nHere is the plan.',
            spoken: ['welcome', 'back', 'here', 'is', 'the', 'plan'],
            shown: 'Welcome back. Here is the plan.',
            diagnostics: [],
          },
        ],
      },
    ],
  },
];

/** Every entry, in reading order. */
export function syntaxEntries(): SyntaxEntry[] {
  return SYNTAX_REFERENCE.flatMap((group) => group.entries);
}
