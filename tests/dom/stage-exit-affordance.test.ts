/**
 * The stage's two operator-facing instruments: the way out, and the feed
 * readout that says why the document is not moving.
 *
 * They share a file because they share the only harness that can test either —
 * a mounted `StageApp` driven through the real event protocol. Both are defects
 * of INTEGRATION rather than of logic: which plane an element is nested in, and
 * which signal an effect depends on. Neither is visible from a unit test of the
 * part.
 *
 * ---------------------------------------------------------------------------
 * The way out of a full-screen stage that is not a keystroke
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * The stage is frameless, sized to a whole monitor, and always-on-top (§52.7).
 * Escape ends a take from whichever window holds the keyboard — which means a
 * stage covering a screen while the operator works in some other application
 * cannot be dismissed at all: Escape goes to that other application, and the
 * stage has to be clicked before it can be told anything. A full-screen window
 * with no visible way out reads as a hang.
 *
 * The affordance that fixes it lives in the session dock, inside the operator
 * plane — and that plane is `pointer-events: none`, on purpose, so a stray
 * click over any of the readouts in it lands on the root and reports focus
 * instead of being swallowed by decoration. A button inheriting that rule
 * paints perfectly, invites the click, and does nothing: the exact dead control
 * it was added to replace. Nothing else can see that. Its markup is right, its
 * handler is right, its unit behaviour is right, and it is inert.
 *
 * So this drives the mounted `StageApp` and asserts the facts that are only
 * true of a real, hittable control: it takes pointer events, one click on it
 * asks rather than acts, and confirming sends the same "end the take" message a
 * second Escape sends.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGE_EVENT } from '../../src/shared/contracts';

/**
 * Outbound stage traffic, captured at the bridge.
 *
 * `emitStageEvent` writes to a module-private `EventTarget` outside Tauri, so
 * there is nothing a test can subscribe to. The rest of the module is kept real
 * — `dispatchLocalStageEvent` and `subscribeStageEvent` are what drive the
 * stage in this harness, and replacing them would leave nothing under test.
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
  StageRenderDocument,
  StageSessionEnvelope,
} from '../../src/shared/contracts';
import { buildStageSettings } from '../../src/control/services/stage-envelope';

const STAGE_GENERATION = 7;

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

beforeEach(() => {
  emitted.length = 0;
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

function envelope(): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: STAGE_GENERATION,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'hash-abc',
    compileRevision: 1,
    stageSettings: buildStageSettings({}),
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

/** A well-formed snapshot for the session the envelope above declares. */
function snapshot(seq: number) {
  return {
    sessionGeneration: 1,
    seq,
    state: 'following',
    decision: 'localConfirmed',
    confirmedToken: seq,
    observedToken: seq,
    rateTokensPerSecond: 2.6,
    evidenceAudioMs: seq * 1000,
    atAudioMs: seq * 1000,
    maxPredictionMs: 900,
    pauseOnsetMs: 1800,
    leadFloorMs: 550,
    maxLeadTokens: 2.5,
    leadMarginTokens: 2.2,
    leadEaseMs: 450,
    leadHoldMs: 0,
    leadDecayMs: 1200,
    displayLimitToken: 3,
    confidence: 0.9,
    suggestionToken: null,
    scriptLenTokens: 3,
    observedAtom: seq,
    confirmedAtom: seq,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountLiveStage(): Promise<HTMLElement> {
  render(StageApp);
  await settle();
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope());
  await settle();
  const root = document.querySelector('.stage-root');
  if (!(root instanceof HTMLElement)) throw new Error('the stage did not mount');
  return root;
}

/**
 * Wake the dock the way a person does: by moving the mouse.
 *
 * Coordinates, because the dock wakes on DISPLACEMENT rather than on events —
 * trackpad tremor emits `pointermove` continuously, and a dock that brightened
 * for every one of those would flicker in the corner of the presenter's eye for
 * a whole take with nobody touching anything.
 */
function movePointer(root: HTMLElement, x = 40, y = 40): void {
  root.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
}

/** The dock's End control, or null while the dock's buttons are hidden. */
function exitButton(): HTMLButtonElement | null {
  const button = document.querySelector<HTMLButtonElement>('.stage-dock .dock-button.end');
  // Present in the DOM the whole time — it keeps its place in the layout so the
  // audio readout beside it never moves — so "offered" means visible and
  // hittable, not mounted.
  if (!button || button.dataset.hidden === 'true') return null;
  return button;
}

/** Whichever button in the anchored confirmation actually ends the take. */
function confirmEndButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.stage-dock .confirm-end');
}

/** Put the stage into Diagnostic Take, which is where the raw transcript is. */
async function showDiagnostics(): Promise<void> {
  dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
    stageGeneration: STAGE_GENERATION,
    directive: { kind: 'diagnostics', visible: true },
  });
  await settle();
}

/** The escape prompt the stage answers a single press with. */
function escapeHint(): Element | null {
  return document.querySelector('.escape-hint');
}

/** One line of the Diagnostic Take readout, by its leading label. */
function diagnosticLine(label: string): string | undefined {
  return [...document.querySelectorAll('.diagnostics div')]
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((text) => text.startsWith(label));
}

const feedLine = () => diagnosticLine('feed:');
const tokenLine = () => diagnosticLine('token:');

describe('the stage exit affordance', () => {
  /*
   * IT SHOWS ITSELF ONCE, AND THEN GETS OUT OF THE WAY.
   *
   * The old rule was "hidden until somebody reaches for the mouse", full stop.
   * That is right about the steady state and wrong about the first four
   * seconds: somebody has just had a full-screen, always-on-top window take
   * over a display, and a screen with no visible way out reads as a hang. The
   * take has not started — nobody has drawn breath yet — so the opening reveal
   * costs it nothing.
   *
   * What must not happen is the controls STAYING. A take is exactly when nobody
   * touches the mouse, and a lit button in the corner of the presenter's glass
   * for the whole performance is in shot.
   */
  it('shows itself at the top of a take and then fades', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mountLiveStage();
      expect(exitButton(), 'the dock should introduce itself').not.toBeNull();

      vi.advanceTimersByTime(5000);
      await settle();
      expect(exitButton(), 'and then leave').toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('comes back on pointer movement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const root = await mountLiveStage();
      vi.advanceTimersByTime(5000);
      await settle();
      expect(exitButton()).toBeNull();

      movePointer(root);
      await settle();
      expect(exitButton()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * -------------------------------------------------------------------------
   * NOT TESTED HERE: that the button is actually HITTABLE.
   * -------------------------------------------------------------------------
   * The obvious assertion — `getComputedStyle(button).pointerEvents === 'auto'`
   * — is worthless in jsdom, and was written and deleted rather than left in.
   * jsdom returns the INITIAL value (`auto`) for `pointer-events` without
   * inheriting `.stage-safe-plane`'s `none`, so the assertion passes whether or
   * not the button opts back in. Removing the fix from the component leaves it
   * green: verified, not assumed.
   *
   * A test that cannot fail is worse than a missing one, because it is counted.
   * The real claim needs hit-testing, so it lives in Playwright, where the
   * browser does it: see "the exit affordance is clickable, not just painted"
   * in tests/e2e/browser/stage-preview.spec.ts. Playwright's actionability
   * check fails a click on an element that cannot receive pointer events, which
   * is exactly the defect.
   */

  /*
   * ONE CLICK ASKS. It used to end the take outright, on the reasoning that
   * somebody who has found a button labelled "End session" and pressed it has
   * already confirmed.
   *
   * That reasoning depends on the button being hard to hit by accident, and
   * this one is not: it sits in a dock at the bottom-left corner, six pixels
   * from the audio readout somebody may well be leaning in to inspect, on a
   * screen where the pointer is invisible most of the time. The cost of the
   * mistake is a ruined take. So the click opens an anchored confirmation, and
   * the confirmation is what sends the message.
   */
  it('asks before it ends anything', async () => {
    const root = await mountLiveStage();
    movePointer(root);
    await settle();

    exitButton()!.click();
    await settle();

    expect(confirmEndButton(), 'the confirmation should be up').not.toBeNull();
    expect(emitted.filter(([name]) => name === STAGE_EVENT.escapePressed)).toEqual([]);
  });

  it('ends the take when the confirmation is taken, as a second Escape would', async () => {
    const root = await mountLiveStage();
    movePointer(root);
    await settle();

    exitButton()!.click();
    await settle();
    confirmEndButton()!.click();
    await settle();

    const escapes = emitted
      .filter(([name]) => name === STAGE_EVENT.escapePressed)
      .map(([, payload]) => payload as StageEscapePayload);

    // Two presses: the SAME message a second Escape sends, not a second way of
    // ending a take. Control owns the whole teardown either way.
    expect(escapes.map((e) => e.presses)).toEqual([2]);
    expect(escapes[0]?.stageGeneration).toBe(STAGE_GENERATION);
  });

  it('backs out of the confirmation on Escape without ending the take', async () => {
    const root = await mountLiveStage();
    movePointer(root);
    await settle();
    exitButton()!.click();
    await settle();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();

    // Both halves matter. The confirmation closes, and — the part that would be
    // a disaster — the key that backs out of "end the session?" is not also
    // counted towards the double press that ends it.
    expect(confirmEndButton()).toBeNull();
    expect(emitted.filter(([name]) => name === STAGE_EVENT.escapePressed)).toEqual([]);
    expect(escapeHint(), 'and it did not reach the stage as a first press').toBeNull();
  });

  /**
   * A stage with NO DOCUMENT can still be escaped.
   *
   * The calibration wizard opens a bare stage and drives it with directives —
   * no envelope, ever, on purpose (`control/routes/Calibrate.svelte`). Escape
   * used to be stamped `app.envelope?.stageGeneration ?? 0`, so from that window
   * it always carried generation 0. Rust relays the press through
   * `coordinator.stage_event`, which drops anything whose generation is not the
   * live one (`src-tauri/src/app.rs`) — so the press died in Rust, control never
   * heard it, and a borderless always-on-top window covering a monitor had no
   * way out at all. Force-quitting the app was the only exit, and that is how it
   * was reported.
   *
   * Directives carry the real generation, so the stage learns it from them. This
   * asserts the stamp that makes the relay accept the press: get it wrong and
   * the fix is silently undone, with every other test in this file still green
   * because they all have an envelope.
   */
  it('stamps Escape with a generation learned from directives when it has no document', async () => {
    const CALIBRATION_GENERATION = 11;
    render(StageApp);
    await settle();

    // No `loadSession` — this is the documentless case, exactly as the wizard
    // drives it.
    dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
      stageGeneration: CALIBRATION_GENERATION,
      directive: { kind: 'calibration', active: true, mode: 'safe_area' },
    });
    await settle();

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();

    const escapes = emitted
      .filter(([name]) => name === STAGE_EVENT.escapePressed)
      .map(([, payload]) => payload as StageEscapePayload);

    expect(escapes.map((e) => e.presses)).toEqual([1, 2]);
    // The whole point: NOT 0, which is what Rust would have thrown away.
    for (const escape of escapes) {
      expect(escape.stageGeneration).toBe(CALIBRATION_GENERATION);
    }
  });

  /**
   * The alignment-feed readout accumulates across a take.
   *
   * `app` is `$state.raw` and is reassigned on every dispatch — once a second,
   * by the very snapshots this readout counts. A reset effect that depended on
   * `app` rather than on the session generation ALONE would therefore re-run on
   * each snapshot and zero the counters it exists to accumulate, leaving the
   * instrument permanently reporting "1 ok / 0 dropped" no matter what the take
   * did. Verified by construction: the effect keys off a `$derived` number.
   */
  it('accumulates the alignment feed across a take instead of resetting each snapshot', async () => {
    await mountLiveStage();
    // Diagnostic Take shows the readout; the clean stage never does.
    dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION,
      directive: { kind: 'settings', settings: { ...buildStageSettings({}), stageMode: 'diagnostic' } },
    });
    await settle();

    for (let seq = 1; seq <= 3; seq += 1) {
      dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot(seq));
      await settle();
    }

    expect(feedLine(), 'the diagnostic readout should carry a feed line').toBeDefined();
    // Three snapshots in, three accepted — not one.
    expect(feedLine()).toMatch(/3 ok/);
  });

  /**
   * A snapshot from another session is refused, counted, and NAMED.
   *
   * ---------------------------------------------------------------------
   * SCOPE, stated because it is narrower than it looks
   * ---------------------------------------------------------------------
   * This asserts the receiver's verdict and the readout that reports it. It
   * does NOT assert the other half of the same change — that a refused snapshot
   * is kept out of the reducer, and so out of the §62 fallback path that turns
   * `app.alignment` into a scroll target.
   *
   * It cannot, here. The reducer's first line is `if (!state.envelope ||
   * state.phase === 'handshake') return state;`, and a jsdom stage never leaves
   * `handshake`: there is no layout engine, so the layout never reports ready.
   * Every reducer-visible field (`token:`, `tracking rev:`) is therefore frozen
   * regardless of the gate, and an assertion on them would pass with the gate
   * removed. Verified rather than assumed — the probe prints
   * `phase: handshake`.
   *
   * Covering that half needs a stage that reaches `live`, which means the
   * browser harness. It is not covered today, and saying so is better than a
   * green test that stands for it.
   */
  it('refuses a snapshot from another session and says which rule refused it', async () => {
    await mountLiveStage();
    dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION,
      directive: { kind: 'settings', settings: { ...buildStageSettings({}), stageMode: 'diagnostic' } },
    });
    await settle();

    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot(1));
    await settle();
    expect(feedLine()).toMatch(/1 ok \/ 0 dropped/);

    // Another session's snapshot, further along.
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, {
      ...snapshot(9),
      sessionGeneration: 4242,
      confirmedToken: 99,
    });
    await settle();

    // The whole point of the readout: not just that something was dropped, but
    // which rule dropped it — the difference between a delivery problem and a
    // take/envelope disagreement.
    expect(feedLine()).toMatch(/1 ok \/ 1 dropped \(session_generation\)/);
  });

  /**
   * The transcript bar's words arrive as a DIRECTIVE, on the Rust relay.
   *
   * They used to come straight from the control webview as
   * `emitTo('stage', 'stage://transcript-tap', …)`, and on a real rig that
   * delivered nothing: the bar read "listening — no words yet" for a whole take
   * while control counted six taps sent, in the same seconds that alignment
   * snapshots — emitted from RUST — arrived and moved the document to the
   * pixel. The difference was the road, not the payload.
   *
   * This pins the new road: a `transcript` directive on `applyCommand`, which
   * is the same channel freeze, blank, settings and calibration already use.
   */
  it('shows the recogniser words that arrive as a directive', async () => {
    await mountLiveStage();
    await showDiagnostics();
    expect(document.querySelector('.transcript-tap')?.textContent).toContain('listening');

    dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION,
      directive: { kind: 'transcript', text: 'this is a test of the transcription', final: false },
    });
    await settle();

    expect(document.querySelector('.transcript-tap')?.textContent).toContain(
      'this is a test of the transcription',
    );
  });

  it('recovers recogniser words from the Rust live checkpoint after an event loss', async () => {
    await mountLiveStage();
    await showDiagnostics();
    expect(document.querySelector('.transcript-tap')?.textContent).toContain('listening');

    // Deliberately do not dispatch applyCommand: this models the immediate
    // webview event being lost. The next stage pull returns the Rust-owned
    // checkpoint and must produce the same visible result.
    dispatchLocalStageEvent(STAGE_EVENT.liveSync, {
      stageGeneration: STAGE_GENERATION,
      revision: 4,
      alignment: null,
      transcript: {
        stageGeneration: STAGE_GENERATION,
        directive: { kind: 'transcript', text: 'recovered after a dropped event', final: false },
      },
      voicePill: null,
    });
    await settle();

    expect(document.querySelector('.transcript-tap')?.textContent).toContain(
      'recovered after a dropped event',
    );
  });

  it('ignores transcript words addressed to another stage generation', async () => {
    await mountLiveStage();
    await showDiagnostics();
    dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION + 99,
      directive: { kind: 'transcript', text: 'from a take that ended', final: true },
    });
    await settle();
    expect(document.querySelector('.transcript-tap')?.textContent).toContain('listening');
  });

  it('does not offer itself over a blanked stage', async () => {
    const root = await mountLiveStage();
    dispatchLocalStageEvent(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GENERATION,
      directive: { kind: 'blank', blanked: true },
    });
    await settle();
    movePointer(root);
    await settle();
    // A blank is a deliberate "show nothing", and Escape is already the answer
    // to one — the hint that says so is the thing on screen at that moment.
    // The whole dock goes, not just the button.
    expect(document.querySelector('.stage-dock')).toBeNull();
  });
});
