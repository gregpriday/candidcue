import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  addTakeMarker,
  clearSession,
  connectionPill,
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
import type { SessionMode } from '../../../src/control/services/settings-types';

/** Published rate for the default realtime model (§35.1). */
const RATE_USD_PER_MINUTE = 0.017;

function start(mode: SessionMode = 'voice'): string {
  return startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode,
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

    const s = get(session);
    expect(s.active).toBe(false);
    expect(s.summary).toEqual(summary);
  });

  /*
   * The estimate used to be `Math.round((elapsedSeconds / 60) * 0.6) / 100`,
   * which quantised in ~$0.01-per-100-seconds steps: $0.00 for the first 49 s,
   * then nothing between $0.01 and $0.02. The status-bar popover and the F.17
   * summary also computed it two different ways.
   */
  describe('cost estimate (§35)', () => {
    it('tracks elapsed time continuously instead of in 100-second steps', () => {
      start();
      startPrompting();

      vi.advanceTimersByTime(49_000);
      expect(get(session).estimatedCostUsd).toBeCloseTo((49 / 60) * RATE_USD_PER_MINUTE, 6);

      vi.advanceTimersByTime(51_000); // 100 s total
      expect(get(session).estimatedCostUsd).toBeCloseTo((100 / 60) * RATE_USD_PER_MINUTE, 6);
      // The old formula gave the same $0.01 for both of the above.
      expect(get(session).estimatedCostUsd).not.toBeCloseTo((49 / 60) * RATE_USD_PER_MINUTE, 4);
    });

    it('reports a realistic figure for a 30-minute take', () => {
      start();
      startPrompting();
      vi.advanceTimersByTime(1_800_000);
      const summary = stopSession();
      // 30 min × $0.017/min = $0.51; the old formula reported $0.18.
      expect(summary.estimatedCostUsd).toBe(0.51);
    });

    it('is the same number the summary reports', () => {
      start();
      startPrompting();
      vi.advanceTimersByTime(600_000);
      const live = get(session).estimatedCostUsd;
      const summary = stopSession();
      expect(summary.estimatedCostUsd).toBe(Math.round(live * 100) / 100);
    });

    it('charges nothing when no realtime stream exists (manual mode)', () => {
      start('manual');
      startPrompting();
      vi.advanceTimersByTime(600_000);
      expect(get(session).estimatedCostUsd).toBe(0);
      expect(stopSession().estimatedCostUsd).toBe(0);
    });

    /*
     * §42.1: Luna sidecar spend is a SECOND figure, from a different
     * subsystem with a different unit (tokens, not audio minutes) and a rate
     * that is configured rather than published in the app. The trap this
     * guards is reading the transcription number as "the OpenAI cost": the
     * two must stay in separate fields and must never be summed.
     */
    it('keeps Luna spend separate from the transcription estimate', () => {
      start();
      startPrompting();
      vi.advanceTimersByTime(600_000);

      const live = get(session);
      expect(live.estimatedCostUsd).toBeCloseTo((600 / 60) * RATE_USD_PER_MINUTE, 6);
      // No sidecar in this mode: no requests, no tokens, and — critically —
      // an UNKNOWN cost rather than a confident $0.00.
      expect(live.semanticSpend.requests).toBe(0);
      expect(live.semanticSpend.totalTokens).toBe(0);
      expect(live.semanticSpend.estimatedCostUsd).toBeNull();
      // The §42 default cap is in force until the user sets their own.
      expect(live.semanticSpend.requestLimit).toBe(400);

      const summary = stopSession();
      expect(summary.estimatedCostUsd).toBe(0.17);
      expect(summary.semanticCostUsd).toBeNull();
      expect(summary.semanticRequests).toBe(0);
      // Transcription is not silently inflated by (or folded into) Luna.
      expect(summary.estimatedCostUsd).not.toBe(summary.semanticCostUsd);
    });
  });

  it('does not manufacture a summary when there is no session to stop', () => {
    // Live opens the F.17 dialog on `!active && summary !== null`; a spurious
    // stop used to pop it with a zeroed summary.
    const summary = stopSession();
    expect(summary.durationSeconds).toBe(0);
    expect(get(session).summary).toBeNull();
    expect(get(liveStatusLabel)).toBe('Ready to start');
  });

  it('keeps the first summary when stop is called twice', () => {
    start();
    startPrompting();
    vi.advanceTimersByTime(60_000);
    const first = stopSession();
    const second = stopSession();
    expect(second).toEqual(first);
    expect(get(session).summary).toEqual(first);
  });

  it('names the connection state honestly, including a fatal offline', () => {
    // `offline` is non-recoverable — nothing is retrying, so it must not read
    // as a warning-toned "Reconnecting".
    expect(connectionPill('connected')).toEqual({ tone: 'success', label: 'Connected' });
    expect(connectionPill('reconnecting')).toEqual({ tone: 'warning', label: 'Reconnecting' });
    expect(connectionPill('offline')).toEqual({ tone: 'danger', label: 'Disconnected' });
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
