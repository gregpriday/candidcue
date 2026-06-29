// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StageStateProjection } from '@shared/contracts';

// Keep the mount headless in jsdom — none of these engines is under test here.
vi.mock('../../src/renderer/stage/playback/SpeechPlayer', () => ({
  SpeechPlayer: class {
    load = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/playback/BackchannelPlayer', () => ({
  BackchannelPlayer: class {
    init = vi.fn(async () => {});
    play = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/audio/SyncBeeper', () => ({
  SyncBeeper: class {
    play = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/audio/CaptureController', () => ({
  CaptureController: class {
    start = vi.fn(async () => {});
    setGate = vi.fn();
    dispose = vi.fn(async () => {});
  },
}));
vi.mock('../../src/renderer/stage/playback/VideoDeck', () => ({
  VideoDeck: () => null,
}));

import { StageApp } from '../../src/renderer/stage/stage-app';

const send = vi.fn();
let onStateCb: ((next: StageStateProjection) => void) | null = null;

function projection(overrides: Partial<StageStateProjection> = {}): StageStateProjection {
  return {
    version: 1,
    visualState: 'standby',
    micState: 'closed',
    statusText: null,
    captions: null,
    cue: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    canBegin: false,
    ...overrides,
  };
}

function installStageBridge(): void {
  onStateCb = null;
  (window as unknown as { candidcueStage: unknown }).candidcueStage = {
    bootstrap: vi.fn(async () => ({
      characterId: 'mira',
      posterUrl: '',
      listeningClips: [],
      backchannelClips: [],
      video: { fit: 'cover', mirror: false, zoom: 1, verticalOffsetPercent: 0, transitionMs: 0 },
    })),
    commands: { send },
    playback: {
      reportReady: vi.fn(),
      reportStarted: vi.fn(),
      reportEnded: vi.fn(),
      reportError: vi.fn(),
    },
    audio: { reportMeter: vi.fn(), openCapturePort: vi.fn() },
    events: {
      onState: vi.fn((cb: (next: StageStateProjection) => void) => {
        onStateCb = cb;
        return () => {};
      }),
      onPlaybackPlan: vi.fn(() => () => {}),
      onPlayBackchannel: vi.fn(() => () => {}),
      onCaptureConfig: vi.fn(() => () => {}),
    },
  };
}

async function mountStage(): Promise<void> {
  render(<StageApp />);
  await screen.findByText('Your interview is ready.');
}

/** Drive an authoritative state projection into the mounted stage. */
function pushState(next: StageStateProjection): void {
  act(() => {
    onStateCb?.(next);
  });
}

beforeEach(() => {
  send.mockClear();
  installStageBridge();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { candidcueStage?: unknown }).candidcueStage;
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('StageApp — keypress confirm/reject', () => {
  it('confirms a command that lands and still sends it', async () => {
    await mountStage();
    pushState(projection({ visualState: 'listening', micState: 'active' }));

    fireEvent.keyDown(window, { code: 'Space', key: ' ' });

    expect(screen.getByText('Got it')).toHaveAttribute('data-kind', 'ok');
    expect(send).toHaveBeenCalledWith({ type: 'COMMIT', reason: 'manual' });
  });

  it('rejects a wrong-moment command but still sends it (orchestrator decides)', async () => {
    await mountStage();
    pushState(projection({ visualState: 'speaking', micState: 'closed' }));

    fireEvent.keyDown(window, { code: 'Space', key: ' ' });

    expect(screen.getByText('Not now')).toHaveAttribute('data-kind', 'rejected');
    expect(send).toHaveBeenCalledWith({ type: 'COMMIT', reason: 'manual' });
  });

  it('shows no cue for keys that were never stage controls', async () => {
    await mountStage();
    pushState(projection({ visualState: 'listening', micState: 'active' }));

    fireEvent.keyDown(window, { code: 'KeyX', key: 'x' });

    expect(screen.queryByText('Got it')).toBeNull();
    expect(screen.queryByText('Not now')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('clears the cue after a beat and re-pulses on the next press', async () => {
    await mountStage();
    pushState(projection({ visualState: 'listening', micState: 'active' }));
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, { code: 'Space', key: ' ' });
      expect(screen.getByText('Got it')).toBeInTheDocument();

      // It stays brief: gone after the clear timer fires.
      act(() => vi.advanceTimersByTime(1200));
      expect(screen.queryByText('Got it')).toBeNull();

      // A fresh press brings it back (token restart).
      fireEvent.keyDown(window, { code: 'Space', key: ' ' });
      expect(screen.getByText('Got it')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms REPEAT from a pause even after speaking (documented approximation)', async () => {
    // The renderer cannot see `userHasSpoken`, so a pause taken after the founder
    // began answering still confirms REPEAT; the orchestrator is the final word.
    await mountStage();
    pushState(projection({ visualState: 'listening', micState: 'active' }));
    pushState(projection({ visualState: 'paused', micState: 'closed' }));

    fireEvent.keyDown(window, { code: 'KeyR', key: 'r' });

    expect(screen.getByText('Got it')).toHaveAttribute('data-kind', 'ok');
    expect(send).toHaveBeenCalledWith({ type: 'REPEAT' });
  });
});

describe('StageApp — mic-arm chime', () => {
  function installAudioContextSpy(): { start: ReturnType<typeof vi.fn> } {
    const start = vi.fn();
    const osc = {
      type: '',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start,
      stop: vi.fn(),
    };
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const ctor = vi.fn(() => ({
      currentTime: 0,
      destination: {},
      createGain: () => gain,
      createOscillator: () => osc,
      close: vi.fn(async () => {}),
    }));
    (window as unknown as { AudioContext: unknown }).AudioContext = ctor;
    return { start };
  }

  it('chimes once on each transition into armed, not on repeat or non-armed', async () => {
    const { start } = installAudioContextSpy();
    await mountStage();

    // The interviewer speaking (mic closed) never chimes.
    pushState(projection({ visualState: 'speaking', micState: 'closed' }));
    expect(start).not.toHaveBeenCalled();

    // The mic arming is the "your turn" moment — chime.
    pushState(projection({ visualState: 'listening', micState: 'armed' }));
    expect(start).toHaveBeenCalledTimes(1);

    // A second armed projection (no transition) must not re-chime.
    pushState(projection({ visualState: 'listening', micState: 'armed' }));
    expect(start).toHaveBeenCalledTimes(1);

    // Founder starts speaking (active), then a fresh turn re-arms — chime again.
    pushState(projection({ visualState: 'listening', micState: 'active' }));
    pushState(projection({ visualState: 'listening', micState: 'armed' }));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not throw when Web Audio is unavailable', async () => {
    // No AudioContext on window (the jsdom default) — arming must stay silent
    // and harmless.
    await mountStage();
    expect(() => {
      pushState(projection({ visualState: 'listening', micState: 'armed' }));
    }).not.toThrow();
  });
});
