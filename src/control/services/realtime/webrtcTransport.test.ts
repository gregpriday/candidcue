import { describe, expect, it, vi } from 'vitest';
import { WebRtcTranscriptionTransport, type RtcDataChannelLike, type RtcPeerConnectionLike, type RtcSenderLike } from './webrtcTransport';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';
import type { EphemeralCredential, TranscriptEvent } from '../../../shared/contracts';
import type { MediaStreamLike, MediaStreamTrackLike } from '../audio/types';
import singleTurn from '../../../../tests/fixtures/audio/realtime-single-turn.json';

// C1: a realistic epoch-MILLISECOND clock. A small synthetic `NOW` is
// indistinguishable from a seconds-shaped provider timestamp, which is part of
// why the credential unit mismatch went unnoticed for so long.
const NOW = 1_785_110_400_000;

function credential(): EphemeralCredential {
  return { value: 'ek_short', expiresAtEpochMs: NOW + 60_000, sessionType: 'transcription', credentialGeneration: 1 };
}

type FakeTrack = MediaStreamTrackLike & {
  stopped: boolean;
  listeners: Record<string, Array<() => void>>;
  fire(type: string): void;
};

function fakeTrack(): FakeTrack {
  return {
    kind: 'audio',
    label: 'Mic',
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true;
    },
    listeners: {} as Record<string, Array<() => void>>,
    addEventListener(type: string, cb: () => void): void {
      (this.listeners[type] ??= []).push(cb);
    },
    removeEventListener(type: string, cb: () => void): void {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f: () => void) => f !== cb);
    },
    /** Simulate the device going away (USB unplug, default-device change). */
    fire(type: string): void {
      for (const cb of [...(this.listeners[type] ?? [])]) cb();
    },
  };
}

class FakeDataChannel implements RtcDataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  sent: string[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
  receive(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

class FakePeerConnection implements RtcPeerConnectionLike {
  connectionState = 'new';
  iceConnectionState = 'new';
  dc = new FakeDataChannel();
  senders: RtcSenderLike[] = [];
  localDescription: unknown = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  closed = false;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(): FakeDataChannel {
    return this.dc;
  }
  addTrack(track: unknown): unknown {
    const sender: RtcSenderLike & { replaced: unknown[] } = {
      track: track as { stop(): void },
      replaced: [],
      replaceTrack(next: unknown) {
        this.replaced.push(next);
        this.track = next as { stop(): void };
        return Promise.resolve();
      },
    };
    this.senders.push(sender);
    return sender;
  }
  getSenders(): RtcSenderLike[] {
    return this.senders;
  }
  createOffer(): Promise<{ type: string; sdp?: string }> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0 offer' });
  }
  setLocalDescription(description: unknown): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
  fireConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

interface Harness {
  transport: WebRtcTranscriptionTransport;
  pc: FakePeerConnection;
  invoke: ReturnType<typeof vi.fn>;
  fetchFn: ReturnType<typeof vi.fn>;
  streams: Array<{ stream: MediaStreamLike; track: FakeTrack }>;
  events: TranscriptEvent[];
  releaseMicrophone: () => void;
}

function makeHarness(
  overrides: {
    fetchStatus?: number;
    /** H2: never resolve the SDP fetch — models a hung network call. */
    hangFetch?: boolean;
    /** H2: gate mic acquisition so a stop can land mid-connect. */
    gateMicrophone?: boolean;
  } = {},
): Harness {
  const pc = new FakePeerConnection();
  const invoke = vi.fn().mockResolvedValue(credential());
  const fetchFn = overrides.hangFetch
    ? vi.fn().mockImplementation(() => new Promise(() => {}))
    : vi.fn().mockResolvedValue({
        ok: (overrides.fetchStatus ?? 200) < 400,
        status: overrides.fetchStatus ?? 200,
        text: () => Promise.resolve('v=0 answer'),
      });
  let releaseMic: (() => void) | null = null;
  const micGate = overrides.gateMicrophone
    ? new Promise<void>((resolve) => {
        releaseMic = resolve;
      })
    : null;
  const streams: Harness['streams'] = [];
  const transport = new WebRtcTranscriptionTransport({
    invoke,
    fetchFn,
    createPeerConnection: () => pc,
    acquireMicrophone: async () => {
      if (micGate) await micGate;
      const track = fakeTrack();
      const stream: MediaStreamLike = { getAudioTracks: () => [track], getTracks: () => [track] };
      streams.push({ stream, track });
      return stream;
    },
    now: () => NOW,
    getVocabularyPrompt: () => 'Vocabulary: CandidCue.',
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const events: TranscriptEvent[] = [];
  transport.onEvent((event) => events.push(event));
  // Open the data channel as soon as the answer is applied.
  const origSetRemote = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = async (description) => {
    await origSetRemote(description);
    pc.dc.open();
  };
  return {
    transport,
    pc,
    invoke,
    fetchFn,
    streams,
    events,
    releaseMicrophone: () => releaseMic?.(),
  };
}

describe('WebRtcTranscriptionTransport (spec §27.3, E.2)', () => {
  it('connects: mints via the Tauri command, exchanges SDP, sends session.update', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);

    expect(h.invoke).toHaveBeenCalledWith('create_realtime_transcription_credential', {
      config: DEFAULT_TRANSCRIPTION_CONFIG,
    });
    expect(h.fetchFn).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: 'Bearer ek_short', 'Content-Type': 'application/sdp' },
      body: 'v=0 offer',
      // H2: the SDP handshake must be abortable, or a stalled fetch outlives
      // disconnect() and installs a live mic on a stopped session.
      signal: expect.anything() as AbortSignal,
    });
    expect(h.pc.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(h.pc.senders).toHaveLength(1);

    const sessionUpdate = JSON.parse(h.pc.dc.sent[0] ?? '{}') as {
      type: string;
      session: { audio: { input: { transcription: { prompt?: string } } } };
    };
    expect(sessionUpdate.type).toBe('session.update');
    expect(sessionUpdate.session.audio.input.transcription.prompt).toBe('Vocabulary: CandidCue.');

    expect(h.events.filter((e) => e.type === 'transport_state').map((e) => e.state)).toEqual([
      'connecting',
      'connected',
    ]);
    const diagnostics = h.transport.getDiagnostics();
    expect(diagnostics.transportState).toBe('connected');
    expect(diagnostics.sessionGeneration).toBe(1);
    expect(diagnostics.credentialExpiresAtEpochMs).toBe(NOW + 60_000);
  });

  it('maps a failed SDP handshake per E.7 and cleans up', async () => {
    const h = makeHarness({ fetchStatus: 401 });
    await expect(h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG)).rejects.toMatchObject({
      code: 'AUTH_KEY_INVALID',
      recoverable: false,
      httpStatus: 401,
    });
    expect(h.pc.closed).toBe(true);
    expect(h.streams[0]?.track.stopped).toBe(true);
    expect(h.transport.getDiagnostics().transportState).toBe('failed');
  });

  it('adapts server events from the data channel into TranscriptEvents', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    // A commit must be recorded before its acknowledgement arrives.
    h.transport.ledger.recordPending({ reason: 'vad_silence', speechStartMs: 0, speechEndMs: 900 });
    for (const raw of singleTurn.events as unknown[]) h.pc.dc.receive(raw);

    const types = h.events.filter((e) => e.type !== 'transport_state').map((e) => e.type);
    expect(types).toEqual(['item_started', 'delta', 'delta', 'delta', 'completed']);
    expect(h.transport.getDiagnostics().lastServerEventAtMs).toBe(NOW);
    expect(h.transport.getDiagnostics().lastCompletedItemAtMs).toBe(NOW);
  });

  it('sends manual commit and clear events only while the channel is open', async () => {
    const h = makeHarness();
    h.transport.commit('vad_silence'); // not connected: silently dropped (E.3)
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    h.transport.commit('vad_silence');
    h.transport.clearBufferedAudio();
    const sent = h.pc.dc.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    expect(sent).toEqual(['session.update', 'input_audio_buffer.commit', 'input_audio_buffer.clear']);
  });

  it('switches microphone via replaceTrack and releases the old stream', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await h.transport.setMicrophone('mic-2');
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0]?.track.stopped).toBe(true); // old track stopped
    expect(h.streams[1]?.track.stopped).toBe(false);
    const sender = h.pc.senders[0] as RtcSenderLike & { replaced: unknown[] };
    expect(sender.replaced).toHaveLength(1);
  });

  it('emits a recoverable connection-loss failure on unexpected peer failure', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    h.pc.fireConnectionState('failed');
    expect(h.events.at(-1)).toMatchObject({
      type: 'failed',
      code: 'REALTIME_CONNECTION_LOST',
      recoverable: true,
    });
  });

  it('disconnect stops tracks, closes the peer, and stays quiet about it', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await h.transport.disconnect('stop');
    expect(h.pc.closed).toBe(true);
    expect(h.streams[0]?.track.stopped).toBe(true);
    expect(h.transport.getDiagnostics().transportState).toBe('disconnected');
    // No spurious connection-lost event from an intentional close.
    expect(h.events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('refuses to double-connect', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await expect(h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG)).rejects.toMatchObject({
      code: 'REALTIME_NEGOTIATION_FAILED',
    });
  });

  // -------------------------------------------------------------------------
  // H2: a connect attempt must be cancellable
  // -------------------------------------------------------------------------

  it('H2: stopping during a hung SDP fetch releases the microphone and never publishes', async () => {
    const h = makeHarness({ hangFetch: true });
    const connecting = h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await flush();

    // The mic is open and the fetch is stalled — precisely the state where the
    // user gives up and presses Stop.
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]?.track.stopped).toBe(false);

    await h.transport.disconnect('stop');
    await expect(connecting).rejects.toBeTruthy();
    await flush();

    // Pre-fix the fetch outlived disconnect() and later installed a live peer
    // connection and an open microphone on a stopped session.
    expect(h.streams[0]?.track.stopped).toBe(true);
    expect(h.pc.closed).toBe(true);
    expect(h.transport.getDiagnostics().transportState).toBe('disconnected');
    expect(h.transport.hasPendingConnect).toBe(false);
  });

  it('H2: stopping during microphone acquisition never leaves a mic open', async () => {
    const h = makeHarness({ gateMicrophone: true });
    const connecting = h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await flush();

    await h.transport.disconnect('stop'); // stop lands before the mic resolves
    h.releaseMicrophone(); // the getUserMedia promise finally settles
    await expect(connecting).rejects.toBeTruthy();
    await flush();

    expect(h.streams[0]?.track.stopped).toBe(true);
    expect(h.transport.getDiagnostics().transportState).toBe('disconnected');
  });

  it('H2: a cancelled attempt does not report itself as a transport failure', async () => {
    const h = makeHarness({ hangFetch: true });
    const connecting = h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await flush();
    await h.transport.disconnect('stop');
    await connecting.catch(() => {});
    await flush();

    // A deliberate stop must not surface as `failed` — that reads to the user
    // as "something went wrong" on a clean stop.
    const states = h.events.filter((e) => e.type === 'transport_state').map((e) => e.state);
    expect(states).not.toContain('failed');
    expect(states.at(-1)).toBe('disconnected');
  });

  it('H2: the SDP fetch is aborted, not merely abandoned', async () => {
    const h = makeHarness({ hangFetch: true });
    const connecting = h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await flush();
    const init = h.fetchFn.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(false);

    await h.transport.disconnect('stop');
    await connecting.catch(() => {});
    expect(init.signal?.aborted).toBe(true);
  });

  it('H2: the total connect deadline terminates a hung attempt', async () => {
    const pc = new FakePeerConnection();
    const deadline: { fire: (() => void) | null } = { fire: null };
    const streams: Array<{ track: FakeTrack }> = [];
    const transport = new WebRtcTranscriptionTransport({
      invoke: vi.fn().mockResolvedValue(credential()),
      fetchFn: vi.fn().mockImplementation(() => new Promise(() => {})),
      createPeerConnection: () => pc,
      acquireMicrophone: () => {
        const track = fakeTrack();
        streams.push({ track });
        return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
      },
      now: () => NOW,
      // Capture the deadline timer so the test can fire it deterministically.
      timers: {
        setTimeout: (cb: () => void) => {
          deadline.fire = cb;
          return 1;
        },
        clearTimeout: () => {},
      },
    });

    const connecting = transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await flush();
    deadline.fire?.();
    await expect(connecting).rejects.toBeTruthy();
    await flush();

    // Without a deadline this attempt hangs forever and the reconnect loop
    // above it can never make progress.
    expect(streams[0]?.track.stopped).toBe(true);
  });

  // -------------------------------------------------------------------------
  // H5: device loss must be observable
  // -------------------------------------------------------------------------

  it('H5: a track that ends mid-session emits a session-level device-lost failure', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    h.events.length = 0;

    // USB mic unplugged: the peer connection and data channel stay healthy.
    h.streams[0]?.track.fire('ended');

    const failures = h.events.filter((e) => e.type === 'failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'MIC_DEVICE_LOST', recoverable: true });
    // Session-level: no item id, so the controller owns recovery.
    expect((failures[0] as { itemId?: string }).itemId).toBeUndefined();
    // The transport itself is still "connected" — which is exactly why nothing
    // else in the stack would have noticed.
    expect(h.transport.getDiagnostics().transportState).toBe('connected');
  });

  it('H5: mute/unmute report silent input and recovery', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    h.events.length = 0;

    h.streams[0]?.track.fire('mute');
    expect(h.events.at(-1)).toMatchObject({ type: 'failed', code: 'MIC_NO_SIGNAL' });

    h.streams[0]?.track.fire('unmute');
    expect(h.events.at(-1)).toEqual({ type: 'input_restored' });
  });

  it('H5: switching microphone moves the watcher to the new track', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await h.transport.setMicrophone('mic-2');
    h.events.length = 0;

    // The old track is no longer transmitted; its events must be ignored.
    h.streams[0]?.track.fire('ended');
    expect(h.events.filter((e) => e.type === 'failed')).toHaveLength(0);

    h.streams[1]?.track.fire('ended');
    expect(h.events.at(-1)).toMatchObject({ type: 'failed', code: 'MIC_DEVICE_LOST' });
  });

  it('H5: disconnect detaches the track watcher', async () => {
    const h = makeHarness();
    await h.transport.connect(DEFAULT_TRANSCRIPTION_CONFIG);
    await h.transport.disconnect('stop');
    h.events.length = 0;

    h.streams[0]?.track.fire('ended');
    expect(h.events).toEqual([]);
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
