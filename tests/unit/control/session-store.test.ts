import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  addTakeMarker,
  clearSession,
  hardPause,
  liveStatusLabel,
  moveSentences,
  pauseListening,
  restartParagraph,
  resumeSession,
  session,
  startLiveSession,
  startPrompting,
  stopSession,
  togglePlayPause,
} from '../../../src/control/stores/session';

function start(): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Teleprompter Display',
    outline: [],
    sentences: [],
    totalTokens: 200,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearSession();
  vi.useRealTimers();
});

describe('live session store', () => {
  it('starts inactive-prompting and waits for Start (§9.1)', () => {
    start();
    const s = get(session);
    expect(s.active).toBe(true);
    expect(s.prompting).toBe(false);
    expect(get(liveStatusLabel)).toBe('Ready to start');
  });

  it('follows after Start and produces snapshots + transcript tail', () => {
    start();
    startPrompting();
    vi.advanceTimersByTime(1600 * 3);
    const s = get(session);
    expect(s.snapshot).not.toBeNull();
    expect(s.transcriptTail.length).toBeGreaterThan(0);
    expect(s.transcriptTail.length).toBeLessThanOrEqual(4);
  });

  it('distinguishes listening pause from hard pause (§15.3)', () => {
    start();
    startPrompting();
    pauseListening();
    expect(get(session).paused).toBe('listening');
    expect(get(session).micState).toBe('live'); // still connected & listening
    expect(get(liveStatusLabel)).toContain('still listening');

    resumeSession();
    expect(get(session).paused).toBe('none');

    hardPause();
    expect(get(session).paused).toBe('hard');
    expect(get(session).micState).toBe('muted');
    expect(get(liveStatusLabel)).toBe('Hard paused — microphone off');
  });

  it('space-bar semantics: start, then pause, then resume', () => {
    start();
    togglePlayPause();
    expect(get(session).prompting).toBe(true);
    togglePlayPause();
    expect(get(session).paused).toBe('listening');
    togglePlayPause();
    expect(get(session).paused).toBe('none');
  });

  it('tracks the elapsed clock', () => {
    start();
    startPrompting();
    vi.advanceTimersByTime(65_000);
    expect(get(session).elapsedSeconds).toBeGreaterThanOrEqual(64);
  });

  it('counts manual moves and retakes for the summary', () => {
    start();
    startPrompting();
    moveSentences(1);
    moveSentences(-1);
    restartParagraph();
    addTakeMarker();
    vi.advanceTimersByTime(60_000);

    const summary = stopSession();
    expect(summary.retakes).toBe(1);
    expect(summary.commands).toBe(1);
    expect(summary.durationSeconds).toBeGreaterThanOrEqual(59);
    expect(summary.transcriptSaved).toBe(false);
    expect(summary.estimatedCostUsd).toBeGreaterThan(0);

    const s = get(session);
    expect(s.active).toBe(false);
    expect(s.summary).toEqual(summary);
  });

  it('clearSession resets to the initial state', () => {
    start();
    startPrompting();
    stopSession();
    clearSession();
    const s = get(session);
    expect(s.active).toBe(false);
    expect(s.summary).toBeNull();
    expect(s.sessionId).toBeNull();
  });
});
