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
/** Fields never retained in diagnostics (spec §30.1: no auth/audio payloads). */
const REDACTED_FIELDS = new Set(['audio', 'delta_audio', 'client_secret', 'authorization']);

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

export class TranscriptEventAdapter {
  private readonly now: () => number;
  private readonly diagnostics: Array<Record<string, unknown>> = [];

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
        const text = asString(event.delta);
        if (!itemId || text === null) return null;
        return { type: 'delta', itemId, text, receivedAtMs: this.now() };
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = asString(event.item_id);
        if (!itemId) return null;
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

  private remember(event: RawRealtimeEvent): void {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      redacted[key] = REDACTED_FIELDS.has(key.toLowerCase()) ? '[redacted]' : value;
    }
    this.diagnostics.push(redacted);
    if (this.diagnostics.length > MAX_DIAGNOSTIC_EVENTS) this.diagnostics.shift();
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
