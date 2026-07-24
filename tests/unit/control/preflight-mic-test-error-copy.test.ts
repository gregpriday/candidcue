/**
 * §44.12 — the Preflight microphone test leaked codes too.
 *
 * `voice-live.ts` handed the transport's `event.code` straight to
 * `describeError`, which returned the string unchanged, so the inline alert
 * under the Test transcription button read "QUOTA_EXHAUSTED". Same defect,
 * different screen.
 *
 * This drives the real facade: a transport `failed` event, and a rejected
 * `connect()`, both of which end in the string the Preflight UI renders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionEvent } from '../../../src/shared/contracts';

const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

const transportControl = vi.hoisted(() => ({
  emit: null as ((event: TranscriptionEvent) => void) | null,
  connectRejection: null as unknown,
}));

vi.mock('../../../src/control/services/realtime', () => ({
  WebRtcTranscriptionTransport: class {
    ledger = {};
    connect = vi.fn(async () => {
      if (transportControl.connectRejection !== null) throw transportControl.connectRejection;
    });
    disconnect = vi.fn(async () => {});
    commit = vi.fn(() => true);
    clearBufferedAudio = vi.fn(() => true);
    onEvent(handler: (event: TranscriptionEvent) => void): () => void {
      transportControl.emit = handler;
      return () => {
        transportControl.emit = null;
      };
    }
  },
  ManualCommitDriver: class {
    handleVadEvent(): void {}
  },
}));

vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});

const { createRealVoiceFacade } = await import('../../../src/control/services/voice-live');

interface Captured {
  partials: string[];
  finals: string[];
  errors: string[];
}

async function runTest(): Promise<{ captured: Captured; stop: () => void }> {
  const captured: Captured = { partials: [], finals: [], errors: [] };
  const stop = await createRealVoiceFacade().startTranscriptionTest('mic-1', {
    onPartial: (text) => captured.partials.push(text),
    onFinal: (text) => captured.finals.push(text),
    onError: (message) => captured.errors.push(message),
  });
  return { captured, stop };
}

beforeEach(() => {
  transportControl.emit = null;
  transportControl.connectRejection = null;
});

describe('the Preflight transcription test reports failures in English', () => {
  it('renders a fatal provider failure as advice rather than its code', async () => {
    const { captured } = await runTest();
    expect(transportControl.emit).not.toBeNull();

    transportControl.emit?.({
      type: 'failed',
      code: 'QUOTA_EXHAUSTED',
      recoverable: false,
    } as TranscriptionEvent);

    const [message] = captured.errors;
    expect(message).toBeDefined();
    expect(message).not.toContain('QUOTA_EXHAUSTED');
    expect(message).not.toMatch(CODE_TOKEN);
    expect(message).toMatch(/quota|billing/i);
  });

  it('renders a failed connect as advice rather than its code', async () => {
    transportControl.connectRejection = Object.assign(new Error('handshake refused'), {
      code: 'AUTH_KEY_INVALID',
    });
    const { captured } = await runTest();

    const [message] = captured.errors;
    expect(message).toBeDefined();
    expect(message).not.toMatch(CODE_TOKEN);
    expect(message).not.toBe('handshake refused');
    expect(message).toMatch(/Settings → OpenAI/);
  });

  it('renders a microphone code thrown as an Error message in English', async () => {
    // `acquireMicrophone` throws `new Error(result.code)`.
    transportControl.connectRejection = new Error('MIC_PERMISSION_DENIED');
    const { captured } = await runTest();

    const [message] = captured.errors;
    expect(message).not.toContain('MIC_PERMISSION_DENIED');
    expect(message).not.toMatch(CODE_TOKEN);
    expect(message).toMatch(/System Settings/);
  });
});
