import {
  InworldSttClient,
  type SttConnectFactory,
  type SttTransport,
} from '@main/providers/inworld/stt-client';
import type { SttSessionConfig, Unsubscribe } from '@shared/contracts/adapters';

/**
 * A fake transport that captures the client's onMessage listener so tests can
 * push raw provider events at will. send/close are no-ops.
 */
class FakeTransport implements SttTransport {
  private listener: ((raw: unknown) => void) | null = null;

  send(_payload: ArrayBuffer): void {}
  close(): void {}
  onMessage(listener: (raw: unknown) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  /** Push a raw event into the client's fold path. */
  emit(raw: unknown): void {
    this.listener?.(raw);
  }
  partial(text: string): void {
    this.emit({ transcription: { transcript: text, isFinal: false } });
  }
  finalSegment(text: string): void {
    this.emit({ transcription: { transcript: text, isFinal: true } });
  }
}

const sessionConfig: SttSessionConfig = {
  sampleRate: 16000,
  channels: 1,
  model: 'inworld/inworld-stt-1',
  interimResults: true,
};

async function makeClient(): Promise<{ client: InworldSttClient; transport: FakeTransport }> {
  const transport = new FakeTransport();
  const connect: SttConnectFactory = async () => transport;
  const client = new InworldSttClient({ apiKey: 'k', connect });
  await client.connect(sessionConfig);
  return { client, transport };
}

describe('InworldSttClient.endTurn interim promotion', () => {
  it('promotes the last interim as the answer when only partials arrive (deadline fires)', async () => {
    const { client, transport } = await makeClient();
    await client.beginTurn('turn-1');

    transport.partial('I think');
    transport.partial('I think the answer');
    transport.partial('I think the answer is yes'); // no finalSegment ever

    const result = await client.endTurn({ deadlineMs: 5 });

    expect(result.text).toBe('I think the answer is yes');
    expect(result.finalSegments).toEqual(['I think the answer is yes']);
    expect(result.confidence).toBeNull();
  });

  it('returns empty text and no segments when neither finals nor interim exist', async () => {
    const { client } = await makeClient();
    await client.beginTurn('turn-quiet');

    const result = await client.endTurn({ deadlineMs: 5 });

    expect(result.text).toBe('');
    expect(result.finalSegments).toEqual([]);
  });

  it('uses the FINAL text and ignores a trailing interim (FINAL wins, deadline short-circuited)', async () => {
    const { client, transport } = await makeClient();
    await client.beginTurn('turn-2');

    transport.partial('I think the answer');

    // A long deadline proves the FINAL short-circuits the wait rather than the
    // timer firing. The FINAL must arrive WHILE endTurn is waiting, so emit it
    // on a microtask after endTurn has registered its early-resolve hook.
    queueMicrotask(() => {
      transport.finalSegment('I think the answer is no.');
      // A late partial that must not override the committed final.
      transport.partial('ignored trailing partial');
    });

    const start = Date.now();
    const result = await client.endTurn({ deadlineMs: 10_000 });
    const elapsed = Date.now() - start;

    expect(result.text).toBe('I think the answer is no.');
    expect(result.finalSegments).toEqual(['I think the answer is no.']);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('deactivates the turn when aborted mid-wait so later events do not fold in', async () => {
    const { client, transport } = await makeClient();
    await client.beginTurn('turn-abort');

    const controller = new AbortController();
    // Abort while endTurn is parked on its wait (before any FINAL or deadline).
    queueMicrotask(() => controller.abort());

    // The aborted endTurn rejects with an AbortError.
    await expect(
      client.endTurn({ signal: controller.signal, deadlineMs: 10_000 }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Prove turnActive was cleared by the finally (the bug left it true): a
    // post-abort FINAL must NOT fold into the now-dead turn. A fresh, fast
    // endTurn then sees an accumulator with no final segment from the leak — it
    // is not resurrected into the aborted turn.
    transport.finalSegment('leaked after abort');

    const after = await client.endTurn({ deadlineMs: 5 });
    expect(after.text).toBe('');
    expect(after.finalSegments).toEqual([]);
  });

  it('returns an already-arrived FINAL (not a promoted interim) for a pre-call final', async () => {
    const { client, transport } = await makeClient();
    await client.beginTurn('turn-prearrived-final');

    // A trailing interim plus a FINAL that both land BEFORE endTurn is called
    // (not on a later microtask). The committed final must win over the interim.
    transport.partial('an interim that must lose');
    transport.finalSegment('the final answer.');

    // Short deadline keeps the test fast; the assertion is that endTurn returns
    // the committed FINAL text/segments and never waits past the deadline.
    const start = Date.now();
    const result = await client.endTurn({ deadlineMs: 50 });
    const elapsed = Date.now() - start;

    expect(result.text).toBe('the final answer.');
    expect(result.finalSegments).toEqual(['the final answer.']);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('does not promote a whitespace-only interim (text stays empty)', async () => {
    const { client, transport } = await makeClient();
    await client.beginTurn('turn-whitespace');

    transport.partial('   '); // only whitespace, no finalSegment ever

    const result = await client.endTurn({ deadlineMs: 5 });

    expect(result.text).toBe('');
    expect(result.finalSegments).toEqual([]);
  });
});
