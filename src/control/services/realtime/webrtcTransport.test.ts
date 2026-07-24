import { describe, expect, it, vi } from 'vitest';
import { WebRtcTranscriptionTransport, type RtcDataChannelLike, type RtcPeerConnectionLike, type RtcSenderLike } from './webrtcTransport';
import { DEFAULT_TRANSCRIPTION_CONFIG } from './sessionConfig';
import type { EphemeralCredential, TranscriptEvent } from '../../../shared/contracts';
import type { MediaStreamLike, MediaStreamTrackLike } from '../audio/types';
import singleTurn from '../../../../tests/fixtures/audio/realtime-single-turn.json';

const NOW = 1_000_000;

function credential(): EphemeralCredential {
  return { value: 'ek_short', expiresAt: NOW + 60_000, sessionType: 'transcription', credentialGeneration: 1 };
}

function fakeTrack(): MediaStreamTrackLike & { stopped: boolean } {
  return {
    kind: 'audio',
    label: 'Mic',
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener() {},
    removeEventListener() {},
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
  streams: Array<{ stream: MediaStreamLike; track: ReturnType<typeof fakeTrack> }>;
  events: TranscriptEvent[];
}

function makeHarness(overrides: { fetchStatus?: number } = {}): Harness {
  const pc = new FakePeerConnection();
  const invoke = vi.fn().mockResolvedValue(credential());
  const fetchFn = vi.fn().mockResolvedValue({
    ok: (overrides.fetchStatus ?? 200) < 400,
    status: overrides.fetchStatus ?? 200,
    text: () => Promise.resolve('v=0 answer'),
  });
  const streams: Harness['streams'] = [];
  const transport = new WebRtcTranscriptionTransport({
    invoke,
    fetchFn,
    createPeerConnection: () => pc,
    acquireMicrophone: () => {
      const track = fakeTrack();
      const stream: MediaStreamLike = { getAudioTracks: () => [track], getTracks: () => [track] };
      streams.push({ stream, track });
      return Promise.resolve(stream);
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
  return { transport, pc, invoke, fetchFn, streams, events };
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
    expect(diagnostics.credentialExpiresAt).toBe(NOW + 60_000);
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
});
