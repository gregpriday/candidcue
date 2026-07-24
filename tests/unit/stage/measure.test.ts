/**
 * Layout fingerprinting and section identity (companion §7.2, §33).
 *
 * The DOM measurement pass itself needs a real layout engine (jsdom reports
 * zero-sized rects), so it is exercised through the stage preview; everything
 * pure about it is covered here.
 */
import { describe, it, expect } from 'vitest';
import type { CompiledBlock, StageSettings } from '../../../src/shared/contracts';
import {
  buildLayoutFingerprint,
  sameLayout,
  sectionIdsForBlocks,
} from '../../../src/stage/motion';

const settings: StageSettings = {
  schemaVersion: 1,
  themeId: 'stage-dark',
  background: '#000',
  foreground: '#fff',
  fontFamilyId: 'system-sans',
  fontSizePx: 64,
  lineHeight: 1.28,
  letterSpacingEm: 0,
  columnWidthPercent: 68,
  readingBandCenterPercent: 38,
  readingBandHalfHeightPercent: 4,
  pastOpacity: 0.42,
  futureOpacity: 0.92,
  currentUnderlayOpacity: 0.1,
  mirrorX: false,
  mirrorY: false,
  showCues: true,
  stageAcknowledgements: true,
  reducedMotion: false,
};

function block(id: string, kind: CompiledBlock['kind']): CompiledBlock {
  return {
    id,
    kind,
    renderNodes: [],
    source: { utf16Start: 0, utf16End: 0 },
    spoken: kind === 'paragraph' || kind === 'heading',
  };
}

function fingerprint(overrides: Partial<StageSettings> = {}, layoutGeneration = 1) {
  return buildLayoutFingerprint({
    scriptCompileHash: 'hash-a',
    stageGeneration: 1,
    layoutGeneration,
    settings: { ...settings, ...overrides },
    viewportWidthPx: 1920,
    viewportHeightPx: 1080,
    displayScaleFactor: 2,
  });
}

describe('section identity (§7)', () => {
  it('opens a new section at every heading', () => {
    const blocks = [
      block('b0', 'paragraph'),
      block('b1', 'heading'),
      block('b2', 'paragraph'),
      block('b3', 'paragraph'),
      block('b4', 'heading'),
      block('b5', 'paragraph'),
    ];
    const sections = sectionIdsForBlocks(blocks);
    expect(sections.get('b0')).toBe('section:0');
    expect(sections.get('b1')).toBe('section:b1');
    expect(sections.get('b3')).toBe('section:b1');
    expect(sections.get('b5')).toBe('section:b4');
  });
});

describe('layout fingerprint (§7.2, §33)', () => {
  it('is stable for the same layout and ignores the generation counter', () => {
    expect(sameLayout(fingerprint(), fingerprint({}, 9))).toBe(true);
  });

  it.each([
    ['font size', { fontSizePx: 72 }],
    ['line height', { lineHeight: 1.4 }],
    ['column width', { columnWidthPercent: 80 }],
    ['font family', { fontFamilyId: 'serif' }],
    ['mirror state', { mirrorX: true }],
    ['cue layout', { showCues: false }],
  ] as const)('invalidates on a %s change', (_name, overrides) => {
    expect(sameLayout(fingerprint(), fingerprint(overrides))).toBe(false);
  });

  it('invalidates on a viewport or scale-factor change', () => {
    const base = fingerprint();
    const resized = buildLayoutFingerprint({
      scriptCompileHash: 'hash-a',
      stageGeneration: 1,
      layoutGeneration: 1,
      settings,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
      displayScaleFactor: 2,
    });
    const rescaled = buildLayoutFingerprint({
      scriptCompileHash: 'hash-a',
      stageGeneration: 1,
      layoutGeneration: 1,
      settings,
      viewportWidthPx: 1920,
      viewportHeightPx: 1080,
      displayScaleFactor: 1.5,
    });
    expect(sameLayout(base, resized)).toBe(false);
    expect(sameLayout(base, rescaled)).toBe(false);
  });

  it('invalidates on a new script or stage generation', () => {
    const base = fingerprint();
    expect(sameLayout(base, { ...base, scriptCompileHash: 'hash-b' })).toBe(false);
    expect(sameLayout(base, { ...base, stageGeneration: 2 })).toBe(false);
    expect(sameLayout(base, null)).toBe(false);
  });
});
