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
import { STAGE_EVENT, STAGE_VOICE_PILL_TRACE_SAMPLES } from '../../src/shared/contracts';
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
    leadMarginTokens: 1.2,
    leadEaseMs: 450,
    leadHoldMs: 0,
    leadDecayMs: 1200,
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
    await settle();

    for (const selector of ['.hold-status', '.ack']) {
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

    /*
     * THE AUDIO READOUT AND THE WAY OUT LIVE HERE NOW.
     *
     * This test used to assert the opposite for the pill, and the argument for
     * that was about the fault NAME: a word the presenter has to read at a
     * glance, which an unmirrored plane guarantees will arrive backwards in the
     * glass. That argument is still correct and is now satisfied somewhere
     * else — `resolveHoldStatus` puts a named fault at the top of the hold
     * ladder, so "No audio" reaches the presenter through the mirrored hold
     * chip, in presenter-sized type. What is left in the dock is a waveform, a
     * mark, and two mouse targets.
     *
     * The mouse targets are what force the move rather than merely allow it. A
     * CSS transform carries hit-testing with it, so a mirrored button is
     * clickable exactly where it appears — on the opposite side of the screen
     * from where it was before somebody turned mirroring on. That is not a
     * property a control may have.
     */
    expect(planeOf(container, '.stage-dock'), 'the session dock').toBe('operator');

    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'listening',
      levels: [0.2, 0.6],
      label: 'Listening',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();
    expect(planeOf(container, '.voice-pill'), 'the audio readout').toBe('operator');

    // And nothing the presenter has to READ leaked into it.
    const operator = container.querySelector('.stage-operator-plane');
    expect(operator?.querySelector('.escape-hint')).toBeNull();
    expect(operator?.querySelector('.hold-status')).toBeNull();
  });

  it('insets the dock and the transcript by the rig\'s own safe rectangle', async () => {
    // A hood crops the panel. The operator's instruments are inside the same
    // rectangle the presenter's overlays are, for the same reason — a dock 20px
    // from the window's corner on a hooded rig is a dock under the bezel.
    const container = await mountStage('diagnostic', hoodedOptics());
    await settleLayout();

    /*
     * `.diagnostics` is in this list because it used to be the one thing in the
     * operator plane that was NOT: it sat as a direct child of the full-bleed
     * plane, so its `--stage-chrome-inset` offsets ran from the raw window
     * corner while the dock beside it measured from the safe rectangle. On a
     * hooded rig that is a readout under the bezel — a diagnostic nobody can
     * see, which is the whole point of one thrown away.
     */
    for (const selector of ['.stage-dock', '.transcript-tap', '.diagnostics']) {
      expect(
        container.querySelector(selector)?.closest('.stage-operator-safe'),
        `${selector} is outside the operator safe plane`,
      ).not.toBeNull();
    }

    const plane = container.querySelector<HTMLElement>('.stage-operator-safe');
    expect(parseFloat(plane?.style.top ?? 'NaN')).toBeCloseTo(8, 3);
    expect(parseFloat(plane?.style.left ?? 'NaN')).toBeCloseTo(5, 3);
    expect(parseFloat(plane?.style.width ?? 'NaN')).toBeCloseTo(90, 3);
    expect(parseFloat(plane?.style.height ?? 'NaN')).toBeCloseTo(80, 3);

    /*
     * And the popovers that rise from the dock are bounded by that rectangle
     * rather than by the window.
     *
     * This is the failure it prevents: the appearance panel is ~412px, the dock
     * sits 16px above the safe bottom, and a rig with a deep bottom inset — the
     * optical model accepts up to 45% an edge — puts the panel's title and its
     * Done button above the top of the visible area, where `.stage-root`'s
     * `overflow: hidden` removes them and nothing can scroll them back.
     */
    const budget = plane?.style.getPropertyValue('--stage-popover-max-height') ?? '';
    expect(budget, 'the dock must publish a popover height budget').toMatch(/^\d+px$/);
    // Strictly less than the viewport answer, which is the whole point.
    expect(parseFloat(budget)).toBeLessThan(window.innerHeight - 72);
    expect(parseFloat(budget)).toBeGreaterThan(0);
  });
});

describe('Clean Take against Diagnostic Take', () => {
  it('keeps the raw transcript out of Clean Take, and says why it can afford to', async () => {
    /*
     * ---------------------------------------------------------------------
     * THIS TEST HAS NOW ASSERTED BOTH ANSWERS, AND BOTH WERE RIGHT AT THE TIME
     * ---------------------------------------------------------------------
     * It first pinned "diagnostic only", on the reasoning that a strip of
     * changing words along the bottom edge is peripheral motion competing with
     * the reading line. Then it pinned the opposite, because that reasoning had
     * hidden the ONLY instrument that separated three unrelated faults with one
     * symptom: a script that has stopped moving, because the microphone was
     * never captured, or because the recogniser heard nothing, or because the
     * aligner would not match.
     *
     * The separation no longer depends on this bar. Each of those three has a
     * first-class reading somewhere the presenter is already looking — a named
     * fault on the audio readout AND, through `resolveHoldStatus`, the same
     * sentence in the mirrored hold chip; "Not hearing you" for speech with
     * nothing coming back; "Holding here" for an aligner that will not match.
     * So the strip goes back to being what it always was — a raw recogniser
     * dump for somebody debugging a rig — and Clean Take stops looking like a
     * development HUD.
     *
     * The claim is not "it is hidden". It is "it is hidden AND nothing was
     * lost", so this asserts the replacement as well.
     */
    const container = await mountStage('clean');
    await settleLayout();

    dispatchLocalStageEvent(STAGE_EVENT.transcriptTap, {
      stageGeneration: STAGE_GENERATION,
      text: 'hello there',
      final: false,
      sentAtMs: 1000,
    });
    await settle();
    expect(container.querySelector('.transcript-tap')).toBeNull();
    expect(container.querySelector('.diagnostics')).toBeNull();

    // The replacement: a named fault, in the mirrored chip the presenter reads.
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'fault',
      levels: [0.2, 0.6],
      label: 'No audio',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();

    const chip = container.querySelector('.hold-status');
    expect(chip?.getAttribute('data-visible'), 'the fault must reach the glass').toBe('true');
    expect(chip?.textContent).toContain('No audio');
    expect(planeOf(container, '.hold-status'), 'mirrored, so it reads in the glass').toBe('talent');
  });

  it('still says when following is off, or the recogniser is not connected (#300)', async () => {
    /*
     * Clean Take is the default now, so everything the presenter can act on has
     * to read without the instruments. A take paused by hand and a take with no
     * recogniser behind it both hold the script still, and neither clears by
     * itself — so both are named in the mirrored chip, in Clean Take.
     */
    const container = await mountStage('clean');
    await settleLayout();

    directive({ kind: 'follow', paused: true });
    await settle();
    const chip = container.querySelector('.hold-status');
    expect(chip?.getAttribute('data-visible'), 'a paused take must say so').toBe('true');
    expect(chip?.textContent).toContain('Following off');

    directive({ kind: 'follow', paused: false });
    dispatchLocalStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, {
      stageGeneration: STAGE_GENERATION,
      reading: 'fault',
      levels: [0, 0],
      label: 'Not connected',
      visible: true,
      sentAtMs: 1000,
    });
    await settle();
    expect(container.querySelector('.hold-status')?.textContent).toContain('Not connected');
    expect(planeOf(container, '.hold-status')).toBe('talent');

    // And neither brought the instruments back with it.
    expect(container.querySelector('.diagnostics')).toBeNull();
    expect(container.querySelector('.transcript-tap')).toBeNull();
  });

  it('carries only the tail of a long utterance, not everything since the last final', async () => {
    /*
     * The bar answers "is CandidCue hearing me?", and the words that answer it
     * are the ones that just arrived. It used to hold the whole utterance and
     * rely on `overflow: hidden`, which hides the excess on the glass while the
     * element still LAYS OUT at the full width of it — a strip of moving text
     * across the panel, under a script somebody is reading.
     *
     * `transcript-tail.ts` owns the rule and is unit-tested; this is the seam
     * that says the stage actually applies it, which no unit test can see.
     */
    const container = await mountStage('diagnostic');
    await settleLayout();

    const spoken = Array.from({ length: 26 }, (_, i) => `word${i + 1}`);
    dispatchLocalStageEvent(STAGE_EVENT.transcriptTap, {
      stageGeneration: STAGE_GENERATION,
      text: spoken.join(' '),
      final: false,
      sentAtMs: 1000,
    });
    await settle();

    const shown = (container.querySelector('.transcript-tap')?.textContent ?? '').trim();
    expect(shown.split(/\s+/)).toHaveLength(10);
    // The NEWEST words. Cropping the wrong end would freeze the bar on the
    // opening of a long utterance, which is the one thing it must never do.
    expect(shown).toBe(spoken.slice(-10).join(' '));
    expect(shown).not.toContain('word16');
  });

  it('draws both once the rig is in Diagnostic Take', async () => {
    const container = await mountStage('diagnostic');
    await settleLayout();
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot());
    await settle();

    expect(container.querySelector('.transcript-tap')).not.toBeNull();
    expect(container.querySelector('.diagnostics')).not.toBeNull();
  });

  it('draws the waveform in either mode, even long after the chain is proven', async () => {
    /*
     * Twice something has tried to retire the trace once recognition comes
     * back: the stage forced `collapsed` in Clean Take, and control faded the
     * whole pill a couple of seconds after it confirmed. Both were reasoning
     * about a real cost — peripheral motion beside a script — and both left the
     * presenter with no way to ask "am I still being picked up?", which is the
     * only question this instrument is ever asked.
     *
     * A `confirmed` pill is the settled, everything-is-fine case. The bars have
     * to be there anyway.
     */
    const pill: StageVoicePillPayload = {
      stageGeneration: STAGE_GENERATION,
      reading: 'confirmed',
      levels: [0.3, 0.7],
      label: 'Hearing you',
      visible: true,
      sentAtMs: 1000,
    };

    for (const mode of ['clean', 'diagnostic'] as const) {
      document.body.innerHTML = '';
      const container = await mountStage(mode);
      dispatchLocalStageEvent(STAGE_EVENT.voicePill, pill);
      await settle();
      const wave = container.querySelector('.voice-pill .wave');
      expect(wave, `${mode} take must draw the trace`).not.toBeNull();
      expect(
        wave?.querySelectorAll('.bar').length,
        `${mode} take must draw a full trace, not a stub`,
      ).toBe(STAGE_VOICE_PILL_TRACE_SAMPLES);
    }
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
