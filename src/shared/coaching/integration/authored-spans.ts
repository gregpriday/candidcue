/**
 * §20.4/§22. The authored sentences the Luna Coach Observer is shown.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `LunaCoachRequest.authoredSpans` had no producer. `CoachingHostState`
 * initialized it to `[]`, nothing ever pushed a value, and the orchestrator
 * forwarded that empty array into every request — so §20.4's "1–3 authored
 * sentences around the active span" was never sent, and `punctuationClass`, a
 * required field of the contract, had no source at all. The model was being
 * asked to judge delivery against the script while being shown none of it.
 *
 * ---------------------------------------------------------------------------
 * PUNCTUATION IS READ, NOT INFERRED
 * ---------------------------------------------------------------------------
 * The tokenizer emits no punctuation token (`markdown/tokenize.ts`: "pure
 * punctuation never becomes a token"), so no `SpokenToken` carries
 * `TOKEN_FLAGS.PUNCTUATION` and the punctuation cannot be recovered from the
 * token stream. What survives is `CompiledBlock.renderNodes`: the authored text
 * with its punctuation intact, plus the `tokenIndexes` that text produced.
 *
 * This module therefore walks the render nodes the same way
 * `buildTrackingDocument`'s `deriveClauseEnds` does — forward-only `indexOf`
 * over each run's real characters, with the tail carried across node boundaries
 * because `**first**, we` puts the comma at the head of the *next* node. The
 * walk is duplicated rather than shared because the two want different answers
 * from it: tracking wants the set of clause ends for the unit axis, this wants
 * the exact characters that close each sentence.
 *
 * A span whose surfaces cannot be located — a `{say="…"}` override writes a
 * spoken form that is not in the visual text — contributes no trailing text and
 * is classed `weak`. That is the weakest claim available, which is the right
 * failure: guessing `strong` would tell the model a sentence closes firmly when
 * we do not know that it closes at all.
 */
import type {
  CompiledBlock,
  CompiledScript,
  SafeRenderNode,
  SentenceUnit,
  SpokenToken,
} from '../../contracts/compiler';
import type { LunaCoachRequest } from '../../contracts/coaching';
import { extractCriticalTerms } from '../fidelity/terms';

type AuthoredSpan = LunaCoachRequest['authoredSpans'][number];
type PunctuationClass = AuthoredSpan['punctuationClass'];

/** §20.4: "1–3 authored sentences around the active span." */
export const MAX_AUTHORED_SPAN_SENTENCES = 3;

/** Terminal punctuation: the sentence closes. */
const STRONG_PUNCTUATION = /[.!?…]/u;
/** Comma, semicolon, colon, en/em dash — a break in delivery, not a full stop. */
const MEDIUM_PUNCTUATION = /[,;:–—]/u;

/**
 * How strongly the authored text closes a span.
 *
 * `paragraph` outranks everything: the sentence ends its block, so whatever
 * punctuation it carries the presenter is also crossing a structural boundary,
 * and that is the stronger fact about how the line should land.
 */
function classifyTrailing(trailing: string, endsBlock: boolean): PunctuationClass {
  if (endsBlock) return 'paragraph';
  if (STRONG_PUNCTUATION.test(trailing)) return 'strong';
  if (MEDIUM_PUNCTUATION.test(trailing)) return 'medium';
  return 'weak';
}

/** One run of authored text, the spoken tokens it produced, and its marks. */
interface RenderRun {
  text: string;
  tokenIndexes: readonly number[];
  emphasized: boolean;
}

function flatten(nodes: readonly SafeRenderNode[], into: RenderRun[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const marks = node.marks ?? [];
        into.push({
          text: node.text,
          tokenIndexes: node.tokenIndexes ?? [],
          // §22 `emphasisTokens`: the authored **bold**/*italic* the writer put
          // on the word. `code` and `strike` are not delivery emphasis.
          emphasized: marks.includes('strong') || marks.includes('em'),
        });
        break;
      }
      case 'link':
        flatten(node.label, into);
        break;
      case 'table':
        for (const row of node.rows) for (const cell of row) flatten(cell, into);
        break;
      // A line break, a cue marker and an image contribute no authored
      // characters *between* two spoken tokens, so they cannot hide a comma.
      default:
        break;
    }
  }
}

interface AuthoredTextFacts {
  /** Token index → the authored characters that follow it, before the next token. */
  trailing: Map<number, string>;
  /** Token indexes the author marked bold or italic. */
  emphasized: Set<number>;
  /** Token indexes that are the last spoken token of their block. */
  blockEnds: Set<number>;
}

function readAuthoredText(
  blocks: readonly CompiledBlock[],
  tokens: readonly SpokenToken[],
): AuthoredTextFacts {
  const trailing = new Map<number, string>();
  const emphasized = new Set<number>();
  const blockEnds = new Set<number>();

  for (const block of blocks) {
    // The block's own last spoken token, which the compiler knows exactly. The
    // walk below is only asked about *characters*; "does this sentence close a
    // paragraph" is structure and is read off the structure.
    if (typeof block.endTokenIndex === 'number') blockEnds.add(block.endTokenIndex);

    const runs: RenderRun[] = [];
    flatten(block.renderNodes, runs);
    let pending = '';
    let previousTokenIndex = -1;
    let located = true;
    for (const run of runs) {
      let cursor = 0;
      for (const tokenIndex of run.tokenIndexes) {
        const surface = tokens[tokenIndex]?.surface;
        if (surface === undefined || surface.length === 0) continue;
        const at = run.text.indexOf(surface, cursor);
        // The run's surfaces are no longer locatable (a spoken override writes
        // a form that is not in the visual text). Stop contributing rather than
        // mis-attributing the rest of the run.
        if (at < 0) {
          located = false;
          break;
        }
        if (previousTokenIndex >= 0) {
          trailing.set(previousTokenIndex, pending + run.text.slice(cursor, at));
        }
        pending = '';
        cursor = at + surface.length;
        previousTokenIndex = tokenIndex;
        if (run.emphasized) emphasized.add(tokenIndex);
      }
      pending += run.text.slice(cursor);
    }
    // Whatever closes the block belongs to its last token — a trailing full
    // stop lives there, not between two tokens. Only claimed when the walk
    // actually reached that token: after a break, `pending` has swallowed the
    // text around a token we could not place, and reading a full stop out of
    // it would report a firm close we did not observe.
    if (located && previousTokenIndex >= 0) trailing.set(previousTokenIndex, pending);
  }
  return { trailing, emphasized, blockEnds };
}

/**
 * Precompute one {@link AuthoredSpan} per authored sentence.
 *
 * Done once per session rather than per tracking snapshot: the script does not
 * move, only the cursor does, so the per-frame cost of §22 is a bounded slice
 * of this array. `coachingDisabled` is the §19.4 `cc:coach off` set, resolved
 * by the caller because it is settings-dependent.
 */
export function buildAuthoredSpans(
  compiled: CompiledScript | null | undefined,
  coachingDisabledSpanIds: ReadonlySet<string>,
): AuthoredSpan[] {
  if (!compiled) return [];
  const tokens = compiled.spokenTokens;
  const facts = readAuthoredText(compiled.blocks ?? [], tokens);
  const spans: AuthoredSpan[] = [];
  for (const sentence of compiled.sentences) {
    spans.push(spanFor(sentence, tokens, facts, coachingDisabledSpanIds.has(sentence.id)));
  }
  return spans;
}

function spanFor(
  sentence: SentenceUnit,
  tokens: readonly SpokenToken[],
  facts: AuthoredTextFacts,
  coachingDisabled: boolean,
): AuthoredSpan {
  const surfaces: string[] = [];
  const emphasisTokens: string[] = [];
  const authored: Array<{ tokenIndex: number; surface: string; flags: number; sentenceId: string }> =
    [];
  for (let index = sentence.startTokenIndex; index <= sentence.endTokenIndex; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    surfaces.push(token.surface);
    if (facts.emphasized.has(index)) emphasisTokens.push(token.surface);
    authored.push({
      tokenIndex: token.index,
      surface: token.surface,
      flags: token.flags,
      sentenceId: token.sentenceId,
    });
  }
  // §22 `criticalTokens` is the same notion of "critical" the local comparator
  // acts on — numbers, units, names, negations — so it is read off the one
  // extractor rather than re-decided here with a second definition.
  const criticalTokens = extractCriticalTerms(authored).terms.map((term) => term.authoredText);
  return {
    spanId: sentence.id,
    text: surfaces.join(' '),
    criticalTokens,
    emphasisTokens,
    punctuationClass: classifyTrailing(
      facts.trailing.get(sentence.endTokenIndex) ?? '',
      facts.blockEnds.has(sentence.endTokenIndex),
    ),
    coachingDisabled,
  };
}

/**
 * §20.4. The window of authored spans around `activeSpanId`: the sentence the
 * presenter is on, the one before it, and the one after.
 *
 * An unknown or absent active span yields nothing rather than the top of the
 * script — a request that shows the model the wrong three sentences is worse
 * than one that shows it none, because it invites a confident wrong answer.
 */
export function authoredSpanWindow(
  spans: readonly AuthoredSpan[],
  activeSpanId: string | null,
): AuthoredSpan[] {
  if (activeSpanId === null || spans.length === 0) return [];
  const at = spans.findIndex((span) => span.spanId === activeSpanId);
  if (at < 0) return [];
  const start = Math.max(0, at - 1);
  return spans.slice(start, start + MAX_AUTHORED_SPAN_SENTENCES);
}
