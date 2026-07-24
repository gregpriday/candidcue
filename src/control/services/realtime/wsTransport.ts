/**
 * Fallback transport skeleton: native Rust WebSocket (spec §27.4).
 *
 * NOT IMPLEMENTED. This is the contingency path if the Phase 0 spike finds
 * WebRTC unreliable inside a target system WebView, manual commit semantics
 * inadequate, or microphone switching unable to meet release criteria.
 *
 * Full parity requires work that lives mostly in Rust:
 * - PCM capture (or forwarding) and resampling to 24 kHz mono PCM16;
 * - a native WebSocket to the OpenAI Realtime endpoint holding the key
 *   inside the trusted process (no ephemeral secret needed);
 * - an IPC event bridge streaming provider events into this class, which
 *   would reuse `TranscriptEventAdapter`, `CommitLedger`, and
 *   `buildSessionUpdateEvent` unchanged.
 *
 * Every method that would touch the network throws `NotImplementedError`
 * so accidental activation fails loudly instead of half-working.
 */
import type {
  CommitReason,
  DisconnectReason,
  RealtimeTranscriptionTransport,
  TranscriptEvent,
  TranscriptionConfig,
  TransportDiagnostics,
  Unsubscribe,
} from '../../../shared/contracts';
import { CommitLedger } from './commitLedger';
import { NotImplementedError } from './errors';

export class RustWebSocketTranscriptionTransport implements RealtimeTranscriptionTransport {
  readonly ledger = new CommitLedger();
  private readonly handlers = new Set<(event: TranscriptEvent) => void>();

  async connect(_config: TranscriptionConfig): Promise<void> {
    // TODO(ws-fallback): invoke a Rust command to open the native WebSocket
    // session and subscribe to its event stream over Tauri events.
    throw new NotImplementedError('RustWebSocketTranscriptionTransport.connect');
  }

  async setMicrophone(_deviceId: string): Promise<void> {
    // TODO(ws-fallback): route device selection to the native capture path.
    throw new NotImplementedError('RustWebSocketTranscriptionTransport.setMicrophone');
  }

  commit(_reason: CommitReason): boolean {
    // TODO(ws-fallback): forward `input_audio_buffer.commit` over IPC.
    throw new NotImplementedError('RustWebSocketTranscriptionTransport.commit');
  }

  clearBufferedAudio(): boolean {
    // TODO(ws-fallback): forward `input_audio_buffer.clear` over IPC.
    throw new NotImplementedError('RustWebSocketTranscriptionTransport.clearBufferedAudio');
  }

  async disconnect(_reason: DisconnectReason): Promise<void> {
    // Safe no-op: nothing can be connected yet.
  }

  onEvent(handler: (event: TranscriptEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getDiagnostics(): TransportDiagnostics {
    return {
      transportState: 'disconnected',
      sessionGeneration: this.ledger.getSessionGeneration(),
      reconnectAttempts: 0,
    };
  }
}
