import { describe, it, expect } from 'vitest';
import { APP_ERROR_CODES, STAGE_EVENT, CONTROL_EVENT } from '../../src/shared/contracts';
import type {
  AlignmentSnapshot,
  ScriptSummary,
  StageSessionEnvelope,
} from '../../src/shared/contracts';

describe('shared contracts', () => {
  it('exposes the stable application error codes', () => {
    expect(APP_ERROR_CODES).toContain('INTERNAL_UNEXPECTED');
    expect(APP_ERROR_CODES).toContain('STAGE_OPEN_FAILED');
    // §181: raised recoverable by `speech/mod.rs` and by `select_speech_language`
    // whenever this machine has no usable copy of the weights, which since §152
    // is an ordinary first-run state rather than a damaged installation.
    expect(APP_ERROR_CODES).toContain('STT_MODEL_NOT_INSTALLED');
    // Structured codes minted by src-tauri/src/errors.rs constructors.
    expect(APP_ERROR_CODES).toContain('NOT_IMPLEMENTED');
    expect(APP_ERROR_CODES).toContain('NOT_FOUND');
    expect(APP_ERROR_CODES).toContain('VALIDATION_FAILED');
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
  });

  it('keeps the stage event protocol on the Rust stage:// naming convention', () => {
    // Names are mirrored verbatim in src-tauri/src/windows/mod.rs::events;
    // a Rust test (stage_event_names_match_ts_contract) checks the pairing.
    const names = Object.values(STAGE_EVENT);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith('stage://')).toBe(true);
    }
    expect(STAGE_EVENT.loadSession).toBe('stage://load-session');
    expect(STAGE_EVENT.alignmentSnapshot).toBe('stage://alignment-snapshot');
    expect(STAGE_EVENT.applyCommand).toBe('stage://apply-command');
    expect(STAGE_EVENT.closeSession).toBe('stage://close-session');
    expect(STAGE_EVENT.heartbeat).toBe('stage://heartbeat');
    expect(STAGE_EVENT.hydrated).toBe('stage://hydrated');
    expect(STAGE_EVENT.layoutReady).toBe('stage://layout-ready');
    expect(STAGE_EVENT.heartbeatAck).toBe('stage://heartbeat-ack');
    expect(STAGE_EVENT.mediaError).toBe('stage://media-error');
    expect(STAGE_EVENT.escapePressed).toBe('stage://escape-pressed');
    expect(STAGE_EVENT.escapeRequested).toBe('stage://escape-requested');
    expect(STAGE_EVENT.motionReport).toBe('stage://motion-report');
    expect(STAGE_EVENT.motionAck).toBe('stage://motion-ack');
    // S6: the §62 layout report follows the same stage-name / relayed-name pair.
    expect(STAGE_EVENT.layoutError).toBe('stage://layout-error');
    expect(STAGE_EVENT.layoutFailed).toBe('stage://layout-failed');
    expect(STAGE_EVENT.intent).toBe('stage://intent');
    expect(CONTROL_EVENT.stageReady).toBe('stage://ready');
    expect(CONTROL_EVENT.stageClosed).toBe('stage://closed');
    expect(CONTROL_EVENT.identifyDisplays).toBe('app://identify-displays');
  });

  it('type-checks representative contract shapes', () => {
    const summary: ScriptSummary = {
      id: '00000000-0000-0000-0000-000000000000',
      title: 'Scaffold',
      scriptRevision: 1,
      status: 'draft',
      language: 'en',
      spokenWordCount: 0,
      estimatedDurationSeconds: 0,
      updatedAt: new Date().toISOString(),
      previewText: '',
      hasWarnings: false,
    };
    expect(summary.status).toBe('draft');

    // Compile-time only assertions that the barrel exports resolve.
    const _envelope: StageSessionEnvelope | undefined = undefined;
    const _alignment: AlignmentSnapshot | undefined = undefined;
    expect(_alignment).toBeUndefined();
    expect(_envelope).toBeUndefined();
  });
});
