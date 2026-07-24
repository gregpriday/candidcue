import { describe, it, expect } from 'vitest';
import { APP_ERROR_CODES } from '../../src/shared/contracts';
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
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
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
