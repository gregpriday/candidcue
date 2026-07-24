/**
 * Hand-made CompiledScript-shaped fixtures for alignment tests.
 *
 * Deliberately independent of the real Markdown compiler (built by another
 * workstream): tests depend only on the structural `TrackingDocument`
 * contract. The mini "compiler" here understands just enough:
 *   - lines starting with "# " become headings (level = number of #);
 *   - blank lines separate paragraph blocks;
 *   - sentences split on . ! ? within a block.
 */
import { normalizeText, STOPWORDS } from '../../../src/shared/tracking/normalize';
import { TOKEN_FLAG } from '../../../src/shared/tracking/types';
import type { SpokenToken, TrackingDocument } from '../../../src/shared/tracking/types';
import type {
  NavigationTarget,
  OutlineNode,
  SentenceUnit,
} from '../../../src/shared/contracts/compiler';

export interface FixtureOptions {
  scriptId?: string;
  /** Extra weight for these normalized words (rare anchors). */
  rareWords?: readonly string[];
}

export function compileFixtureScript(source: string, options?: FixtureOptions): TrackingDocument {
  const rare = new Set(options?.rareWords ?? []);
  const spokenTokens: SpokenToken[] = [];
  const sentences: SentenceUnit[] = [];
  const outline: OutlineNode[] = [];
  const navigationTargets: NavigationTarget[] = [];

  let tokenIndex = 0;
  let blockCounter = 0;
  let sentenceCounter = 0;
  let headingCounter = 0;
  let charCursor = 0;

  const pushSentence = (blockId: string, words: string[], start: number): void => {
    if (words.length === 0) return;
    const sentenceId = `s${sentenceCounter++}`;
    const startToken = tokenIndex;
    for (const word of words) {
      const normalized = normalizeText(word);
      if (normalized.length === 0) continue;
      const isStopword = STOPWORDS.has(normalized);
      let flags = 0;
      if (isStopword) flags |= TOKEN_FLAG.stopword;
      if (/^\d+$/.test(normalized)) flags |= TOKEN_FLAG.number;
      spokenTokens.push({
        index: tokenIndex,
        blockId,
        sentenceId,
        surface: word,
        normalized,
        aliases: [],
        weight: rare.has(normalized) ? 1.5 : isStopword ? 0.35 : 1.0,
        source: { utf16Start: start, utf16End: start + word.length },
        flags,
      });
      tokenIndex++;
    }
    if (tokenIndex > startToken) {
      sentences.push({
        id: sentenceId,
        blockId,
        startTokenIndex: startToken,
        endTokenIndex: tokenIndex - 1,
        normalizedText: spokenTokens
          .slice(startToken, tokenIndex)
          .map((t) => t.normalized)
          .join(' '),
        source: { utf16Start: start, utf16End: start },
      });
    }
  };

  const blocks = source
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  for (const block of blocks) {
    const blockId = `b${blockCounter++}`;
    const headingMatch = /^(#+)\s+(.*)$/.exec(block);
    if (headingMatch !== null && headingMatch[1] !== undefined && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const startToken = tokenIndex;
      pushSentence(blockId, title.split(/\s+/), charCursor);
      const headingId = `h${headingCounter++}`;
      outline.push({
        id: headingId,
        level,
        title,
        normalizedTitle: normalizeText(title),
        blockId,
        startTokenIndex: startToken,
        endTokenIndex: tokenIndex - 1, // patched to section end below
        children: [],
      });
      navigationTargets.push({
        id: `nav-${headingId}`,
        type: 'heading',
        label: title,
        normalizedLabel: normalizeText(title),
        tokenIndex: startToken,
        blockId,
      });
    } else {
      const sentenceTexts = block
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const sentence of sentenceTexts) {
        pushSentence(blockId, sentence.split(/\s+/), charCursor);
      }
    }
    charCursor += block.length + 2;
  }

  // Extend each heading's range to the start of the next same-or-higher
  // heading (section spans, spec §31.3.3).
  for (let i = 0; i < outline.length; i++) {
    const node = outline[i];
    if (node === undefined) continue;
    let end = tokenIndex - 1;
    for (let j = i + 1; j < outline.length; j++) {
      const later = outline[j];
      if (later !== undefined && later.level <= node.level) {
        end = later.startTokenIndex - 1;
        break;
      }
    }
    node.endTokenIndex = end;
  }

  if (spokenTokens.length > 0) {
    const first = spokenTokens[0];
    const last = spokenTokens[spokenTokens.length - 1];
    if (first !== undefined && last !== undefined) {
      navigationTargets.push({
        id: 'nav-beginning',
        type: 'beginning',
        label: 'Beginning',
        normalizedLabel: 'beginning',
        tokenIndex: first.index,
        blockId: first.blockId,
      });
      navigationTargets.push({
        id: 'nav-end',
        type: 'end',
        label: 'End',
        normalizedLabel: 'end',
        tokenIndex: last.index,
        blockId: last.blockId,
      });
    }
  }

  return {
    scriptId: options?.scriptId ?? 'fixture-script',
    spokenTokens,
    sentences,
    outline,
    navigationTargets,
  };
}

/**
 * The shared demo script used across engine scenario tests. Contains a
 * repeated refrain ("let's get started") in two distant sections on purpose
 * (spec §31.13) and rare anchors like "kaleidoscope" and "metronome".
 */
export const DEMO_SCRIPT_SOURCE = `# Welcome

Hello everyone and welcome to the channel. Today we are talking about building a teleprompter that actually listens. Let's get started with the basics right away.

The first principle is that the prompter follows you instead of forcing you to follow it. When you pause the prompter pauses. When you ad lib the prompter waits patiently for you to come back.

# The Kaleidoscope Demo

Now watch the kaleidoscope demo carefully because the colors shift like a metronome keeping perfect time. This section explains the alignment engine and the confidence model in plain language.

The engine scores candidate windows using exact matches aliases numbers and phonetic similarity. It refuses to jump when two candidates look almost identical.

# Closing Thoughts

Let's get started with the wrap up now. Remember to subscribe and share this video with a friend. Thank you so much for watching until the very end.`;

export function demoDocument(): TrackingDocument {
  return compileFixtureScript(DEMO_SCRIPT_SOURCE, {
    rareWords: ['kaleidoscope', 'metronome', 'teleprompter', 'subscribe'],
  });
}

/* ---------------------------------------------------------------------------
 * Liveness fixtures — document *shapes*, not document content
 *
 * The tracking suite had thorough safety coverage ("no illegal jump ever
 * happens") and no liveness coverage at all ("a presenter reading correctly
 * gets to the end"). Safety alone cannot distinguish a correct section gate
 * from one that refuses everything, and two ordinary shapes made it refuse
 * everything. These are those shapes.
 * ------------------------------------------------------------------------- */

/**
 * `# Part` immediately followed by `## Scene`, three times over — the shape of
 * every screenplay, course module, and chaptered talk. The parent owns only
 * its own heading words, which nobody reads aloud, so the cursor can never
 * land in it and the boundary has to be crossed *through* it (§13.2).
 */
export const NESTED_PARTS_SOURCE = `# Part One

## Scene A

The morning market opened with vendors calling across the narrow lanes. Fresh bread and roasted chestnuts scented the cold air near the stone fountain.

## Scene B

Later the painter arrived carrying a folding easel and a wooden box of brushes. She worked quickly capturing the bustling crowd before the light could change.

# Part Two

## Scene C

That evening the square emptied and the lanterns flickered along the colonnade. A violinist played softly while the waiter stacked the heavy iron chairs.

## Scene D

Rain began after midnight and washed the cobbles clean of the day's dust. The baker unlocked his shutters and the ovens breathed warmth into the alley.

# Part Three

## Scene E

By dawn the gulls had claimed the empty awnings above the shuttered stalls. A postman wheeled his bicycle past the cathedral steps whistling an old tune.

## Scene F

The market reopened and the whole cycle began again without any ceremony. Nobody remembered the rain except the puddles drying slowly in the sunlight.`;

export function nestedPartsDocument(): TrackingDocument {
  return compileFixtureScript(NESTED_PARTS_SOURCE, {
    rareWords: [
      'chestnuts',
      'easel',
      'colonnade',
      'violinist',
      'cobbles',
      'shutters',
      'awnings',
      'cathedral',
      'puddles',
      'lanterns',
    ],
  });
}

/**
 * Many short sections. The boundary corridor is clamped to a fraction of the
 * enclosing section, so with sections this size it collapses to one or two
 * tokens — which is where an entry test that keys on where the matched span
 * *ended* rather than where it *entered* becomes a near-certain wedge.
 */
export const SHORT_SECTIONS_SOURCE = `# Sunrise

The lighthouse dimmed as the horizon turned pale amber. Gulls lifted off the breakwater in one loose ragged sheet.

# Harbor

Fishing boats returned early with a modest catch of mackerel. Their diesel engines coughed twice and then settled into idle.

# Auction

Dockworkers shouted bids beneath the circling herring gulls. Crates changed hands faster than anyone outside could follow.

# Ledger

The harbormaster recorded every crate in a leather ledger. His handwriting sloped downward whenever the tally ran long.

# Tide

Water climbed the seawall and retreated before anyone noticed. Weed marked the highest reach in a dark uneven line.

# Dusk

Lamps flickered along the quay while the nets dried overhead. Two children counted the lamps aloud and lost their place.

# Anchor

A rusting anchor leaned against the chandlery like a monument. Nobody could remember which vessel had abandoned it there.

# Silence

Nothing moved on the water except one late returning trawler. Its wake folded quietly against the pilings and disappeared.`;

export function shortSectionsDocument(): TrackingDocument {
  return compileFixtureScript(SHORT_SECTIONS_SOURCE, {
    rareWords: [
      'lighthouse',
      'mackerel',
      'dockworkers',
      'harbormaster',
      'seawall',
      'quay',
      'chandlery',
      'trawler',
      'herring',
      'amber',
      'breakwater',
      'diesel',
      'pilings',
    ],
  });
}

/**
 * Flat sections with a preamble before the first heading. The preamble is an
 * unowned token range, and the flat successor lookup had no entry for it, so
 * progressing out of it into the first real section was prohibited too.
 */
export const PREAMBLE_SOURCE = `Before we begin I want to thank everyone who sent questions during the week. Your notes shaped almost every example you are about to see.

# Foundations

The committee gathered in the paneled room to review the quarterly figures. Revenue climbed steadily while expenses stayed flat across the whole region.

# Consequences

Outside the harbor the fishing boats returned early carrying a modest catch. By noon the auction house echoed with rapid bids and unexpected laughter.

# Reflections

Everyone agreed the plan deserved another season of patient careful funding. The chairman closed his folder and thanked the room for its attention.`;

export function preambleDocument(): TrackingDocument {
  return compileFixtureScript(PREAMBLE_SOURCE, {
    rareWords: ['paneled', 'quarterly', 'harbor', 'auction', 'chairman', 'folder'],
  });
}
