/**
 * Primary Realtime transport: browser WebRTC in the control window
 * (spec §27.3, Appendix E.2).
 *
 * All platform surfaces (peer connection, fetch, Tauri invoke, microphone
 * acquisition, timers) are injected so the transport is unit-testable with
 * fakes. Raw OpenAI events never leave this module — the adapter converts
 * them to `TranscriptEvent`s at the boundary (spec §27.4/§30.1).
 */
import type {
  CommitReason,
  DisconnectReason,
  EphemeralCredential,
  RealtimeTranscriptionTransport,
  TranscriptEvent,
  TranscriptionConfig,
  TransportDiagnostics,
  TransportState,
  Unsubscribe,
} from '../../../shared/contracts';
import type { Clock, MediaStreamLike, MediaStreamTrackLike } from '../audio/types';
import { releaseStream } from '../audio/permissions';
import { watchTrackHealth } from '../audio/failures';
import { CommitLedger } from './commitLedger';
import { mintTranscriptionCredential, type TauriInvoke } from './credentials';
import { TranscriptEventAdapter } from './eventAdapter';
import {
  mapRealtimeHttpStatus,
  readProviderFailureContext,
  RealtimeTransportError,
} from './errors';
import { buildSessionUpdateEvent, type TranscriptionSessionOptions } from './sessionConfig';

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
export const DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS = 10_000;
/**
 * H2: hard ceiling on ONE connect attempt, end to end (mic → mint → SDP →
 * data channel). Every step already has, or now has, its own guard, but a
 * total deadline is what guarantees a connect attempt always terminates so the
 * controller's reconnect loop can make progress instead of hanging forever
 * behind a stalled network call while the UI still reads "connected".
 */
export const DEFAULT_CONNECT_DEADLINE_MS = 30_000;

/**
 * How long ICE gets to recover from `disconnected` before it counts as a drop.
 *
 * `disconnected` is a recoverable state by specification — the agent is still
 * running connectivity checks — and it is reached routinely by a Wi-Fi roam, a
 * NAT rebinding, or a brief CPU stall. Reporting it immediately ended live
 * takes that would have recovered on their own within a second.
 *
 * Five seconds is a compromise, not a tuning: long enough to ride out the
 * ordinary blips, short enough that a presenter who has genuinely lost the
 * network is told promptly rather than left following a prompter that quietly
 * stopped listening (§60).
 */
export const DEFAULT_DISCONNECT_GRACE_MS = 5_000;

/**
 * Thrown when a connect attempt is invalidated by `disconnect()`/suspend, or
 * by the total deadline. Distinct from a negotiation failure: nothing is
 * wrong with the provider, the caller simply stopped caring about this
 * attempt, so it must never be published and never be retried on its own.
 */
export class ConnectCancelledError extends RealtimeTransportError {
  constructor(reason: string) {
    super('REALTIME_CONNECTION_LOST', `Connect cancelled: ${reason}`, true);
    this.name = 'ConnectCancelledError';
  }
}

// ---------------------------------------------------------------------------
// Thin structural WebRTC interfaces (injected; matched by the real DOM types)
// ---------------------------------------------------------------------------

export interface RtcDataChannelLike {
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RtcSenderLike {
  track: { stop(): void } | null;
  replaceTrack(track: unknown): Promise<void>;
}

export interface RtcPeerConnectionLike {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  createDataChannel(label: string): RtcDataChannelLike;
  addTrack(track: unknown, stream: unknown): unknown;
  getSenders(): RtcSenderLike[];
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  close(): void;
  onconnectionstatechange: (() => void) | null;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** M4: needed to honour `Retry-After` on a 429. */
  headers?: { get(name: string): string | null } | null;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    /**
     * H2: the SDP handshake must be abortable. Without it a stalled fetch
     * outlives `disconnect()` and later installs a live peer connection and an
     * open microphone on an already-stopped session.
     */
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface TransportTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WebRtcTransportDeps {
  /** Tauri invoke used to mint the short-lived client secret (§46.4). */
  invoke: TauriInvoke;
  /** Open the selected microphone (audio package provides this). */
  acquireMicrophone: (deviceId?: string) => Promise<MediaStreamLike>;
  fetchFn?: FetchLike;
  createPeerConnection?: () => RtcPeerConnectionLike;
  ledger?: CommitLedger;
  now?: Clock;
  callsUrl?: string;
  /** Vocabulary prompt injection point (spec §27.5). Read at connect time. */
  getVocabularyPrompt?: () => string | undefined;
  sessionOptions?: Omit<TranscriptionSessionOptions, 'vocabularyPrompt'>;
  dataChannelOpenTimeoutMs?: number;
  /** H2: total wall-clock ceiling for one connect attempt. */
  connectDeadlineMs?: number;
  /**
   * How long a transient ICE `disconnected` is given to recover before it is
   * reported as a dropped connection. See `handleConnectionStateChange`.
   */
  disconnectGraceMs?: number;
  timers?: TransportTimers;
  /**
   * Optional connect-progress callback so the session controller can mirror
   * the §29.1 sub-states (opening_microphone → minting_credential →
   * negotiating) without depending on transport internals.
   */
  onConnectProgress?: (phase: ConnectPhase) => void;
}

export type ConnectPhase = 'opening_microphone' | 'minting_credential' | 'negotiating';

interface ActiveConnection {
  pc: RtcPeerConnectionLike;
  dc: RtcDataChannelLike;
  stream: MediaStreamLike;
  credentialExpiresAtEpochMs: number;
  credentialGeneration: number;
}

export class WebRtcTranscriptionTransport implements RealtimeTranscriptionTransport {
  readonly ledger: CommitLedger;

  private readonly adapter: TranscriptEventAdapter;
  private readonly now: Clock;
  private readonly fetchFn: FetchLike;
  private readonly createPc: () => RtcPeerConnectionLike;
  private readonly timers: TransportTimers;
  private readonly callsUrl: string;
  private readonly openTimeoutMs: number;
  private readonly connectDeadlineMs: number;

  private readonly handlers = new Set<(event: TranscriptEvent) => void>();
  private state: TransportState = 'disconnected';
  private connection: ActiveConnection | null = null;
  private preferredDeviceId: string | undefined;
  private lastServerEventAtMs: number | undefined;
  private lastCompletedItemAtMs: number | undefined;
  private lastCommitAtMs: number | undefined;
  private reconnectAttempts = 0;
  private closingIntentionally = false;
  /** H5: detaches the device-loss listeners on the transmitted track. */
  private disposeTrackWatch: (() => void) | null = null;
  /** Recovery window for a transient ICE `disconnected` (see below). */
  private disconnectGraceTimer: unknown = null;
  private readonly disconnectGraceMs: number;
  /** Why the last connection ended unexpectedly, for diagnostics. */
  private lastCloseReason: string | undefined;

  // -- H2 cancellable-connect state ----------------------------------------
  /**
   * Monotonic operation epoch. Every connect attempt captures the value at
   * entry and re-checks it after each await; `disconnect()` bumps it. An
   * attempt whose epoch is stale releases whatever it built and never
   * publishes, so a stalled negotiation can no longer resurrect a microphone
   * on a session the user already stopped.
   */
  private connectEpoch = 0;
  /**
   * Resources of the IN-FLIGHT attempt, recorded the instant they exist so
   * `disconnect()` can see and close them mid-negotiation. Previously these
   * lived in local variables until negotiation completed and were therefore
   * invisible to cancellation.
   */
  private pending: {
    epoch: number;
    stream: MediaStreamLike | null;
    pc: RtcPeerConnectionLike | null;
    dc: RtcDataChannelLike | null;
    abort: AbortController | null;
    deadlineTimer: unknown | null;
    /**
     * Rejects the moment this attempt is cancelled. Every await in `connect`
     * races against it, so cancellation does not depend on the underlying
     * operation honouring an AbortSignal — a `fetch` polyfill, a WebView quirk
     * or a peer-connection call that simply never settles would otherwise pin
     * the attempt open forever and hold the microphone with it.
     */
    cancelled: Promise<never>;
    cancel: (error: Error) => void;
  } | null = null;

  constructor(private readonly deps: WebRtcTransportDeps) {
    this.ledger = deps.ledger ?? new CommitLedger();
    this.now = deps.now ?? (() => Date.now());
    this.adapter = new TranscriptEventAdapter({ ledger: this.ledger, now: this.now });
    this.fetchFn =
      deps.fetchFn ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>);
    this.createPc =
      deps.createPeerConnection ??
      (() => new RTCPeerConnection() as unknown as RtcPeerConnectionLike);
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
    };
    this.callsUrl = deps.callsUrl ?? OPENAI_REALTIME_CALLS_URL;
    this.openTimeoutMs = deps.dataChannelOpenTimeoutMs ?? DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS;
    this.connectDeadlineMs = deps.connectDeadlineMs ?? DEFAULT_CONNECT_DEADLINE_MS;
    this.disconnectGraceMs = deps.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  }

  // -- RealtimeTranscriptionTransport -------------------------------------

  async connect(config: TranscriptionConfig): Promise<void> {
    if (this.connection) {
      throw new RealtimeTransportError(
        'REALTIME_NEGOTIATION_FAILED',
        'Transport is already connected',
        true,
      );
    }
    this.setState('connecting');

    // H2: claim a fresh epoch and publish the in-flight slot BEFORE anything
    // is acquired, so `disconnect()` can cancel and reclaim at any await.
    const epoch = ++this.connectEpoch;
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let cancel!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = reject;
    });
    // Nothing may await `cancelled` before the first race, so pre-attach a
    // no-op handler to keep it from being reported as an unhandled rejection.
    cancelled.catch(() => {});
    const attempt = {
      epoch,
      stream: null as MediaStreamLike | null,
      pc: null as RtcPeerConnectionLike | null,
      dc: null as RtcDataChannelLike | null,
      abort,
      deadlineTimer: null as unknown,
      cancelled,
      cancel,
    };
    this.pending = attempt;
    attempt.deadlineTimer = this.timers.setTimeout(() => {
      // Total deadline: invalidate the epoch so the attempt unwinds at its
      // next checkpoint even if the underlying promise never settles.
      if (this.pending === attempt) this.cancelPending('connect deadline exceeded');
    }, this.connectDeadlineMs);

    let credential: EphemeralCredential | null = null;
    try {
      // 1. Open the microphone and verify an active track (§29.2 step 4).
      this.deps.onConnectProgress?.('opening_microphone');
      const micPromise = this.deps.acquireMicrophone(this.preferredDeviceId);
      // If cancellation wins the race the microphone still opens a moment
      // later, with nobody holding a reference to close it — a live recording
      // indicator on a session the user already stopped. Release it whenever
      // it arrives too late.
      void micPromise.then(
        (late) => {
          if (epoch !== this.connectEpoch) releaseStream(late);
        },
        () => {},
      );
      const stream = await this.race(attempt, micPromise);
      attempt.stream = stream;
      this.assertLive(epoch, 'after microphone acquisition');
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') {
        throw new RealtimeTransportError('MIC_DEVICE_MISSING', 'No live audio track', true);
      }

      // 2. Mint a fresh short-lived client secret in Rust (§29.2 step 5).
      this.deps.onConnectProgress?.('minting_credential');
      credential = await this.race(
        attempt,
        mintTranscriptionCredential(this.deps.invoke, config, this.now),
      );
      this.assertLive(epoch, 'after credential mint');

      // 3. Peer connection + data channel (Appendix E.2).
      this.deps.onConnectProgress?.('negotiating');
      const pc = this.createPc();
      attempt.pc = pc;
      const dc = pc.createDataChannel('oai-events');
      attempt.dc = dc;
      pc.addTrack(track, stream);
      dc.onmessage = (event) => this.handleServerMessage(event.data);

      // 4. SDP offer/answer via the calls endpoint, ephemeral bearer only.
      const offer = await this.race(attempt, pc.createOffer());
      this.assertLive(epoch, 'after createOffer');
      await this.race(attempt, pc.setLocalDescription(offer));
      this.assertLive(epoch, 'after setLocalDescription');
      const response = await this.race(
        attempt,
        this.fetchFn(this.callsUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential.value}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp ?? '',
          ...(abort ? { signal: abort.signal } : {}),
        }),
      );
      this.assertLive(epoch, 'after SDP fetch');
      if (!response.ok) {
        // M4: classify on status PLUS the structured provider code. A 429 can
        // be a temporary rate limit (retry) or hard quota exhaustion (never
        // retry) — treating them alike either wastes the reconnect budget or
        // gives up on a recoverable stall.
        const body = await this.race(attempt, response.text()).catch(() => null);
        const mapped = mapRealtimeHttpStatus(
          response.status,
          readProviderFailureContext(body, response.headers),
        );
        throw new RealtimeTransportError(
          mapped.code,
          `Realtime SDP handshake failed (${response.status})`,
          mapped.recoverable,
          response.status,
        );
      }
      const answerSdp = await this.race(attempt, response.text());
      this.assertLive(epoch, 'after reading SDP answer');
      await this.race(attempt, pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }));
      this.assertLive(epoch, 'after setRemoteDescription');

      // 5. Wait for the events channel, then send/verify session config.
      await this.race(attempt, this.waitForDataChannelOpen(dc));
      this.assertLive(epoch, 'after data channel open');
      this.adapter.reset(); // H4: item ids are unique per connection only.
      this.ledger.beginSessionGeneration();
      const sessionUpdate = buildSessionUpdateEvent(config, {
        ...this.deps.sessionOptions,
        vocabularyPrompt: this.deps.getVocabularyPrompt?.(),
      });
      dc.send(JSON.stringify(sessionUpdate));

      // Final checkpoint immediately before publishing. Everything above may
      // have yielded; this is the last chance to notice a stop.
      this.assertLive(epoch, 'before publishing the connection');

      this.connection = {
        pc,
        dc,
        stream,
        credentialExpiresAtEpochMs: credential.expiresAtEpochMs,
        credentialGeneration: credential.credentialGeneration,
      };
      // Ephemeral secret is single-use for the handshake; drop the reference.
      credential = null;
      this.closingIntentionally = false;
      pc.onconnectionstatechange = () => this.handleConnectionStateChange();
      dc.onclose = () => this.handleUnexpectedClose('data channel closed');
      this.watchInputTrack(track); // H5: arm device-loss detection.
      this.clearAttempt(attempt);
      this.setState('connected');
    } catch (error) {
      credential = null;
      // Release whatever THIS attempt built. `disconnect()` may already have
      // done it (cancellation path) — both paths are idempotent.
      this.releaseAttempt(attempt);
      if (this.pending === attempt) this.pending = null;
      // A cancelled attempt must not stomp the state the canceller chose:
      // `disconnect()` already moved us to `disconnected`/`closing`, and
      // flipping to `failed` here would make a clean stop look like an error.
      if (epoch === this.connectEpoch) {
        this.connection = null;
        this.setState('failed');
      }
      throw error instanceof RealtimeTransportError
        ? error
        : new RealtimeTransportError(
            'REALTIME_NEGOTIATION_FAILED',
            error instanceof Error ? error.message : 'Realtime negotiation failed',
            true,
          );
    }
  }

  // -- H2 cancellation helpers ---------------------------------------------

  /** Throw if this attempt has been superseded, cancelled, or timed out. */
  private assertLive(epoch: number, where: string): void {
    if (epoch !== this.connectEpoch) throw new ConnectCancelledError(where);
  }

  /**
   * Await `work`, but lose the race to cancellation. This is what makes
   * `disconnect()` genuinely synchronous from the caller's point of view: the
   * connect promise rejects immediately instead of waiting on a network call
   * that may never come back.
   */
  private race<T>(attempt: { cancelled: Promise<never> }, work: Promise<T>): Promise<T> {
    // Swallow the loser's rejection so an abandoned operation cannot surface
    // as an unhandled rejection later.
    work.catch(() => {});
    return Promise.race([work, attempt.cancelled]);
  }

  /**
   * Invalidate the in-flight attempt and tear down whatever it has already
   * acquired. Safe to call with no attempt in flight.
   */
  private cancelPending(reason: string): void {
    const attempt = this.pending;
    this.connectEpoch += 1; // any in-flight attempt is now stale
    if (!attempt) return;
    this.pending = null;
    const error = new ConnectCancelledError(reason);
    try {
      attempt.abort?.abort(error);
    } catch {
      // AbortController.abort never throws in practice; be defensive anyway.
    }
    // Unblock every await in the attempt, whether or not the underlying
    // operation honours the abort signal.
    attempt.cancel(error);
    this.releaseAttempt(attempt);
  }

  /** Close and release an attempt's resources. Idempotent. */
  private releaseAttempt(attempt: {
    stream: MediaStreamLike | null;
    pc: RtcPeerConnectionLike | null;
    dc: RtcDataChannelLike | null;
    deadlineTimer: unknown;
  }): void {
    if (attempt.deadlineTimer !== null) {
      this.timers.clearTimeout(attempt.deadlineTimer);
      attempt.deadlineTimer = null;
    }
    if (attempt.dc) {
      attempt.dc.onmessage = null;
      attempt.dc.onopen = null;
      attempt.dc.onclose = null;
      attempt.dc.onerror = null;
      try {
        attempt.dc.close();
      } catch {
        // already closed
      }
      attempt.dc = null;
    }
    if (attempt.pc) {
      attempt.pc.onconnectionstatechange = null;
      safeClose(attempt.pc);
      attempt.pc = null;
    }
    // The microphone is the one that matters: leaving it open is a live
    // recording indicator on a session the user believes is stopped.
    releaseStream(attempt.stream);
    attempt.stream = null;
  }

  /** Successful publish: keep the resources, drop only the attempt bookkeeping. */
  private clearAttempt(attempt: { deadlineTimer: unknown }): void {
    if (attempt.deadlineTimer !== null) {
      this.timers.clearTimeout(attempt.deadlineTimer);
      attempt.deadlineTimer = null;
    }
    if (this.pending?.epoch === (attempt as { epoch?: number }).epoch) this.pending = null;
  }

  /**
   * Switch microphone. Mid-session this replaces the sender track without a
   * renegotiation; the caller is responsible for committing buffered speech
   * first (spec §28.2/§29.3 — commit before switch).
   */
  async setMicrophone(deviceId: string): Promise<void> {
    this.preferredDeviceId = deviceId || undefined;
    if (!this.connection) return; // applies on next connect

    const newStream = await this.deps.acquireMicrophone(this.preferredDeviceId);
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack || newTrack.readyState !== 'live') {
      releaseStream(newStream);
      throw new RealtimeTransportError('MIC_DEVICE_MISSING', 'No live audio track', true);
    }
    const sender = this.connection.pc.getSenders().find((s) => s.track !== null);
    if (!sender) {
      releaseStream(newStream);
      throw new RealtimeTransportError('REALTIME_CONNECTION_LOST', 'No audio sender', true);
    }
    await sender.replaceTrack(newTrack as unknown as MediaStreamTrackLike);
    releaseStream(this.connection.stream);
    this.connection.stream = newStream;
    // H5: the old track is gone; health must follow the track we actually send.
    this.watchInputTrack(newTrack);
  }

  /**
   * H5: arm device-loss detection on the track we are actually transmitting.
   *
   * A USB mic unplugged mid-take ends the track while the peer connection and
   * data channel stay perfectly healthy — the exact shape of "the UI looks
   * live but nothing is being transcribed". These surface as SESSION-level
   * failures (no `itemId`) so the controller's recovery policy owns them.
   */
  private watchInputTrack(track: MediaStreamTrackLike): void {
    this.stopWatchingInputTrack();
    this.disposeTrackWatch = watchTrackHealth(track, (failure, code) => {
      if (failure === 'track_ended') {
        this.emit({ type: 'failed', code: code ?? 'MIC_DEVICE_LOST', recoverable: true });
        return;
      }
      if (failure === 'track_muted') {
        // A muted track transmits silence: the provider stays happy and
        // returns nothing. Treat it as input loss, not a cosmetic warning.
        this.emit({ type: 'failed', code: 'MIC_NO_SIGNAL', recoverable: true });
        return;
      }
      // track_recovered — unmuted; the controller decides whether to resume.
      this.emit({ type: 'input_restored' });
    });
  }

  private stopWatchingInputTrack(): void {
    this.disposeTrackWatch?.();
    this.disposeTrackWatch = null;
  }

  /**
   * Manual commit (Appendix E.3). Never sent before the channel is open.
   *
   * M1: returns whether the event was actually enqueued. Silently returning
   * void on a closed channel let the driver record a pending FIFO entry for a
   * commit that never left the client, which then mis-associated every later
   * provider item with the wrong commit metadata.
   */
  commit(_reason: CommitReason): boolean {
    const dc = this.connection?.dc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch {
      // The channel can transition to closing between the readyState check
      // and the send; treat it as not sent rather than assuming success.
      return false;
    }
    this.lastCommitAtMs = this.now();
    return true;
  }

  /** Connection generation a commit belongs to (M1: VAD-gate the driver). */
  get connectedGeneration(): number | null {
    return this.connection ? this.ledger.getSessionGeneration() : null;
  }

  clearBufferedAudio(): boolean {
    const dc = this.connection?.dc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
    } catch {
      return false;
    }
    return true;
  }

  async disconnect(reason: DisconnectReason): Promise<void> {
    this.closingIntentionally = true;
    // H2: cancel FIRST and unconditionally. A connect attempt in flight owns a
    // microphone and possibly a peer connection that `this.connection` cannot
    // see; without this, stopping during negotiation left the mic open and let
    // the attempt publish itself onto a stopped session.
    this.cancelPending(`disconnect (${reason})`);
    this.stopWatchingInputTrack();
    // A recovery window armed moments ago must not outlive the connection it
    // was watching — it would fire against a torn-down transport and report a
    // dropped connection for a take the operator stopped on purpose.
    this.clearDisconnectGrace();

    const connection = this.connection;
    if (!connection) {
      this.setState('disconnected');
      return;
    }
    this.setState('closing');
    this.connection = null;
    connection.pc.onconnectionstatechange = null;
    connection.dc.onclose = null;
    connection.dc.onmessage = null;
    try {
      connection.dc.close();
    } catch {
      // already closed
    }
    safeClose(connection.pc);
    // Stop tracks and clear references (spec §28.7 / §29.7).
    releaseStream(connection.stream);
    this.setState('disconnected');
  }

  /** True while a connect attempt is in flight (H2 diagnostics/tests). */
  get hasPendingConnect(): boolean {
    return this.pending !== null;
  }

  onEvent(handler: (event: TranscriptEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getDiagnostics(): TransportDiagnostics {
    return {
      transportState: this.state,
      peerConnectionState: this.connection?.pc.connectionState,
      iceConnectionState: this.connection?.pc.iceConnectionState,
      dataChannelState: this.connection?.dc.readyState,
      lastServerEventAtMs: this.lastServerEventAtMs,
      lastCompletedItemAtMs: this.lastCompletedItemAtMs,
      lastCommitAtMs: this.lastCommitAtMs,
      credentialExpiresAtEpochMs: this.connection?.credentialExpiresAtEpochMs,
      credentialGeneration: this.connection?.credentialGeneration,
      sessionGeneration: this.ledger.getSessionGeneration(),
      reconnectAttempts: this.reconnectAttempts,
      lastCloseReason: this.lastCloseReason,
    };
  }

  // -- helpers -------------------------------------------------------------

  /** Redacted developer diagnostics from the adapter (spec §30.1). */
  getAdapterDiagnostics(): ReadonlyArray<Record<string, unknown>> {
    return this.adapter.getDiagnosticEvents();
  }

  noteReconnectAttempt(): void {
    this.reconnectAttempts += 1;
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private handleServerMessage(data: unknown): void {
    this.lastServerEventAtMs = this.now();
    const event = this.adapter.adapt(data);
    if (!event) return;
    if (event.type === 'completed') this.lastCompletedItemAtMs = this.now();
    this.emit(event);
  }

  /**
   * §29.1. `disconnected` is not a failure — it is ICE saying so.
   *
   * The WebRTC spec defines `disconnected` as connectivity checks failing for
   * at least one component *while the agent keeps trying*; it recovers on its
   * own from the things that happen constantly on a laptop — a Wi-Fi roam
   * between access points, a NAT rebinding, a few hundred milliseconds of CPU
   * starvation while the stage lays out a long script. `failed` is the terminal
   * one, and it is a state ICE reaches by itself when recovery is genuinely
   * out of reach.
   *
   * Treating them alike ended the take on the first blip: the transport tore
   * down a connection that was about to come back, and the presenter — mid
   * take, on camera — got "the realtime connection to OpenAI dropped" and had
   * to start voice following again. On a normal home network that is a matter
   * of when, not whether.
   *
   * So a transient state starts a clock instead of a teardown. Recovery cancels
   * it and nothing is reported, because nothing happened worth reporting. The
   * grace window is deliberately short: following has already stopped for its
   * duration, and a presenter is better served by a clear failure at five
   * seconds than by a prompter that silently stopped following and never said
   * so (§60 is emphatic that a stalled follow must surface).
   */
  private handleConnectionStateChange(): void {
    const state = this.connection?.pc.connectionState;
    if (!state || this.closingIntentionally) return;
    if (state === 'failed' || state === 'closed') {
      this.clearDisconnectGrace();
      this.handleUnexpectedClose(`peer connection ${state}`);
      return;
    }
    if (state === 'disconnected') {
      this.armDisconnectGrace();
      return;
    }
    // `connected` (or back to `connecting`) — ICE recovered on its own.
    this.clearDisconnectGrace();
  }

  /** Start the recovery window, if one is not already running. */
  private armDisconnectGrace(): void {
    if (this.disconnectGraceTimer !== null) return;
    this.disconnectGraceTimer = this.timers.setTimeout(() => {
      this.disconnectGraceTimer = null;
      // Re-read rather than trusting the state that armed this: the whole
      // point is that it may have moved, and a `connected` here means the
      // blip resolved without another state change reaching us.
      const state = this.connection?.pc.connectionState;
      if (state === 'connected' || state === 'completed') return;
      this.handleUnexpectedClose(`peer connection ${state ?? 'disconnected'} beyond grace`);
    }, this.disconnectGraceMs);
  }

  private clearDisconnectGrace(): void {
    if (this.disconnectGraceTimer === null) return;
    this.timers.clearTimeout(this.disconnectGraceTimer);
    this.disconnectGraceTimer = null;
  }

  private handleUnexpectedClose(detail: string): void {
    if (this.closingIntentionally || !this.connection) return;
    this.clearDisconnectGrace();
    // Kept, not discarded: this is the only record of WHICH way the connection
    // died, and it is what the support bundle and a bug report have to carry.
    this.lastCloseReason = detail;
    this.setState('failed');
    this.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
  }

  private waitForDataChannelOpen(dc: RtcDataChannelLike): Promise<void> {
    if (dc.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = this.timers.setTimeout(() => {
        dc.onopen = null;
        dc.onerror = null;
        reject(
          new RealtimeTransportError(
            'REALTIME_NEGOTIATION_FAILED',
            'Data channel did not open in time',
            true,
          ),
        );
      }, this.openTimeoutMs);
      dc.onopen = () => {
        this.timers.clearTimeout(timeout);
        dc.onopen = null;
        dc.onerror = null;
        resolve();
      };
      dc.onerror = () => {
        this.timers.clearTimeout(timeout);
        dc.onopen = null;
        dc.onerror = null;
        reject(
          new RealtimeTransportError(
            'REALTIME_NEGOTIATION_FAILED',
            'Data channel error before open',
            true,
          ),
        );
      };
    });
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'transport_state', state });
  }

  private emit(event: TranscriptEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

function safeClose(pc: RtcPeerConnectionLike): void {
  try {
    pc.close();
  } catch {
    // already closed
  }
}
