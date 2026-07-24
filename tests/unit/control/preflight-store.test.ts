import { describe, expect, it } from 'vitest';
import {
  computeReadiness,
  scriptStatusFromDiagnostics,
  type PreflightChecks,
} from '../../../src/control/stores/preflight';
import type { CompileDiagnostic } from '../../../src/shared/contracts';

function checks(partial: Partial<PreflightChecks>): PreflightChecks {
  return {
    mode: 'voice',
    script: 'ready',
    stage: 'ready',
    openai: 'ready',
    microphone: 'ready',
    listenerEnabled: false,
    listener: 'idle',
    warnings: [],
    ...partial,
  };
}

describe('computeReadiness', () => {
  it('is ready when all required checks pass', () => {
    const r = computeReadiness(checks({}));
    expect(r.overall).toBe('ready');
    expect(r.canStart).toBe(true);
    expect(r.startLabel).toBe('Start session');
    expect(r.summary).toBe('Script ready · Stage ready · OpenAI ready · Mic ready');
  });

  it('blocks on a missing stage regardless of mode', () => {
    const r = computeReadiness(checks({ stage: 'blocked', mode: 'manual' }));
    expect(r.canStart).toBe(false);
    expect(r.blockedReason).toContain('Stage');
  });

  it('voice mode requires OpenAI and the microphone', () => {
    const r = computeReadiness(checks({ openai: 'blocked' }));
    expect(r.canStart).toBe(false);
    // Only voice prerequisites failed → the alternative label appears (F.10).
    expect(r.startLabel).toBe('Start in manual mode');
  });

  it('manual mode ignores OpenAI/microphone problems', () => {
    const r = computeReadiness(checks({ mode: 'manual', openai: 'blocked', microphone: 'blocked' }));
    expect(r.canStart).toBe(true);
  });

  it('warnings do not block but change the label', () => {
    const r = computeReadiness(checks({ warnings: ['Two sections are named "Results".'] }));
    expect(r.overall).toBe('ready_warning');
    expect(r.canStart).toBe(true);
    expect(r.startLabel).toBe('Start with warning');
  });

  it('checking anywhere keeps Start disabled', () => {
    const r = computeReadiness(checks({ microphone: 'checking' }));
    expect(r.overall).toBe('checking');
    expect(r.canStart).toBe(false);
  });

  it('an enabled listener must be ready', () => {
    const r = computeReadiness(checks({ listenerEnabled: true, listener: 'blocked' }));
    expect(r.canStart).toBe(false);
    expect(r.blockedReason).toContain('Listener');
  });
});

describe('scriptStatusFromDiagnostics', () => {
  const warning: CompileDiagnostic = {
    code: 'DUPLICATE_TARGET',
    severity: 'warning',
    message: 'More than one heading is named "Pricing."',
    blocking: false,
  };
  const blocking: CompileDiagnostic = {
    code: 'MALFORMED_CUE',
    severity: 'error',
    message: 'CandidCue could not parse this directive.',
    blocking: true,
  };

  it('maps compile lifecycle to check status', () => {
    expect(scriptStatusFromDiagnostics([], 'compiling').status).toBe('checking');
    expect(scriptStatusFromDiagnostics([], 'idle').status).toBe('blocked');
    expect(scriptStatusFromDiagnostics([], 'error').status).toBe('blocked');
    expect(scriptStatusFromDiagnostics([], 'ready').status).toBe('ready');
  });

  it('blocking diagnostics block; warnings warn', () => {
    expect(scriptStatusFromDiagnostics([blocking], 'ready').status).toBe('blocked');
    const result = scriptStatusFromDiagnostics([warning], 'ready');
    expect(result.status).toBe('warning');
    expect(result.warnings).toEqual(['More than one heading is named "Pricing."']);
  });
});
