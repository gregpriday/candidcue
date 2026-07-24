import { describe, it, expect } from 'vitest';
import { APP_ERROR_CODES, STAGE_EVENT, CONTROL_EVENT } from '../../src/shared/contracts';
import type {
  ScriptSummary,
  TrackingSnapshot,
  StageSessionEnvelope,
  ListenerPackManifest,
} from '../../src/shared/contracts';
import miraManifest from '../../assets/listeners/mira/manifest.json';

describe('shared contracts', () => {
  it('exposes the stable application error codes', () => {
    expect(APP_ERROR_CODES).toContain('INTERNAL_UNEXPECTED');
    expect(APP_ERROR_CODES).toContain('STAGE_OPEN_FAILED');
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
    expect(STAGE_EVENT.trackingSnapshot).toBe('stage://tracking-snapshot');
    expect(STAGE_EVENT.applyCommand).toBe('stage://apply-command');
    expect(STAGE_EVENT.listenerState).toBe('stage://listener-state');
    expect(STAGE_EVENT.closeSession).toBe('stage://close-session');
    expect(STAGE_EVENT.heartbeat).toBe('stage://heartbeat');
    expect(STAGE_EVENT.hydrated).toBe('stage://hydrated');
    expect(STAGE_EVENT.layoutReady).toBe('stage://layout-ready');
    expect(STAGE_EVENT.heartbeatAck).toBe('stage://heartbeat-ack');
    expect(STAGE_EVENT.mediaError).toBe('stage://media-error');
    expect(STAGE_EVENT.escapeRequested).toBe('stage://escape-requested');
    expect(STAGE_EVENT.intent).toBe('stage://intent');
    expect(CONTROL_EVENT.stageReady).toBe('stage://ready');
    expect(CONTROL_EVENT.stageClosed).toBe('stage://closed');
    expect(CONTROL_EVENT.identifyDisplays).toBe('app://identify-displays');
  });

  it('type-checks representative contract shapes', () => {
    const summary: ScriptSummary = {
      id: '00000000-0000-0000-0000-000000000000',
      title: 'Scaffold',
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
    const _snapshot: TrackingSnapshot | undefined = undefined;
    const _envelope: StageSessionEnvelope | undefined = undefined;
    expect(_snapshot).toBeUndefined();
    expect(_envelope).toBeUndefined();
  });

  it('validates the bundled mira listener manifest against the contract', () => {
    const manifest: ListenerPackManifest = miraManifest as ListenerPackManifest;
    expect(manifest.id).toBe('mira');
    expect(manifest.defaultZoom).toBeCloseTo(1.15);
    expect(manifest.fit).toBe('cover');
    expect(manifest.clips).toHaveLength(2);
    for (const clip of manifest.clips) {
      expect(clip.role).toBe('neutral');
      expect(clip.mime).toBe('video/mp4');
      expect(clip.durationMs).toBeGreaterThan(0);
    }
  });
});
