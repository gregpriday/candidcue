/**
 * One mirrored plane for the presenter, one unmirrored plane for the operator.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * The Escape confirmation, the transcript bar and the voice pill were all
 * mounted OUTSIDE the mirror plane, each with a comment explaining that this was
 * what kept them legible. A beamsplitter does not work that way: it reflects
 * every pixel equally, so an element left out of the corrective flip is the one
 * element guaranteed to arrive at the presenter's eye backwards. The three
 * things excluded were, between them, "how to stop the take", "is the
 * microphone working" and the recogniser's own words — short strings read at a
 * glance, which is precisely the case a mirror destroys.
 *
 * Every one of those components had passing unit tests. The defect was which
 * DIV they were nested in, which is only visible from the mounted stage, which
 * is why this file drives `StageApp` through the real event protocol rather
 * than rendering the leaves.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import StageApp from '../../src/stage/StageApp.svelte';
import { dispatchLocalStageEvent } from '../../src/stage/events';
import { STAGE_EVENT } from '../../src/shared/contracts';
import type {
  AlignmentSnapshot,
  ResolvedOptics,
  StageCalibrationMode,
  StageMode,
  StageRenderDocument,
  StageSessionEnvelope,
  StageStatePayload,
  StageVoicePillPayload,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';
import { discoverProfile } from '../../src/shared/optical-discovery';
import { resolveStageGeometry } from '../../src/shared/optical-resolve';

const STAGE_GENERATION = 7;

/**
 * A calibrated rig whose hood crops the panel unevenly.
 *
 * Resolved through the real model rather than hand-written, because the numbers
 * under test are the ones the resolver publishes — a fixture that invented them
 * would pass while the two sides disagreed.
 */
function hoodedOptics(): ResolvedOptics {
  const { profile } = discoverProfile({
    name: 'Elgato Prompter',
    physicalSize: { width: 1024, height: 600 },
    scaleFactor: 1,
  });
  return resolveStageGeometry({
    profile: { ...profile, safeArea: { top: 0.08, right: 0.05, bottom: 0.12, left: 0.05 } },
    viewport: { widthPx: 1024, heightPx: 600 },
  }).optics;
}

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

function renderDocument(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello there friend', tokenIndexes: [0, 1, 2] }],
        startTokenIndex: 0,
        endTokenIndex: 2,
        source: { utf16Start: 0, utf16End: 18 },
        spoken: true,
      },
    ],
    tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
    assets: {},
    sentences: [{ id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 2 }],
  } as unknown as StageRenderDocument;
}

function envelope(stageMode: StageMode = 'clean', optics?: ResolvedOptics): StageSessionEnvelope {
  const stageSettings = buildStageSettings({ stageMode });
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: STAGE_GENERATION,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: optics ? { ...stageSettings, optics } : stageSettings,
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

function snapshot(): AlignmentSnapshot {
  return {
    sessionGeneration: 1,
    seq: 1,
    state: 'following',
    decision: 'localConfirmed',
    confirmedToken: 1,
    observedToken: 1,
    rateTokensPerSecond: 2.6,
    evidenceAudioMs: 1000,
    atAudioMs: 1000,
    maxPredictionMs: 900,
    pauseOnsetMs: 1800,
    leadFloorMs: 550,
    maxLeadTokens: 2.5,
    displayLimitToken: 3,
    confidence: 0.9,
    suggestionToken: null,
    scriptLenTokens: 3,
    observedAtom: 1,
    confirmedAtom: 1,
  };
}

function directive(payload: StageStatePayload['directive']): void {
  dispatchLocalStageEvent<StageStatePayload>(STAGE_EVENT.applyCommand, {
    stageGeneration: STAGE_GENERATION,
    directive: payload,
  });
}

/** Let the stage's async subscriptions register and its effects settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the handshake to complete.
 *
 * The reducer refuses alignment snapshots while the phase is still `handshake`,
 * and the phase only advances when the script layer reports its first
 * measurement — which arrives on a rAF, or on the 350 ms timer that covers a
 * window rAF never runs in.
 */
async function settleLayout(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 420));
  await settle();
}

async function mountStage(
  stageMode: StageMode = 'clean',
  optics?: ResolvedOptics,
): Promise<HTMLElement> {
  const { container } = render(StageApp);
  await settle();
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope(stageMode, optics));
  await settle();
  return container;
}

/** The element, and which plane it is nested inside. */
function planeOf(container: HTMLElement, selector: string): 'talent' | 'operator' | null {
  const el = container.querySelector(selector);
  if (!el) return null;
  if (el.closest('.stage-talent-plane')) return 'talent';
  if (el.closest('.stage-operator-plane')) return 'operator';
  return null;
}

describe('everything the presenter reads through the glass', () => {
  it('sits inside the mirrored talent plane', async () => {
    const container = await mountStage();

    // Escape, answered locally so the first press is visible on the stage.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(planeOf(container, '.escape-hint'), 'the escape confirmation').toBe('talent');

    directive({ kind: 'ack', label: 'Chapter 1', durationMs: 900 });
    await settle();
    expect(planeOf(container, '.ack'), 'the acknowledgement chip').toBe('talent');

    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'listening',
      levels: [0.2, 0.6],
      label: 'Listening',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();
    expect(planeOf(container, '.voice-pill'), 'the voice pill').toBe('talent');

    expect(planeOf(container, '.hold-status'), 'the hold status chip').toBe('talent');
    expect(planeOf(container, '.script-layer'), 'the script itself').toBe('talent');
    expect(planeOf(container, '.cue'), 'the reading cue').toBe('talent');
  });

  it('is placed inside the safe rectangle, not against the raw viewport', async () => {
    // A hood crops the panel. A chip 24px from the window's corner on a hooded
    // rig sits under the bezel, and the one message worth reading is the one
    // nobody can see.
    const container = await mountStage('clean', hoodedOptics());
    directive({ kind: 'ack', label: 'Chapter 1', durationMs: 900 });
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'listening',
      levels: [0.2, 0.6],
      label: 'Listening',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();

    for (const selector of ['.hold-status', '.ack', '.voice-pill']) {
      const el = container.querySelector(selector);
      expect(el, `${selector} is not mounted at all`).not.toBeNull();
      expect(
        el?.closest('.stage-safe-plane'),
        `${selector} is outside the safe plane`,
      ).not.toBeNull();
    }

    /*
     * And the plane is inset by what the rig actually reported. Nesting alone
     * proves only that a div has the right name: a safe plane at inset zero
     * puts every one of these chips back under the bezel while every structural
     * assertion above still passes.
     */
    const plane = container.querySelector<HTMLElement>('.stage-safe-plane');
    expect(parseFloat(plane?.style.top ?? 'NaN')).toBeCloseTo(8, 3);
    expect(parseFloat(plane?.style.left ?? 'NaN')).toBeCloseTo(5, 3);
    expect(parseFloat(plane?.style.width ?? 'NaN')).toBeCloseTo(90, 3);
    expect(parseFloat(plane?.style.height ?? 'NaN')).toBeCloseTo(80, 3);
  });

  it('carries the optical secondary-text floor on the root', async () => {
    // The chips and the calibration cards are siblings of the script layer, not
    // children of it. A floor published only inside the script layer left them
    // on the em-relative default from `stage.css` — decoration size on a rig
    // whose optics had already said how small readable gets.
    const optics = hoodedOptics();
    const container = await mountStage('clean', optics);
    const root = container.querySelector<HTMLElement>('.stage-root');
    expect(root?.style.getPropertyValue('--stage-secondary-min')).toBe(
      `${optics.secondaryMinPx}px`,
    );
  });
});

describe('the operator plane', () => {
  it('holds the diagnostics, unmirrored, and nothing the presenter needs', async () => {
    const container = await mountStage('diagnostic');
    await settleLayout();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot());
    await settle();

    expect(planeOf(container, '.diagnostics'), 'the diagnostics readout').toBe('operator');
    expect(planeOf(container, '.transcript-tap'), 'the transcript bar').toBe('operator');

    // And nothing presenter-facing leaked into it.
    const operator = container.querySelector('.stage-operator-plane');
    expect(operator?.querySelector('.escape-hint')).toBeNull();
    expect(operator?.querySelector('.voice-pill')).toBeNull();
    expect(operator?.querySelector('.hold-status')).toBeNull();
  });
});

describe('Clean Take against Diagnostic Take', () => {
  it('keeps the transcript bar off a clean stage, live or not', async () => {
    /*
     * The bar is the raw recogniser text — an instrument, not something
     * addressed to the presenter — and a full-width strip of changing words
     * along the bottom edge is continuous motion in the one place peripheral
     * vision is already busy holding the reading line.
     */
    const container = await mountStage('clean');
    await settleLayout();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot());
    dispatchLocalStageEvent(STAGE_EVENT.transcriptTap, {
      stageGeneration: STAGE_GENERATION,
      text: 'hello there',
      final: false,
      sentAtMs: 1000,
    });
    await settle();

    expect(container.querySelector('.stage-root')?.getAttribute('data-phase')).toBe('live');
    expect(container.querySelector('.transcript-tap')).toBeNull();
    expect(container.querySelector('.diagnostics')).toBeNull();
  });

  it('draws both once the rig is in Diagnostic Take', async () => {
    const container = await mountStage('diagnostic');
    await settleLayout();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot());
    await settle();

    expect(container.querySelector('.transcript-tap')).not.toBeNull();
    expect(container.querySelector('.diagnostics')).not.toBeNull();
  });

  it('collapses the pill to its mark on a clean stage and leaves the trace to diagnostics', async () => {
    /*
     * The mark is presenter-facing in both modes — a cross is an actionable
     * fault and a tick is the only evidence the input chain works. The WAVEFORM
     * is not: it is the one thing on the glass besides the script that moves,
     * and it goes on moving for the rest of the take after it has finished
     * saying anything new.
     */
    const pill: StageVoicePillPayload = {
      stageGeneration: STAGE_GENERATION,
      reading: 'confirmed',
      levels: [0.3, 0.7],
      label: 'Hearing you',
      visible: true,
      prominence: 'expanded',
      sentAtMs: 1000,
    };

    const clean = await mountStage('clean');
    dispatchLocalStageEvent(STAGE_EVENT.voicePill, pill);
    await settle();
    expect(clean.querySelector('.voice-pill')?.getAttribute('data-expanded')).toBe('false');

    document.body.innerHTML = '';
    const diagnostic = await mountStage('diagnostic');
    dispatchLocalStageEvent(STAGE_EVENT.voicePill, pill);
    await settle();
    expect(diagnostic.querySelector('.voice-pill')?.getAttribute('data-expanded')).toBe('true');
  });

  it('still answers an explicit diagnostics directive on a clean stage', async () => {
    // Mode is a default, not a lock: an operator asking for the readout mid-take
    // is asking for it whatever the rig is nominally set to.
    const container = await mountStage('clean');
    directive({ kind: 'diagnostics', visible: true });
    await settle();
    expect(container.querySelector('.diagnostics')).not.toBeNull();
  });
});

describe('the calibration overlays', () => {
  it('draws the crosshair for the crosshair mode, as it always did', async () => {
    const container = await mountStage();
    directive({ kind: 'calibration', active: true, mode: 'crosshair', crosshairX: 0.5, crosshairY: 0.4 });
    await settle();

    expect(container.querySelector('.crosshair')).not.toBeNull();
    expect(container.querySelector('.calibration-card')).toBeNull();
    expect(planeOf(container, '.crosshair')).toBe('talent');
  });

  for (const mode of ['orientation', 'safe-area', 'ruler', 'type-sample'] as StageCalibrationMode[]) {
    it(`draws the ${mode} card, mirrored with the content it is aligned against`, async () => {
      const container = await mountStage();
      directive({
        kind: 'calibration',
        active: true,
        mode,
        safeArea: { top: 0.06, right: 0.04, bottom: 0.1, left: 0.04 },
        rulerLengthPx: 400,
        sampleFontSizePx: 64,
        sampleColumnCh: 34,
        sampleLabel: 'Standard · 24′',
      });
      await settle();

      const card = container.querySelector('.calibration-card');
      expect(card, `the ${mode} card is not drawn`).not.toBeNull();
      expect(card?.getAttribute('data-mode')).toBe(mode);
      expect(planeOf(container, '.calibration-card')).toBe('talent');
      expect(container.querySelector('.crosshair')).toBeNull();
    });
  }

  it('names the size being judged on the type sample', async () => {
    // `sampleLabel` rode the directive into the stage state and was read by
    // nothing, which left the operator comparing unlabelled samples.
    const container = await mountStage();
    directive({
      kind: 'calibration',
      active: true,
      mode: 'type-sample',
      sampleFontSizePx: 64,
      sampleColumnCh: 34,
      sampleLabel: 'Standard · 24′',
    });
    await settle();
    expect(container.querySelector('.sample-label')?.textContent).toBe('Standard · 24′');
  });

  it('clears every overlay when calibration ends', async () => {
    const container = await mountStage();
    directive({ kind: 'calibration', active: true, mode: 'ruler', rulerLengthPx: 400 });
    await settle();
    expect(container.querySelector('.calibration-card')).not.toBeNull();

    directive({ kind: 'calibration', active: false });
    await settle();
    expect(container.querySelector('.calibration-card')).toBeNull();
    expect(container.querySelector('.crosshair')).toBeNull();
  });
});
