<!--
  Calibrate a rig (shared/contracts/optical.ts).

  ---------------------------------------------------------------------------
  WHY THIS IS A ROUTE AND NOT A PANEL IN SETTINGS
  ---------------------------------------------------------------------------
  Every other stage preference is a number you pick once and forget. These are
  MEASUREMENTS, and each of them is taken by a person standing at their rig
  looking through the glass — which means this screen has to drive the real
  stage window on the real panel while it asks. It opens one, holds it for the
  whole sequence, and closes it on the way out.

  So it is a sequence with a beginning and an end, not a page of controls, and
  it owns a window. That is what makes it a route.

  ---------------------------------------------------------------------------
  NOTHING HERE IS COMPULSORY
  ---------------------------------------------------------------------------
  Discovery has already answered what it can (shared/optical-discovery.ts): the
  panel, its physical scale, a plausible distance for that hardware. Every step
  therefore opens with an answer already in it, and every step can be skipped.
  A skipped step is recorded as skipped rather than as done — `completedSteps`
  is what tells a later reader whether all-zero safe-area insets mean "this hood
  reveals the whole panel" or "nobody was asked".

  ---------------------------------------------------------------------------
  SAVED AT THE END, ON PURPOSE
  ---------------------------------------------------------------------------
  The working profile is held here and written to settings once, at Finish. A
  wizard that saved each step as it went would make a half-measured rig the one
  in force on that panel the moment somebody wandered off mid-sequence — a
  distance recorded without the scale that gives it meaning, sizing every take
  until they came back to it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '../components/Button.svelte';
  import Icon from '../components/Icon.svelte';
  import Toolbar from '../components/Toolbar.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import Select from '../components/Select.svelte';
  import Slider from '../components/Slider.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import TextField from '../components/TextField.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { describeError } from '../services/errors';
  import { isTauriRuntime } from '../services/ipc';
  import * as stageService from '../services/stage';
  import { buildStageSettings } from '../services/stage-envelope';
  import { opticalRigKey, withOpticalProfile } from '../services/settings-types';
  import type { DisplayDescriptor } from '../services/stage-types';
  import SidecarChecklist from '../components/SidecarChecklist.svelte';
  import {
    OPTICAL_HARDWARE,
    STAGE_EVENT,
    defaultOpticalProfile,
    type OpticalCalibrationStep,
    type OpticalHardwareKind,
    type OpticalProfile,
    type ReadingCueStyle,
    type StageCalibrationMode,
    type StageDirective,
    type StageEscapePayload,
    type StageSettings,
    type TextIntensity,
  } from '../../shared/contracts';
  import { discoverProfile, identifyHardware } from '../../shared/optical-discovery';
  import { resolveStageGeometry } from '../../shared/optical-resolve';
  import {
    opticalProfileFieldsForPreset,
    profileMatchesPreset,
    RIG_PRESETS,
    type OpticalRigPreset,
  } from '../../shared/optical-rig-presets';
  import {
    inchesToMm,
    isPlausibleDiagonalMm,
    isPlausibleViewingDistanceMm,
    mmPerCssPixel,
    mmPerCssPixelFromRuler,
    MAX_VIEWING_DISTANCE_MM,
    MIN_VIEWING_DISTANCE_MM,
  } from '../../shared/optics';
  import { requestConfirm } from '../stores/confirm';
  import { navigate, registerNavigationGuard } from '../stores/router';
  import { patchSettings, settings } from '../stores/settings';
  import { showToast } from '../stores/toasts';

  interface Props {
    /** The panel being measured. Rigs are stored per panel, per name. */
    displayFingerprint: string;
    /** Which rig on that panel — several mountings share one monitor. */
    rigName: string;
  }
  let { displayFingerprint, rigName }: Props = $props();

  /* --------------------------------------------------------------- steps */

  /**
   * The ten questions, in the order they can be answered.
   *
   * The order is not cosmetic. Preset comes first because it is a shortcut for
   * several of the answers that follow, not a replacement for any of them —
   * every field it writes is still open to correction on its own step. Scale
   * has to precede distance because the two multiply into every angular
   * result, and both have to precede text size or the sample on the glass is a
   * guess being judged as a measurement. Safe area precedes lens because the
   * lens is expressed as a fraction of the safe rectangle, so moving the frame
   * afterwards would silently move the crosshair.
   */
  type WizardStepId =
    | 'preset'
    | 'hardware'
    | 'scale'
    | 'safe-area'
    | 'orientation'
    | 'lens'
    | 'distance'
    | 'text-size'
    | 'line-width'
    | 'brightness';

  interface WizardStep {
    id: WizardStepId;
    title: string;
    /** One sentence saying what the presenter should be doing. */
    lead: string;
    /**
     * The `completedSteps` token this answers, when there is one.
     *
     * `scale` has none, and deliberately: the scale is EVIDENT — `profile.scale`
     * is either a measurement with a provenance or it is null. A token would be
     * a second, weaker record of the same fact that could disagree with it. The
     * other eight all have answers that look identical whether they were given
     * or defaulted (all-zero insets, a centred lens, unflipped glass), which is
     * exactly what the token list exists to disambiguate.
     *
     * `preset` has none for the same reason as `scale`: which preset, if any,
     * is already evident from the profile's own fields — `matchesPreset` reads
     * it off directly — so a token would only be a second, unsynchronised place
     * for a fact the profile already states.
     */
    records: OpticalCalibrationStep | null;
    /** What the stage draws while this step is open. */
    card: StageCalibrationMode | null;
  }

  const STEPS: WizardStep[] = [
    {
      id: 'preset',
      title: 'Start from a preset?',
      lead: 'Pick the arrangement closest to yours to fill in the obvious answers. Every one of them stays open to correction on the steps ahead.',
      records: null,
      card: null,
    },
    {
      id: 'hardware',
      title: 'Which prompter is this?',
      lead: 'CandidCue has already looked. Correct it if it guessed wrong, and give this arrangement a name you will recognise.',
      records: 'hardware',
      card: null,
    },
    {
      id: 'scale',
      title: 'How big is the picture, really?',
      lead: 'Everything else rests on this: how many millimetres one pixel is worth on this glass.',
      records: null,
      card: 'ruler',
    },
    {
      id: 'safe-area',
      title: 'What can you actually see?',
      lead: 'Move each edge in until the whole frame is inside what the hood reveals.',
      records: 'safe-area',
      card: 'safe-area',
    },
    {
      id: 'orientation',
      title: 'Does it read the right way round?',
      lead: 'Look at the card through the glass, from where you will present.',
      records: 'orientation',
      card: 'orientation',
    },
    {
      id: 'lens',
      title: 'Where is the lens?',
      lead: 'Put the crosshair over the camera. The script is centred on the lens, not on the display.',
      records: 'lens',
      card: 'crosshair',
    },
    {
      id: 'distance',
      title: 'How far away do you stand?',
      lead: 'Stand where you will present and measure, or pick the nearest.',
      records: 'distance',
      card: 'type-sample',
    },
    {
      id: 'text-size',
      title: 'How large should the text be?',
      lead: 'Choose the smallest size you can read without effort — larger type costs you words per line.',
      records: 'text-size',
      card: 'type-sample',
    },
    {
      id: 'line-width',
      title: 'How wide should a line run?',
      lead: 'A tight shot notices a sideways glance that a wide one hides, so tighter framing wants a narrower column.',
      records: 'line-width',
      card: 'type-sample',
    },
    {
      id: 'brightness',
      title: 'How hot should the type burn?',
      lead: 'A bright room washes out a soft face; a dark studio makes a strong one bloom.',
      records: 'brightness',
      card: 'type-sample',
    },
  ];

  let stepIndex = $state(0);
  const step = $derived(STEPS[stepIndex] ?? STEPS[0]!);
  const isLastStep = $derived(stepIndex === STEPS.length - 1);

  /* ------------------------------------------------------------- profile */

  /**
   * The working copy, seeded from the props once.
   *
   * Deliberately not derived from `rigName`: this screen's props are its
   * IDENTITY, not its inputs. Calibrating a different rig is a navigation, so
   * the props never change under a mounted instance — and if they did, deriving
   * would throw away half-taken measurements the moment the route re-rendered.
   * `hydrate()` replaces this wholesale with the stored or discovered rig.
   */
  function seedProfile(): OpticalProfile {
    return { ...defaultOpticalProfile(), rigName };
  }
  let profile = $state<OpticalProfile>(seedProfile());
  /**
   * True once `hydrate()` has installed the stored or discovered profile.
   *
   * `onMount` fires `hydrate()` without awaiting it, so the wizard's first
   * paint happens before that IPC round trip settles. A preset applied in that
   * gap would patch the seeded default and then be silently overwritten the
   * moment `hydrate()` replaces `profile` wholesale — so the preset step
   * withholds its cards until this is true.
   */
  let hydrated = $state(false);
  /** Steps answered in THIS sitting, plus whatever the stored rig already had. */
  let answered = $state<OpticalCalibrationStep[]>([]);
  /** True once anything has been touched, so leaving can warn rather than lose it. */
  let dirty = $state(false);
  /** Set just before the wizard navigates away itself, so its own exit is clean. */
  let finished = $state(false);
  /**
   * True while `finish()` is mid-save, so a second press cannot start a second one.
   *
   * Finishing is two settings writes in a row, and `patchSettings` reads the
   * store's revision when it is CALLED, not when it lands. Two overlapping
   * finishes therefore both start from the same revision, and the later write
   * is rejected as stale — which would drop the mirror axes exactly the way
   * this screen used to drop them. One at a time is the whole guarantee.
   */
  let finishing = $state(false);

  let displays = $state<DisplayDescriptor[]>([]);
  let loadError = $state<string | null>(null);
  const display = $derived(displays.find((d) => d.fingerprint === displayFingerprint) ?? null);

  /**
   * The panel, in the structural shape the shared modules take.
   *
   * `DisplayDescriptor` lives in the control layer and `shared/` may not depend
   * on it, so discovery and the Sidecar heuristic both accept the three fields
   * they actually need. Projecting here keeps that boundary in one place rather
   * than at every call.
   */
  const sidecarDisplayShape = $derived(
    display
      ? {
          ...(display.name === undefined ? {} : { name: display.name }),
          physicalSize: display.physicalSize,
          scaleFactor: display.scaleFactor,
        }
      : null,
  );

  /** Just enough of the panel for discovery, which must not import control types. */
  const shape = $derived(
    display
      ? {
          name: display.name,
          physicalSize: display.physicalSize,
          scaleFactor: display.scaleFactor,
        }
      : null,
  );
  const identification = $derived(identifyHardware(shape));

  /**
   * The panel in the units the stage lays out in.
   *
   * CSS pixels, not device pixels: a display running at 2x would otherwise
   * resolve to half the true millimetres per pixel and every size on the glass
   * would come out at half the angle it was asked for.
   */
  const viewport = $derived(
    display
      ? { widthPx: display.logicalSize.width, heightPx: display.logicalSize.height }
      : null,
  );

  const resolved = $derived(
    viewport ? resolveStageGeometry({ profile, viewport }) : null,
  );
  const optics = $derived(resolved?.optics ?? null);

  function patchProfile(patch: Partial<OpticalProfile>): void {
    profile = { ...profile, ...patch };
    dirty = true;
  }

  /* ---------------------------------------------------------- step: preset */

  /**
   * Apply a named rig's starting values to the WORKING profile, and nowhere else.
   *
   * A preset sets both mirror axes, and it used to write them straight into the
   * `teleprompter` settings a real take renders from, so that the glass could
   * redraw. It does not need to: `calibrationStageSettings()` builds the live
   * preview out of `profile.flips`, so `patchProfile` alone is already enough
   * to turn the glass around. Writing settings here made the leave-without-
   * saving prompt a lie — the mirror change outlived the Discard it claimed to
   * have dropped, and the next take opened flipped with nothing on screen to
   * explain it. Within this wizard, `finish()` is now the only place that puts
   * a flip anywhere permanent.
   */
  function applyPreset(preset: OpticalRigPreset): void {
    patchProfile(opticalProfileFieldsForPreset(preset));
  }

  /** Whether every field a preset owns already matches it — for the selected card, not for persistence. */
  function matchesPreset(preset: OpticalRigPreset): boolean {
    return profileMatchesPreset(profile, preset);
  }

  /* -------------------------------------------------------------- arrival */

  onMount(() => {
    /*
     * Leaving with unsaved measurements is a real loss, so it is asked about.
     * Registered rather than hung off the back button because the sidebar, a
     * keyboard shortcut and Present can all navigate too.
     */
    const unregister = registerNavigationGuard(async () => {
      if (!dirty || finished) return true;
      return await requestConfirm({
        title: 'Leave without saving?',
        body: 'The measurements you have taken here have not been applied to this display yet.',
        confirmLabel: 'Discard',
        danger: true,
      });
    });

    // The stage open waits on this: it may only put a window on the prompter
    // once the display list says there IS a prompter. See `openCalibrationStage`.
    const hydration = hydrate();
    const teardown = openCalibrationStage(hydration);
    const unwatchEscape = watchStageEscape();

    return () => {
      unregister();
      unwatchEscape();
      void teardown();
    };
  });

  /**
   * Start from what is already known: the stored rig if there is one, otherwise
   * whatever discovery can work out from the panel itself.
   *
   * Discovery is deliberately given the stored profile when one exists, because
   * its own rule is that a saved scale WINS over a freshly derived one — a
   * ruler measurement describes the finished optical path, including a
   * beamsplitter that magnifies, while a model lookup only describes the panel.
   */
  async function hydrate(): Promise<void> {
    loadError = null;
    try {
      displays = await stageService.listDisplays();
    } catch (err) {
      displays = [];
      loadError = `CandidCue could not list the connected displays. ${describeError(err)}`;
    }

    const panel = displays.find((d) => d.fingerprint === displayFingerprint) ?? null;
    const existing = $settings.optical.profiles[opticalRigKey(displayFingerprint, rigName)] ?? null;
    const found = discoverProfile(
      panel
        ? { name: panel.name, physicalSize: panel.physicalSize, scaleFactor: panel.scaleFactor }
        : null,
      existing,
    );
    const completed = existing?.completedSteps ?? [];
    profile = {
      ...found.profile,
      rigName,
      /*
       * Mirroring starts from whatever is ALREADY in force, unless this rig has
       * an answer of its own.
       *
       * `finish()` writes both axes every time — that is what stops the
       * profile's record and `teleprompter.mirrorX/mirrorY` drifting apart — so
       * the working profile has to arrive holding the truth, or Apply would
       * switch OFF a mirror the operator set on the Stage display screen and
       * never revisited in here. That is this screen's original defect pointed
       * the other way: the wizard changing a global nobody touched in it.
       *
       * `defaultOpticalProfile()` starts unflipped and `discoverProfile` always
       * lists orientation outstanding — it is the one fact no code can derive —
       * so square glass on a fresh rig is an ABSENCE of an answer, not an
       * answer, which is exactly the ambiguity `completedSteps` exists to
       * settle. A rig that HAS answered orientation keeps its own record; one
       * that has not adopts the display's current mirroring, which also makes
       * the orientation card an honest question: it is drawn the way a real
       * take would draw it rather than from an assumed-square start.
       */
      flips: completed.includes('orientation')
        ? found.profile.flips
        : {
            horizontal: $settings.teleprompter.mirrorX,
            vertical: $settings.teleprompter.mirrorY,
          },
    };
    answered = completed;
    // Discovery filling fields in is not the user having answered anything, so
    // the sequence still starts clean and nothing here counts as dirty yet.
    dirty = false;
    hydrated = true;
  }

  /* ---------------------------------------------------------- the stage */

  /**
   * The wizard's own stage window.
   *
   * A calibration stage carries no document on purpose. The cards are
   * self-sufficient (stage/renderer/CalibrationCard.svelte) and a script would
   * only put words on the glass that the presenter is not being asked about —
   * so this opens a bare stage and drives it with directives.
   */
  const stageSessionId = `calibrate-${Date.now().toString(36)}`;
  let stageGeneration = $state(0);
  let stageLive = $state(false);
  let stageError = $state<string | null>(null);
  /**
   * A window EXISTS on the panel — which is not the same question as `stageLive`.
   *
   * `stageLive` means the stage is loaded and taking cards. Between `openStage`
   * resolving and that point there is already a borderless, always-on-top window
   * covering the display, and the load can also fail outright and leave one
   * there. Anything whose job is to take that window down has to ask this
   * question rather than `stageLive`, or the very state that needs rescuing is
   * the one it refuses to act on. Not `$state`: nothing renders it.
   */
  let stageOpened = false;

  function openCalibrationStage(hydration: Promise<void>): () => Promise<void> {
    let closed = false;

    void (async () => {
      // The display list decides whether a window may be opened at all, so the
      // open waits for it rather than racing it.
      await hydration.catch(() => {});
      if (closed) return;

      /*
       * A CALIBRATION STAGE MUST NOT OPEN ON THE PANEL DRIVING THE WIZARD
       * ----------------------------------------------------------------------
       * `open_stage` builds a borderless window sized to the whole monitor and
       * marks it `always_on_top` (`windows/mod.rs`) — correct for a prompter
       * sitting behind glass, and a trap anywhere else.
       *
       * With one display connected `chooseStageDisplay` has nothing to choose
       * and hands back the panel the control window is on (`lib/start-take.ts`
       * documents that fallback), so Settings offered Calibrate for it and this
       * function covered the wizard with an opaque window that could not be
       * dismissed: the stage holds no command permissions (`capabilities/stage.json`),
       * its dock buttons emit events this route never listened for, and its
       * Escape was stamped with generation 0 and dropped in Rust. Quitting the
       * app was the only way out, which is how it was reported.
       *
       * So the window is not opened. Every step still WRITES correctly without
       * a stage — that is what `stageError` below already exists to say — and on
       * a single-panel machine it is the honest answer anyway: a rig is a
       * measurement of a physical viewing arrangement, and there is no second
       * panel here to measure one on.
       */
      if (loadError !== null) {
        // `hydrate` could not enumerate the displays and has already said so.
        // Reading a display COUNT off the empty list it left behind would add a
        // second, more confident-sounding diagnosis of a fact nobody knows.
        stageError =
          'The prompt window was not opened, because CandidCue could not tell which displays are connected.';
        return;
      }
      if (displays.length <= 1 || (await targetIsControlPanel())) {
        stageError =
          'Calibration needs a second display: the prompt window has to open on the panel you read from, and opening it on the panel showing this wizard would cover it up. Connect the prompter display, make it the one this window is NOT on, and open this screen again — every measurement here still saves without it, you just cannot judge it by eye.';
        return;
      }

      try {
        const opened = await stageService.openStage({ displayFingerprint, sessionId: stageSessionId });
        if (closed) {
          await stageService.closeStage(stageSessionId).catch(() => {});
          return;
        }
        stageGeneration = opened.stageGeneration;
        stageOpened = true;
        await stageService.setStageFullscreen(stageSessionId, true);
        const listening = await awaitStageListening(opened.stageGeneration, () => closed);
        if (closed) return;
        if (!listening) {
          /*
           * Close it again rather than leaving it there.
           *
           * A stage whose bundle never ran cannot show a calibration card, and
           * it cannot be dismissed from the glass either — Escape is emitted by
           * that bundle, so there is nothing on the panel to press. What is left
           * is a black, borderless, always-on-top rectangle over the display
           * with no owner, which is the exact shape of the fault this whole
           * function was rewritten for.
           */
          const gone = await stageService
            .closeStage(stageSessionId)
            .then(() => true)
            .catch(() => false);
          // Same rule as `dismissStage`: only give up ownership once the window
          // is actually gone, so a close that failed can still be retried.
          if (gone) stageOpened = false;
          stageError = gone
            ? 'The prompt window opened but never finished loading, so it was closed again. Every measurement here still saves — you just cannot judge it by eye.'
            : 'The prompt window opened but never finished loading, and would not close either. Leave this screen to take it down.';
          return;
        }
        stageLive = true;
      } catch (err) {
        // Said here, next to the sequence it blocks. Every step still WRITES
        // correctly without a stage — it just cannot be judged by eye.
        stageError = `CandidCue could not open the prompt window on this display. ${describeError(err)}`;
      }
    })();

    return async () => {
      closed = true;
      stageLive = false;
      stageOpened = false;
      await stageService
        .publishStageDirective(stageSessionId, stageGeneration, {
          kind: 'calibration',
          active: false,
        })
        .catch(() => {});
      await stageService.closeStage(stageSessionId).catch(() => {});
    };
  }

  /**
   * Is the panel being calibrated the one this window is sitting on?
   *
   * A display COUNT is not the real question — it is a proxy that happens to be
   * right on a one-panel machine. The real one is whether the borderless
   * always-on-top window is about to land on top of the wizard driving it, and
   * with two displays that can still happen: a pinned fingerprint wins in
   * `chooseStageDisplay` (`lib/start-take.ts`), so an operator who pinned their
   * primary panel and then dragged the control window onto it gets exactly the
   * fault this guard exists to prevent.
   *
   * Matched on position and physical size, which is the same rule Rust uses to
   * line a monitor up with its descriptor (`windows/mod.rs`).
   *
   * FAILS OPEN, deliberately, and this is a considered disagreement with review
   * feedback that wanted the opposite. A false NO costs a covered wizard that
   * Escape and leaving the route can both now recover from. A false YES refuses
   * to calibrate at all — on the two-display rig that is the entire point of the
   * feature, for anyone whose monitor CandidCue cannot line up against its own
   * enumeration. The recoverable failure is the one to take.
   */
  async function targetIsControlPanel(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    try {
      const { currentMonitor } = await import('@tauri-apps/api/window');
      const monitor = await currentMonitor();
      if (!monitor) return false;
      const here = displays.find(
        (d) =>
          d.physicalPosition.x === monitor.position.x &&
          d.physicalPosition.y === monitor.position.y &&
          d.physicalSize.width === monitor.size.width &&
          d.physicalSize.height === monitor.size.height,
      );
      return here !== undefined && here.fingerprint === displayFingerprint;
    } catch {
      return false;
    }
  }

  /** Close the prompt window and say so, leaving the measurements untouched. */
  async function dismissStage(): Promise<void> {
    // `stageOpened`, not `stageLive`: a window that came up and never went live
    // is the one most in need of being taken down. See `stageOpened`.
    if (!stageOpened) return;
    stageLive = false;
    await stageService
      .publishStageDirective(stageSessionId, stageGeneration, {
        kind: 'calibration',
        active: false,
      })
      .catch(() => {});
    try {
      await stageService.closeStage(stageSessionId);
    } catch (err) {
      /*
       * Ownership is NOT surrendered on a failed close.
       *
       * Clearing `stageOpened` here would make the next Escape return at the
       * guard above, so the window would still be covering the panel and the
       * one key that could take it down would have been quietly disarmed —
       * with a message on screen claiming it had been closed. Keeping
       * ownership means a second press tries again.
       */
      stageError = `The prompt window would not close. ${describeError(err)} Press Escape on the prompter again, or leave this screen to take it down.`;
      return;
    }
    stageOpened = false;
    /*
     * Deliberately does NOT say "leave this screen".
     *
     * Leaving is what the navigation guard catches, and the only button on
     * that prompt that actually leaves is Discard — so the old wording sent an
     * operator who had lost the preview to the one action that throws away
     * every measurement in the sentence before it. Finishing keeps the work
     * AND is the thing that lets the window come back.
     */
    stageError =
      'The prompt window was closed from the prompter. Everything measured here is still here — carry on and apply the rig when you are ready. Opening Calibrate again after it is saved puts the window back.';
  }

  /**
   * Escape on the glass closes the prompt window.
   *
   * The window this route opens is borderless, covers a whole panel and sits
   * above everything (`windows/mod.rs`). A presenter who wants out of it presses
   * Escape, and until now this route was not listening: the press reached
   * control as `escapeRequested` and no handler anywhere owned a CALIBRATION
   * stage, so the only exit was quitting the app. The Settings preview has had
   * this listener for the same reason and its comment says the same thing.
   *
   * Two presses, not one, because that is the rule the stage itself shows a
   * prompt for (`StageApp.sendEscape`) — the same key means the same thing on
   * every screen. Generation-checked, so a take running beside this wizard can
   * never be ended by it.
   */
  function watchStageEscape(): () => void {
    if (!isTauriRuntime()) return () => {};
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<StageEscapePayload>(STAGE_EVENT.escapeRequested, (event) => {
        if (event.payload.stageGeneration !== stageGeneration) return;
        if (event.payload.presses < 2) return;
        void dismissStage();
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    })().catch(() => {
      // Without the listener the glass cannot dismiss itself, but leaving this
      // route still tears the window down — so it is never unclosable.
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  /**
   * Wait until the stage webview is genuinely subscribed.
   *
   * `openStage` resolves when the WINDOW exists, which is a few hundred
   * milliseconds before its bundle has run and its listeners are installed. A
   * directive published into that gap is not queued anywhere — it is relayed to
   * a window that is not listening and is simply lost, and the first card never
   * appears. `waitForStageReady` cannot be reused here: it waits for a document
   * handshake, and a calibration stage deliberately has no document.
   */
  async function awaitStageListening(
    generation: number,
    // Checked every iteration, not just at the end: leaving the route while a
    // stage is still coming up otherwise left this loop polling `getStageStatus`
    // every 200ms for the rest of its 20s deadline — a hundred IPC round trips
    // asking after a window the teardown had already closed.
    isCancelled: () => boolean = () => false,
    deadlineMs = 20000,
  ): Promise<boolean> {
    const until = Date.now() + deadlineMs;
    for (;;) {
      if (isCancelled()) return false;
      const status = await stageService.getStageStatus().catch(() => null);
      if (isCancelled()) return false;
      if (status && status.stageGeneration === generation && status.listening) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * What the stage should be drawing for the step that is open.
   *
   * Note the two conversions. `crosshairX/Y` are fractions of the whole
   * VIEWPORT because the stage draws them against the window, while
   * `profile.lens` is a fraction of the SAFE rectangle because that is what
   * every consumer downstream resolves it against — so a hood that hides the
   * top of the panel must be folded back in on the way out and back off on the
   * way in, or the crosshair the operator lined up on the camera lands
   * somewhere else the moment the safe area is non-zero.
   */
  function calibrationDirective(): StageDirective {
    const insets = profile.safeArea;
    const usableX = Math.max(0, 1 - insets.left - insets.right);
    const usableY = Math.max(0, 1 - insets.top - insets.bottom);
    const mode = step.card;
    if (mode === null) return { kind: 'calibration', active: false };
    return {
      kind: 'calibration',
      active: true,
      mode,
      crosshairX: insets.left + profile.lens.x * usableX,
      crosshairY: insets.top + profile.lens.y * usableY,
      safeArea: insets,
      rulerLengthPx: rulerBarPx,
      sampleFontSizePx: optics ? Math.round(optics.bodyFontSizePx) : 64,
      sampleColumnCh: optics ? optics.columnCh : 34,
      sampleLabel: sampleLabel,
    };
  }

  /**
   * The appearance the cards are drawn with.
   *
   * Sent as a full `settings` directive rather than as extra fields on the
   * calibration one, because these are the SAME facts a take runs on — the
   * mirror axes, the text intensity, the resolved type — and the stage already
   * has one way to be told them. Without it the orientation card could never be
   * judged: it is drawn unmirrored, so a presenter who says "that reads
   * backwards" and flips the toggle needs the glass to redraw before they can
   * confirm they fixed it rather than doubled it.
   *
   * Note where the mirror axes come from: the WORKING profile, not
   * `$settings.teleprompter`. That is what lets the preview be live while the
   * settings stay untouched until Finish — the whole reason a flip can be tried
   * and abandoned here without following the operator into their next take.
   */
  function calibrationStageSettings(): StageSettings {
    return buildStageSettings({
      fontFamilyId: $settings.teleprompter.fontFamilyId,
      mirrorX: profile.flips.horizontal,
      mirrorY: profile.flips.vertical,
      textIntensity: profile.intensity,
      ...(viewport ? { optical: { profile, viewport } } : {}),
    });
  }

  /*
   * Pushed to the glass whenever the step or the working profile changes.
   *
   * Read synchronously so the effect actually depends on them: everything after
   * the first `await` is invisible to the tracker, which is how a "live preview"
   * quietly stops updating after its first frame.
   */
  $effect(() => {
    const directive = calibrationDirective();
    const stageSettings = calibrationStageSettings();
    if (!stageLive) return;
    void pushToStage(stageSettings, directive);
  });

  /**
   * One publish in flight, and only ever the newest state.
   *
   * A slider fires on every pointer move. Chaining each of those onto the last
   * would queue a hundred round trips and leave the glass seconds behind the
   * control; dropping them while one is in flight would leave the glass showing
   * an intermediate value the operator has already moved past. Coalescing keeps
   * the final position and nothing else.
   */
  let pendingPush: { stageSettings: StageSettings; directive: StageDirective } | null = null;
  let pushing = false;

  async function pushToStage(stageSettings: StageSettings, directive: StageDirective): Promise<void> {
    pendingPush = { stageSettings, directive };
    if (pushing) return;
    pushing = true;
    try {
      while (pendingPush !== null) {
        const next = pendingPush;
        pendingPush = null;
        await stageService.publishStageDirective(stageSessionId, stageGeneration, {
          kind: 'settings',
          settings: next.stageSettings,
        });
        await stageService.publishStageDirective(stageSessionId, stageGeneration, next.directive);
      }
    } catch (err) {
      stageError = `The prompt window stopped accepting changes. ${describeError(err)}`;
    } finally {
      pushing = false;
    }
  }

  /* -------------------------------------------------- step: orientation */

  /**
   * A flip is recorded in two places, and this is the only screen that may set
   * either of them.
   *
   * `profile.flips` is the RECORD — what this rig's glass does — and
   * `teleprompter.mirrorX/mirrorY` is what a real take actually renders from.
   * `buildStageSettings` takes mirroring as explicit arguments rather than
   * choosing a source: a take passes the Settings values, and this screen
   * passes `profile.flips` (honouring both at once would double-flip a rig).
   * Two homes for one physical fact can only stay consistent if one place
   * writes both, and within this wizard that place is `finish()` — the Stage
   * display screen still owns its own toggles.
   *
   * This writes only the record. Judging the step by eye still works, because
   * the preview does not come from the settings — `calibrationStageSettings()`
   * reads `profile.flips` and the effect below republishes it the moment
   * `patchProfile` reassigns `profile`, so the glass turns around on the same
   * frame it always did. Deferring the settings write is what makes the
   * leave-without-saving prompt honest: a flip tried out and abandoned no
   * longer follows the operator into their next take.
   */
  function setFlip(axis: 'horizontal' | 'vertical', value: boolean): void {
    patchProfile({ flips: { ...profile.flips, [axis]: value } });
  }

  /* ---------------------------------------------------------- step: scale */

  /**
   * The bar the operator holds a ruler against.
   *
   * Sized to the panel rather than fixed, because the whole measurement is only
   * as accurate as the bar is long — and a 400px bar that runs off the short
   * edge of a 1024x600 prompter is measured to the bezel and produces a scale
   * that is wrong by however much was cut off, silently.
   */
  const rulerBarPx = $derived(
    Math.max(120, Math.min(600, Math.round((viewport?.widthPx ?? 1024) * 0.55))),
  );

  let rulerMmField = $state('');
  let diagonalField = $state('');

  function applyRulerMeasurement(): void {
    const measuredMm = Number(rulerMmField.trim());
    const mmPerCssPx = mmPerCssPixelFromRuler({ barLengthPx: rulerBarPx, measuredMm });
    if (mmPerCssPx === null) {
      showToast('Type the length you measured, in millimetres.', 'danger');
      return;
    }
    /*
     * A ruler reading is checked against the panel it claims to describe.
     *
     * `mmPerCssPixelFromRuler` asks only for a positive number, and the typed
     * diagonal path is the one that carries `isPlausibleDiagonalMm` — so "56"
     * for a bar that measures 560 is accepted here, resolves to a scale ten
     * times too small, and every arcminute this screen then reports is wrong by
     * that factor with nothing NaN anywhere to notice. The resolver treats a
     * merely-positive scale as CALIBRATED, so the readout would state the wrong
     * answer confidently and the presenter would meet it on the glass.
     *
     * Multiplying back up by the panel's diagonal in pixels is the same
     * arithmetic `mmPerCssPixel` inverts, so the two entry methods now accept
     * exactly the same set of panels.
     */
    const impliedDiagonalMm = viewport
      ? mmPerCssPx * Math.hypot(viewport.widthPx, viewport.heightPx)
      : null;
    if (impliedDiagonalMm !== null && !isPlausibleDiagonalMm(impliedDiagonalMm)) {
      showToast(
        `That would make this panel about ${Math.round(impliedDiagonalMm / 25.4)} inches across the diagonal. Check the units and measure the bar again.`,
        'danger',
      );
      return;
    }
    patchProfile({ scale: { mmPerCssPx, source: 'ruler' } });
  }

  function applyTypedDiagonal(): void {
    const inches = Number(diagonalField.trim());
    if (!viewport) return;
    const diagonalMm = inchesToMm(inches);
    const mmPerCssPx = mmPerCssPixel({
      diagonalMm,
      widthPx: viewport.widthPx,
      heightPx: viewport.heightPx,
    });
    if (mmPerCssPx === null) {
      showToast('That is not a diagonal CandidCue can use. Type the size in inches.', 'danger');
      return;
    }
    patchProfile({ scale: { mmPerCssPx, source: 'diagonal', diagonalMm } });
  }

  function applyModelScale(): void {
    if (!shape) return;
    const found = discoverProfile(shape, null);
    if (found.profile.scale === null) {
      showToast('CandidCue does not know this panel’s physical size. Measure it instead.', 'info');
      return;
    }
    patchProfile({ scale: found.profile.scale });
  }

  const scaleSourceLabel = $derived(
    profile.scale === null
      ? 'Not measured'
      : profile.scale.source === 'ruler'
        ? 'Measured against the glass'
        : profile.scale.source === 'diagonal'
          ? 'From the diagonal you typed'
          : 'From the panel model',
  );

  /* ------------------------------------------------------- step: distance */

  /**
   * Metres, because that is the unit somebody pacing out a studio thinks in.
   *
   * Includes every distance a rig preset can set (0.6, 2.5, 3.0), so choosing
   * one on the preset step and then reaching this step later shows a chip
   * already selected rather than a blank field describing a value that is, in
   * fact, already in force.
   */
  const DISTANCE_PRESETS_M = [0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.5, 3.0];
  let distanceField = $state('');

  function setDistanceMm(mm: number): void {
    patchProfile({ viewingDistanceMm: mm });
  }

  function applyTypedDistance(): void {
    const metres = Number(distanceField.trim());
    const mm = Math.round(metres * 1000);
    if (!isPlausibleViewingDistanceMm(mm)) {
      showToast(
        `A viewing distance has to be between ${MIN_VIEWING_DISTANCE_MM / 1000} m and ${MAX_VIEWING_DISTANCE_MM / 1000} m.`,
        'danger',
      );
      return;
    }
    setDistanceMm(mm);
  }

  /**
   * Elgato publishes a comfortable-reading range per panel. Saying so is worth
   * more than refusing the number: a presenter who genuinely stands 5 m from a
   * 9-inch prompter is not making a typo, they are making a mistake, and the
   * two want different answers.
   */
  const distanceWarning = $derived.by(() => {
    const max = OPTICAL_HARDWARE[profile.hardwareKind].maxComfortableDistanceMm;
    const at = profile.viewingDistanceMm;
    if (max === null || at === null || at <= max) return null;
    return `${OPTICAL_HARDWARE[profile.hardwareKind].label} is rated for comfortable reading up to about ${(max / 1000).toFixed(1)} m.`;
  });

  /* -------------------------------------------------------- step: framing */

  const sampleLabel = $derived(
    optics?.bodyArcminutes === null || optics === null
      ? ''
      : `${Math.round(optics.bodyFontSizePx)} px · ${optics.bodyArcminutes!.toFixed(0)}′`,
  );

  /* ------------------------------------------------------------- readout */

  /**
   * How many lines of script the presenter can see at once.
   *
   * Not on `ResolvedOptics`, and it should not be: it is a consequence of the
   * safe height and the line pitch, which the stage measures for itself. This
   * is the control-side estimate of it, and it is the number that decides
   * whether a chosen size is generous or claustrophobic — six lines is a
   * paragraph of context, three is a card being read one phrase at a time.
   */
  const visibleLines = $derived.by(() => {
    if (!optics || !viewport) return null;
    const safeHeightPx = viewport.heightPx * (1 - optics.safeArea.top - optics.safeArea.bottom);
    const linePx = optics.bodyFontSizePx * optics.lineHeight;
    if (!(linePx > 0) || !(safeHeightPx > 0)) return null;
    return Math.floor(safeHeightPx / linePx);
  });

  const FIT_PHRASES: Record<string, string> = {
    ok: 'The size you asked for and a full reading line both fit on this panel.',
    width_limited: 'Type is at the size you asked for; the line is narrower than ideal.',
    angle_limited: 'A readable line needs the type smaller than you asked for.',
    impossible: 'This panel cannot do both at this distance.',
    uncalibrated: 'Not calibrated yet, so no claim about apparent size can be made.',
  };

  /* ---------------------------------------------------------- navigation */

  function markAnswered(): void {
    const token = step.records;
    if (token !== null && !answered.includes(token)) answered = [...answered, token];
  }

  function goNext(): void {
    markAnswered();
    if (isLastStep) {
      void finish();
      return;
    }
    stepIndex += 1;
  }

  function goSkip(): void {
    if (isLastStep) {
      void finish();
      return;
    }
    stepIndex += 1;
  }

  function goBack(): void {
    stepIndex = Math.max(0, stepIndex - 1);
  }

  /**
   * Write the rig and make it the one this panel runs with.
   *
   * `withOpticalProfile` does both in one move on purpose: a stored profile that
   * is not chosen changes nothing, and a panel pointed at a rig that was never
   * stored resolves to nothing. Splitting them is how a calibration ends up
   * saved and inert.
   *
   * This is also the ONLY place a flip becomes permanent. The orientation step
   * and the presets move `profile.flips` alone — enough for the glass to redraw,
   * not enough to survive a Discard — so the axes are copied into the
   * `teleprompter` settings a real take renders from here, at the one moment the
   * operator has actually said to keep this rig.
   *
   * Both axes go every time, including for a rig whose orientation step was
   * never opened. That is safe only because `hydrate()` seeds `profile.flips`
   * from the mirroring already in force when the rig has no orientation answer
   * of its own, so "wrote it unchanged" and "never asked" produce the same
   * value here. Take that seed away and this line starts CLEARING mirrors the
   * wizard was never shown.
   *
   * The two writes are awaited one after the other, never together. Optical
   * goes first because it is the calibration itself: if it cannot be stored
   * there is no rig to be mirrored for, and a global flip written against a
   * profile that failed to save is the orphaned state this change is about.
   *
   * They are sequential rather than concurrent for ordering, not for the
   * revision race — `toRustPatch` has no optical branch, so only the mirror
   * write reaches the backend and the two cannot collide over a revision. Two
   * overlapping FINISHES still could, which is what `finishing` is for.
   */
  async function finish(): Promise<void> {
    if (finishing) return;
    const name = profile.rigName.trim();
    if (name === '') {
      showToast('Give this rig a name so you can tell it from the others on this panel.', 'danger');
      // Not necessarily step 0: the preset step precedes 'hardware', which is
      // the step that actually owns the rig-name field.
      stepIndex = STEPS.findIndex((s) => s.id === 'hardware');
      return;
    }
    const next: OpticalProfile = { ...profile, rigName: name, completedSteps: answered };
    finishing = true;
    try {
      await patchSettings(
        'optical',
        withOpticalProfile($settings.optical, displayFingerprint, next),
      );
      // `next.flips`, not `profile.flips`: the awaits above are suspension
      // points, and the saved rig is the one that should reach the glass.
      await patchSettings('teleprompter', {
        mirrorX: next.flips.horizontal,
        mirrorY: next.flips.vertical,
      });
      finished = true;
      showToast(`${name} is now the rig this display runs with.`, 'success');
      await navigate({ name: 'settings', section: 'stage' });
    } catch {
      /*
       * patchSettings has already reverted and toasted; staying put is what
       * keeps the measurements on screen rather than losing them to a failed
       * write nobody could have anticipated.
       *
       * Note what a mirror-write failure leaves behind: the optical write ran
       * first and `withOpticalProfile` sets `activeRig`, so the rig is stored
       * AND already the one this panel runs with — only its mirroring did not
       * land. Pressing Apply again is the retry, and it is idempotent.
       */
    } finally {
      finishing = false;
    }
  }

  const HARDWARE_OPTIONS = (Object.keys(OPTICAL_HARDWARE) as OpticalHardwareKind[]).map((kind) => ({
    value: kind,
    label: OPTICAL_HARDWARE[kind].label,
  }));
</script>

<div class="page">
  <Toolbar
    title="Calibrate this display"
    detail={display?.name ?? 'Display'}
    backLabel="Stage display"
    onback={() => void navigate({ name: 'settings', section: 'stage' })}
  >
    {#snippet status()}
      <!--
        A status LIGHT plus text, not a pill (§9.4, §12.3).
        This is a continuous health state — is the prompter showing? — which is
        exactly the category §9.4 says to draw as a light and a word. It also
        keeps its place and its width as the state changes, so the toolbar does
        not shuffle while the stage is coming up.
      -->
      <span
        class="stage-state"
        class:good={stageLive}
        class:bad={stageError !== null}
        aria-live="polite"
      >
        <span class="state-dot" aria-hidden="true"></span>
        {#if stageLive}
          Showing on the prompter
        {:else if stageError}
          No prompt window
        {:else}
          Opening the prompter…
        {/if}
      </span>
    {/snippet}
  </Toolbar>

  <div class="body">
    <!-- The whole sequence, always visible. A wizard that hides its own length
         cannot be judged as worth starting, and every one of these can be
         skipped — which only helps if you can see what you are skipping. -->
    <nav class="steps" aria-label="Calibration steps">
      {#each STEPS as entry, index (entry.id)}
        <button
          type="button"
          class="step-item"
          class:active={index === stepIndex}
          class:done={entry.records !== null && answered.includes(entry.records)}
          aria-current={index === stepIndex ? 'step' : undefined}
          onclick={() => (stepIndex = index)}
        >
          <span class="step-num">{index + 1}</span>
          <span class="step-name">{entry.title}</span>
          {#if entry.records !== null && answered.includes(entry.records)}
            <span class="step-tick"><Icon name="check" size={14} /></span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="workspace">
    <div class="content">
      {#if loadError}
        <p class="inline-alert" role="alert">{loadError}</p>
      {/if}
      {#if stageError}
        <p class="inline-alert" role="alert">{stageError}</p>
      {/if}

      <div class="step-head">
        <h2 class="step-title">{step.title}</h2>
        <p class="step-lead">{step.lead}</p>
      </div>

      {#if step.id === 'preset'}
        {#if !hydrated}
          <p class="hint-line">Loading what CandidCue already knows about this display…</p>
        {:else}
          <div class="preset-grid" role="group" aria-label="Rig presets">
            {#each RIG_PRESETS as preset (preset.id)}
              <button
                type="button"
                class="preset-card"
                class:selected={matchesPreset(preset)}
                aria-pressed={matchesPreset(preset)}
                onclick={() => applyPreset(preset)}
              >
                <span class="preset-name">{preset.label}</span>
                <span class="preset-description">{preset.description}</span>
              </button>
            {/each}
          </div>
          <p class="hint-line">
            Not sure, or using something else entirely? Skip this — CandidCue will start from what
            it already knows about this display, and every field below stays open to correction.
          </p>
        {/if}
      {:else if step.id === 'hardware'}
        <TextField
          label="Rig name"
          value={profile.rigName}
          hint="One panel often holds several arrangements — “Desk hood” and “Boom arm” are two rigs, not one."
          oninput={(value) => patchProfile({ rigName: value })}
        />
        <Select
          label="Hardware"
          value={profile.hardwareKind}
          options={HARDWARE_OPTIONS}
          onchange={(value) => patchProfile({ hardwareKind: value as OpticalHardwareKind })}
        />
        <p class="hint-line">
          {#if identification.confidence === 'model'}
            Identified from the display’s own name: {identification.label}.
          {:else if identification.confidence === 'resolution'}
            {identification.label}
          {:else}
            CandidCue could not recognise this panel, so it will ask you to measure it.
          {/if}
        </p>
        <!--
          Sidecar is the one rig where the things that ruin a take are invisible
          from inside the app: a mirrored rather than extended desktop, the
          sidebar and Touch Bar eating the safe area, an iPad app suspending the
          session mid-sentence. The checklist renders itself away when the
          display is not one, so it costs nothing on every other rig.

          Here rather than at the end because two of its items — sidebar and
          Touch Bar off — change the geometry that the safe-area step is about
          to measure. Ticking them afterwards would mean measuring an aperture
          that is about to move.
        -->
        <SidecarChecklist
          display={sidecarDisplayShape}
          hardwareKind={profile.hardwareKind}
          {viewport}
          onapplysafearea={(insets) => patchProfile({ safeArea: insets })}
        />
      {:else if step.id === 'scale'}
        <div class="readout-row">
          <span class="readout-label">Physical scale</span>
          <span class="readout-value">
            {profile.scale ? `${profile.scale.mmPerCssPx.toFixed(4)} mm per pixel` : '—'}
          </span>
          <span class="readout-note">{scaleSourceLabel}</span>
        </div>
        <p class="hint-line">
          A ruler held against the glass is the only method that measures the finished optical path,
          so it absorbs a beamsplitter that magnifies and a panel that overscans. The other two
          describe the panel alone.
        </p>
        <div class="row-actions">
          <Button
            disabled={identification.diagonalInches === null}
            onclick={() => applyModelScale()}
          >
            Use the known size
          </Button>
        </div>
        <div class="measure-row">
          <TextField
            label="Measured length of the bar on the prompter (mm)"
            value={rulerMmField}
            placeholder={`Bar is ${rulerBarPx} px wide`}
            oninput={(value) => (rulerMmField = value)}
            onsubmit={() => applyRulerMeasurement()}
          />
          <Button variant="primary" onclick={() => applyRulerMeasurement()}>Use this</Button>
        </div>
        <div class="measure-row">
          <TextField
            label="Or type the panel’s diagonal (inches)"
            value={diagonalField}
            oninput={(value) => (diagonalField = value)}
            onsubmit={() => applyTypedDiagonal()}
          />
          <Button onclick={() => applyTypedDiagonal()}>Use this</Button>
        </div>
      {:else if step.id === 'safe-area'}
        <Slider
          label="Top"
          value={Math.round(profile.safeArea.top * 100)}
          min={0}
          max={45}
          format={(v) => `${v}%`}
          onchange={(value) =>
            patchProfile({ safeArea: { ...profile.safeArea, top: value / 100 } })}
        />
        <Slider
          label="Bottom"
          value={Math.round(profile.safeArea.bottom * 100)}
          min={0}
          max={45}
          format={(v) => `${v}%`}
          onchange={(value) =>
            patchProfile({ safeArea: { ...profile.safeArea, bottom: value / 100 } })}
        />
        <Slider
          label="Left"
          value={Math.round(profile.safeArea.left * 100)}
          min={0}
          max={45}
          format={(v) => `${v}%`}
          onchange={(value) =>
            patchProfile({ safeArea: { ...profile.safeArea, left: value / 100 } })}
        />
        <Slider
          label="Right"
          value={Math.round(profile.safeArea.right * 100)}
          min={0}
          max={45}
          format={(v) => `${v}%`}
          onchange={(value) =>
            patchProfile({ safeArea: { ...profile.safeArea, right: value / 100 } })}
        />
        <p class="hint-line">
          Every piece of geometry below is computed inside this rectangle, so a frame set too
          generously pushes the text under the bezel where you cannot read it.
        </p>
      {:else if step.id === 'orientation'}
        <Toggle
          checked={profile.flips.horizontal}
          label="Mirror horizontally"
          description="A glass rig reflects the panel, so the script has to be flipped to read forwards"
          onchange={(value) => setFlip('horizontal', value)}
        />
        <Toggle
          checked={profile.flips.vertical}
          label="Mirror vertically"
          onchange={(value) => setFlip('vertical', value)}
        />
        <p class="hint-line">
          The card on the prompter changes as you flip these. The eye marked <strong>L</strong> must
          sit on the left, and every word on it must read the right way round.
        </p>
      {:else if step.id === 'lens'}
        <Slider
          label="Across"
          value={Math.round(profile.lens.x * 100)}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          onchange={(value) => patchProfile({ lens: { ...profile.lens, x: value / 100 } })}
        />
        <Slider
          label="Down"
          value={Math.round(profile.lens.y * 100)}
          min={10}
          max={90}
          format={(v) => `${v}%`}
          onchange={(value) => patchProfile({ lens: { ...profile.lens, y: value / 100 } })}
        />
        <p class="hint-line">
          Down is also the reading band — the height your eyeline rests at for the whole take. A
          camera that sits off-centre pulls your gaze sideways, which a viewer notices about twice as
          readily as a vertical shift.
        </p>
      {:else if step.id === 'distance'}
        <div class="chip-row" role="group" aria-label="Viewing distance">
          {#each DISTANCE_PRESETS_M as metres (metres)}
            <button
              type="button"
              class="chip"
              class:selected={profile.viewingDistanceMm === Math.round(metres * 1000)}
              aria-pressed={profile.viewingDistanceMm === Math.round(metres * 1000)}
              onclick={() => setDistanceMm(Math.round(metres * 1000))}
            >
              {metres.toFixed(1)} m
            </button>
          {/each}
        </div>
        <div class="measure-row">
          <TextField
            label="Or measure it (metres)"
            value={distanceField}
            oninput={(value) => (distanceField = value)}
            onsubmit={() => applyTypedDistance()}
          />
          <Button onclick={() => applyTypedDistance()}>Use this</Button>
        </div>
        {#if distanceWarning}
          <p class="hint-line">{distanceWarning}</p>
        {/if}
      {:else if step.id === 'text-size'}
        <Slider
          label="More text on screen ⟷ Larger, easier text"
          value={Math.round(profile.bias * 100)}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          onchange={(value) => patchProfile({ bias: value / 100 })}
        />
        <p class="hint-line">
          One control rather than two, because on a fixed panel size and line length are the same
          decision: bigger type is fewer words at a time.
        </p>
      {:else if step.id === 'line-width'}
        <Select
          label="How you are framed"
          value={profile.framing}
          options={[
            { value: 'close-up', label: 'Close-up' },
            { value: 'head-and-shoulders', label: 'Head and shoulders' },
            { value: 'waist-up', label: 'Waist up' },
            { value: 'full-body', label: 'Full body' },
          ]}
          onchange={(value) =>
            patchProfile({ framing: value as OpticalProfile['framing'] })}
        />
      {:else}
        <SegmentedControl
          label="Text intensity"
          value={profile.intensity}
          options={[
            { value: 'soft', label: 'Soft' },
            { value: 'standard', label: 'Standard' },
            { value: 'strong', label: 'Strong' },
          ]}
          onchange={(value) => patchProfile({ intensity: value as TextIntensity })}
        />
        <SegmentedControl
          label="Reading cue"
          value={profile.readingCue}
          options={[
            { value: 'ticks', label: 'Ticks' },
            { value: 'wash', label: 'Wash' },
            { value: 'none', label: 'None' },
          ]}
          onchange={(value) => patchProfile({ readingCue: value as ReadingCueStyle })}
        />
      {/if}

      <!-- The live answer, on every step. What makes the maths trustworthy is
           watching it move while you change something. -->
      {#if optics}
        <dl class="readout">
          <div class="readout-row">
            <dt class="readout-label">Body text</dt>
            <dd class="readout-value">
              {Math.round(optics.bodyFontSizePx)} px
              {#if optics.bodyArcminutes !== null}· {optics.bodyArcminutes.toFixed(0)}′{/if}
            </dd>
          </div>
          <div class="readout-row">
            <dt class="readout-label">Line holds</dt>
            <dd class="readout-value">
              {optics.charactersPerLine === null
                ? '—'
                : `about ${Math.round(optics.charactersPerLine)} characters`}
            </dd>
          </div>
          <div class="readout-row">
            <dt class="readout-label">Visible</dt>
            <dd class="readout-value">
              {visibleLines === null ? '—' : `about ${visibleLines} lines`}
            </dd>
          </div>
          <div class="readout-row">
            <dt class="readout-label">Fit</dt>
            <dd class="readout-value">{FIT_PHRASES[optics.fitVerdict] ?? optics.fitVerdict}</dd>
          </div>
        </dl>
        {#each resolved?.warnings ?? [] as warning (warning)}
          <p class="hint-line">{warning}</p>
        {/each}
      {/if}

    </div>

    <!--
      PINNED, and the positions never move (§15.1).

      These used to sit at the bottom of the scrolling content, so on a long step
      they were below the fold and on a short one they floated mid-screen — and
      Back/Skip/Next changed x-position with the width of their own labels. §15.1
      asks for a workflow footer whose controls are in the same place on every
      step: Back on the left, the primary on the right, and the escape hatch
      beside it without competing.
    -->
    <div class="step-actions">
      <Button disabled={stepIndex === 0} onclick={() => goBack()}>Back</Button>
      <span class="step-actions-spacer"></span>
      <Button variant="ghost" disabled={finishing} onclick={() => goSkip()}>
        {isLastStep ? 'Finish without this' : 'Skip'}
      </Button>
      <Button variant="primary" disabled={finishing} onclick={() => goNext()}>
        {isLastStep ? 'Apply this rig' : 'Next'}
      </Button>
    </div>
    </div>
  </div>
</div>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }

  /*
   * The prompter's state: a light and a word (§9.4, §12.3).
   *
   * A fixed-width dot beside text that changes, so the toolbar's geometry is
   * the same whichever of the three states is showing — and the state is never
   * carried by colour alone, because the words say it too.
   */
  .stage-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .state-dot {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .stage-state.good .state-dot {
    background: var(--success);
  }
  .stage-state.bad .state-dot {
    background: var(--warning);
  }

  .steps {
    /* 200px, from 248: the rail carries a number and a short label, and the
       extra 48px was buying nothing but distance from the work (§15.2). */
    flex: 0 0 200px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-3) var(--space-2);
    overflow-y: auto;
  }
  .step-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    min-height: 34px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .step-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /* Flat, per §15.2 — a tonal fill, no elevation, no raised card. */
  .step-item.active,
  .step-item.active:hover {
    background: var(--bg-row-selected);
    border-color: transparent;
    box-shadow: none;
    color: var(--text-primary);
  }
  .step-num {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .step-name {
    min-width: 0;
    flex: 1 1 auto;
  }
  .step-tick {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--success);
  }
  .step-item.done .step-num {
    color: var(--success);
  }

  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-5) var(--page-x) var(--space-6);
    /* A comfortable reading measure for the instructions, kept as a MAX rather
       than a width so the remaining space stays available to the readouts
       (§15.3) instead of being padded out into nothing. */
    max-width: 680px;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .step-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .step-title {
    margin: 0;
    font-size: var(--text-section);
    line-height: var(--lh-section);
    font-weight: 600;
    color: var(--text-primary);
  }
  .step-lead {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .hint-line {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .inline-alert {
    margin: 0;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--danger);
  }

  .row-actions,
  .chip-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .measure-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .measure-row :global(.field) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .chip {
    min-height: var(--button-h);
    padding-inline: 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-control);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .chip:hover {
    background: var(--bg-hover-surface);
  }
  .chip.selected,
  .chip.selected:hover {
    background: var(--accent-wash);
    border-color: var(--border-strong);
  }

  .preset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-2);
  }
  .preset-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-control);
    background: var(--bg-elevated);
    text-align: left;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .preset-card:hover {
    background: var(--bg-hover-surface);
  }
  .preset-card.selected,
  .preset-card.selected:hover {
    background: var(--accent-wash);
    border-color: var(--border-strong);
  }
  .preset-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .preset-description {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .readout {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .readout-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
  }
  .readout-label {
    flex: 0 0 120px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .readout-value {
    margin: 0;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .readout-note {
    font-size: var(--text-meta);
    color: var(--text-faint);
  }

  /*
   * The workspace column: scrolling content above, pinned actions below.
   * `min-height: 0` on both so the content is what scrolls rather than the
   * column growing and pushing the action bar off the bottom of the window.
   */
  .workspace {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .step-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--page-x);
    border-top: var(--divider-w) solid var(--divider);
    background: var(--bg-toolbar);
  }
  /* Back on the left, everything else on the right — a fixed geometry, so the
     primary action is in the same place on every step (§15.1). */
  .step-actions-spacer {
    flex: 1 1 auto;
  }

  @media (max-width: 760px) {
    .steps {
      flex-basis: 180px;
    }
  }
</style>

