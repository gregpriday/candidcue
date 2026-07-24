/**
 * Live session store (spec §15, §45.2 RealtimeStore/TrackingStore facade for
 * the Live screen). Owns transport actions, pause semantics (§15.3), the
 * elapsed clock, transcript tail, and the end-of-session summary (F.17).
 */
import { derived, get, writable } from 'svelte/store';
import type { OutlineNode, SentenceUnit, TrackingSnapshot } from '../../shared/contracts';
import type { SessionMode } from '../services/settings-types';
import { createTrackingDriver, newSessionId, type TrackingDriver } from '../services/session';
import * as stageService from '../services/stage';

export type PauseKind = 'none' | 'listening' | 'hard';

export interface SessionCounts {
  jumps: number;
  retakes: number;
  commands: number;
  reconnects: number;
}

export interface SessionSummary {
  durationSeconds: number;
  mode: SessionMode;
  sectionsReached: number;
  retakes: number;
  commands: number;
  reconnects: number;
  /** Estimated realtime transcription cost — clearly an estimate (F.17). */
  estimatedCostUsd: number;
  endingLocation: string;
  transcriptSaved: false;
}

export interface SessionState {
  active: boolean;
  sessionId: string | null;
  scriptId: string | null;
  scriptTitle: string;
  mode: SessionMode;
  displayLabel: string;
  startedAtMs: number;
  elapsedSeconds: number;
  /** False until the user (or a voice command) starts prompting (§9.1). */
  prompting: boolean;
  paused: PauseKind;
  stageBlanked: boolean;
  voiceFollow: boolean;
  connection: 'connected' | 'reconnecting' | 'offline';
  micState: 'live' | 'muted' | 'disconnected';
  snapshot: TrackingSnapshot | null;
  transcriptTail: string[];
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  counts: SessionCounts;
  summary: SessionSummary | null;
  blocksSeen: string[];
}

const initial: SessionState = {
  active: false,
  sessionId: null,
  scriptId: null,
  scriptTitle: '',
  mode: 'voice',
  displayLabel: '',
  startedAtMs: 0,
  elapsedSeconds: 0,
  prompting: false,
  paused: 'none',
  stageBlanked: false,
  voiceFollow: true,
  connection: 'connected',
  micState: 'live',
  snapshot: null,
  transcriptTail: [],
  outline: [],
  sentences: [],
  counts: { jumps: 0, retakes: 0, commands: 0, reconnects: 0 },
  summary: null,
  blocksSeen: [],
};

const state = writable<SessionState>({ ...initial });
export const session = { subscribe: state.subscribe };

let driver: TrackingDriver | null = null;
let clock: ReturnType<typeof setInterval> | null = null;

export interface StartSessionInput {
  scriptId: string;
  scriptTitle: string;
  mode: SessionMode;
  displayLabel: string;
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  totalTokens: number;
}

export function startLiveSession(input: StartSessionInput): string {
  stopInternals();
  const sessionId = newSessionId();
  state.set({
    ...initial,
    active: true,
    sessionId,
    scriptId: input.scriptId,
    scriptTitle: input.scriptTitle,
    mode: input.mode,
    displayLabel: input.displayLabel,
    startedAtMs: Date.now(),
    voiceFollow: input.mode === 'voice',
    outline: input.outline,
    sentences: input.sentences,
  });
  driver = createTrackingDriver({
    sessionId,
    scriptId: input.scriptId,
    sentences: input.sentences,
    totalTokens: input.totalTokens,
    onSnapshot(snapshot) {
      state.update((s) => ({
        ...s,
        snapshot,
        blocksSeen: s.blocksSeen.includes(snapshot.blockId)
          ? s.blocksSeen
          : [...s.blocksSeen, snapshot.blockId],
      }));
      const current = get(state);
      if (current.sessionId) void stageService.publishStageSnapshot(current.sessionId, snapshot);
    },
    onTranscript(line) {
      state.update((s) => ({
        ...s,
        transcriptTail: [...s.transcriptTail, line].slice(-4),
      }));
    },
  });
  clock = setInterval(() => {
    state.update((s) =>
      s.active ? { ...s, elapsedSeconds: Math.floor((Date.now() - s.startedAtMs) / 1000) } : s,
    );
  }, 1000);
  return sessionId;
}

/** Start (or restart) prompting — the stage begins following. */
export function startPrompting(): void {
  const s = get(state);
  if (!s.active || s.prompting) return;
  state.update((prev) => ({ ...prev, prompting: true, paused: 'none' }));
  driver?.start();
}

/** Listening pause — transcription stays connected (§15.3). */
export function pauseListening(): void {
  state.update((s) => ({ ...s, paused: 'listening' }));
  driver?.pause();
}

/** Hard pause — the realtime connection closes; voice cannot resume (§15.3). */
export function hardPause(): void {
  state.update((s) => ({ ...s, paused: 'hard', micState: 'muted' }));
  driver?.pause();
}

export function resumeSession(): void {
  state.update((s) => ({ ...s, paused: 'none', micState: 'live' }));
  driver?.resume();
}

export function togglePlayPause(): void {
  const s = get(state);
  if (!s.active) return;
  if (!s.prompting) startPrompting();
  else if (s.paused === 'none') pauseListening();
  else resumeSession();
}

export function moveSentences(delta: number): void {
  driver?.moveSentences(delta);
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

export function restartParagraph(): void {
  driver?.restartParagraph();
  state.update((s) => ({ ...s, counts: { ...s.counts, retakes: s.counts.retakes + 1 } }));
}

export function addTakeMarker(): void {
  state.update((s) => ({ ...s, counts: { ...s.counts, commands: s.counts.commands + 1 } }));
}

export function toggleBlankStage(): void {
  const s = get(state);
  if (s.sessionId) {
    void stageService.publishStageCommand(s.sessionId, {
      action: s.stageBlanked ? 'unblank_stage' : 'blank_stage',
    });
  }
  state.update((prev) => ({ ...prev, stageBlanked: !prev.stageBlanked }));
}

export function toggleVoiceFollow(): void {
  state.update((s) => ({ ...s, voiceFollow: !s.voiceFollow }));
}

/** Stop the session and produce the F.17 summary. */
export function stopSession(): SessionSummary {
  const s = get(state);
  const minutes = s.elapsedSeconds / 60;
  const summary: SessionSummary = {
    durationSeconds: s.elapsedSeconds,
    mode: s.mode,
    sectionsReached: s.blocksSeen.length,
    retakes: s.counts.retakes,
    commands: s.counts.commands,
    reconnects: s.counts.reconnects,
    // MOCK estimate — replaced by real usage accounting at integration.
    estimatedCostUsd: Math.round(minutes * 0.6) / 100,
    endingLocation: locateEnding(s),
    transcriptSaved: false,
  };
  stopInternals();
  if (s.sessionId) void stageService.closeStage(s.sessionId);
  state.update((prev) => ({ ...prev, active: false, prompting: false, summary }));
  return summary;
}

export function clearSession(): void {
  stopInternals();
  state.set({ ...initial });
}

function locateEnding(s: SessionState): string {
  const snapshot = s.snapshot;
  if (!snapshot) return 'Beginning';
  const flat: OutlineNode[] = [];
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(s.outline);
  const section = [...flat]
    .reverse()
    .find((n) => n.startTokenIndex <= snapshot.tokenIndex);
  return section ? section.title : `Token ${snapshot.tokenIndex}`;
}

function stopInternals(): void {
  driver?.dispose();
  driver = null;
  if (clock) clearInterval(clock);
  clock = null;
}

/** F.11 status line for the top bar and tracking visualization. */
export const liveStatusLabel = derived(state, (s): string => {
  if (!s.active) return s.summary ? 'Session complete' : 'Ready to start';
  if (s.connection === 'reconnecting') return 'Reconnecting — position held';
  if (s.micState === 'disconnected') return 'Microphone disconnected — position held';
  if (s.paused === 'hard') return 'Hard paused — microphone off';
  if (s.paused === 'listening') return 'Paused — still listening for “CandidCue, resume”';
  if (!s.prompting) return 'Ready to start';
  switch (s.snapshot?.state) {
    case 'following':
      return 'Following';
    case 'holding':
      return 'Holding your place';
    case 'searching':
      return 'Looking for your place';
    case 'retake_candidate':
      return 'Retake detected';
    case 'command_pending':
      return 'Command heard';
    case 'paused':
      return 'Paused — still listening for “CandidCue, resume”';
    case 'reconnecting':
      return 'Reconnecting — position held';
    default:
      return 'Listening';
  }
});
