import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron's MessageChannelMain so setupAudioPort can run under vitest
// (no real Chromium MessagePorts available). port1 records close() calls so we
// can prove the disposer closes exactly the live port.
const channels: Array<{ port1: FakePort; port2: FakePort }> = [];

class FakePort {
  public closed = 0;
  public started = 0;
  on = vi.fn();
  start = vi.fn(() => {
    this.started += 1;
  });
  close = vi.fn(() => {
    this.closed += 1;
  });
}

vi.mock('electron', () => {
  class MessageChannelMain {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      channels.push({ port1: this.port1, port2: this.port2 });
    }
  }
  return { MessageChannelMain };
});

import { setupAudioPort } from '@main/ipc/audio-port';
import { AppController } from '@main/app-controller';
import { NOOP_LOGGER } from '@main/interview/ports';

function fakeWebContents() {
  return { postMessage: vi.fn() } as unknown as import('electron').WebContents;
}

function makeController() {
  return new AppController({
    repository: {} as never,
    credentials: {} as never,
    logger: NOOP_LOGGER,
    videosRoot: '',
    getControl: () => null,
    getStage: () => null,
    ensureStageWindow: () => {
      throw new Error('not used');
    },
  });
}

beforeEach(() => {
  channels.length = 0;
});

describe('setupAudioPort', () => {
  it('starts port1, transfers port2 to the stage, and returns a disposer that closes port1 once', () => {
    const wc = fakeWebContents();
    const dispose = setupAudioPort(wc, vi.fn());

    expect(channels).toHaveLength(1);
    const { port1, port2 } = channels[0]!;
    expect(port1.started).toBe(1);
    expect(port1.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(wc.postMessage).toHaveBeenCalledWith(expect.any(String), null, [port2]);

    expect(port1.closed).toBe(0);
    dispose();
    expect(port1.closed).toBe(1);
    // Calling again is safe (port1.close swallows / is idempotent in the disposer).
    dispose();
    expect(port1.closed).toBe(2);
  });
});

describe('AppController audio-port disposer wiring', () => {
  it('disposes the PREVIOUS port before storing a new one (only one live at a time)', () => {
    const app = makeController();
    app.setAudioPortDisposer(setupAudioPort(fakeWebContents(), vi.fn()));
    app.setAudioPortDisposer(setupAudioPort(fakeWebContents(), vi.fn()));

    expect(channels).toHaveLength(2);
    // Re-registering closed the first port's port1; the second is still live.
    expect(channels[0]!.port1.closed).toBe(1);
    expect(channels[1]!.port1.closed).toBe(0);
  });

  it('disposes the live port on teardown and does not call a stale disposer twice', async () => {
    const app = makeController();
    app.setAudioPortDisposer(setupAudioPort(fakeWebContents(), vi.fn()));

    // shutdown() -> teardownActive() -> clearAudioPort()
    await app.shutdown();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.port1.closed).toBe(1);

    // A second teardown must not re-close the already-disposed (cleared) port.
    await app.shutdown();
    expect(channels[0]!.port1.closed).toBe(1);
  });
});
