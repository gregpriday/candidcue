// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StageStateProjection } from '@shared/contracts';

// Same headless scaffold as stage-app-end.test.tsx: StageApp builds a real
// SpeechPlayer/CaptureController and a <video> deck on mount, none of which are
// relevant to the founder-start countdown under test.
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
// Captured so a test can drive StageApp's state the way the main process would.
let stateListener: ((state: StageStateProjection) => void) | null = null;

function installStageBridge(): void {
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
      onState: vi.fn((listener: (state: StageStateProjection) => void) => {
        stateListener = listener;
        return () => {
          stateListener = null;
        };
      }),
      onPlaybackPlan: vi.fn(() => () => {}),
      onPlayBackchannel: vi.fn(() => () => {}),
      onCaptureConfig: vi.fn(() => () => {}),
    },
  };
}

function readyState(overrides: Partial<StageStateProjection> = {}): StageStateProjection {
  return {
    version: 1,
    visualState: 'standby',
    micState: 'closed',
    statusText: null,
    captions: null,
    mirror: false,
    zoom: 1,
    verticalOffsetPercent: 0,
    canBegin: true,
    ...overrides,
  };
}

/** Push a projection into the mounted StageApp via the captured state listener. */
function emit(state: StageStateProjection): void {
  act(() => {
    stateListener?.(state);
  });
}

/** Mount and wait past bootstrap so the standby chrome renders (real timers). */
async function mount(): Promise<void> {
  render(<StageApp />);
  await screen.findByText('Your interview is ready.');
}

beforeEach(() => {
  send.mockClear();
  stateListener = null;
  installStageBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { candidcueStage?: unknown }).candidcueStage;
});

describe('StageApp founder-start countdown', () => {
  it('shows the begin prompt once the session is begin-able', async () => {
    await mount();
    emit(readyState());
    expect(screen.getByText('Press Space to begin.')).toBeInTheDocument();
  });

  it('arms a visible countdown on Space without sending a command', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());

    fireEvent.keyDown(window, { code: 'Space', key: ' ' });

    expect(send).not.toHaveBeenCalled();
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('Starting in 3');
    // The begin hint is replaced while counting.
    expect(screen.queryByText('Press Space to begin.')).not.toBeInTheDocument();
  });

  it('ticks 3→2→1 and then sends exactly one BEGIN', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('timer')).toHaveTextContent('Starting in 2');

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('timer')).toHaveTextContent('Starting in 1');

    act(() => vi.advanceTimersByTime(1000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'BEGIN' });
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('cancels the countdown on Escape and never sends BEGIN', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByRole('timer')).toBeInTheDocument();

    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });

    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.getByText('Press Space to begin.')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels the countdown when the stage window loses focus', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByRole('timer')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(screen.queryByRole('timer')).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not restart or double-fire when Space is pressed again mid-countdown', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('timer')).toHaveTextContent('Starting in 2');
    // A second Space must not reset the count back to 3 or queue a second BEGIN.
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByRole('timer')).toHaveTextContent('Starting in 2');

    // Advance second-by-second so React flushes the effect that schedules each
    // next tick between fires (the final tick hands off to BEGIN).
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'BEGIN' });
  });

  it('cancels an in-flight countdown if the session leaves standby', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByRole('timer')).toBeInTheDocument();

    // The interview began by some other path: standby is gone, begin not allowed.
    emit(readyState({ visualState: 'speaking', canBegin: false }));

    expect(screen.queryByRole('timer')).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not re-arm a second countdown after BEGIN has already fired', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(send).toHaveBeenCalledTimes(1);

    // The orchestrator hasn't replied yet, so the standby projection is still
    // begin-able. A stray Space must not arm a fresh countdown / second BEGIN.
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.queryByRole('timer')).toBeNull();
    act(() => vi.advanceTimersByTime(4000));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancels the countdown when the end-confirm is opened (Shift+E)', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByRole('timer')).toBeInTheDocument();

    fireEvent.keyDown(window, { code: 'KeyE', key: 'E', shiftKey: true });

    expect(screen.queryByRole('timer')).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels the countdown if the session stops being begin-able while still standby', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(screen.getByRole('timer')).toBeInTheDocument();

    // READY lost but still on the standby screen — begin is no longer allowed.
    emit(readyState({ canBegin: false }));

    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.getByText('Getting everything ready…')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not arm a countdown on Shift+Space (modifier excluded from the gate)', async () => {
    await mount();
    vi.useFakeTimers();
    emit(readyState());

    fireEvent.keyDown(window, { code: 'Space', key: ' ', shiftKey: true });

    // Shift+Space is excluded from the founder-start gate, so no countdown arms.
    // (It falls through to the normal command path, which is a harmless no-op in
    // READY — this test only guards the gate, not that downstream behaviour.)
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('still commits on Space in standby before the session is begin-able', async () => {
    await mount();
    // INITIAL_STATE is standby with canBegin:false — the begin gate must not
    // swallow Space; the prior commit behaviour is preserved.
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    expect(send).toHaveBeenCalledWith({ type: 'COMMIT', reason: 'manual' });
  });
});
