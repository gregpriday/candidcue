/**
 * The separate stage window, as the Settings preview drives it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE WINDOW IS FOR NOW
 * ---------------------------------------------------------------------------
 * A take renders the stage inside the control window and feeds it through the
 * `embedded` bridge prop. The separate window is opened only by Settings (the
 * "Show on teleprompter" preview) and Calibrate, and neither carries a take. So
 * the window keeps exactly what those need — the document handshake, the
 * directive channel and the Escape relay — and none of the receivers a
 * two-window take once needed: no heartbeat or control-loss watchdog, no
 * transcript or voice-pill subscription, no live-sync pull, and no motion,
 * layout-error or intent reports that nothing on the control side reads (#235).
 *
 * The cold start is the case most likely to break. `open_stage` returns before
 * this bundle has run, so the envelope Settings publishes straight after lands
 * on a page with no listeners and is lost; the stage announces `listening`
 * once its subscriptions are live and Rust replays the envelope it holds. The
 * replay is modelled here by answering `listening` by hand.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { STAGE_EVENT } from '../../src/shared/contracts';

/**
 * Outbound stage traffic, captured at the bridge. The rest of the module stays
 * real: `dispatchLocalStageEvent` and `subscribeStageEvent` are the protocol.
 */
const emitted: Array<[string, unknown]> = [];
vi.mock('../../src/stage/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/events')>();
  return {
    ...actual,
    emitStageEvent: (name: string, payload: unknown) => {
      emitted.push([name, payload]);
    },
  };
});

const StageApp = (await import('../../src/stage/StageApp.svelte')).default;
const { dispatchLocalStageEvent } = await import('../../src/stage/events');
import type {
  StageEscapePayload,
  StageHydratedPayload,
  StageReadyPayload,
  StageRenderDocument,
  StageSessionEnvelope,
  StageStatePayload,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

const STAGE_GENERATION = 9;

/**
 * Everything the separate window may still say: the handshake, Escape, and the
 * viewport prior the script layer reports (a no-op in Rust outside a take).
 */
const WINDOW_EVENTS = new Set<string>([
  STAGE_EVENT.listening,
  STAGE_EVENT.hydrated,
  STAGE_EVENT.layoutReady,
  STAGE_EVENT.escapePressed,
  STAGE_EVENT.viewportHint,
]);

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
  emitted.length = 0;
});

/**
 * The envelope the Settings preview publishes: a real document and real
 * settings, and NO `sessionGeneration`, because it belongs to no take.
 */
function previewEnvelope(): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000bb',
    stageGeneration: STAGE_GENERATION,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'preview',
    compileRevision: 1,
    stageSettings: buildStageSettings({}),
    renderDocument: {
      schemaVersion: 1,
      title: 'Preview',
      blocks: [
        {
          id: 'b1',
          kind: 'paragraph',
          renderNodes: [{ type: 'text', text: 'Read this aloud', tokenIndexes: [0, 1, 2] }],
          startTokenIndex: 0,
          endTokenIndex: 2,
          source: { utf16Start: 0, utf16End: 15 },
          spoken: true,
        },
      ],
      tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
      assets: {},
      sentences: [],
    } as unknown as StageRenderDocument,
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const names = () => emitted.map(([name]) => name);

function press(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** A cold preview: the first envelope is lost, and the replay on `listening` lands. */
async function mountColdPreview(): Promise<HTMLElement> {
  // Published before the bundle subscribed — nobody hears it.
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, previewEnvelope());
  const { container } = render(StageApp);
  await settle();
  expect(names(), 'the stage must say it can hear before Rust replays').toContain(
    STAGE_EVENT.listening,
  );
  expect(container.textContent).not.toContain('Read this aloud');

  // Rust's answer to `listening`: the envelope it holds for this generation.
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, previewEnvelope());
  await settle();
  return container;
}

describe('a Settings preview opened cold', () => {
  it('shows its first document from the replay and completes the handshake', async () => {
    const container = await mountColdPreview();

    // Both handshake steps carry the envelope's generation and session: Rust
    // checks each against the stage it has open and drops a mismatch.
    const sent = previewEnvelope();
    const hydrated = emitted
      .filter(([name]) => name === STAGE_EVENT.hydrated)
      .map(([, payload]) => payload as StageHydratedPayload);
    expect(hydrated).toEqual([{ stageGeneration: sent.stageGeneration, sessionId: sent.sessionId }]);

    // `layout-ready` is what Rust turns into `stage://ready` for Settings.
    await vi.waitFor(() => expect(names()).toContain(STAGE_EVENT.layoutReady), { timeout: 3000 });
    const ready = emitted.find(([name]) => name === STAGE_EVENT.layoutReady)?.[1] as StageReadyPayload;
    expect(ready.stageGeneration).toBe(sent.stageGeneration);
    expect(ready.sessionId).toBe(sent.sessionId);
    expect(ready.hydrated).toBe(true);
    expect(ready.layoutReady).toBe(true);
    await settle();
    expect(container.textContent).toContain('Read this aloud');
    expect(container.querySelector('.stage-root')?.getAttribute('data-phase')).toBe('ready');
  });

  it('follows a settings directive, the way the sliders drive it', async () => {
    const container = await mountColdPreview();
    const plane = () => container.querySelector('.stage-talent-plane');
    expect(plane()?.getAttribute('data-mirror-x')).toBe('false');

    dispatchLocalStageEvent<StageStatePayload>(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION,
      directive: { kind: 'settings', settings: { ...buildStageSettings({}), mirrorX: true } },
    });
    await settle();
    expect(plane()?.getAttribute('data-mirror-x')).toBe('true');
  });

  it('closes on a second Escape, stamped for the generation-checked relay', async () => {
    await mountColdPreview();
    press('Escape');
    await settle();
    press('Escape');
    await settle();

    const escapes = emitted
      .filter(([name]) => name === STAGE_EVENT.escapePressed)
      .map(([, payload]) => payload as StageEscapePayload);
    expect(escapes.map((e) => e.presses)).toEqual([1, 2]);
    for (const escape of escapes) expect(escape.stageGeneration).toBe(STAGE_GENERATION);
  });
});

describe('the take-only traffic is gone from the window', () => {
  it('neither pulls live state nor reports anything control does not read', async () => {
    await mountColdPreview();
    // Long enough for the old 500 ms sync-request loop to have fired twice,
    // and for the old 1 s watchdog to have ticked.
    await wait(1200);
    await settle();
    // The transport keys still answer a take; here they have nobody to tell.
    press('a');
    press(']');
    press('ArrowDown');
    await settle();

    const unexpected = names().filter((name) => !WINDOW_EVENTS.has(name));
    expect(unexpected, 'the separate window emitted take-only traffic').toEqual([]);
  });
});
