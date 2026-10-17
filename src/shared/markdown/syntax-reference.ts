/**
 * The script syntax reference: every construct CandidCue adds to Markdown, with
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
 * `note` makes about another form is a `case` with its own source and outcome.
 * `syntax-reference.test.ts` compiles all of them with the real `compile()` and
 * fails on any difference, and it also fails when the compiler gains a
 * container, a shorthand cue, a take-time label or a diagnostic this file does
 * not account for.
 *
 * What a test cannot read is prose. `glass` and `following` are kept to a line
 * each so there is little in them to go stale, and the strings that DO come
 * from the code — the take-time cue labels — are interpolated from it.
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
}

export interface SyntaxEntry {
  id: string;
  title: string;
  /** Script source, shown exactly as written. */
  example: string;
  /** What the presenter sees. */
  glass: string;
  /** What following does with it. */
  following: string;
  note?: string;
  /** Asserted against `example`. */
  expect: SyntaxOutcome;
  /** Each claim `note` makes, proved on its own source. */
  cases?: SyntaxCase[];
}

export interface SyntaxGroup {
  id: string;
  title: string;
  entries: SyntaxEntry[];
}

/** Where the heading switch lives, named as the Settings window names it. */
export const READ_HEADINGS_SETTING = { section: 'General', label: 'Read headings aloud' } as const;

const READ_HEADINGS_PATH = `Settings › ${READ_HEADINGS_SETTING.section} › ${READ_HEADINGS_SETTING.label}`;

const IN_FULL_ELSEWHERE = 'Shown in full in the preview and in practice.';

export const SYNTAX_REFERENCE: readonly SyntaxGroup[] = [
  {
    id: 'cues',
    title: 'Cues',
    entries: [
      {
        id: 'cue',
        title: 'Cue',
        example: '[Cue: look at the lens] Welcome back.',
        glass: 'Shows the note as a cue where you wrote it.',
        following: 'Not spoken. Following carries on with the next word.',
        note: 'A cue with no label stays on the page as typed, with a warning.',
        expect: {
          spoken: ['welcome', 'back'],
          shown: 'Welcome back.',
          cues: [{ cueType: 'cue', label: 'look at the lens' }],
          diagnostics: [],
        },
        cases: [
          {
            what: 'an empty cue is shown as source and warns',
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
        glass: 'Shows a short marker where you wrote it.',
        following: 'Not spoken. Following carries on with the next word.',
        note: 'The names are not case-sensitive: [beat] works too.',
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
        glass: 'Shows the part name as a marker.',
        following:
          'Not spoken. Divides the script into parts the Present menu can start one at a time.',
        note:
          'Without part breaks, the script is divided at its top-level headings. A --- line only draws a divider. A part break needs a name, and a nameless one stops the script being presented; give each part a different name.',
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
            what: 'with no part breaks, the top-level headings divide the script',
            source: '# Opening\n\nWelcome to the show.\n\n# Demo\n\nHere is how it works.',
            parts: ['Opening', 'Demo'],
            diagnostics: [],
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
            source: '[Take:]\n\nWelcome to the show.',
            spoken: ['welcome', 'to', 'the', 'show'],
            diagnostics: ['directive_take_empty'],
            blocking: true,
          },
          {
            what: 'two parts with one name warn',
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
        glass: 'Shows the word before the braces.',
        following: 'Follows you saying the words in say="…" instead.',
        note:
          'It applies to the single word right before the brace, and the quotes must be double quotes. Use :::spoken for anything longer.',
        expect: {
          spoken: ['the', 'a', 'p', 'i', 'is', 'fast'],
          shown: 'The API is fast.',
          diagnostics: [],
        },
        cases: [
          {
            what: 'an empty spoken form warns',
            source: 'The API{say=""} is fast.',
            diagnostics: ['directive_say_empty'],
            blocking: false,
          },
        ],
      },
      {
        id: 'spoken-block',
        title: 'Spoken block',
        example: ':::spoken\nvisual: Q3 revenue: $4.2M\nsay: third quarter revenue was four point two million\n:::',
        glass: 'Shows the visual: line.',
        following: 'Follows you saying the say: line.',
        note: 'Both lines are needed. Without them the block shows as source and stops the script being presented.',
        expect: {
          spoken: ['third', 'quarter', 'revenue', 'was', 'four', 'point', 'two', 'million'],
          shown: 'Q3 revenue: $4.2M',
          diagnostics: [],
        },
        cases: [
          {
            what: 'a spoken block without a say: line blocks presenting',
            source: ':::spoken\nvisual: Q3 revenue: $4.2M\n:::',
            spoken: [],
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
        glass: 'Shown on the glass, set apart from the script.',
        following: 'Never spoken or followed.',
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
        example: ':::stage\nKey result: **42% faster**\n:::',
        glass: 'Shown on the glass for you. Images, tables and diagrams inside one stay in full during a take.',
        following: 'Never spoken or followed.',
        expect: {
          spoken: [],
          shown: 'Key result: 42% faster',
          blockKinds: ['stage_only'],
          diagnostics: [],
        },
        cases: [
          {
            what: 'a table inside a stage block is not replaced in a take',
            source: ':::stage\n| Plan | Price |\n| --- | --- |\n| Pro | 12 |\n:::',
            spoken: [],
            blockKinds: ['stage_only'],
            takeCues: [],
            diagnostics: [],
          },
        ],
      },
      {
        id: 'nesting',
        title: 'Nesting and closing',
        example:
          ':::stage\nSlide four.\n\n:::spoken\nvisual: $4.2M\nsay: four point two million\n:::\n:::',
        glass: 'A bare ::: closes the block opened most recently, so blocks can sit inside each other.',
        following:
          'An outer silent or stage block keeps everything inside it unspoken, except a spoken block.',
        note:
          'Fence lines start at the beginning of a line. A block left open, an unknown name or a stray ::: each gets a warning.',
        expect: {
          spoken: ['four', 'point', 'two', 'million'],
          diagnostics: [],
        },
        cases: [
          {
            what: 'an outer silent block wins over what is inside it',
            source: ':::silent\nIntro notes.\n\n:::literal-command\nThanks for trying CandidCue.\n:::\n:::',
            spoken: [],
            diagnostics: [],
          },
          {
            what: 'an unclosed block is reported',
            source: ':::stage\nKey result.',
            diagnostics: ['directive_unclosed'],
          },
          {
            what: 'an unknown block name is reported and kept as text',
            source: ':::aside\nKey result.\n:::',
            diagnostics: ['directive_unknown'],
          },
          {
            what: 'a ::: with nothing open is reported',
            source: 'Key result.\n\n:::',
            diagnostics: ['directive_stray_fence'],
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
        example: ':::literal-command\nThanks for trying CandidCue.\n:::',
        glass: 'Shown like any other text.',
        following:
          'Spoken and followed as normal. It tells the editor the wake phrase CandidCue is meant to be read aloud, so it stops warning about it.',
        expect: {
          spoken: ['thanks', 'for', 'trying', 'candidcue'],
          shown: 'Thanks for trying CandidCue.',
          diagnostics: [],
        },
        cases: [
          {
            what: 'the same sentence outside the block warns',
            source: 'Thanks for trying CandidCue.',
            diagnostics: ['command_collision'],
            blocking: false,
          },
        ],
      },
      {
        id: 'escape',
        title: 'Brackets as text',
        example: 'Type \\[Pause] to add a pause.',
        glass: 'Shows [Pause] as written, without the backslash.',
        following: 'Spoken and followed as ordinary words.',
        note: 'A backslash before the bracket keeps any directive as plain text. Brackets that are not directives, like [sic], are plain text already.',
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
    entries: [
      {
        id: 'image',
        title: 'Image',
        example: '![Product shot](images/product.png)',
        glass: `In a take: a one-line ${PERFORMANCE_CUE_LABELS.image} cue. ${IN_FULL_ELSEWHERE}`,
        following: 'Not spoken.',
        note: 'Images must be files added to the script. Web addresses are not loaded.',
        expect: {
          spoken: [],
          blockKinds: ['image'],
          takeCues: [PERFORMANCE_CUE_LABELS.image],
          diagnostics: [],
        },
        cases: [
          {
            what: 'a remote image is not loaded',
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
        glass: `In a take: a one-line ${PERFORMANCE_CUE_LABELS.table} cue. ${IN_FULL_ELSEWHERE}`,
        following: 'Not spoken.',
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
        glass: `In a take: a one-line ${PERFORMANCE_CUE_LABELS.code} cue. ${IN_FULL_ELSEWHERE}`,
        following: 'Not spoken.',
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
        glass: `A mermaid fence is drawn as a diagram. In a take: a one-line ${PERFORMANCE_CUE_LABELS.diagram} cue.`,
        following: 'Not spoken.',
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
        glass: 'Shown as a heading.',
        following: `Not spoken, unless ${READ_HEADINGS_PATH} is on.`,
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
        glass: 'Shown with its formatting. Links are not clickable on the glass.',
        following: 'Spoken and followed. A link is read by its text, never its address.',
        expect: {
          spoken: ['works', 'offline', 'read', 'the', 'guide', 'first'],
          shown: 'Works offline Read the guide first',
          blockKinds: ['list_item', 'list_item'],
          diagnostics: [],
        },
      },
    ],
  },
];

/** Every entry, in reading order. */
export function syntaxEntries(): SyntaxEntry[] {
  return SYNTAX_REFERENCE.flatMap((group) => group.entries);
}
