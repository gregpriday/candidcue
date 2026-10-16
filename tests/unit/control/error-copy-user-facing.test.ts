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
} = await import('../../../src/control/services/errors');

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
    expect(message).toContain('Voice following stopped.');
    // What happened, and what to do about it. The recogniser runs on this
    // machine, so the remedy is the model download — never an account, a key
    // or a dashboard.
    expect(message).toMatch(/speech model/i);
    // Not `/download|manual mode/`: "manual mode" is a banned phrase now (see
    // the Settings-guarded sweep below), so accepting it as an alternative here
    // would have let the very copy that test forbids satisfy this one.
    //
    // This asserted `/reinstall/i` until #181. The model moved out of the
    // bundle in §152, so a reinstall leaves it exactly as it was and the old
    // copy sent the reader somewhere that could not help them; the remedy that
    // does work is the download, and the screen it is on is named in full for
    // the same reason the Diagnostics path is below.
    expect(message).toMatch(/download/i);
    expect(message).toMatch(/Settings → Speech/);
    // The fallback it points at has to be one that exists.
    expect(message).toMatch(/auto-scroll/i);
  });

  it('gives a missing model, a microphone refusal and a network drop different advice', () => {
    start();
    hooks().onSessionFailure?.('STT_MODEL_MISSING', true);
    hooks().onSessionFailure?.('MIC_PERMISSION_DENIED', true);
    hooks().onSessionFailure?.('NETWORK_OFFLINE', true);

    const [model, mic, network] = toastMessages();
    expect(new Set([model, mic, network]).size).toBe(3);
    // Each names the remedy that actually applies to it.
    expect(model).toMatch(/Settings → Speech/);
    expect(mic).toMatch(/System Settings|Privacy/i);
    expect(network).toMatch(/internet connection/i);
    // …and not one that does not: a model download cannot grant a microphone
    // permission, and a privacy toggle cannot restore a missing model.
    expect(mic).not.toMatch(/Settings → Speech/);
    expect(network).not.toMatch(/Settings → Speech/);
    // Kept from before #181, which swapped the positive assertion above from
    // reinstall to download: a reinstall is no more able to grant a permission
    // or mend a connection than it is to restore a model, and dropping these
    // would have let that advice reappear on the two codes the model-state ban
    // below deliberately does not cover.
    expect(mic).not.toMatch(/\breinstall/i);
    expect(network).not.toMatch(/\breinstall/i);
  });

  it('distinguishes a stopped session from an interrupted one', () => {
    start();
    hooks().onSessionFailure?.('REALTIME_CONNECTION_LOST', false);
    expect(toastMessages()[0]).toContain('Voice following interrupted.');
    expect(toastMessages()[0]).not.toMatch(CODE_TOKEN);
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
    /*
     * Honest plain English that points at where the code can be read — and at
     * a place that EXISTS. The copy used to say "Settings → Diagnostics",
     * which is not a section: Diagnostics is a card inside "Data, privacy &
     * updates". Being sent to a screen you cannot find is worse than being
     * told nothing, so the path is asserted in full rather than by fragment.
     */
    expect(message).toMatch(/Settings → Data, privacy & updates → Diagnostics/);
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

    const message = toastMessages().find((m) => m.includes('Voice tracking is unavailable.'));
    expect(message).toBeDefined();
    expect(message).not.toContain('MIC_PERMISSION_DENIED');
    expect(message).not.toMatch(CODE_TOKEN);
    expect(message).toMatch(/System Settings/);
  });

  it('does not leak a code carried on a RealtimeTransportError', () => {
    // `RealtimeTransportError` puts developer prose in `message` and the real
    // code in `.code`; the prose is not user copy either.
    const err = Object.assign(new Error('No live audio track'), { code: 'MIC_DEVICE_MISSING' });
    const shown = describeError(err);
    expect(shown).not.toMatch(CODE_TOKEN);
    expect(shown).not.toBe('No live audio track');
    expect(shown).toMatch(/No microphone was found/);
  });
});

/**
 * The other half of the rule in `errors.ts`'s header: copy must not imply an
 * action that does not exist.
 *
 * All four recogniser errors used to end "Manual and fixed-speed modes still
 * work." Settings renders both of those as disabled — "not available in this
 * release" — so a presenter whose recogniser had just died was sent hunting
 * for a greyed-out menu item and left with nothing.
 *
 * This reads Settings as the source of truth rather than hard-coding the ban,
 * so the day either mode actually ships, its `disabled: true` goes away and
 * the ban retires itself instead of blocking the copy that would then be true.
 */
describe('error copy never offers a session mode Settings marks unavailable', () => {
  const settingsSource = readFileSync(
    new URL('../../../src/control/routes/Settings.svelte', import.meta.url),
    'utf8',
  );

  /**
   * The session-mode CHOOSER, if Settings still offers one.
   *
   * It did until #124. Two of its three options were permanently
   * `disabled: true`, which is a dropdown that answers "there was never
   * anything to decide" — so it became a static readout, and this parse had to
   * follow it.
   *
   * Both shapes are still read, and that is the point rather than tidiness:
   * the day a mode genuinely ships, the natural change is a Select coming back
   * with it enabled, and this guard must retire itself then WITHOUT anybody
   * remembering that a test in another directory encodes the rule.
   */
  const selectMatch = settingsSource.match(
    /label="(?:Default session mode|Session mode)"[\s\S]*?options=\{\[([\s\S]*?)\]\}/,
  );

  /** Each `{ value: 'manual' … }` / `{ value: 'fixed' … }` object, body included. */
  const selectOptions = [
    ...(selectMatch?.[1] ?? '').matchAll(/\{([^{}]*\bvalue:\s*'(manual|fixed)'[^{}]*)\}/g),
  ].map((m) => ({ body: m[1] ?? '', mode: m[2] ?? '' }));

  /**
   * The readout that replaced it, and the sentence carrying the same fact.
   *
   * Anchored on the sentence rather than on the component name because the
   * sentence is the claim: while Settings tells the reader these modes are not
   * offered, error copy must not send them looking for one.
   */
  const readoutSaysUnavailable =
    /manual and fixed-speed modes are not offered/i.test(settingsSource);

  /** Each mode, and whether Settings currently marks it unavailable. */
  const modeOptions = selectOptions.length > 0 ? selectOptions : [{ body: '', mode: 'manual' }, { body: '', mode: 'fixed' }];

  /**
   * A phrase per mode, deliberately broader than the label.
   *
   * `manual` is matched as a bare word on purpose: the sentence this test
   * exists to forbid read "Manual **and** fixed-speed modes", where "manual"
   * is never followed by "mode" at all — a narrower /manual mode/ would have
   * sailed straight past the actual bug. It does not match "manually", which
   * has no word boundary after the l.
   *
   * `fixed` tolerates any run of spaces or dashes, U+2010–U+2015 included, so
   * the phrase cannot slip through on an en dash a word processor introduced.
   * It is deliberately NOT broadened to "fixed pace" or "constant speed": the
   * auto-scroll transport genuinely IS a fixed pace, and banning that would
   * forbid the copy from describing the very fallback this issue added.
   */
  const BANNED = {
    manual: /\bmanual\b/i,
    // The class is \s, the range U+2010–U+2015, and a trailing ASCII hyphen.
    // Those dashes are indistinguishable by eye, so the range is asserted
    // directly below rather than trusted to survive a reformat.
    fixed: /\bfixed[\s‐-―-]+speed\b/iu,
  } satisfies Record<string, RegExp>;

  /**
   * Availability, read rather than assumed.
   *
   * `readable` is the anti-vacuity check. A ban that quietly stops applying is
   * worse than no ban, so the only states this test accepts are the two it can
   * actually interpret: exactly one `disabled: true`/`false`, or no `disabled`
   * key at all (which means enabled). Anything else — `disabled: !someFlag`,
   * the shorthand `disabled`, a computed value — is a state we cannot read,
   * and the self-check below fails rather than guessing.
   *
   * Two ways this could have lapsed silently, both closed here:
   *
   *  - Mentions are COUNTED, not just tested. `.match` returns the first hit,
   *    so a second mention of the word — an explanatory comment reading
   *    "disabled: false once it ships", sitting ahead of the real
   *    `disabled: true` — would otherwise be taken as the answer.
   *  - The literal must run to the property delimiter. Without that,
   *    `disabled: false || !modesShipped` reads as a literal `false` and lifts
   *    the ban while the option is disabled at runtime.
   *
   * That keeps the guard self-retiring in the way the issue asked for: flip
   * either option to `disabled: false`, or drop the key when the mode really
   * ships, and its ban lifts on its own with no test to edit.
   */
  const availability = modeOptions.map((o) => {
    /*
     * With no Select on the screen, the readout's sentence IS the statement of
     * availability, and it speaks for both modes at once. `readable` still
     * means "we could tell either way": if neither a parseable Select nor that
     * sentence is present, we cannot, and the self-check below fails rather
     * than letting a ban lapse silently.
     */
    if (selectOptions.length === 0) {
      return { mode: o.mode, disabled: readoutSaysUnavailable, readable: readoutSaysUnavailable };
    }
    // `\s*(?=,|$)` is the load-bearing part: the boolean has to BE the value,
    // not merely start it.
    const literal = o.body.match(/\bdisabled:\s*(true|false)\s*(?=,|$)/);
    const mentions = o.body.match(/\bdisabled\b/g)?.length ?? 0;
    // A spread could carry a `disabled` this never sees.
    const spread = o.body.includes('...');
    return {
      mode: o.mode,
      disabled: literal?.[1] === 'true',
      readable: !spread && (mentions === 0 || (mentions === 1 && literal !== null)),
    };
  });

  it('bans every spelling of the mode names, and nothing legitimate', () => {
    // The bans are the whole guard, so they get asserted rather than assumed.
    for (const spelling of [
      'Manual and fixed-speed modes still work.',
      'manual mode still works',
      'Use Manual instead.',
    ]) {
      expect(spelling, `'${spelling}' should trip the manual ban`).toMatch(BANNED.manual);
    }
    for (const spelling of ['fixed-speed', 'fixed speed', 'Fixed Speed', 'fixed‑speed', 'fixed–speed']) {
      expect(spelling, `'${spelling}' should trip the fixed ban`).toMatch(BANNED.fixed);
    }
    // Auto-scroll IS a fixed pace, and "manually" is a different word. Banning
    // either would forbid copy that is true.
    expect('rolls the script at a fixed pace').not.toMatch(BANNED.fixed);
    expect('scroll the script manually').not.toMatch(BANNED.manual);
  });

  it('can still read both session modes out of Settings', () => {
    // Either shape is fine; being unable to read EITHER is not, because then
    // the ban below stops applying without anybody deciding that it should.
    expect(
      selectMatch !== null || readoutSaysUnavailable,
      'Settings no longer states session-mode availability in a shape this can read',
    ).toBe(true);
    expect(modeOptions.map((o) => o.mode).sort()).toEqual(['fixed', 'manual']);
    // Not "both are disabled" — that would have to be edited the day one ships.
    // Only "we could tell either way", which stays true forever.
    expect(
      availability.filter((a) => !a.readable).map((a) => a.mode),
      'a session-mode option no longer states its availability as a literal',
    ).toEqual([]);
  });

  it('does not name a mode that cannot start a take', () => {
    // Vacuous by design once both modes ship — at which point the copy is free
    // to name them again, which is the whole point of reading Settings.
    for (const { mode, disabled } of availability) {
      if (!disabled) continue;
      for (const code of KNOWN_ERROR_CODES) {
        const copy = copyForErrorCode(code);
        expect(
          copy,
          `${code} offers '${mode}', which Settings marks unavailable: ${copy}`,
        ).not.toMatch(BANNED[mode as keyof typeof BANNED]);
      }
    }
  });

  it('points the recogniser failures at auto-scroll, which does exist', () => {
    // The replacement is only an improvement if it names the real fallback and
    // the key that starts it (`a` → 'toggle-auto-scroll' in lib/shortcuts.ts).
    for (const code of RECOGNISER_CODES) {
      const copy = copyForErrorCode(code);
      expect(copy, `${code} does not name auto-scroll`).toMatch(/auto-scroll/i);
      // Loose enough not to police the sentence around it; `shortcuts.test.ts`
      // asserts that this key still reaches the transport.
      expect(copy, `${code} does not name the key that works it`).toMatch(
        /\bpress (?:the )?A\b/i,
      );
    }
  });
});

/**
 * The same rule again, one surface further out: copy must not imply an action
 * that does not exist WHERE IT IS READ.
 *
 * Pointing the recogniser failures at auto-scroll is only true with a take
 * open, and these five strings have a second reader who has none — with
 * `STT_MODEL_NOT_INSTALLED` reaching a third, the language picker, which
 * `tests/dom/speech-language-picker.test.ts` asserts as a screen.
 * `voice-live.ts` hands `describeError(...)` to `events.onError` on both the
 * `startTranscription()` rejection and every `failed` frame; `MicTestSession`
 * keeps it as `snapshot.error`; Settings → Audio renders it verbatim. That is
 * the microphone test, where `toggleAutoScroll()` returns early on
 * `!state.active` and `A` is just a letter — so "Press A to start or stop
 * auto-scroll. Reinstall CandidCue after the take." is exactly the defect
 * gregpriday/candidcue#121 is about, relocated rather than fixed.
 *
 * The fix is a conditional: a sentence that names a take-only affordance has to
 * SAY it is about a take. Then it is true in the toast and true in Settings.
 */
describe('recogniser copy stays true on the surface with no take', () => {
  const settingsSource = readFileSync(
    new URL('../../../src/control/routes/Settings.svelte', import.meta.url),
    'utf8',
  );
  const voiceLiveSource = readFileSync(
    new URL('../../../src/control/services/voice-live.ts', import.meta.url),
    'utf8',
  );

  /** Affordances that only exist while a take is running. */
  const TAKE_ONLY = /\bauto-scroll\b|\bpress (?:the )?A\b|\b(?:the|a|your) take\b/i;
  /** The scope that makes naming one of them honest anywhere. */
  const SCOPED = /^In a take[,:]/;

  const sentences = (copy: string): string[] =>
    copy
      .split(/(?<=\.)\s+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');

  const unscoped = (copy: string): string[] =>
    sentences(copy).filter((s) => TAKE_ONLY.test(s) && !SCOPED.test(s));

  it('still has a reader with no take — the Settings → Audio microphone test', () => {
    /*
     * Anti-vacuity, in the spirit of the availability check above: this ban
     * only earns its keep while that second surface exists. Asserting the wiring
     * means the day the mic test stops rendering `describeError` output, this
     * fails loudly and someone decides whether the scope is still needed —
     * rather than the ban quietly guarding nothing.
     */
    expect(voiceLiveSource, 'the mic test no longer routes failures through describeError').toMatch(
      /events\.onError\(describeError\(/,
    );
    expect(settingsSource, 'Settings no longer describes mic-test errors with describeError').toMatch(
      /describe:\s*describeError/,
    );
    expect(settingsSource, 'Settings no longer renders the mic-test error').toMatch(/\{micError\}/);
  });

  it('detects an unscoped take-only promise, and leaves honest copy alone', () => {
    // The detector is the whole guard, so it is asserted rather than assumed.
    // Left column: every clause this fix removed.
    for (const bad of [
      'Press A to start or stop auto-scroll.',
      'Reinstall CandidCue after the take.',
      'To retry voice following, stop and restart the take.',
      'Use auto-scroll instead.',
    ]) {
      expect(unscoped(bad), `'${bad}' should read as an unscoped take-only promise`).toEqual([bad]);
    }
    for (const good of [
      'In a take, press A to start or stop auto-scroll.',
      'In a take, press A to start or stop auto-scroll, then stop and start the take to retry.',
      'Restart CandidCue, and reinstall it if this keeps happening.',
      'The speech model is missing from this installation.',
    ]) {
      expect(unscoped(good), `'${good}' is true on both surfaces and should pass`).toEqual([]);
    }
  });

  it('never promises a take-only action unconditionally', () => {
    for (const code of RECOGNISER_CODES) {
      const copy = copyForErrorCode(code);
      expect(
        unscoped(copy),
        `${code} names a take-only action to a reader who may have no take: ${copy}`,
      ).toEqual([]);
      // The specific phrasing that was wrong on this surface: "after the take"
      // has no referent in Settings, whichever sentence it lands in.
      expect(copy, `${code} still frames its repair around a take`).not.toMatch(/after the take/i);
    }
  });

  it('leaves the conditional off the sentence that says what happened', () => {
    // Scoping is for the remedy, not the diagnosis: a missing model is missing
    // in Settings too, and hedging that would be its own small lie.
    for (const code of RECOGNISER_CODES) {
      const [first] = sentences(copyForErrorCode(code));
      expect(first, `${code} has no leading statement of what happened`).toBeDefined();
      expect(first, `${code} opens with a condition instead of the fault`).not.toMatch(SCOPED);
      expect(first).toMatch(/^The speech (?:model|recogniser)\b/);
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
 *    reinstall CandidCue. The model lives in the app-data directory now, so a
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
   * words — "install CandidCue again", "try installing the app again" — which a
   * narrower pattern would have waved past.
   */
  const REINSTALL_ADVICE =
    /\bre[\s‐-―‑-]?install|\binstall(?:ing)?\s+(?:CandidCue|the app|it)\s+again\b/iu;

  /** What Rust puts on the `AppError`, at both raise sites, verbatim. */
  const BACKEND_MESSAGES = [
    // `speech/mod.rs::not_installed`, reached through `ensure_loaded`.
    'The speech model has not been downloaded yet. Open Settings › Speech to install it.',
    // `speech_cmds.rs::select_speech_language`, refusing an uninstalled language.
    'Download this language before switching to it.',
  ];

  /** The claim about what happened, which is always the leading sentence. */
  const opener = (copy: string): string => copy.split(/(?<=\.)\s+/)[0]?.trim() ?? '';

  it('authors the copy for a model that is not installed, rather than borrowing Rust’s', () => {
    expect(hasErrorCopy('STT_MODEL_NOT_INSTALLED')).toBe(true);

    for (const userMessage of BACKEND_MESSAGES) {
      const shown = describeError({ code: 'STT_MODEL_NOT_INSTALLED', userMessage });
      // The assertion that carries the issue: both backend sentences are
      // perfectly readable, so passing one through would look fine on screen
      // and still mean this file had no say in it.
      expect(shown, 'the backend message reached the user unedited').not.toBe(userMessage);
      expect(shown).toBe(copyForErrorCode('STT_MODEL_NOT_INSTALLED'));
      expect(shown).toMatch(/Settings → Speech/);
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
      'Reinstall CandidCue to restore voice following.',
      'Restart CandidCue, and reinstall it if this keeps happening.',
      're-install CandidCue',
      // U+2011, which a word processor introduces without anyone deciding to.
      're‑install CandidCue',
      'Install CandidCue again to fix it.',
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
      'Restart CandidCue to bring it back.',
    ]) {
      expect(spelling, `'${spelling}' is honest copy and should pass`).not.toMatch(
        REINSTALL_ADVICE,
      );
    }
  });

  it('points every model-state failure at the screen that can fix it', () => {
    for (const code of MODEL_STATE_CODES) {
      const copy = copyForErrorCode(code);
      expect(copy, `${code} does not name the screen that fixes it`).toMatch(/Settings → Speech/);
      expect(copy, `${code} does not name the action that fixes it`).toMatch(/download/i);
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
    const notInstalled = copyForErrorCode('STT_MODEL_NOT_INSTALLED');
    const missing = copyForErrorCode('STT_MODEL_MISSING');
    expect(notInstalled).not.toBe(missing);
    expect(opener(notInstalled)).not.toBe(opener(missing));
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
    expect(copy).toMatch(/network settings/);
    expect(copy).toMatch(/try another network/);
    expect(copy).not.toMatch(/release/i);
    expect(copy).not.toMatch(CODE_TOKEN);
    expect(describeError({ code: 'STT_MODEL_URL_BLOCKED', userMessage: 'x' })).toBe(copy);
  });
});
