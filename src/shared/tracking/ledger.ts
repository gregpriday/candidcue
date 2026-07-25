/**
 * Transcript ledger and reconciliation (spec §30).
 *
 * Converts provider-neutral `TranscriptEvent`s into a deterministic,
 * commit-ordered item ledger; handles duplicates, delayed and superseded
 * events (§30.7); classifies fillers (§30.6); trims to a rolling horizon
 * (§30.3); and exposes an alignable tail with command items masked out
 * (§33.4 — the command router marks items via `setCommandDisposition`).
 */
import { classifyFillers, tokenizeNormalized, STOPWORDS } from './normalize';
import { tokenConfidencesFromLogprobs } from './transcript-confidence';
import { STABLE_REVISIONS } from './types';
import type {
  CommandDisposition,
  LedgerItem,
  LedgerToken,
  ReconciledTranscriptUpdate,
  TranscriptEvent,
} from './types';

export interface AlignableTail {
  tokens: LedgerToken[];
  /** Item ids contributing to the tail, in commit order. */
  itemIds: string[];
  /** True when the newest contributing item is final. */
  final: boolean;
  /** Mean token confidence over the tail (1 when providers omit it). */
  confidence: number;
}

/** What one revision did to an item's tokens. */
interface TokenRevision {
  /** Tokens the provider withdrew. */
  retracted: number;
  /** Leading tokens it left untouched. */
  stablePrefix: number;
}

export interface LedgerAnomaly {
  itemId: string;
  code: 'conflicting_completion' | 'unknown_item_completed' | 'stale_generation';
  atMs: number;
}

const DEFAULT_HORIZON_MS = 180_000; // §30.3: detailed evidence for 90–180 s.
/**
 * Anomalies are diagnostics, not evidence. Every other buffer in the tracking
 * worker is bounded; this one was not, so a flapping connection replaying
 * stale-generation completions grew the worker heap for the whole session.
 */
const DEFAULT_MAX_ANOMALIES = 200;

export class TranscriptLedger {
  private items = new Map<string, LedgerItem>();
  private order: string[] = []; // itemIds sorted by commitSequence
  /** Items whose commitSequence was synthesized before item_started arrived. */
  private synthetic = new Set<string>();
  private generation = 0;
  private anomalies: LedgerAnomaly[] = [];
  private horizonMs: number;
  private maxAnomalies: number;
  private nextSyntheticSequence = 0;

  constructor(options?: { horizonMs?: number; maxAnomalies?: number }) {
    this.horizonMs = options?.horizonMs ?? DEFAULT_HORIZON_MS;
    this.maxAnomalies = Math.max(1, options?.maxAnomalies ?? DEFAULT_MAX_ANOMALIES);
  }

  /** Newest-last, bounded ring of §30.7 reconciliation anomalies. */
  private recordAnomaly(anomaly: LedgerAnomaly): void {
    this.anomalies.push(anomaly);
    if (this.anomalies.length > this.maxAnomalies) {
      this.anomalies.splice(0, this.anomalies.length - this.maxAnomalies);
    }
  }

  get sessionGeneration(): number {
    return this.generation;
  }

  /** Reset for a new connection generation (spec §30.7 / §31). */
  setSessionGeneration(generation: number): void {
    if (generation === this.generation) return;
    this.generation = generation;
    this.items.clear();
    this.order = [];
    this.synthetic.clear();
    this.nextSyntheticSequence = 0;
  }

  recordedAnomalies(): readonly LedgerAnomaly[] {
    return this.anomalies;
  }

  /**
   * Apply one transcript event. Returns a reconciled update when the event
   * changed alignable state, or undefined when it was a no-op/duplicate.
   */
  apply(event: TranscriptEvent): ReconciledTranscriptUpdate | undefined {
    if (event.type === 'transport_state') return undefined;
    if (event.sessionGeneration !== this.generation) {
      // Ignore events from a previous connection generation (§30.7).
      if (event.sessionGeneration < this.generation) {
        this.recordAnomaly({
          itemId: 'itemId' in event && event.itemId !== undefined ? event.itemId : '',
          code: 'stale_generation',
          atMs: event.receivedAtMs,
        });
        return undefined;
      }
      this.setSessionGeneration(event.sessionGeneration);
    }

    switch (event.type) {
      case 'item_started': {
        const existing = this.items.get(event.itemId);
        if (existing) {
          // A delta/completion may have arrived first with a synthesized
          // sequence; the authoritative start restores commit order (§30.2).
          if (this.synthetic.has(event.itemId)) {
            this.synthetic.delete(event.itemId);
            this.order = this.order.filter((id) => id !== event.itemId);
            existing.commitSequence = event.commitSequence;
            existing.audioStartMs = event.audioStartMs;
            this.items.delete(event.itemId);
            this.insert(existing);
          }
          return undefined; // duplicate start is otherwise harmless
        }
        const item: LedgerItem = {
          sessionGeneration: event.sessionGeneration,
          itemId: event.itemId,
          commitSequence: event.commitSequence,
          audioStartMs: event.audioStartMs,
          audioEndMs: event.audioStartMs,
          provisionalText: '',
          status: 'open',
          normalizedTokens: [],
          commandDisposition: 'unknown',
          updatedAtMs: event.receivedAtMs,
        };
        this.insert(item);
        return undefined;
      }
      case 'delta': {
        const item = this.ensureItem(event.itemId, event.receivedAtMs);
        if (item.status === 'complete') return undefined; // completion supersedes deltas (§30.7)
        /*
         * A partial is a REPLACEMENT, not an append.
         *
         * This used to keep whichever text was longer, which is not a revision
         * model at all: it made a correction that removes a word unrepresentable.
         *
         *   revision 1: "we should build a very complicated navigation system"
         *   revision 2: "we should build a complicated navigation system"
         *
         * The second is the recogniser withdrawing `very` on better evidence,
         * and the longest-wins policy pinned the stale word in place for the
         * rest of the utterance — where it went on to be matched against the
         * script as though the presenter had said it.
         *
         * An empty partial is the one restatement not honoured: providers emit
         * one while re-segmenting, and no evidence is not evidence of no words.
         */
        if (event.text.trim().length === 0) return undefined;
        if (event.text === item.provisionalText && item.normalizedTokens.length > 0) {
          return undefined;
        }
        item.provisionalText = event.text;
        item.updatedAtMs = event.receivedAtMs;
        const revision = this.retokenize(item, false);
        return this.update(item, false, event.receivedAtMs, revision);
      }
      case 'completed': {
        const item = this.ensureItem(event.itemId, event.receivedAtMs);
        if (item.status === 'complete') {
          if (item.finalText === event.text) return undefined; // harmless repeat (§30.7)
          this.recordAnomaly({
            itemId: item.itemId,
            code: 'conflicting_completion',
            atMs: event.receivedAtMs,
          });
          // Tested policy: latest authoritative completion wins (§30.7).
        }
        item.finalText = event.text;
        item.provisionalText = event.text;
        item.status = 'complete';
        // §30.5: the provider's per-token log probabilities are the only ASR
        // evidence in the pipeline, and they arrive only with the authoritative
        // completion. A conflicting completion replaces them along with the
        // text they describe — keeping the old ones would attribute the
        // previous transcript's certainty to this one's words.
        if (event.logprobs !== undefined) item.logprobs = event.logprobs;
        else delete item.logprobs;
        if (event.audioEndMs !== undefined) item.audioEndMs = event.audioEndMs;
        item.updatedAtMs = event.receivedAtMs;
        const revision = this.retokenize(item, true);
        this.trim(event.receivedAtMs);
        return this.update(item, true, event.receivedAtMs, revision);
      }
      case 'failed': {
        if (event.itemId === undefined) return undefined;
        const item = this.items.get(event.itemId);
        if (!item || item.status === 'complete') return undefined;
        item.status = 'failed';
        item.normalizedTokens = [];
        item.updatedAtMs = event.receivedAtMs;
        return undefined;
      }
    }
  }

  /** Mark items as consumed by the command channel (spec §33.4 step 5). */
  setCommandDisposition(itemIds: readonly string[], disposition: CommandDisposition): void {
    for (const id of itemIds) {
      const item = this.items.get(id);
      if (item) item.commandDisposition = disposition;
    }
  }

  getItem(itemId: string): LedgerItem | undefined {
    return this.items.get(itemId);
  }

  /** Items in deterministic commit order. */
  itemsInOrder(): LedgerItem[] {
    const out: LedgerItem[] = [];
    for (const id of this.order) {
      const item = this.items.get(id);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * The rolling alignable tail (G.1 `getAlignableTail`): newest tokens first
   * trimmed to `maxTokens`, excluding failed items, command-consumed items,
   * and any explicitly excluded item ids.
   */
  getAlignableTail(options: {
    maxTokens: number;
    excludeItemIds?: ReadonlySet<string> | readonly string[];
  }): AlignableTail {
    const excluded =
      options.excludeItemIds instanceof Set
        ? options.excludeItemIds
        : new Set(options.excludeItemIds ?? []);

    const tokens: LedgerToken[] = [];
    const itemIds: string[] = [];
    let final = true;
    for (const item of this.itemsInOrder()) {
      if (item.status === 'failed') continue;
      if (item.commandDisposition === 'command' || item.commandDisposition === 'discarded') continue;
      if (excluded.has(item.itemId)) continue;
      if (item.normalizedTokens.length === 0) continue;
      tokens.push(...item.normalizedTokens);
      itemIds.push(item.itemId);
      final = item.status === 'complete';
    }
    const tail = tokens.length > options.maxTokens ? tokens.slice(tokens.length - options.maxTokens) : tokens;
    const contributing = new Set(tail.map((t) => t.itemId));
    let confidenceSum = 0;
    for (const token of tail) confidenceSum += token.confidence ?? 1;
    return {
      tokens: tail,
      itemIds: itemIds.filter((id) => contributing.has(id)),
      final,
      confidence: tail.length === 0 ? 1 : confidenceSum / tail.length,
    };
  }

  /**
   * Recent normalized tokens (finals plus the open item) for the command
   * router's wake scan (G.7 `recentNormalizedTokens`).
   */
  recentTokens(maxTokens: number): LedgerToken[] {
    const tokens: LedgerToken[] = [];
    for (const item of this.itemsInOrder()) {
      if (item.status === 'failed') continue;
      tokens.push(...item.normalizedTokens);
    }
    return tokens.length > maxTokens ? tokens.slice(tokens.length - maxTokens) : tokens;
  }

  /* ----------------------------------------------------------------------- */

  private ensureItem(itemId: string, atMs: number): LedgerItem {
    const existing = this.items.get(itemId);
    if (existing) return existing;
    // Delta/completion for an unknown item: synthesize with the next
    // sequence so ordering stays deterministic (§30.2).
    const item: LedgerItem = {
      sessionGeneration: this.generation,
      itemId,
      commitSequence: this.tailSequence() + 1 + this.nextSyntheticSequence++ / 1_000_000,
      audioStartMs: atMs,
      audioEndMs: atMs,
      provisionalText: '',
      status: 'open',
      normalizedTokens: [],
      commandDisposition: 'unknown',
      updatedAtMs: atMs,
    };
    this.synthetic.add(itemId);
    this.insert(item);
    return item;
  }

  private tailSequence(): number {
    const lastId = this.order[this.order.length - 1];
    const last = lastId !== undefined ? this.items.get(lastId) : undefined;
    return last ? last.commitSequence : 0;
  }

  private insert(item: LedgerItem): void {
    this.items.set(item.itemId, item);
    // Insert keeping commit order; stable for equal sequences by itemId.
    let index = this.order.length;
    while (index > 0) {
      const prevId = this.order[index - 1];
      const prev = prevId !== undefined ? this.items.get(prevId) : undefined;
      if (!prev) break;
      if (
        prev.commitSequence < item.commitSequence ||
        (prev.commitSequence === item.commitSequence && prev.itemId <= item.itemId)
      ) {
        break;
      }
      index--;
    }
    this.order.splice(index, 0, item.itemId);
  }

  /**
   * Re-derive an item's tokens from its current text, carrying the stability of
   * every token the revision left in place.
   *
   * The shared leading run is found on normalized surfaces rather than
   * characters, so "dont" → "don't" is one token changing rather than a prefix
   * break that retracts the rest of the sentence.
   */
  private retokenize(item: LedgerItem, final: boolean): TokenRevision {
    const text = final ? item.finalText ?? '' : item.provisionalText;
    const words = tokenizeNormalized(text);
    const previous = item.normalizedTokens;
    let stablePrefix = 0;
    while (
      stablePrefix < words.length &&
      stablePrefix < previous.length &&
      previous[stablePrefix]?.normalized === words[stablePrefix]
    ) {
      stablePrefix++;
    }
    const retracted = previous.length - stablePrefix;
    const fillers = classifyFillers(words, true);
    /**
     * §30.5 per-token ASR confidence. Provisional text has no logprobs (the
     * provider sends them only with the completion), and an unreconcilable
     * mapping yields none — in both cases the field stays absent and
     * `getAlignableTail` falls back to 1, exactly as before. So confidence is
     * only ever present when it is genuinely known.
     */
    const confidences = final ? tokenConfidencesFromLogprobs(text, item.logprobs) : undefined;
    item.normalizedTokens = words.map((word, index) => {
      const filler = fillers[index] ?? false;
      const confidence = confidences?.[index];
      /*
       * A token inside the untouched prefix has survived one more revision.
       * Past the prefix the recogniser has changed its mind, so the count
       * restarts even where a word happens to reappear further along — it is a
       * different word in a different place, and crediting it with the old
       * one's history is how a retraction turns back into evidence.
       */
      const carried = index < stablePrefix ? previous[index]?.stability ?? 0 : 0;
      const stability = final
        ? Math.max(carried + 1, STABLE_REVISIONS)
        : carried + 1;
      return {
        itemId: item.itemId,
        indexInItem: index,
        surface: word,
        normalized: word,
        final,
        filler,
        content: !filler && !STOPWORDS.has(word),
        stability,
        ...(confidence !== undefined ? { confidence } : {}),
      };
    });
    return { retracted, stablePrefix };
  }

  /** Drop detailed evidence outside the rolling horizon (spec §30.3). */
  private trim(nowMs: number): void {
    const cutoff = nowMs - this.horizonMs;
    while (this.order.length > 0) {
      const id = this.order[0];
      const item = id !== undefined ? this.items.get(id) : undefined;
      if (!item) {
        this.order.shift();
        continue;
      }
      if (item.status === 'open' || item.updatedAtMs >= cutoff) break;
      this.order.shift();
      this.items.delete(item.itemId);
      this.synthetic.delete(item.itemId);
    }
  }

  private update(
    item: LedgerItem,
    final: boolean,
    receivedAtMs: number,
    revision: TokenRevision,
  ): ReconciledTranscriptUpdate {
    return {
      sessionGeneration: item.sessionGeneration,
      itemId: item.itemId,
      final,
      receivedAtMs,
      retractedTokens: revision.retracted,
      stablePrefixTokens: revision.stablePrefix,
    };
  }
}
