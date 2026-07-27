/**
 * The Settings screen's live view of the glass.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Teleprompter section sets type size, line height, column width and the
 * reading band's position. Every one of those is a claim about what something
 * will look like from two metres away through a beamsplitter, and the screen
 * they are set on is a laptop at arm's length. "64 px" and "38%" are not
 * quantities anybody can evaluate — they are quantities you can only recognise
 * once you are looking at them on the rig.
 *
 * The reading band is the sharpest case. It is where the presenter's eyes rest,
 * so it wants to sit over the camera lens, and nobody can place it over a lens
 * by choosing a percentage. They can place it by watching it move.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a second renderer. It opens a REAL stage window on the chosen display and
 * drives it with the real envelope and the real `settings` directive, so what
 * appears on the glass is produced by exactly the code a take runs. A preview
 * with its own drawing path would be free to be wrong in precisely the way that
 * matters — agreeing with the sliders and disagreeing with the take.
 *
 * Not a calibration either. Calibrate (§17) measures a rig: millimetres per
 * pixel, the hood's safe area, where the lens sits, how far away the presenter
 * stands. This shows what the CURRENT settings look like, which is the question
 * an uncalibrated rig has and the one the wizard does not answer.
 */
import type { CompiledScript, StageSettings } from '../../shared/contracts';
import { compileScript } from './compiler';
import { buildStageEnvelope } from './stage-envelope';
import * as stageService from './stage';

/**
 * The passage the preview prompts.
 *
 * Chosen to be judged rather than read. It carries a heading (so heading
 * treatment is visible), several paragraphs of ordinary sentence lengths (so
 * the column measure can be seen doing its job over more than one line), and a
 * line that names what the reader should be looking at — because somebody
 * standing at a prompter needs to know whether the band they are aligning is
 * the band, and a lorem-ipsum block cannot tell them.
 *
 * Deliberately not the user's own script. Loading one would make the preview
 * depend on which script was last open, and a long document would scroll the
 * interesting part off the glass before they looked up.
 */
export const STAGE_PREVIEW_SOURCE = `# Reading band check

This is what your script will look like on the glass. Adjust the size, the line
height and the column width until this paragraph reads without effort from where
you actually stand.

The marks at the sides show the reading band. Move "Reading band position" until
they sit over your camera lens — that is where your eyes will rest, so that is
where the lens wants to be.

Read this line aloud at your normal pace to judge the size. If you find yourself
leaning in, the type is too small; if your eyes travel, the column is too wide.
`;

/** A stable id, so a stale preview window can never be mistaken for a take. */
export const STAGE_PREVIEW_SCRIPT_ID = '00000000-0000-0000-0000-00000000fee1';

/**
 * Session ids are minted, not fixed.
 *
 * Rust authorises `close_stage` by SESSION ID rather than by stage generation
 * (`windows::close_stage`), so a shared id makes a late teardown from one
 * preview able to close its own replacement. That is reachable rather than
 * theoretical: the failure path in `openStagePreview` closes on the way out,
 * and the case it closes for — a rejected document, meaning the window was
 * REPLACED — is exactly the case where a second preview already owns the id.
 *
 * A process-local counter rather than a random or time-based suffix: it is
 * enough to distinguish two previews in one session, which is all the id has to
 * do, and it keeps the value reproducible in tests.
 */
let previewOrdinal = 0;

/**
 * Preview windows this process has opened and not yet confirmed closed.
 *
 * The last line of defence for a teardown that cannot retry. Component destroy
 * has nowhere to report a failed close and nothing left to hold the handle — so
 * if `closeStage` rejects there, the window survives with no owner. Recording
 * the id here means the NEXT preview can sweep it, which turns "stranded until
 * the app is quit" into "gone the next time the operator opens one".
 *
 * Deliberately not a fix for the failure itself. It is a mop, and it is here
 * because the thing being mopped up is a frameless always-on-top rectangle
 * covering the operator's prompter.
 *
 * PRECONDITION: one preview per process at a time. The set cannot tell an
 * abandoned window from a live one, so opening a second preview while the first
 * handle is still owned would sweep the first — closing its window while its
 * handle still believes it open. Settings cannot do that (an open preview turns
 * the control into Stop, `stagePreviewBusy` blocks overlap, and every teardown
 * drops ownership before another open can start), and any future caller has to
 * hold the same rule.
 */
const openPreviewSessions = new Set<string>();

function forgetPreview(sessionId: string): void {
  openPreviewSessions.delete(sessionId);
}

/**
 * Close any preview window this process opened and lost track of.
 *
 * Failures are swallowed on purpose: this runs before opening a NEW preview,
 * and a sweep that could not reach a window from some earlier visit is not a
 * reason to refuse the one being asked for now.
 */
export async function closeOrphanedStagePreviews(): Promise<void> {
  const orphans = [...openPreviewSessions];
  await Promise.all(
    orphans.map(async (sessionId) => {
      try {
        await stageService.closeStage(sessionId);
        openPreviewSessions.delete(sessionId);
      } catch {
        // Still unreachable. Keep the id: the next sweep gets another go.
      }
    }),
  );
}

export interface StagePreviewHandle {
  readonly sessionId: string;
  /**
   * The window's stage generation.
   *
   * Exposed so the caller can recognise this window's own messages — the stage
   * stamps every outbound payload with it, and "End session" pressed on the
   * glass is one of them. Without it, a preview would have to either ignore
   * that button or act on an Escape belonging to some other window.
   */
  readonly stageGeneration: number;
  /** Push a changed appearance to the open window, without republishing. */
  applySettings(settings: StageSettings): Promise<void>;
  /**
   * Close the window.
   *
   * Rejects if the window could not be closed, and stays OPEN — the handle is
   * still the only thing that can close it. Swallowing that error is how a
   * frameless always-on-top rectangle ends up covering a monitor with every
   * piece of software in the building convinced it is already gone.
   */
  close(): Promise<void>;
}

export interface StagePreviewOptions {
  displayFingerprint: string;
  settings: StageSettings;
  fullscreen: boolean;
  /** Injected in tests; the real compiler otherwise. */
  compile?: (scriptId: string, source: string) => Promise<{ script: CompiledScript | null }>;
}

/**
 * Open the preview and return a handle to it.
 *
 * Throws if the window cannot be opened or the script cannot be compiled — the
 * caller has a place to say so, and a half-open preview that silently shows
 * nothing is the failure this whole feature exists to remove.
 */
export async function openStagePreview(
  options: StagePreviewOptions,
): Promise<StagePreviewHandle> {
  /*
   * The sweep goes FIRST — before the compile, not after it.
   *
   * Behind the compile it was conditional on the compile succeeding, and a
   * worker that rejects or returns a superseded result is not a reason to leave
   * an always-on-top window covering somebody's prompter. The two have nothing
   * to do with each other: one is tidying up a window this process already
   * opened, the other is preparing the next one.
   */
  await closeOrphanedStagePreviews();

  const compile = options.compile ?? compileScript;
  const compiled = await compile(STAGE_PREVIEW_SCRIPT_ID, STAGE_PREVIEW_SOURCE);
  const script = compiled.script;
  if (!script) throw new Error('the preview passage could not be compiled');

  previewOrdinal += 1;
  const sessionId = `stage-preview-${previewOrdinal}`;
  const opened = await stageService.openStage({
    displayFingerprint: options.displayFingerprint,
    sessionId,
  });
  openPreviewSessions.add(sessionId);

  /*
   * From here on every failure closes the window before it rethrows.
   *
   * A stage that opened and then failed to receive its script is a black
   * rectangle covering a monitor with nothing on it that says why, and — since
   * it is not a take — nothing else in the app will ever close it. That is a
   * worse outcome than the error the caller is about to be handed.
   */
  try {
    /*
     * The envelope carries NO session generation, deliberately.
     *
     * Rust drops any payload whose `sessionGeneration` disagrees with the
     * coordinator's current one (`validate_stage_payload_header`), and the
     * coordinator's number is minted by `start_session` — which a preview never
     * calls, because it is not a take. Any constant here is therefore wrong
     * except by coincidence: on a fresh launch the coordinator is at 0, after
     * one take it is at 1, and the preview would publish successfully only in
     * whichever of those a hard-coded literal happened to match. The failure is
     * silent from control's side too — the ack simply comes back rejected and
     * the operator is told the stage was "replaced".
     *
     * The same validator treats the field as genuinely optional ("A session
     * generation, WHEN CARRIED, must also be current"), so omitting it is the
     * sanctioned way to say "this payload does not belong to a take". The stage
     * reads it only to seed the alignment receiver's generation, and nothing is
     * aligning against a preview — there is no transcript and no snapshot feed.
     *
     * So the field is simply not supplied. `buildStageEnvelope` leaves it off
     * the payload entirely when it is omitted — not defaulted to a number,
     * which would put the silent drop straight back.
     */
    const envelope = buildStageEnvelope({
      script,
      sessionId,
      stageGeneration: opened.stageGeneration,
      stageSettings: options.settings,
    });

    const ack = await stageService.publishStageDocument(sessionId, envelope);
    if (!ack.accepted) throw new Error('the stage was replaced while the preview was opening');
    await stageService.waitForStageReady(opened.stageGeneration);
    await stageService.setStageFullscreen(sessionId, options.fullscreen);
  } catch (err) {
    // The id stays in `openPreviewSessions` if this close fails, so the next
    // preview sweeps it rather than the window being lost with the handle.
    await stageService
      .closeStage(sessionId)
      .then(() => forgetPreview(sessionId))
      .catch(() => {});
    throw err;
  }

  let closed = false;
  /**
   * The directive in flight, and the one waiting behind it.
   *
   * A slider drag produces a burst of settings, each sent as its own unawaited
   * command. Nothing in the IPC layer promises they arrive in order, and the
   * stage replaces its WHOLE settings object for each one — so a directive
   * overtaken in transit does not merely arrive late, it restores an older
   * appearance and leaves it there until the operator moves something else.
   *
   * So: one in flight at a time, and only the LATEST value queued behind it.
   * That is coalescing rather than debouncing — no delay is introduced, which
   * is the whole point of the feature (drag the slider, watch the band move) —
   * and the last value the operator chose is guaranteed to be the last one the
   * stage is told about.
   */
  let inFlight: Promise<void> | null = null;
  let queued: StageSettings | null = null;
  /** The first send failure of a drain pass, reported once the pass is done. */
  let failure: unknown;

  async function drain(): Promise<void> {
    while (queued !== null && !closed) {
      const next = queued;
      queued = null;
      try {
        await stageService.publishStageDirective(sessionId, opened.stageGeneration, {
          kind: 'settings',
          settings: next,
        });
      } catch (err) {
        /*
         * A failed send must not strand the newest appearance.
         *
         * Two cases, and they want opposite things. If nothing newer arrived
         * while this one was in flight, the value goes BACK on the queue and
         * the loop stops: it will go out with the next change, and retrying it
         * here in a loop would spin against whatever just refused it.
         *
         * If something newer HAS arrived, that value is the one the operator
         * actually wants and this one is already stale — so it is dropped and
         * the loop CONTINUES. Rethrowing here instead (which is what this did
         * first) exited the loop with the newer value still queued and nothing
         * left to pump it, so the preview sat on an older appearance until some
         * unrelated control was moved. The caller still learns the send failed,
         * from the error recorded below.
         */
        failure = err;
        if (queued === null) {
          queued = next;
          break;
        }
      }
    }
    if (failure !== undefined) {
      const err = failure;
      failure = undefined;
      throw err;
    }
  }

  /** One shared close, so concurrent callers cannot double-close the window. */
  let closing: Promise<void> | null = null;

  return {
    sessionId,
    stageGeneration: opened.stageGeneration,
    async applySettings(settings) {
      if (closed) return;
      queued = settings;
      if (inFlight) return inFlight;
      inFlight = drain().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async close() {
      if (closed) return;
      /*
       * One close in flight, shared by every caller.
       *
       * `closed` alone is not enough: it only becomes true once Rust confirms,
       * so two callers arriving during that window would each issue their own
       * `close_stage` for the same session. The routes that can collide are
       * real — the operator presses Stop while a section change or a route
       * teardown is running the same close.
       */
      if (closing) return closing;
      /*
       * Marked closed only once Rust confirms it.
       *
       * On a rejection the handle stays live and the caller keeps ownership,
       * because the handle is the only thing that knows this window's session
       * id — dropping it on a failed close would leave a frameless,
       * always-on-top rectangle over the operator's prompter that nothing in
       * the app can address any more. A retry has somewhere to go instead.
       */
      queued = null;
      closing = stageService
        .closeStage(sessionId)
        .then(() => {
          closed = true;
          forgetPreview(sessionId);
        })
        .finally(() => {
          closing = null;
        });
      return closing;
    },
  };
}
