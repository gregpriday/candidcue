/**
 * PreflightStore (spec §45.2, §14) — readiness checks per section plus the
 * pure readiness derivation used by the sticky footer. Blockers vs warnings
 * follow §14.2 G / §57.4: missing compile, invalid stage, invalid mic (voice
 * mode), or invalid speech-provider connection block Start; collisions and stale
 * analysis only warn.
 */
import { derived, get, writable } from 'svelte/store';
import type { CompileDiagnostic } from '../../shared/contracts';
import type { SessionMode } from '../services/settings-types';

export type CheckStatus = 'idle' | 'checking' | 'ready' | 'warning' | 'blocked';

export interface PreflightChecks {
  mode: SessionMode;
  script: CheckStatus;
  stage: CheckStatus;
  speech: CheckStatus;
  microphone: CheckStatus;
  listenerEnabled: boolean;
  listener: CheckStatus;
  warnings: string[];
}

export interface Readiness {
  overall: 'not_ready' | 'checking' | 'ready' | 'ready_warning';
  canStart: boolean;
  /** Concise reason shown beside the disabled Start button (spec §14.3). */
  blockedReason: string | null;
  /** "Stage ready · Mic ready · Speech ready" footer summary. */
  summary: string;
  /** F.10 — primary label swaps when only voice is unavailable. */
  startLabel: 'Start session' | 'Start in manual mode' | 'Start with warning';
}

const initialChecks: PreflightChecks = {
  mode: 'voice',
  script: 'idle',
  stage: 'idle',
  speech: 'idle',
  microphone: 'idle',
  listenerEnabled: false,
  listener: 'idle',
  warnings: [],
};

const checksStore = writable<PreflightChecks>({ ...initialChecks });
export const preflightChecks = { subscribe: checksStore.subscribe };

export function resetPreflight(mode: SessionMode): void {
  checksStore.set({ ...initialChecks, mode });
}

export function updatePreflight(patch: Partial<PreflightChecks>): void {
  checksStore.update((s) => ({ ...s, ...patch }));
}

export function getPreflightChecks(): PreflightChecks {
  return get(checksStore);
}

/** Pure derivation — unit tested directly. */
export function computeReadiness(checks: PreflightChecks): Readiness {
  const voiceRequired = checks.mode === 'voice';
  const relevant: Array<[string, CheckStatus, boolean]> = [
    ['Script', checks.script, true],
    ['Stage', checks.stage, true],
    ['Speech', checks.speech, voiceRequired],
    ['Mic', checks.microphone, voiceRequired],
    ['Listener', checks.listener, checks.listenerEnabled],
  ];

  const active = relevant.filter(([, , required]) => required);
  if (active.some(([, status]) => status === 'checking')) {
    return {
      overall: 'checking',
      canStart: false,
      blockedReason: 'Checks are still running',
      summary: 'Checking…',
      startLabel: 'Start session',
    };
  }

  const blocked = active.filter(([, status]) => status === 'blocked' || status === 'idle');
  const readyParts = relevant
    .filter(([, status]) => status === 'ready' || status === 'warning')
    .map(([label]) => `${label} ready`);
  const summary = readyParts.length > 0 ? readyParts.join(' · ') : 'Not ready';

  if (blocked.length > 0) {
    const labels = blocked.map(([label]) => label);
    const voiceOnlyBlocked =
      voiceRequired &&
      labels.every((l) => l === 'Speech' || l === 'Mic') &&
      checks.script !== 'blocked' &&
      checks.stage !== 'blocked';
    return {
      overall: 'not_ready',
      canStart: false,
      blockedReason:
        blocked.length === 1
          ? `${labels[0]} is not ready`
          : `${labels.join(' and ')} are not ready`,
      summary,
      startLabel: voiceOnlyBlocked ? 'Start in manual mode' : 'Start session',
    };
  }

  const hasWarnings =
    checks.warnings.length > 0 || active.some(([, status]) => status === 'warning');
  return {
    overall: hasWarnings ? 'ready_warning' : 'ready',
    canStart: true,
    blockedReason: null,
    summary,
    startLabel: hasWarnings ? 'Start with warning' : 'Start session',
  };
}

export const preflightReadiness = derived(checksStore, computeReadiness);

/** Map compile diagnostics to a section status + warning strings (F.9). */
export function scriptStatusFromDiagnostics(
  diagnostics: CompileDiagnostic[],
  compileStatus: 'idle' | 'compiling' | 'ready' | 'error',
): { status: CheckStatus; warnings: string[] } {
  if (compileStatus === 'compiling') return { status: 'checking', warnings: [] };
  if (compileStatus === 'error' || compileStatus === 'idle') return { status: 'blocked', warnings: [] };
  if (diagnostics.some((d) => d.blocking)) return { status: 'blocked', warnings: [] };
  const warnings = diagnostics
    .filter((d) => d.severity === 'warning')
    .map((d) => d.message);
  return { status: warnings.length > 0 ? 'warning' : 'ready', warnings };
}
