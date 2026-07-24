/**
 * Transcript event adapter (spec Appendix E.4, §30.1).
 *
 * Converts raw OpenAI Realtime server events into the provider-neutral
 * `TranscriptEvent` stream immediately at the transport boundary. Nothing
 * above the transport may depend on provider event shapes. Unknown events
 * return null (tolerated for forward compatibility); a bounded, redacted
 * copy is kept in memory for developer diagnostics only.
 */
import type { TokenLogprob, TranscriptEvent } from '../../../shared/contracts';
import type { CommitLedger } from './commitLedger';
import { mapProviderErrorEvent } from './errors';

const MAX_DIAGNOSTIC_EVENTS = 50;

interface RawRealtimeEvent {
  type?: unknown;
  item_id?: unknown;
  previous_item_id?: unknown;
  delta?: unknown;
  transcript?: unknown;
  logprobs?: unknown;
  error?: unknown;
  code?: unknown;
  [key: string]: unknown;
}

export function normalizeLogprobs(raw: unknown): TokenLogprob[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: TokenLogprob[] = [];
  for (const entry of raw) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { token?: unknown }).token === 'string' &&
      typeof (entry as { logprob?: unknown }).logprob === 'number'
    ) {
      result.push({
        token: (entry as { token: string }).token,
        logprob: (entry as { logprob: number }).logprob,
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

export interface AdapterDeps {
  ledger: CommitLedger;
  now?: () => number;
}

/** Cap on in-flight delta accumulators and remembered completions (H4). */
const MAX_TRACKED_ITEMS = 64;

export class TranscriptEventAdapter {
  private readonly now: () => number;
  private readonly diagnostics: Array<Record<string, unknown>> = [];
  /** H4: per-item cumulative transcript assembled from incremental deltas. */
  private readonly partials = new Map<string, string>();
  /** Items whose authoritative completion already shipped (§30.7). */
  private readonly completedItems = new Set<string>();

  constructor(private readonly deps: AdapterDeps) {
    this.now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  /**
   * Adapt one raw provider event (already-parsed JSON or a JSON string).
   * Returns the internal event, or null for events with no internal meaning.
   */
  adapt(raw: unknown): TranscriptEvent | null {
    let event: RawRealtimeEvent;
    if (typeof raw === 'string') {
      try {
        event = JSON.parse(raw) as RawRealtimeEvent;
      } catch {
        return { type: 'failed', code: 'PROVIDER_UNAVAILABLE', recoverable: true };
      }
    } else if (typeof raw === 'object' && raw !== null) {
      event = raw as RawRealtimeEvent;
    } else {
      return null;
    }

    const type = typeof event.type === 'string' ? event.type : '';

    switch (type) {
      case 'input_audio_buffer.committed': {
        // Server acknowledged a manual commit and assigned the item id;
        // associate with the oldest pending local commit (spec §29.3).
        const itemId = asString(event.item_id);
        if (!itemId) return null;
        const meta = this.deps.ledger.associateItem(itemId);
        if (!meta) {
          this.remember(event);
          return null;
        }
        return { type: 'item_started', itemId, commitSequence: meta.commitSequence };
      }

      case 'conversation.item.input_audio_transcription.delta': {
        const itemId = asString(event.item_id);
        const chunk = asString(event.delta);
        if (!itemId || chunk === null) return null;
        // A delta arriving after the item completed is stale; the completion
        // is authoritative, so never re-open the item with a fragment.
        if (this.completedItems.has(itemId)) {
          this.remember(event);
          return null;
        }
        // H4: the provider sends INCREMENTAL chunks ("CandidCue ",
        // "is following ", "my voice."). Consumers — the ledger above all —
        // treat `delta.text` as the cumulative transcript so far, so the
        // accumulation must happen here at the boundary. Forwarding chunks
        // verbatim fed the follower the last fragment instead of the
        // utterance, mis-aligning the teleprompter for the whole turn until
        // the final completion repaired it.
        const accumulated = (this.partials.get(itemId) ?? '') + chunk;
        this.rememberPartial(itemId, accumulated);
        return { type: 'delta', itemId, text: accumulated, receivedAtMs: this.now() };
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = asString(event.item_id);
        if (!itemId) return null;
        // The completion is authoritative and supersedes every delta; drop the
        // accumulator so a late delta for this item cannot resurrect a stale
        // prefix (§30.7).
        this.partials.delete(itemId);
        this.completedItems.add(itemId);
        this.trimCompleted();
        const completed: TranscriptEvent = {
          type: 'completed',
          itemId,
          text: asString(event.transcript) ?? '',
        };
        const logprobs = normalizeLogprobs(event.logprobs);
        if (logprobs) completed.logprobs = logprobs;
        return completed;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        const errorObj = (event.error ?? {}) as { code?: string; type?: string };
        const mapped = mapProviderErrorEvent(errorObj);
        const failed: TranscriptEvent = {
          type: 'failed',
          code: mapped.code,
          recoverable: mapped.recoverable,
        };
        const itemId = asString(event.item_id);
        if (itemId) failed.itemId = itemId;
        return failed;
      }

      case 'error': {
        const errorObj = (event.error ?? event) as { code?: string; type?: string };
        const mapped = mapProviderErrorEvent(errorObj);
        return { type: 'failed', code: mapped.code, recoverable: mapped.recoverable };
      }

      default:
        this.remember(event);
        return null;
    }
  }

  /** Redacted, bounded, memory-only diagnostics (spec §30.1). */
  getDiagnosticEvents(): ReadonlyArray<Record<string, unknown>> {
    return this.diagnostics;
  }

  /**
   * Drop all per-item state. Call on a fresh session generation: item ids are
   * only unique within a connection, so carrying accumulators across a
   * reconnect could splice two different utterances together.
   */
  reset(): void {
    this.partials.clear();
    this.completedItems.clear();
  }

  private rememberPartial(itemId: string, text: string): void {
    this.partials.set(itemId, text);
    while (this.partials.size > MAX_TRACKED_ITEMS) {
      const oldest = this.partials.keys().next();
      if (oldest.done) break;
      this.partials.delete(oldest.value);
    }
  }

  private trimCompleted(): void {
    while (this.completedItems.size > MAX_TRACKED_ITEMS) {
      const oldest = this.completedItems.values().next();
      if (oldest.done) break;
      this.completedItems.delete(oldest.value);
    }
  }

  /**
   * M2: store an ALLOWLISTED summary, never the provider object.
   *
   * The previous implementation redacted only top-level denylisted keys, so a
   * nested `session.client_secret`, a nested transcript, or a provider error
   * body carrying user speech all survived into the in-memory diagnostic
   * snapshot. Denylisting an open-ended provider payload cannot be made safe —
   * every new provider field defaults to "retained". So nothing is copied out
   * of the event except the small set of non-sensitive identifiers below;
   * everything else is reduced to a byte count.
   */
  private remember(event: RawRealtimeEvent): void {
    const summary: Record<string, unknown> = {
      type: asString(event.type) ?? '(untyped)',
      atMs: this.now(),
      approxBytes: approximateByteLength(event),
    };
    const itemId = asString(event.item_id);
    if (itemId) summary.itemId = itemId;
    const previousItemId = asString(event.previous_item_id);
    if (previousItemId) summary.previousItemId = previousItemId;
    const eventId = asString((event as { event_id?: unknown }).event_id);
    if (eventId) summary.eventId = eventId;
    // Error CODES are classification input and contain no user content; error
    // messages and bodies are provider prose that can quote speech, so they
    // are counted, never kept.
    const error = event.error;
    if (typeof error === 'object' && error !== null) {
      const code = asString((error as { code?: unknown }).code);
      const errType = asString((error as { type?: unknown }).type);
      if (code) summary.errorCode = code;
      if (errType) summary.errorType = errType;
      summary.errorBodyBytes = approximateByteLength(error);
    }
    this.diagnostics.push(summary);
    if (this.diagnostics.length > MAX_DIAGNOSTIC_EVENTS) this.diagnostics.shift();
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Size only — the payload itself is never retained (M2). */
function approximateByteLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0; // cyclic or non-serializable; the count is a nicety
  }
}
