import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
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
  toggleBlankStage,
  togglePlayPause,
} from '../../../src/control/stores/session';
import type { SessionMode } from '../../../src/control/services/settings-types';

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
  /*
   * This test used to assert the opposite, under §9.1 "hold position until the
   * user explicitly starts prompting" — and in doing so it certified the worst
   * bug this project has shipped as intended behaviour.
   *
   * `Present` opened the stage, claimed the microphone and transcribed speech
   * while the aligner sat paused behind a second button called `Start`, so four
   * consecutive takes reported "0 of 26 words (0%)" beside a live word count.
   * Starting a take is starting to prompt; `Pause` is how a presenter stops.
   */
  it('starts prompting, because Present is the start (§9.1)', () => {
    start();
    const s = get(session);
    expect(s.active).toBe(true);
    expect(s.prompting).toBe(true);
    expect(s.paused).toBe('none');
    // The driver reports `following` as soon as it is started, so the status
    // line says so — rather than "Ready to start" over a live microphone.
    expect(get(liveStatusLabel)).toBe('Following');
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

  /*
   * NEVER CLAIM A STATE YOU DO NOT HAVE. `connection` and `micState` start
   * optimistic and only a running voice pipeline corrects them; a manual take
   * never builds one, so the status line used to offer a wake word that nothing
   * was listening for. The voice wording is asserted in the pause test below,
   * so a fix that just deletes the sentence fails there.
   */
  it('a manual take never claims a microphone or a wake word (F.11)', () => {
    start('manual');
    // A manual take prompts from the off too — the driver's construction-time
    // pause is not a mode distinction, and a scroll-driven take that ignores
    // the scroll is the same defect wearing a different hat.
    expect(get(liveStatusLabel)).toBe('Following');
    pauseListening();
    expect(get(session).paused).toBe('listening');
    expect(get(liveStatusLabel)).toBe('Paused — the script stays where it is');
    expect(get(liveStatusLabel)).not.toContain('CandidCue');

    hardPause();
    expect(get(liveStatusLabel)).toBe('Paused');
    expect(get(liveStatusLabel)).not.toContain('microphone');
  });

  /*
   * §27. There is no rail in a manual take (coaching runs on the voice capture),
   * and coaching mode `off` reserves no band at all. The toggle must decline
   * rather than flip a flag the stage will never see — which is what the Live
   * button's disabled state reflects.
   */
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

  it('space-bar semantics: a take is already running, so space pauses first', () => {
    start();
    // The take starts prompting, so the first press is a pause — there is no
    // "start" left to perform. `togglePlayPause` still handles a non-prompting
    // session, which is reachable through a driver rebuild.
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
    vi.advanceTimersByTime(60_000);

    const summary = stopSession();
    expect(summary.retakes).toBe(1);
    expect(summary.durationSeconds).toBeGreaterThanOrEqual(59);
    expect(summary.transcriptSaved).toBe(false);

    const s = get(session);
    expect(s.active).toBe(false);
    expect(s.summary).toEqual(summary);
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

  /*
   * §16.6, §108: the embedded `StageApp` reads `stageBlanked` through its
   * `blanked` prop, so the flag flipping IS the blank reaching the glass —
   * there is no stage window for a directive to travel to.
   */
  it('flips stageBlanked both ways, which is the whole blank', () => {
    start();
    expect(get(session).stageBlanked).toBe(false);
    toggleBlankStage();
    expect(get(session).stageBlanked).toBe(true);
    toggleBlankStage();
    expect(get(session).stageBlanked).toBe(false);
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

/* --------------------------------------------------------------- practice */

/**
 * A rehearsal is a take that reports nothing.
 *
 * Live opens the F.17 card on `!active && summary !== null`, so the store
 * withholding the summary is the whole of "no report" — which is why it is
 * asserted here rather than on the screen.
 */
describe('a practice', () => {
  function practise(): string {
    return startLiveSession({
      scriptId: 'script-1',
      scriptTitle: 'Launch video',
      mode: 'voice',
      practice: true,
      displayLabel: 'This window',
      outline: [],
      sentences: [],
      totalTokens: 200,
    });
  }

  it('is a voice take, told that it is a rehearsal', () => {
    practise();
    // Both, and the pair is the point: nothing about the MOTION changes.
    expect(get(session).mode).toBe('voice');
    expect(get(session).practice).toBe(true);
  });

  it('opens no end-of-take report', () => {
    practise();
    stopSession();
    expect(get(session).active).toBe(false);
    expect(get(session).summary).toBeNull();
  });

  it('still measures the reading for its caller', () => {
    /*
     * Withheld from the SCREEN, not from the caller. Everything on the stop
     * path still runs — the session row closes, the transcript tail flushes and
     * the ending location reaches Rust — because a rehearsal is a real reading
     * whose ending is a real place in the script.
     */
    practise();
    const summary = stopSession();
    expect(summary.mode).toBe('voice');
    expect(summary).not.toBeNull();
  });

  it('leaves an ordinary take reporting exactly as it did', () => {
    start();
    stopSession();
    expect(get(session).summary).not.toBeNull();
  });

  it('is off by default, so nothing becomes a rehearsal by omission', () => {
    start();
    expect(get(session).practice).toBe(false);
  });
});
