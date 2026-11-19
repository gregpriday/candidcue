/**
 * §44.12 / Appendix E.7 — no user ever reads a stable error code.
 *
 * The defect these guard: `onSessionFailure` handed a bare code string to
 * `describeError`, which fell through `typeof err === 'string' → return err`,
 * so the toast read literally "Voice following stopped: QUOTA_EXHAUSTED"
 * (a code from the hosted-provider era; the codes have changed, the rule has
 * not).
 *
 * These tests drive the REAL store path — `startLiveSession` → the voice
 * pipeline's `onSessionFailure` hook → `showToast` → the toast store — and
 * assert the rendered string. Asserting that `describeError(code)`
 * returns something would prove nothing about what the operator sees.
 *
 * The sweep at the end is the regression guard that matters most: EVERY code
 * this build can produce is pushed through the live path and no rendered
 * string is allowed to contain a SCREAMING_SNAKE_CASE token. A code added
 * tomorrow without copy fails here rather than in front of a camera.
 *
 * The promises the rest of the file protects, each held by rule rather than by
 * the words of today's copy:
 *
 *  - no copy offers a session mode nothing offers (#121), read from
 *    `OFFERED_SESSION_MODES`;
 *  - recogniser copy reads true with no take open: the take-only fallback is
 *    scoped, and only it (#121, relocated to the microphone test);
 *  - a model that is not on the machine is repaired by the download, never by
 *    reinstalling an app the model is not in (#181).
 *
 * Rewording any of the copy while keeping those true passes without a test edit.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { CompiledScript } from '../../../src/shared/contracts';

const stage = vi.hoisted(() => ({
  publishStageSnapshot: vi.fn(async () => {}),
  listDisplays: vi.fn(async () => [{ fingerprint: 'display-0' }]),
}));

const records = vi.hoisted(() => ({
  endSessionRecord: vi.fn(async () => null),
  startSessionRecord: vi.fn(),
  listSessionRecords: vi.fn(async () => []),
}));

const pipeline = vi.hoisted(() => {
  const captured: { deps: Record<string, (...args: never[]) => unknown> | null } = { deps: null };
  const control: { startRejection: unknown } = { startRejection: null };
  class FakePipeline {
    constructor(deps: Record<string, (...args: never[]) => unknown>) {
      captured.deps = deps;
    }
    async start(): Promise<void> {
      if (control.startRejection !== null) throw control.startRejection;
    }
    async stop(): Promise<void> {}
    startListening(): void {}
    softPause(): void {}
    async hardPause(): Promise<void> {}
    async resume(): Promise<void> {}
    async switchMicrophone(): Promise<void> {}
    estimatedCostUsd(): number {
      return 0;
    }
  }
  return { captured, control, FakePipeline };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => stage);
vi.mock('../../../src/control/services/session-records', () => records);
vi.mock('../../../src/control/services/voice-session', () => ({
  VoiceSessionPipeline: pipeline.FakePipeline,
  COMMAND_TICK_INTERVAL_MS: 250,
}));
/*
 * A vi.mock of `services/semantic-sidecar` used to sit here.
 *
 * The OpenAI semantic sidecar was removed from the product; the module does
 * not exist. Nothing imports it, so the mock never applied and the factory
 * below it — a whole fake scheduler with token budgets and cost estimates —
 * was inert. It survived because a mock of a missing module is silent: vitest
 * only resolves the path if something asks for it. The repository completeness
 * gate (scripts/verify-repository.mjs) is what finally named it.
 */
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});

const { clearSession, startLiveSession } = await import(
  '../../../src/control/stores/session'
);
const { toasts, clearToasts } = await import('../../../src/control/stores/toasts');
const {
  KNOWN_ERROR_CODES,
  recentErrorDiagnostics,
  clearErrorDiagnostics,
  describeError,
  copyForErrorCode,
  hasErrorCopy,
  composeRecogniserCopy,
  scopeToTake,
  AUTO_SCROLL_KEY,
  RECOGNISER_COPY,
  RECOGNISER_CODES: AUTHORED_RECOGNISER_CODES,
  withoutTakeAdvice,
} = await import('../../../src/control/services/errors');
const { osCopy } = await import('../../../src/control/lib/os-copy');
const { resolveShortcut } = await import('../../../src/control/lib/shortcuts');
const { OFFERED_SESSION_MODES, SESSION_MODE_LABELS } = await import(
  '../../../src/shared/take-vocabulary'
);

/**
 * The shape a user must never see. Deliberately the same rule the production
 * scrubber uses, applied from the outside to the RENDERED string.
 */
const CODE_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/**
 * The six the on-device recogniser can raise. They share one property no other
 * copy in the file has: more than one surface, and only one of those has a take
 * open.
 *
 * `STT_MODEL_NOT_INSTALLED` reaches a third — `select_speech_language` refuses
 * an uninstalled language and `SpeechLanguagePicker` renders `describeError` in
 * an alert — which is asserted as a screen in `tests/dom/`.
 */
const RECOGNISER_CODES = [
  'STT_MODEL_NOT_INSTALLED',
  'STT_MODEL_MISSING',
  'STT_MODEL_LOAD_FAILED',
  'STT_MODEL_DAMAGED',
  'STT_WORKER_FAILED',
  'STT_ENGINE_ERROR',
] as const;

function compiledStub(): CompiledScript {
  return {
    sourceHash: 'hash-abc',
    sentences: [
      { id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 3, text: 'Hello there.' },
    ],
    navigationTargets: [],
    spokenTokens: [],
    literalCommandRanges: [],
  } as unknown as CompiledScript;
}

function start(): void {
  startLiveSession({
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'voice',
    displayLabel: 'Stage',
    outline: [],
    sentences: [],
    totalTokens: 200,
    sessionId: 'session-uuid-1',
    compiled: compiledStub(),
    sessionGeneration: 7,
  });
}

interface PipelineHooks {
  onSessionFailure?: (code: string, fatal: boolean) => void;
  onInputDeviceLost?: (code: string) => void;
}

function hooks(): PipelineHooks {
  expect(pipeline.captured.deps).not.toBeNull();
  return pipeline.captured.deps as unknown as PipelineHooks;
}

function toastMessages(): string[] {
  return get(toasts).map((t) => t.message);
}

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
  clearErrorDiagnostics();
  pipeline.captured.deps = null;
  pipeline.control.startRejection = null;
});

afterEach(() => {
  clearSession();
  clearToasts();
  vi.useRealTimers();
});

describe('a session-level failure toast is authored copy, not a code', () => {
  it('renders a broken speech model as advice, with no code anywhere in the toast', () => {
    start();
    hooks().onSessionFailure?.('STT_MODEL_MISSING', true);

    const [message] = toastMessages();
    expect(message).toBeDefined();
    // The shape of the literal string the operator used to see.
    expect(message).not.toContain('STT_MODEL_MISSING');
    expect(message).not.toMatch(CODE_TOKEN);
    // The toast carries the copy authored for the code. What that copy may and
    // must say is held further down, by rule rather than by wording: the
    // download as the remedy (#181), and the fallback that exists (#121).
    expect(message).toContain(copyForErrorCode('STT_MODEL_MISSING'));
  });

  it('gives a missing model, a microphone refusal and a network drop different advice', () => {
    start();
    hooks().onSessionFailure?.('STT_MODEL_MISSING', true);
    hooks().onSessionFailure?.('MIC_PERMISSION_DENIED', true);
    hooks().onSessionFailure?.('NETWORK_OFFLINE', true);

    const [model, mic, network] = toastMessages();
    expect(new Set([model, mic, network]).size).toBe(3);
    // Each carries the copy authored for its own code…
    expect(model).toContain(copyForErrorCode('STT_MODEL_MISSING'));
    expect(mic).toContain(copyForErrorCode('MIC_PERMISSION_DENIED'));
    expect(network).toContain(copyForErrorCode('NETWORK_OFFLINE'));
    // …and not the model's repair: a model download cannot grant a microphone
    // permission or mend a connection.
    const modelRepair = RECOGNISER_COPY.STT_MODEL_MISSING.repair;
    expect(mic).not.toContain(modelRepair);
    expect(network).not.toContain(modelRepair);
    // Kept from before #181, which swapped the positive assertion above from
    // reinstall to download: a reinstall is no more able to grant a permission
    // or mend a connection than it is to restore a model, and dropping these
    // would have let that advice reappear on the two codes the model-state ban
    // below deliberately does not cover.
    expect(mic).not.toMatch(/\breinstall/i);
    expect(network).not.toMatch(/\breinstall/i);
  });

  it('distinguishes a stopped session from an interrupted one', () => {
    // The same failure, fatal and then not: the two notices must not read the
    // same, and both still carry the authored copy rather than the code.
    start();
    hooks().onSessionFailure?.('REALTIME_CONNECTION_LOST', true);
    const [stopped] = toastMessages();
    clearSession();
    clearToasts();
    start();
    hooks().onSessionFailure?.('REALTIME_CONNECTION_LOST', false);
    const [interrupted] = toastMessages();

    expect(stopped).toBeDefined();
    expect(interrupted).toBeDefined();
    expect(interrupted).not.toBe(stopped);
    for (const message of [stopped, interrupted]) {
      expect(message).toContain(copyForErrorCode('REALTIME_CONNECTION_LOST'));
      expect(message).not.toMatch(CODE_TOKEN);
    }
  });

  it('keeps the raw code for Settings → Diagnostics', () => {
    start();
    hooks().onSessionFailure?.('STT_MODEL_MISSING', true);

    const entries = recentErrorDiagnostics();
    expect(entries[0]?.code).toBe('STT_MODEL_MISSING');
    // The copy recorded next to it is the copy that was shown.
    expect(toastMessages()[0]).toContain(entries[0]?.shown ?? ' ');
  });
});

describe('no code can reach a user-visible string', () => {
  it('renders every known code as copy through the live session path', () => {
    for (const code of KNOWN_ERROR_CODES) {
      clearToasts();
      start();
      hooks().onSessionFailure?.(code, true);
      hooks().onSessionFailure?.(code, false);
      hooks().onInputDeviceLost?.(code);
      for (const message of toastMessages()) {
        expect(message, `code ${code} leaked into a toast: ${message}`).not.toMatch(CODE_TOKEN);
        expect(message).not.toContain(code);
      }
      clearSession();
    }
  });

  it('does not leak a code nobody has written copy for yet', () => {
    start();
    // Stands in for the next code added to APP_ERROR_CODES without copy.
    hooks().onSessionFailure?.('SOME_FUTURE_PROVIDER_FAULT', true);

    const [message] = toastMessages();
    expect(message).not.toContain('SOME_FUTURE_PROVIDER_FAULT');
    expect(message).not.toMatch(CODE_TOKEN);
    // The honest unmapped sentence, and the code kept where Diagnostics reads it.
    expect(message).toContain(copyForErrorCode('SOME_FUTURE_PROVIDER_FAULT'));
    expect(recentErrorDiagnostics()[0]?.code).toBe('SOME_FUTURE_PROVIDER_FAULT');
  });

  it('does not leak a code thrown as an Error message by audio acquisition', async () => {
    // `voice-session.acquireMicrophone` does `throw new Error(result.code)` —
    // the message IS a code, and it lands in the start-failure toast.
    pipeline.control.startRejection = new Error('MIC_PERMISSION_DENIED');
    start();
    // The rejection is a microtask, not a timer; the store owns recurring
    // intervals so draining every timer would never terminate.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // A refusal has its own notice now (#303), with the pane on it; the code
    // must stay out of that one just the same.
    const notice = get(toasts).find((t) => t.message === osCopy().micRefusedToast);
    expect(notice, 'the microphone refusal notice was not shown').toBeDefined();
    expect(notice?.message).not.toContain('MIC_PERMISSION_DENIED');
    expect(notice?.message).not.toMatch(CODE_TOKEN);
    // …and it carries the way to the pane, not just a description of it.
    expect(notice?.action?.label).toBe(osCopy().openMicrophoneSettings);
  });

  it('does not leak a code carried on a RealtimeTransportError', () => {
    // `RealtimeTransportError` puts developer prose in `message` and the real
    // code in `.code`; the prose is not user copy either.
    const err = Object.assign(new Error('No live audio track'), { code: 'MIC_DEVICE_MISSING' });
    const shown = describeError(err);
    expect(shown).not.toMatch(CODE_TOKEN);
    expect(shown).not.toBe('No live audio track');
    expect(shown).toBe(copyForErrorCode('MIC_DEVICE_MISSING'));
  });
});

/**
 * #121 — copy must not offer a session mode nobody can choose.
 *
 * All the recogniser errors used to end "Manual and fixed-speed modes still
 * work." Nothing in Settings offered either mode, so a presenter whose
 * recogniser had just died was sent hunting for a menu item that was not there.
 *
 * Which modes are offered is read from `OFFERED_SESSION_MODES`, the constant
 * Settings itself branches on, rather than parsed out of the route's markup or
 * its prose: the day a mode ships, adding it there lifts its ban here, and
 * rewording the Settings readout touches nothing in this file.
 */
describe('error copy never offers a session mode that is not offered', () => {
  /**
   * The spellings of each mode, deliberately broader than its label.
   *
   * `manual` is matched as a bare word: the sentence this exists to forbid read
   * "Manual **and** fixed-speed modes", where "manual" is never followed by
   * "mode" at all. It does not match "manually". `fixed` tolerates any run of
   * spaces or dashes, U+2010–U+2015 included, and is NOT broadened to "fixed
   * pace": auto-scroll genuinely is a fixed pace, and it is the fallback the
   * copy has to be free to describe. The glossary labels are not banned:
   * "Roll at pace" also names the auto-scroll movement, which copy may offer.
   */
  const SPELLINGS: Record<string, RegExp[]> = {
    manual: [/\bmanual\b/i],
    // The class is \s, the range U+2010–U+2015, and a trailing ASCII hyphen.
    fixed: [/\bfixed[\s‐-―-]+speed\b/iu],
  };
  const bansFor = (mode: string): RegExp[] => SPELLINGS[mode] ?? [];
  const unoffered = Object.keys(SESSION_MODE_LABELS).filter(
    (mode) => !(OFFERED_SESSION_MODES as readonly string[]).includes(mode),
  );

  it('bans every spelling of the mode names, and nothing legitimate', () => {
    // The bans are the whole guard, so they get asserted rather than assumed.
    for (const spelling of [
      'Manual and fixed-speed modes still work.',
      'manual mode still works',
      'Use Manual instead.',
    ]) {
      expect(bansFor('manual').some((ban) => ban.test(spelling)), spelling).toBe(true);
    }
    for (const spelling of ['fixed-speed', 'fixed speed', 'Fixed Speed', 'fixed‑speed', 'fixed–speed']) {
      expect(bansFor('fixed').some((ban) => ban.test(spelling)), spelling).toBe(true);
    }
    // Auto-scroll IS a fixed pace, "manually" is a different word, and a
    // problem can be fixed. Banning any of those would forbid copy that is true.
    for (const honest of [
      'rolls the script at a fixed pace',
      'scroll the script manually',
      'Try again once the network problem is fixed.',
      'In a take, press A to start auto-scroll and roll at pace.',
    ]) {
      for (const mode of ['manual', 'fixed']) {
        expect(bansFor(mode).some((ban) => ban.test(honest)), honest).toBe(false);
      }
    }
  });

  it('knows which modes are not offered', () => {
    // Anti-vacuity: with every mode offered the sweep below checks nothing,
    // which is right the day it happens and worth a look until then.
    expect(OFFERED_SESSION_MODES.length).toBeGreaterThan(0);
    // Every mode still to be shipped has a way of being spelled to ban.
    for (const mode of unoffered) {
      expect(bansFor(mode).length, `no spelling of '${mode}' is banned`).toBeGreaterThan(0);
    }
  });

  it('does not name a mode that cannot start a take', () => {
    // The honest fallback for a code nobody wrote copy for is shown too.
    const shown = [...KNOWN_ERROR_CODES, 'SOME_FUTURE_PROVIDER_FAULT'];
    for (const mode of unoffered) {
      for (const code of shown) {
        const copy = copyForErrorCode(code);
        for (const ban of bansFor(mode)) {
          expect(copy, `${code} offers '${mode}', which nothing offers: ${copy}`).not.toMatch(ban);
        }
      }
    }
  });
});

/**
 * #121 again, one surface further out: copy must not imply an action that does
 * not exist WHERE IT IS READ.
 *
 * The recogniser failures name auto-scroll as the fallback, which is only true
 * with a take open — and these strings have readers with none: Settings → Audio
 * renders the microphone test's `describeError` output, and the language picker
 * renders `STT_MODEL_NOT_INSTALLED`'s. That is why they are built from parts in
 * `errors.ts`: the take-only fallback lives in `inTake`, and `scopeToTake` is
 * the one place that says it is about a take. These hold that structure, not
 * any wording of it.
 */
describe('recogniser copy stays true on the surface with no take', () => {
  const voiceLiveSource = readFileSync(
    new URL('../../../src/control/services/voice-live.ts', import.meta.url),
    'utf8',
  );

  /** Advice that only exists while a take is running. */
  const TAKE_ONLY = new RegExp(
    `\\bauto-?scroll|\\b(?:scroll|roll)(?:s|ing)?\\b|` +
      `\\b(?:press|tap|hit|use|hold) (?:the )?${AUTO_SCROLL_KEY}\\b|\\b(?:the|a|your) take\\b`,
    'i',
  );

  it('covers every recogniser code', () => {
    expect([...AUTHORED_RECOGNISER_CODES].sort()).toEqual([...RECOGNISER_CODES].sort());
  });

  it('still has a reader with no take — the Settings → Audio microphone test', () => {
    /*
     * Anti-vacuity: the scoping below earns its keep while that surface exists.
     * The day the mic test stops rendering `describeError` output, this fails
     * and someone decides whether the scope is still needed.
     */
    expect(voiceLiveSource, 'the mic test no longer routes failures through describeError').toMatch(
      /events\.onError\(describeError\(/,
    );
    // And Settings shows that failure with the take's advice taken out.
    const settings = readFileSync(
      new URL('../../../src/control/routes/Settings.svelte', import.meta.url),
      'utf8',
    );
    expect(settings, 'Settings must strip take advice from the mic-test error').toMatch(
      /withoutTakeAdvice\(micTestError\)/,
    );
    expect(settings, 'and show only the stripped text').not.toMatch(/text: micTestError\b/);
  });

  it('is the composition of its parts', () => {
    for (const code of RECOGNISER_CODES) {
      expect(copyForErrorCode(code)).toBe(composeRecogniserCopy(RECOGNISER_COPY[code]));
    }
  });

  it('scopes the take-only clause, and only that clause', () => {
    // The composer keeps the clause and says it is about a take.
    const scoped = scopeToTake('clause');
    expect(scoped).toContain('clause');
    const scope = scoped.slice(0, scoped.indexOf('clause'));
    expect(scope, 'the scope must name the take').toMatch(/\btake\b/i);
    // …in the same sentence as the clause, not as a sentence of its own.
    expect(scope, 'the scope is a separate sentence').not.toMatch(/[.!?]/);
    expect(TAKE_ONLY.test('Tap A to keep the script rolling.')).toBe(true);

    for (const code of RECOGNISER_CODES) {
      const { fault, inTake } = RECOGNISER_COPY[code];
      const repair = (RECOGNISER_COPY[code] as { repair?: string }).repair ?? '';
      expect(fault.trim(), `${code} says nothing about what happened`).not.toBe('');
      // The parts read on every surface name nothing a take alone has.
      expect(fault, `${code}'s diagnosis assumes a take`).not.toMatch(TAKE_ONLY);
      expect(repair, `${code}'s repair assumes a take`).not.toMatch(TAKE_ONLY);
      // The scoped clause is where that advice goes, and the copy opens with
      // the fault rather than with a condition.
      expect(inTake.trim(), `${code} offers no fallback in a take`).not.toBe('');
      expect(copyForErrorCode(code).startsWith(fault), `${code} opens with a condition`).toBe(true);
    }
  });

  it('leaves the take out where there is no take', () => {
    // Settings' microphone test shows the fault and the repair, without the
    // fallback a take alone has.
    for (const code of RECOGNISER_CODES) {
      const { fault } = RECOGNISER_COPY[code];
      const repair = (RECOGNISER_COPY[code] as { repair?: string }).repair;
      const shown = withoutTakeAdvice(copyForErrorCode(code));
      // Exactly the fault and the repair: nothing of the clause left behind,
      // nothing of the rest taken with it.
      expect(shown, code).toBe([fault, repair].filter((part) => part !== undefined).join(' '));
      expect(shown, `${code} still offers take-only advice with no take`).not.toMatch(TAKE_ONLY);
    }
    // …including when the test puts its own sentence in front of the copy.
    const prefixed = `The transcription test could not start. ${copyForErrorCode('STT_ENGINE_ERROR')}`;
    expect(withoutTakeAdvice(prefixed)).not.toMatch(TAKE_ONLY);
    expect(withoutTakeAdvice(prefixed)).toBe(
      `The transcription test could not start. ${RECOGNISER_COPY.STT_ENGINE_ERROR.fault}`,
    );
    // Any other copy passes through untouched.
    expect(withoutTakeAdvice(copyForErrorCode('NETWORK_OFFLINE'))).toBe(
      copyForErrorCode('NETWORK_OFFLINE'),
    );
  });

  it('points the take at auto-scroll, on the key that works it', () => {
    // `shortcuts.test.ts` asserts the transport keys independently; this holds
    // the copy's key to the same table.
    expect(
      resolveShortcut({
        key: AUTO_SCROLL_KEY.toLowerCase(),
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        typing: false,
        isMac: true,
      }),
    ).toBe('toggle-auto-scroll');
    for (const code of RECOGNISER_CODES) {
      const { inTake } = RECOGNISER_COPY[code];
      expect(inTake, `${code} does not name auto-scroll`).toMatch(/auto-scroll/i);
      expect(inTake, `${code} does not name the key`).toMatch(new RegExp(`\\b${AUTO_SCROLL_KEY}\\b`));
    }
  });
});

/**
 * §181 — the remedy for a model that is not on the machine is the download,
 * and the app has to say so itself.
 *
 * Two failures, one cause. The weights left the bundle in §152 and nothing in
 * this file was told:
 *
 *  - `STT_MODEL_NOT_INSTALLED` had no copy at all. That did not read as
 *    obviously broken, which is exactly what made it worth a test: Rust writes
 *    a decent `userMessage` and `describeError` falls back to it, so the
 *    presenter saw a reasonable sentence BY ACCIDENT. Reasonable-by-accident is
 *    outside every rule this file enforces — the take-scoping, the banned
 *    modes, the no-code sweep — and one edit on the Rust side away from not
 *    being reasonable at all. The first test below therefore fails if the entry
 *    is removed even though `describeError` would still emit sensible prose.
 *
 *  - `STT_MODEL_MISSING` and `STT_MODEL_LOAD_FAILED` told the reader to
 *    reinstall Speaking Glass. The model lives in the app-data directory now, so a
 *    reinstall leaves it byte for byte where it was: an instruction that cannot
 *    work, which is the same class of defect as naming a mode Settings marks
 *    unavailable.
 */
describe('the model download is the remedy, not a reinstall', () => {
  /**
   * The four raised while working out whether this machine has usable weights.
   * A download is their remedy because their fault is the model's residence.
   */
  const MODEL_STATE_CODES = [
    'STT_MODEL_NOT_INSTALLED',
    'STT_MODEL_MISSING',
    'STT_MODEL_LOAD_FAILED',
    // A damaged download (#258). Its remedy is the download for the same reason
    // as the other three: the fault is in the model's files, not the app.
    'STT_MODEL_DAMAGED',
  ] as const;

  /**
   * The two raised with a model already loaded. Their fault is in app code, so
   * a download would fix nothing and is not asked of them.
   */
  const RUNTIME_RECOGNISER_CODES = ['STT_WORKER_FAILED', 'STT_ENGINE_ERROR'] as const;

  /**
   * Advice to install the APPLICATION again, however it is spelled.
   *
   * Deliberately not a bare `/reinstall/i`. The dash class covers U+2010–U+2015
   * and U+2011 so the phrase cannot slip through on a hyphen nobody typed on
   * purpose, and the second branch catches the same instruction written as two
   * words — "install Speaking Glass again", "try installing the app again" — which a
   * narrower pattern would have waved past.
   */
  const REINSTALL_ADVICE =
    /\bre[\s‐-―‑-]?install|\binstall(?:ing)?\s+(?:Speaking Glass|the app|it)\s+again\b/iu;

  /** What Rust puts on the `AppError`, at both raise sites, verbatim. */
  const BACKEND_MESSAGES = [
    // `speech/mod.rs::not_installed`, reached through `ensure_loaded`.
    'The speech model has not been downloaded yet. Open Settings › Speech to install it.',
    // `speech_cmds.rs::select_speech_language`, refusing an uninstalled language.
    'Download this language before switching to it.',
  ];

  it('authors the copy for a model that is not installed, rather than borrowing Rust’s', () => {
    expect(hasErrorCopy('STT_MODEL_NOT_INSTALLED')).toBe(true);

    for (const userMessage of BACKEND_MESSAGES) {
      const shown = describeError({ code: 'STT_MODEL_NOT_INSTALLED', userMessage });
      // The assertion that carries the issue: both backend sentences are
      // perfectly readable, so passing one through would look fine on screen
      // and still mean this file had no say in it.
      expect(shown, 'the backend message reached the user unedited').not.toBe(userMessage);
      expect(shown).toBe(copyForErrorCode('STT_MODEL_NOT_INSTALLED'));
    }
  });

  it('never sends a presenter to reinstall the app for a model that is not in it', () => {
    /*
     * Scoped to the three, NOT to all five, and the line matters.
     *
     * The claim being enforced is narrow: the weights live outside the
     * application bundle, so reinstalling the app cannot put them there and no
     * sentence about the model's RESIDENCE can honestly say otherwise.
     * `STT_WORKER_FAILED` and `STT_ENGINE_ERROR` are faults in app code with a
     * model already loaded — if reinstalling ever becomes the right advice for
     * those, it will be true advice, and a ban that swept them up would forbid
     * it for no reason. `REALTIME_CONFIG_REJECTED` and the update failures are
     * outside this block for the same reason, and still say "reinstall".
     */
    for (const code of MODEL_STATE_CODES) {
      const copy = copyForErrorCode(code);
      expect(
        copy,
        `${code} tells the reader to reinstall an app the model is not in: ${copy}`,
      ).not.toMatch(REINSTALL_ADVICE);
    }
  });

  it('recognises the ways that advice can be spelled, and nothing legitimate', () => {
    // The detector is the guard, so it is asserted rather than assumed — the
    // same standard the session-mode bans above are held to. The left column is
    // the clause this issue removed plus the ways it could come back.
    for (const spelling of [
      'Reinstall Speaking Glass to restore voice following.',
      'Restart Speaking Glass, and reinstall it if this keeps happening.',
      're-install Speaking Glass',
      // U+2011, which a word processor introduces without anyone deciding to.
      're‑install Speaking Glass',
      'Install Speaking Glass again to fix it.',
      'Try installing the app again.',
    ]) {
      expect(spelling, `'${spelling}' should trip the reinstall ban`).toMatch(REINSTALL_ADVICE);
    }
    // Downloading the model again is the remedy this issue put in, and it must
    // not read as the advice being banned. Nor may the bare word "installed",
    // which is how the copy states the fault in the first place.
    for (const spelling of [
      'Download the model again in Settings → Speech.',
      'The speech model for the requested language is not installed.',
      'Restart Speaking Glass to bring it back.',
    ]) {
      expect(spelling, `'${spelling}' is honest copy and should pass`).not.toMatch(
        REINSTALL_ADVICE,
      );
    }
  });

  it('points every model-state failure at the download that can fix it', () => {
    // The repair, which is the part read on every surface, offers the download
    // and names the Speech pane it lives in — in whatever words.
    for (const code of MODEL_STATE_CODES) {
      const repair = (RECOGNISER_COPY[code] as { repair?: string }).repair ?? '';
      expect(repair, `${code} does not offer the download`).toMatch(/download/i);
      expect(repair, `${code} does not name the pane the download is in`).toMatch(/\bSpeech\b/);
    }
  });

  it('classifies every recogniser code, so a new one cannot slip past these rules', () => {
    /*
     * Anti-drift, in the spirit of the availability check above. A sixth
     * `STT_*` code added to `ERROR_COPY` lands in `RECOGNISER_CODES` and
     * inherits the take-scoping guards, but it would silently sit outside both
     * groups here — neither required to name the download nor barred from
     * recommending a reinstall. Forcing the split to be exhaustive means adding
     * a code is a decision about which kind of failure it is.
     */
    expect([...MODEL_STATE_CODES, ...RUNTIME_RECOGNISER_CODES].sort()).toEqual(
      [...RECOGNISER_CODES].sort(),
    );
  });

  it('keeps “no usable model” and “files not found” distinguishable', () => {
    // Different conditions, different sentences: one machine has no usable
    // model, the other resolved a directory and could not find the files in it.
    // Collapsing them into one string is the defect the file header names.
    expect(copyForErrorCode('STT_MODEL_NOT_INSTALLED')).not.toBe(
      copyForErrorCode('STT_MODEL_MISSING'),
    );
    expect(RECOGNISER_COPY.STT_MODEL_NOT_INSTALLED.fault).not.toBe(
      RECOGNISER_COPY.STT_MODEL_MISSING.fault,
    );
  });
});

/**
 * #261 — a refused model address used to blame the release. The url is compiled
 * in, and the fake-IP and NAT64 answers ordinary networks give it are accepted
 * now, so what usually trips this is the network pointing the name somewhere
 * private: that is the remedy the copy has to offer. It names no single cause,
 * because a broken redirect chain is refused under the same code.
 */
describe('a refused model address points at the network, not the release', () => {
  it('advises on the network and never blames the release', () => {
    const copy = copyForErrorCode('STT_MODEL_URL_BLOCKED');
    expect(hasErrorCopy('STT_MODEL_URL_BLOCKED')).toBe(true);
    // The fault is the network's answer, not the build: the copy must not send
    // the reader to wait for a new release.
    expect(copy).not.toMatch(/release/i);
    expect(copy).not.toMatch(CODE_TOKEN);
    expect(describeError({ code: 'STT_MODEL_URL_BLOCKED', userMessage: 'x' })).toBe(copy);
  });
});

/**
 * #264 — Settings' transcription test is refused while a take holds the
 * recogniser. It is a refusal with a remedy, not a recogniser failure, so it
 * names what was blocked and what to do rather than borrowing the failure copy.
 */
describe('a transcription test refused during a take says why and what to do', () => {
  it('names the take and the remedy', () => {
    // A refusal with a remedy, authored here rather than borrowed from the
    // recogniser failures.
    const copy = copyForErrorCode('STT_TEST_BLOCKED_BY_TAKE');
    expect(hasErrorCopy('STT_TEST_BLOCKED_BY_TAKE')).toBe(true);
    for (const code of RECOGNISER_CODES) expect(copy).not.toBe(copyForErrorCode(code));
    expect(copy).not.toMatch(CODE_TOKEN);
    expect(describeError({ code: 'STT_TEST_BLOCKED_BY_TAKE', userMessage: 'x' })).toBe(copy);
  });
});
