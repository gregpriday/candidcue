/**
 * Passive microphone permission observation (spec §28.1).
 *
 * Preflight used to start at 'unknown' and only ever learn the permission
 * state from `allowMicrophone()`, so a returning user whose grant already
 * persisted was asked to click "Allow" before every session. The facade now
 * reports the state on mount and again on change — using the Permissions API
 * only, so the OS prompt is still reachable exclusively through an explicit
 * user action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealVoiceFacade } from '../../../src/control/services/voice-live';

interface FakeStatus {
  state: 'granted' | 'denied' | 'prompt';
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

let listeners: Array<() => void> = [];
let removed = 0;
let getUserMediaCalls = 0;

function fakeStatus(state: FakeStatus['state']): FakeStatus {
  return {
    state,
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: () => (removed += 1),
  };
}

function installNavigator(permissions: unknown): void {
  vi.stubGlobal('navigator', {
    permissions,
    mediaDevices: {
      enumerateDevices: async () => [],
      getUserMedia: async () => {
        getUserMediaCalls += 1;
        throw new Error('the passive watcher must never open the microphone');
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

/** Let the facade's internal async query settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  listeners = [];
  removed = 0;
  getUserMediaCalls = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watchMicrophonePermission', () => {
  it('reports an already-granted permission without prompting', async () => {
    const status = fakeStatus('granted');
    installNavigator({ query: async () => status });
    const seen: string[] = [];
    createRealVoiceFacade().watchMicrophonePermission((state) => seen.push(state));
    await settle();
    expect(seen).toContain('granted');
    expect(getUserMediaCalls).toBe(0);
  });

  it('notices a grant made while the screen is open', async () => {
    const status = fakeStatus('prompt');
    installNavigator({ query: async () => status });
    const seen: string[] = [];
    createRealVoiceFacade().watchMicrophonePermission((state) => seen.push(state));
    await settle();
    expect(seen).toEqual(['prompt']);

    status.state = 'granted';
    for (const listener of listeners) listener();
    expect(seen).toEqual(['prompt', 'granted']);
    expect(getUserMediaCalls).toBe(0);
  });

  it('reports a denial', async () => {
    installNavigator({ query: async () => fakeStatus('denied') });
    const seen: string[] = [];
    createRealVoiceFacade().watchMicrophonePermission((state) => seen.push(state));
    await settle();
    expect(seen).toEqual(['denied']);
  });

  it("degrades to 'unsupported' where 'microphone' cannot be queried", async () => {
    installNavigator({
      query: async () => {
        throw new TypeError("'microphone' is not a valid permission name");
      },
    });
    const seen: string[] = [];
    createRealVoiceFacade().watchMicrophonePermission((state) => seen.push(state));
    await settle();
    expect(seen).toEqual(['unsupported']);
    expect(getUserMediaCalls).toBe(0);
  });

  it("degrades to 'unsupported' with no Permissions API at all", async () => {
    installNavigator(undefined);
    const seen: string[] = [];
    createRealVoiceFacade().watchMicrophonePermission((state) => seen.push(state));
    await settle();
    expect(seen).toEqual(['unsupported']);
  });

  it('detaches the change listener on unsubscribe', async () => {
    installNavigator({ query: async () => fakeStatus('prompt') });
    const stop = createRealVoiceFacade().watchMicrophonePermission(() => {});
    await settle();
    stop();
    expect(removed).toBe(1);
  });

  it('reports nothing once unsubscribed before the query resolves', async () => {
    installNavigator({ query: async () => fakeStatus('granted') });
    const seen: string[] = [];
    const stop = createRealVoiceFacade().watchMicrophonePermission((s) => seen.push(s));
    stop();
    await settle();
    expect(seen).toEqual([]);
  });
});
