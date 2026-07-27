/**
 * The Settings screen's live view of the glass.
 *
 * The claims worth pinning are the ones that cost an operator a stranded window
 * or a lying preview:
 *
 *  - a failure anywhere after the window opens CLOSES it. The preview is not a
 *    take, so nothing else in the app will ever clean it up, and a black
 *    rectangle over the prompter with no owner is worse than the error;
 *  - appearance changes travel as a `settings` DIRECTIVE, not a republish. A
 *    republished envelope restarts the stage's whole hydration handshake, which
 *    is a visible re-lay-out on every drag of a slider;
 *  - `close()` is idempotent and silences later directives, because the
 *    reactive push that drives it cannot know the window has gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledScript, StageSettings } from '../../../src/shared/contracts';

const openStage = vi.fn();
const closeStage = vi.fn();
const publishStageDocument = vi.fn();
const publishStageDirective = vi.fn();
const setStageFullscreen = vi.fn();
const waitForStageReady = vi.fn();

vi.mock('../../../src/control/services/stage', () => ({
  openStage: (...args: unknown[]) => openStage(...args),
  closeStage: (...args: unknown[]) => closeStage(...args),
  publishStageDocument: (...args: unknown[]) => publishStageDocument(...args),
  publishStageDirective: (...args: unknown[]) => publishStageDirective(...args),
  setStageFullscreen: (...args: unknown[]) => setStageFullscreen(...args),
  waitForStageReady: (...args: unknown[]) => waitForStageReady(...args),
}));

vi.mock('../../../src/control/services/compiler', () => ({
  compileScript: vi.fn(),
}));

const { openStagePreview, STAGE_PREVIEW_SOURCE } = await import(
  '../../../src/control/services/stage-preview-session'
);

/** The smallest compile result the envelope builder will accept. */
function fakeScript(): CompiledScript {
  return {
    scriptId: 'preview',
    sourceHash: 'hash',
    title: 'Reading band check',
    blocks: [],
    cues: [],
    outline: [],
    sentences: [],
    spokenTokens: [],
    assets: [],
    navigationTargets: [],
    diagnostics: [],
  } as unknown as CompiledScript;
}

const compile = async () => ({ script: fakeScript() });

function settingsAt(fontSizePx: number): StageSettings {
  return { fontSizePx } as unknown as StageSettings;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    displayFingerprint: 'fp-1',
    settings: settingsAt(64),
    fullscreen: true,
    compile,
    ...overrides,
  } as Parameters<typeof openStagePreview>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  openStage.mockResolvedValue({ stageGeneration: 7 });
  publishStageDocument.mockResolvedValue({ accepted: true });
  waitForStageReady.mockResolvedValue(undefined);
  setStageFullscreen.mockResolvedValue({});
  publishStageDirective.mockResolvedValue(undefined);
  closeStage.mockResolvedValue(undefined);
});

describe('openStagePreview', () => {
  it('opens, publishes the passage, and presents it full screen', async () => {
    const preview = await openStagePreview(options());

    expect(openStage).toHaveBeenCalledWith(
      expect.objectContaining({ displayFingerprint: 'fp-1', sessionId: preview.sessionId }),
    );
    const [, envelope] = publishStageDocument.mock.calls[0]!;
    expect(envelope.stageGeneration).toBe(7);
    expect(envelope.stageSettings).toEqual(settingsAt(64));
    // Presented at the stage generation the window actually reported, not a
    // number the caller guessed.
    expect(waitForStageReady).toHaveBeenCalledWith(7);
    expect(setStageFullscreen).toHaveBeenCalledWith(preview.sessionId, true);
    expect(closeStage).not.toHaveBeenCalled();
  });

  it('honours a borderless (non-fullscreen) stage preference', async () => {
    const preview = await openStagePreview(options({ fullscreen: false }));
    expect(setStageFullscreen).toHaveBeenCalledWith(preview.sessionId, false);
  });

  it('pushes later changes as a directive rather than a republish', async () => {
    const preview = await openStagePreview(options());
    publishStageDocument.mockClear();

    await preview.applySettings(settingsAt(96));

    expect(publishStageDirective).toHaveBeenCalledWith(preview.sessionId, 7, {
      kind: 'settings',
      settings: settingsAt(96),
    });
    // The whole point: no second hydration handshake per slider drag.
    expect(publishStageDocument).not.toHaveBeenCalled();
  });

  /*
   * The stranded-window cases. Each one opened a real OS window before it
   * failed, and the preview is not a take — no summary dialog, no stop button,
   * no teardown path anywhere else in the app knows about it.
   */
  /**
   * The session id this attempt opened.
   *
   * Asserted by ID rather than by call COUNT, because a raw count also picks up
   * the orphan sweep that runs before every open — and a test that breaks when
   * an unrelated earlier case leaves a window behind is measuring the harness,
   * not the behaviour.
   */
  function openedSessionId(): string {
    const call = openStage.mock.calls.at(-1);
    return (call?.[0] as { sessionId: string }).sessionId;
  }

  it('closes the window when the stage refuses the document', async () => {
    publishStageDocument.mockResolvedValue({ accepted: false });
    await expect(openStagePreview(options())).rejects.toThrow(/replaced/);
    expect(closeStage).toHaveBeenCalledWith(openedSessionId());
  });

  it('closes the window when the handshake never completes', async () => {
    waitForStageReady.mockRejectedValue(new Error('the stage never finished laying out'));
    await expect(openStagePreview(options())).rejects.toThrow(/laying out/);
    expect(closeStage).toHaveBeenCalledWith(openedSessionId());
  });

  it('closes the window when presenting it fails', async () => {
    setStageFullscreen.mockRejectedValue(new Error('no such display'));
    await expect(openStagePreview(options())).rejects.toThrow(/no such display/);
    expect(closeStage).toHaveBeenCalledWith(openedSessionId());
  });

  /**
   * The mop for a teardown that could not retry.
   *
   * Component destroy has nowhere to report a failed close and nothing left to
   * hold the handle, so a window that refuses to close there is orphaned. The
   * id is remembered and swept by the next preview, which turns "stranded until
   * the app quits" into "gone the next time one is opened".
   */
  it('sweeps a window a previous teardown could not close', async () => {
    const stranded = await openStagePreview(options());
    closeStage.mockRejectedValueOnce(new Error('the window did not answer'));
    await expect(stranded.close()).rejects.toThrow();

    closeStage.mockClear();
    closeStage.mockResolvedValue(undefined);
    await openStagePreview(options());

    expect(closeStage).toHaveBeenCalledWith(stranded.sessionId);
  });

  it('stops sweeping a window it has already closed', async () => {
    const preview = await openStagePreview(options());
    await preview.close();

    closeStage.mockClear();
    await openStagePreview(options());

    expect(closeStage).not.toHaveBeenCalledWith(preview.sessionId);
  });

  /**
   * Two callers can arrive during the same close: the operator presses Stop
   * while a section change or a route teardown is running one. `closed` alone
   * does not cover it — it only becomes true once Rust confirms.
   */
  it('issues one close for concurrent callers', async () => {
    const preview = await openStagePreview(options());
    // Clear the orphan sweep this open performed, so the count below is this
    // window's closes and nothing else.
    closeStage.mockClear();

    let release: (() => void) | null = null;
    closeStage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const both = Promise.all([preview.close(), preview.close()]);
    expect(closeStage).toHaveBeenCalledTimes(1);
    release!();
    await both;
    expect(closeStage).toHaveBeenCalledTimes(1);
  });

  /**
   * A send that fails must not strand a newer appearance behind it. Directives
   * are only sent when something changes, so a value dropped here stays unsent
   * until the operator happens to move a different control.
   */
  it('keeps the latest value queued when a send fails', async () => {
    const preview = await openStagePreview(options());

    let reject: ((err: Error) => void) | null = null;
    publishStageDirective.mockImplementationOnce(
      () => new Promise<void>((_resolve, r) => (reject = r)),
    );

    const first = preview.applySettings(settingsAt(70));
    // Shares the same in-flight promise, so it rejects too — swallowed here the
    // way the Settings push effect swallows it.
    void preview.applySettings(settingsAt(110)).catch(() => {});
    reject!(new Error('the stage did not answer'));
    await expect(first).rejects.toThrow(/did not answer/);

    /*
     * NO third `applySettings` here, deliberately.
     *
     * An earlier version of this test called one, and it hid the bug it was
     * written for: the drain threw out of its loop on the failure, leaving the
     * newer value queued with nothing left to pump it, and the extra call
     * supplied the pump. The claim is that the newer value goes out ON ITS
     * OWN — because a directive is only sent when something changes, so a value
     * stranded here stays unsent until the operator moves an unrelated control.
     */
    const sent = publishStageDirective.mock.calls.map(
      ([, , directive]) => (directive as { settings: StageSettings }).settings,
    );
    expect(sent).toEqual([settingsAt(70), settingsAt(110)]);
  });

  /**
   * The mirror case: nothing newer arrived, so the failed value goes BACK on
   * the queue rather than being retried in a loop against whatever refused it.
   */
  it('re-queues a failed value when nothing newer arrived', async () => {
    const preview = await openStagePreview(options());
    publishStageDirective.mockRejectedValueOnce(new Error('the stage did not answer'));

    await expect(preview.applySettings(settingsAt(70))).rejects.toThrow(/did not answer/);
    expect(publishStageDirective).toHaveBeenCalledTimes(1);

    // The next push sends it, and does not need to be told the value again.
    publishStageDirective.mockClear();
    await preview.applySettings(settingsAt(70));
    expect(publishStageDirective).toHaveBeenCalledTimes(1);
  });

  it('does not open a window when the passage will not compile', async () => {
    await expect(
      openStagePreview(options({ compile: async () => ({ script: null }) })),
    ).rejects.toThrow(/could not be compiled/);
    // No window is opened for a passage that will not render...
    expect(openStage).not.toHaveBeenCalled();
  });

  /**
   * ...but a compile that fails is no reason to leave a previous window up.
   *
   * The sweep used to sit BEHIND the compile, which made cleaning up an
   * always-on-top rectangle covering somebody's prompter conditional on an
   * unrelated worker succeeding. The two have nothing to do with each other.
   */
  it('still sweeps an orphaned window when the passage will not compile', async () => {
    const stranded = await openStagePreview(options());
    closeStage.mockRejectedValueOnce(new Error('the window did not answer'));
    await expect(stranded.close()).rejects.toThrow();

    closeStage.mockClear();
    closeStage.mockResolvedValue(undefined);
    await expect(
      openStagePreview(options({ compile: async () => ({ script: null }) })),
    ).rejects.toThrow(/could not be compiled/);

    expect(closeStage).toHaveBeenCalledWith(stranded.sessionId);
  });

  it('closes once, and goes quiet afterwards', async () => {
    const preview = await openStagePreview(options());

    await preview.close();
    await preview.close();
    // By id, not by count: an orphan sweep also calls `closeStage`.
    expect(closeStage.mock.calls.filter(([id]) => id === preview.sessionId)).toHaveLength(1);

    /*
     * The reactive push in Settings cannot know the window has gone — it fires
     * on the settings changing, not on the preview's lifetime. A directive
     * after close must be dropped here rather than sent to a dead session.
     */
    await preview.applySettings(settingsAt(120));
    expect(publishStageDirective).not.toHaveBeenCalled();
  });

  /**
   * A close that FAILED left the window open, so the handle must not pretend
   * otherwise. It is the only thing that knows this window's session id; going
   * quiet here would leave a frameless always-on-top rectangle over the
   * operator's prompter with nothing in the app able to address it.
   */
  it('stays open, and stays usable, when the close fails', async () => {
    const preview = await openStagePreview(options());
    closeStage.mockRejectedValueOnce(new Error('the window did not answer'));

    await expect(preview.close()).rejects.toThrow(/did not answer/);

    // Still owned: a second press is a real retry, not a no-op.
    closeStage.mockResolvedValueOnce(undefined);
    await preview.close();
    expect(closeStage).toHaveBeenCalledTimes(2);
  });

  /**
   * Rust drops any payload whose `sessionGeneration` disagrees with the
   * coordinator's, and the coordinator's number is minted by `start_session` —
   * which a preview never calls. Any literal is therefore wrong except by
   * coincidence, and the validator treats the field as optional when absent.
   */
  it('publishes no session generation at all', async () => {
    await openStagePreview(options());
    const [, envelope] = publishStageDocument.mock.calls[0]!;
    expect('sessionGeneration' in envelope).toBe(false);
  });

  /**
   * Rust authorises `close_stage` by SESSION ID, so two previews sharing one id
   * means a late teardown from the first can close the second. The failure path
   * in `openStagePreview` closes on the way out, and the case it closes for —
   * a rejected document, i.e. the window was REPLACED — is exactly when a
   * second preview already holds the id.
   */
  it('mints a distinct session id per preview', async () => {
    const first = await openStagePreview(options());
    const second = await openStagePreview(options());
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  /**
   * A drag produces a burst of settings. Each is its own unawaited command and
   * nothing promises ordered delivery, while the stage replaces its WHOLE
   * settings object per directive — so one overtaken in transit does not arrive
   * late, it restores an older appearance and leaves it there.
   */
  it('keeps one directive in flight and coalesces to the latest value', async () => {
    const preview = await openStagePreview(options());

    let release: (() => void) | null = null;
    publishStageDirective.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    // First send goes out immediately; the next three land mid-flight.
    const sends = [
      preview.applySettings(settingsAt(70)),
      preview.applySettings(settingsAt(80)),
      preview.applySettings(settingsAt(90)),
      preview.applySettings(settingsAt(100)),
    ];
    expect(publishStageDirective).toHaveBeenCalledTimes(1);

    release!();
    await Promise.all(sends);

    // Two calls, not four: the three queued behind the first collapsed to the
    // last one the operator actually chose.
    expect(publishStageDirective).toHaveBeenCalledTimes(2);
    const settingsSent = publishStageDirective.mock.calls.map(
      ([, , directive]) => (directive as { settings: StageSettings }).settings,
    );
    expect(settingsSent).toEqual([settingsAt(70), settingsAt(100)]);
  });

  it('prompts a passage that names what the operator is looking at', () => {
    // The preview exists to be judged, not read: it has to say which marks are
    // the reading band, or somebody aligning them against a lens is guessing.
    expect(STAGE_PREVIEW_SOURCE).toMatch(/reading band/i);
    expect(STAGE_PREVIEW_SOURCE).toMatch(/lens/i);
  });
});
