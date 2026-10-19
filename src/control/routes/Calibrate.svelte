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
  import { onMount, tick } from 'svelte';
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
  import {
    opticalRigKey,
    panelMirrorFor,
    withOpticalProfile,
    withPanelMirror,
  } from '../services/settings-types';
  import type { DisplayDescriptor } from '../services/stage-types';
  import SidecarChecklist from '../components/SidecarChecklist.svelte';
  import {
    OPTICAL_HARDWARE,
    STAGE_EVENT,
    defaultOpticalProfile,
    type OpticalCalibrationStep,
    type LensPlacement,
    type OpticalHardwareKind,
    type OpticalProfile,
    type ReadingCueStyle,
    type SafeAreaInsets,
    type StageCalibrationMode,
    type StageDirective,
    type StageEscapePayload,
    type StageSettings,
    type TextIntensity,
  } from '../../shared/contracts';
  import {
    AUTOMATIC_RIG_NAME,
    discoverProfile,
    identifyHardware,
  } from '../../shared/optical-discovery';
  import { resolveStageGeometry } from '../../shared/optical-resolve';
  import type { SidecarCheckId } from '../../shared/sidecar';
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

  /**
   * The three tasks the ten questions add up to.
   *
   * Ten equal rows read as ten chores. They are really three jobs — say what
   * the rig is, fit the picture to the glass, then tune how the words read —
   * and the rail and the step header both say which one is under way, so the
   * fine-tuning at the end reads as optional polish rather than more setup.
   */
  type WizardPhaseId = 'rig' | 'glass' | 'reading';

  const PHASES: Array<{ id: WizardPhaseId; title: string }> = [
    { id: 'rig', title: 'Identify the rig' },
    { id: 'glass', title: 'Fit the glass' },
    { id: 'reading', title: 'Tune the reading' },
  ];

  interface WizardStep {
    id: WizardStepId;
    title: string;
    /** The rail's name for the step: a noun, short enough for one line. */
    label: string;
    phase: WizardPhaseId;
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
      label: 'Preset',
      phase: 'rig',
      title: 'Start from a preset?',
      lead: 'Pick the arrangement closest to yours to fill in the obvious answers. Every one of them stays open to correction on the steps ahead.',
      records: null,
      card: null,
    },
    {
      id: 'hardware',
      label: 'Hardware',
      phase: 'rig',
      title: 'Which prompter is this?',
      lead: 'CandidCue has already looked. Correct it if it guessed wrong, and give this arrangement a name you will recognise.',
      records: 'hardware',
      card: null,
    },
    {
      id: 'scale',
      label: 'Scale',
      phase: 'rig',
      title: 'How big is the picture, really?',
      lead: 'Everything else rests on this: how many millimetres one pixel is worth on this glass.',
      records: null,
      card: 'ruler',
    },
    {
      id: 'safe-area',
      label: 'Visible area',
      phase: 'glass',
      title: 'What can you actually see?',
      lead: 'Move each edge in until the whole frame is inside what the hood reveals.',
      records: 'safe-area',
      card: 'safe-area',
    },
    {
      id: 'orientation',
      label: 'Orientation',
      phase: 'glass',
      title: 'Does it read the right way round?',
      lead: 'Look at the card through the glass, from where you will present.',
      records: 'orientation',
      card: 'orientation',
    },
    {
      id: 'lens',
      label: 'Lens',
      phase: 'glass',
      title: 'Where is the lens?',
      lead: 'Put the crosshair over the camera. The script is centred on the lens, not on the display.',
      records: 'lens',
      card: 'crosshair',
    },
    {
      id: 'distance',
      label: 'Distance',
      phase: 'reading',
      title: 'How far away do you stand?',
      lead: 'Stand where you will present and measure, or pick the nearest.',
      records: 'distance',
      card: 'type-sample',
    },
    {
      id: 'text-size',
      label: 'Text size',
      phase: 'reading',
      title: 'How large should the text be?',
      lead: 'Choose the smallest size you can read without effort — larger type costs you words per line.',
      records: 'text-size',
      card: 'type-sample',
    },
    {
      id: 'line-width',
      label: 'Line width',
      phase: 'reading',
      title: 'How wide should a line run?',
      lead: 'A tight shot notices a sideways glance that a wide one hides, so tighter framing wants a narrower column.',
      records: 'line-width',
      card: 'type-sample',
    },
    {
      id: 'brightness',
      label: 'Brightness',
      phase: 'reading',
      title: 'How hot should the type burn?',
      lead: 'Choose what reads comfortably in this room — a bright room washes out soft type, and a dark studio makes strong type bloom.',
      records: 'brightness',
      card: 'type-sample',
    },
  ];

  let stepIndex = $state(0);
  const step = $derived(STEPS[stepIndex] ?? STEPS[0]!);
  const isLastStep = $derived(stepIndex === STEPS.length - 1);
  const phase = $derived(PHASES.find((p) => p.id === step.phase) ?? PHASES[0]!);

  /** The rail, grouped: each phase with its steps and their place in the sequence. */
  const railGroups = PHASES.map((p) => ({
    ...p,
    steps: STEPS.map((entry, index) => ({ entry, index })).filter(
      ({ entry }) => entry.phase === p.id,
    ),
  }));

  /**
   * The Sidecar checklist's ticks, held here for the sitting.
   *
   * The checklist is mounted only on the hardware step, and its own state went
   * with it: stepping to the safe-area step to check the frame it suggested,
   * then back, showed "0 of 6 confirmed" again. Still never persisted — see
   * SidecarChecklist.svelte for why — so they end when this screen does.
   */
  let sidecarTicks = $state<Partial<Record<SidecarCheckId, boolean>>>({});
  let sidecarSeeded = $state<SafeAreaInsets | null>(null);

  /** The current step's heading, which takes focus when the footer moves on. */
  let stepTitleElement = $state<HTMLHeadingElement | null>(null);
  /** The scrolling column, put back at the top on every step change. */
  let contentElement = $state<HTMLDivElement | null>(null);

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
   * `patchSettings` reads the store's revision when it is CALLED, not when it
   * lands. Two overlapping finishes therefore both start from the same
   * revision, and the later write is rejected as stale — a toast about a
   * conflict with nothing but the operator's own second press. One at a time is
   * the whole guarantee.
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
          physicalSizeMm: display.physicalSizeMm ?? null,
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

  /* -------------------------------------------------------------- progress */

  /**
   * Steps passed over with Skip in this sitting. Presentation only.
   *
   * `completedSteps` already says what was answered; this says what the
   * presenter chose to leave, which is the difference between "still to do"
   * and "decided against" when they look back down the rail before Apply.
   * Answering a skipped step later wins over the skip.
   */
  let skipped = $state<WizardStepId[]>([]);
  /**
   * Steps opened in this sitting, the first one included. Presentation only:
   * it is what separates "looked at and left as it was" from "never opened"
   * in the review before Apply, which matters because a step opened and
   * changed without Next still saves what was changed.
   */
  let visited = $state<WizardStepId[]>([STEPS[0]!.id]);

  /**
   * Whether a step has an answer the rail can show a tick for.
   *
   * The eight recorded steps read `answered`. The two with no token read the
   * profile itself, for the reason `records` gives: a measured scale and a
   * matching preset are evident from the fields, so the tick follows them.
   */
  function isAnswered(entry: WizardStep): boolean {
    if (entry.records !== null) return answered.includes(entry.records);
    if (entry.id === 'scale') return profile.scale !== null;
    if (entry.id === 'preset') return hydrated && RIG_PRESETS.some((preset) => matchesPreset(preset));
    return false;
  }

  type StepState = 'answered' | 'skipped' | 'todo';
  function stepState(entry: WizardStep): StepState {
    if (isAnswered(entry)) return 'answered';
    return skipped.includes(entry.id) ? 'skipped' : 'todo';
  }
  const STEP_STATE_WORDS: Record<StepState, string> = {
    answered: 'answered',
    skipped: 'skipped',
    todo: 'not answered yet',
  };
  /** How the review names a step that has no answer. */
  function unansweredWord(entry: WizardStep): string {
    if (skipped.includes(entry.id)) return 'skipped';
    return visited.includes(entry.id) ? 'opened, not confirmed' : 'not opened';
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
      loadError = describeError(err);
    }

    /*
     * Validated here as it is everywhere else it is read: the value comes from
     * a localStorage overlay merged field-wise, so "a number" is not a safe
     * assumption, and a NaN would reach a font size before anything noticed.
     */
    const looseSizeBias = (): number => {
      const value = $settings.teleprompter.sizeBias;
      return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : defaultOpticalProfile().bias;
    };

    const panel = displays.find((d) => d.fingerprint === displayFingerprint) ?? null;
    const existing = $settings.optical.profiles[opticalRigKey(displayFingerprint, rigName)] ?? null;
    const found = discoverProfile(
      panel
        ? {
            name: panel.name,
            physicalSize: panel.physicalSize,
            scaleFactor: panel.scaleFactor,
            physicalSizeMm: panel.physicalSizeMm ?? null,
          }
        : null,
      existing,
    );
    const completed = existing?.completedSteps ?? [];
    profile = {
      ...found.profile,
      rigName,
      /*
       * Mirroring starts from whatever is ALREADY in force on THIS panel.
       *
       * `finish()` writes both axes for this panel every time — that is what
       * stops the profile's record and the panel's mirroring drifting apart — so
       * the working profile has to arrive holding the truth, or Apply would
       * switch OFF a mirror the operator set on the Stage display screen and
       * never revisited in here. That is this screen's original defect pointed
       * the other way: the wizard changing something nobody touched in it.
       *
       * The panel's answer wins over the rig's own record, even for a rig that
       * answered orientation. The record is what the glass did when the rig was
       * measured; a switch thrown in Settings since then is newer, and reopening
       * an old rig to adjust its distance must not quietly put the old mirror
       * back. It also makes the orientation card an honest question: it is
       * drawn the way a real take on this panel would draw it.
       *
       * Only this panel's (#206). It used to be a single global pair, so the
       * wizard on a desk panel seeded from — and then wrote back over — the
       * glass rig's mirror.
       */
      flips: panelMirrorFor($settings.optical, displayFingerprint),
      /*
       * And the size balance starts from what is in force too, for the same
       * reason and with the same exception.
       *
       * A rig that exists has answered this itself, standing at the glass. A
       * FRESH one has not, and the honest starting point is the balance the
       * presenter has actually been reading at — which on an automatic panel
       * is the loose preference. Starting from `defaultOpticalProfile()`
       * instead put the wizard's own preview back to the narrow line somebody
       * had just widened, and stored 0.4 unless they noticed and moved the
       * slider a second time.
       */
      bias: existing ? found.profile.bias : looseSizeBias(),
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
  /**
   * Why there is no live card on the glass, as a heading and the detail.
   *
   * A heading because the detail is the long half: it says what still works
   * and what to do, and at the minimum window it is three lines that the eye
   * should not have to read to know which of the failures this is.
   */
  interface StageNotice {
    title: string;
    detail: string;
    /**
     * Set only for a failed publish to a window that is still up — the one
     * failure the next successful publish proves over, and so the only one
     * that clears itself. Opening and closing failures stay until the screen
     * is left.
     */
    transient?: true;
  }
  let stageError = $state<StageNotice | null>(null);
  /**
   * Every measurement still writes without a stage; most of these say so.
   * Worded around Apply rather than "saves", because nothing here saves until
   * the end and saying otherwise would undercut the leave-without-saving prompt.
   */
  const STILL_SAVES = 'You can still enter measurements and apply them; you just cannot check them by eye.';
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
        stageError = {
          title: 'No prompt window',
          detail: 'It was not opened, because CandidCue could not tell which displays are connected.',
        };
        return;
      }
      if (displays.length <= 1 || (await targetIsControlPanel())) {
        stageError = {
          title: 'Calibration needs a second display',
          detail: `The card opens on the panel you read from — here, it would cover this window. Connect the prompter, keep this window on the other display, and open Calibrate again. ${STILL_SAVES}`,
        };
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
            ? {
                title: 'The prompt window did not load',
                detail: `It opened but never finished loading, so it was closed again. ${STILL_SAVES}`,
              }
            : {
                title: 'The prompt window did not load',
                detail: 'It opened but never finished loading, and would not close either. Leave this screen to take it down.',
              };
          return;
        }
        stageLive = true;
      } catch (err) {
        // Said here, next to the sequence it blocks. Every step still WRITES
        // correctly without a stage — it just cannot be judged by eye.
        stageError = {
          title: 'The prompt window could not open',
          detail: `${describeError(err)} ${STILL_SAVES}`,
        };
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
      stageError = {
        title: 'The prompt window would not close',
        detail: `${describeError(err)} Press Escape on the prompter again, or leave this screen to take it down.`,
      };
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
    stageError = {
      title: 'Prompt window closed from the prompter',
      detail:
        'Everything measured here is still here — carry on and apply the rig when you are ready. Opening Calibrate again after it is saved puts the window back.',
    };
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
   * Note where the mirror axes come from: the WORKING profile, not the
   * panel's saved mirroring. That is what lets the preview be live while the
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
        // The glass has the current state again, so a failure reported by an
        // earlier push is no longer true.
        if (stageError?.transient) stageError = null;
      }
    } catch (err) {
      stageError = {
        title: 'The prompt window stopped updating',
        detail: `${describeError(err)} It will catch up with your next change if the window recovers. ${STILL_SAVES}`,
        transient: true,
      };
    } finally {
      pushing = false;
    }
  }

  /* -------------------------------------------------- step: orientation */

  /**
   * A flip is recorded in two places, and within this wizard `finish()` is the
   * only thing that may set either of them.
   *
   * `profile.flips` is the RECORD — what this rig's glass does — and the
   * panel's entry in `optical.panelMirror` is what a real take on this panel
   * actually renders from (#206). `buildStageSettings` takes mirroring as
   * explicit arguments rather than choosing a source: a take passes the
   * panel's, and this screen passes `profile.flips` (honouring both at once
   * would double-flip a rig). Two homes for one physical fact can only stay
   * consistent if one place writes both, and within this wizard that place is
   * `finish()` — the Stage display screen still owns its own switches.
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
  /**
   * A rejected entry, said under the field that holds it.
   *
   * These used to be toasts, which surfaced at the bottom of the window over
   * the footer and timed out while the presenter was still at the glass with
   * the ruler. The field is where they will look again, so that is where the
   * reason stays until they change the number.
   */
  let rulerError = $state<string | null>(null);
  let diagonalError = $state<string | null>(null);
  /**
   * Edit counters, so Next can tell a number typed since the last decision
   * from one that has already been used or overruled. See `commitDrafts`.
   *
   * Counters rather than the text itself: typing 1.2, choosing a chip, then
   * typing 1.2 again is a new answer, and comparing strings would call it the
   * old one.
   */
  const drafts = {
    ruler: { edits: 0, settled: 0 },
    diagonal: { edits: 0, settled: 0 },
    distance: { edits: 0, settled: 0 },
  };
  type DraftField = keyof typeof drafts;
  function draftEdited(field: DraftField): void {
    drafts[field].edits += 1;
    dirty = true;
  }
  /** Used, or overruled by a later explicit choice. */
  function draftSettled(field: DraftField): void {
    drafts[field].settled = drafts[field].edits;
  }
  function draftPending(field: DraftField, text: string): boolean {
    return text.trim() !== '' && drafts[field].edits > drafts[field].settled;
  }

  /**
   * `explicit` is the presenter pressing this method's own button or Enter,
   * which overrules whatever is still typed in the other field. Next applying
   * pending drafts on their behalf is not explicit, so it overrules nothing.
   */
  function applyRulerMeasurement(explicit = true): boolean {
    const measuredMm = Number(rulerMmField.trim());
    const mmPerCssPx = mmPerCssPixelFromRuler({ barLengthPx: rulerBarPx, measuredMm });
    if (mmPerCssPx === null) {
      rulerError = 'Type the length you measured, in millimetres.';
      return false;
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
      const inches = impliedDiagonalMm / inchesToMm(1);
      const across = inches < 1 ? 'under an inch' : `about ${Math.round(inches)} inches`;
      rulerError = `That would make this panel ${across} across the diagonal. Check the units and measure the bar again.`;
      return false;
    }
    rulerError = null;
    draftSettled('ruler');
    if (explicit) draftSettled('diagonal');
    patchProfile({ scale: { mmPerCssPx, source: 'ruler' } });
    return true;
  }

  function applyTypedDiagonal(explicit = true): boolean {
    const inches = Number(diagonalField.trim());
    if (!viewport) {
      diagonalError =
        'CandidCue needs this display’s size in pixels to use a diagonal, and could not read it. Measure the bar instead.';
      return false;
    }
    const diagonalMm = inchesToMm(inches);
    const mmPerCssPx = mmPerCssPixel({
      diagonalMm,
      widthPx: viewport.widthPx,
      heightPx: viewport.heightPx,
    });
    if (mmPerCssPx === null) {
      diagonalError = 'That is not a diagonal CandidCue can use. Type the size in inches.';
      return false;
    }
    diagonalError = null;
    draftSettled('diagonal');
    if (explicit) draftSettled('ruler');
    patchProfile({ scale: { mmPerCssPx, source: 'diagonal', diagonalMm } });
    return true;
  }

  function applyModelScale(): void {
    if (!shape) return;
    const found = discoverProfile(shape, null);
    if (found.profile.scale === null) {
      showToast('CandidCue does not know this panel’s physical size. Measure it instead.', 'info');
      return;
    }
    draftSettled('ruler');
    draftSettled('diagonal');
    patchProfile({ scale: found.profile.scale });
  }

  const scaleSourceLabel = $derived(
    profile.scale === null
      ? 'Not measured'
      : profile.scale.source === 'ruler'
        ? 'Measured against the glass'
        : profile.scale.source === 'diagonal'
          ? 'From the diagonal you typed'
          : profile.scale.source === 'display'
            ? 'From the size the display reports'
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
  let distanceError = $state<string | null>(null);

  function setDistanceMm(mm: number): void {
    patchProfile({ viewingDistanceMm: mm });
  }

  function applyTypedDistance(): boolean {
    const metres = Number(distanceField.trim());
    const mm = Math.round(metres * 1000);
    if (!isPlausibleViewingDistanceMm(mm)) {
      distanceError = `A viewing distance has to be between ${MIN_VIEWING_DISTANCE_MM / 1000} m and ${MAX_VIEWING_DISTANCE_MM / 1000} m.`;
      return false;
    }
    distanceError = null;
    draftSettled('distance');
    setDistanceMm(mm);
    return true;
  }

  /**
   * Use whatever is typed on this step before leaving it with Next.
   *
   * A number typed into a field and never applied used to stay a draft: Next
   * moved on, recorded the step as answered, and the rig kept the old value —
   * the presenter had measured, typed and pressed the obvious button, and lost
   * the measurement. Next now goes through the same path as Enter, and a
   * rejected entry keeps them on the step with the reason under the field.
   * Skip deliberately does not: skipping is declining to answer.
   *
   * When both scale fields hold something new, the diagonal goes first and the
   * ruler second, so the measurement of the whole optical path is the one left
   * in force — neither overrules the other here, because neither was chosen.
   */
  function commitDrafts(): boolean {
    if (step.id === 'scale') {
      if (draftPending('diagonal', diagonalField) && !applyTypedDiagonal(false)) return false;
      if (draftPending('ruler', rulerMmField) && !applyRulerMeasurement(false)) return false;
    }
    if (step.id === 'distance' && draftPending('distance', distanceField)) {
      return applyTypedDistance();
    }
    return true;
  }

  /**
   * Next refused a typed value: put the presenter in the field that says why.
   *
   * Focus stayed on Next before, so the error appeared without being heard.
   * Landing on the invalid field reads its error out (the field's own
   * aria-describedby) and puts the caret where the fix goes.
   */
  async function focusRejectedField(): Promise<void> {
    await tick();
    contentElement?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
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
    const chars = optics?.charactersPerLine ?? null;
    const cost =
      chars === null
        ? 'Text is sized for where you stand, so expect few words to a line'
        : `Text is sized for where you stand, so a line holds only about ${Math.round(chars)} characters`;
    return `You chose ${(at / 1000).toFixed(1)} m; ${OPTICAL_HARDWARE[profile.hardwareKind].label} is rated for comfortable reading up to about ${(max / 1000).toFixed(1)} m. ${cost} — standing closer gives you more.`;
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
  /** Only a real shortfall is drawn as one; the rest read as plain facts. */
  const FIT_TONE: Record<string, 'good' | 'warn' | 'quiet'> = {
    ok: 'good',
    width_limited: 'quiet',
    angle_limited: 'warn',
    impossible: 'warn',
    uncalibrated: 'quiet',
  };

  /*
   * ---------------------------------------------------------------------------
   * WHAT EACH STEP SHOWS FOR ITSELF
   * ---------------------------------------------------------------------------
   * Every step used to end in the same four-line readout of body size, line
   * length, visible lines and fit. On the steps that move those numbers it is
   * the answer; on the others it was a block of figures competing with the
   * question being asked. So each step now shows the consequence of its own
   * control, and the type figures appear only where they are that consequence.
   */
  const TYPE_STEPS: WizardStepId[] = ['distance', 'text-size', 'line-width'];
  const showsType = $derived(TYPE_STEPS.includes(step.id));

  /** The scale as a panel size — the form somebody can check against the box it came in. */
  const impliedDiagonalInches = $derived(
    profile.scale && viewport
      ? (profile.scale.mmPerCssPx * Math.hypot(viewport.widthPx, viewport.heightPx)) /
          inchesToMm(1)
      : null,
  );
  const formatInches = (inches: number): string => inches.toFixed(1).replace(/\.0$/, '');
  /** True while the scale in force is the one the panel's identity gives. */
  const usingKnownSize = $derived(
    profile.scale?.source === 'model' || profile.scale?.source === 'display',
  );

  /** The text rectangle, as whole percentages of the panel. */
  const safeWidthPct = $derived(
    Math.round((1 - profile.safeArea.left - profile.safeArea.right) * 100),
  );
  const safeHeightPct = $derived(
    Math.round((1 - profile.safeArea.top - profile.safeArea.bottom) * 100),
  );
  /** The panel's own shape, for the small diagrams of the safe area and lens. */
  const panelAspect = $derived(viewport ? `${viewport.widthPx} / ${viewport.heightPx}` : '16 / 9');
  /** Where the crosshair sits on the whole panel — the same fold `calibrationDirective` makes. */
  const lensOnPanel = $derived.by(() => {
    const insets = profile.safeArea;
    const usableX = Math.max(0, 1 - insets.left - insets.right);
    const usableY = Math.max(0, 1 - insets.top - insets.bottom);
    return {
      x: insets.left + profile.lens.x * usableX,
      y: insets.top + profile.lens.y * usableY,
    };
  });

  const orientationLine = $derived(
    profile.flips.horizontal && profile.flips.vertical
      ? 'The card is drawn mirrored left to right and flipped top to bottom.'
      : profile.flips.horizontal
        ? 'The card is drawn mirrored left to right — what reflecting glass needs.'
        : profile.flips.vertical
          ? 'The card is drawn flipped top to bottom.'
          : 'The card is drawn as it is, not mirrored.',
  );

  /**
   * The text size the slider would give, in pixels on this panel.
   *
   * The control stores a balance between size and line length, and a
   * percentage of that means nothing to anybody. The pixel size it resolves to
   * is what the presenter is actually choosing, so that is what it reads.
   */
  function textSizeAt(percent: number): string {
    if (!viewport) return `${percent}%`;
    const at = resolveStageGeometry({ profile: { ...profile, bias: percent / 100 }, viewport });
    return at.optics ? `${Math.round(at.optics.bodyFontSizePx)} px` : `${percent}%`;
  }

  /** What Apply will save, for the last step's review. */
  const review = $derived.by(() => {
    const others = STEPS.filter((entry) => entry.id !== step.id);
    return {
      answeredCount: STEPS.filter((entry) => isAnswered(entry)).length,
      unanswered: others.filter((entry) => stepState(entry) !== 'answered'),
    };
  });

  /* ---------------------------------------------------------- navigation */

  function markAnswered(): void {
    const token = step.records;
    if (token !== null && !answered.includes(token)) answered = [...answered, token];
  }

  /**
   * Show another step.
   *
   * The column goes back to the top, because a long step left scrolled down
   * would open the next one partway through. From the footer, focus moves to
   * the new step's heading so a screen reader announces where it landed and
   * Tab starts from the top of the new task; from the rail it stays on the
   * rail, where the presenter is choosing.
   */
  async function showStep(index: number, focusHeading: boolean): Promise<void> {
    stepIndex = Math.min(STEPS.length - 1, Math.max(0, index));
    const id = STEPS[stepIndex]!.id;
    if (!visited.includes(id)) visited = [...visited, id];
    await tick();
    contentElement?.scrollTo({ top: 0 });
    if (focusHeading) stepTitleElement?.focus({ preventScroll: true });
  }

  function goNext(): void {
    if (!commitDrafts()) {
      void focusRejectedField();
      return;
    }
    markAnswered();
    if (isLastStep) {
      void finish();
      return;
    }
    void showStep(stepIndex + 1, true);
  }

  function goSkip(): void {
    if (!isAnswered(step) && !skipped.includes(step.id)) skipped = [...skipped, step.id];
    if (isLastStep) {
      void finish();
      return;
    }
    void showStep(stepIndex + 1, true);
  }

  function goBack(): void {
    void showStep(stepIndex - 1, true);
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
   * not enough to survive a Discard — so the axes are copied into this PANEL's
   * mirroring here, at the one moment the operator has actually said to keep
   * this rig. Every other panel's mirroring is left exactly as it was (#206):
   * calibrating a desk display used to switch the glass rig's mirror off,
   * because there was only one mirror for every panel.
   *
   * Both axes go every time, including for a rig whose orientation step was
   * never opened. That is safe only because `hydrate()` seeds `profile.flips`
   * from this panel's mirroring, so "wrote it unchanged" and "never asked"
   * produce the same value here. Take that seed away and this line starts
   * CLEARING mirrors the wizard was never shown.
   *
   * ONE write, carrying the rig, the panel's choice of it and the panel's
   * mirroring together. They used to be two — the rig, then a global flip —
   * and a failure between them left a rig stored without the mirror it was
   * calibrated with. In one optical patch they land or fail as one.
   */
  /**
   * Why Apply sent the presenter back to the name, kept under the field.
   *
   * The toast says it at the moment Apply is refused; this is what is still
   * there when they arrive on the step, until they type.
   */
  let rigNameError = $state<string | null>(null);

  async function finish(): Promise<void> {
    if (finishing) return;
    const name = profile.rigName.trim();
    if (name === '') {
      rigNameError = 'Give this rig a name so you can tell it from the others on this panel.';
      showToast(rigNameError, 'danger');
      // Not necessarily step 0: the preset step precedes 'hardware', which is
      // the step that actually owns the rig-name field.
      void showStep(
        STEPS.findIndex((s) => s.id === 'hardware'),
        true,
      );
      return;
    }
    /*
     * The one name a rig may not have. `isAutomaticProfile` tells the
     * profile a take built from the panel apart from one somebody measured by
     * this name alone, so a measured rig called "Automatic" would wear the
     * Automatic badge on the Live screen and be told it cannot be nudged
     * because it was never calibrated — which is exactly backwards.
     */
    if (name.toLowerCase() === AUTOMATIC_RIG_NAME.toLowerCase()) {
      rigNameError = `“${AUTOMATIC_RIG_NAME}” is the name of the sizing CandidCue works out on its own. Call this rig something else.`;
      showToast(rigNameError, 'danger');
      void showStep(
        STEPS.findIndex((s) => s.id === 'hardware'),
        true,
      );
      return;
    }
    const next: OpticalProfile = { ...profile, rigName: name, completedSteps: answered };
    finishing = true;
    try {
      // `next.flips`, not `profile.flips`: the saved rig is the one that should
      // reach the glass.
      await patchSettings(
        'optical',
        withPanelMirror(
          withOpticalProfile($settings.optical, displayFingerprint, next),
          displayFingerprint,
          next.flips,
        ),
      );
      finished = true;
      showToast(`${name} is now the rig this display runs with.`, 'success');
      await navigate({ name: 'settings', section: 'stage' });
    } catch {
      /*
       * patchSettings has already reverted and toasted; staying put is what
       * keeps the measurements on screen rather than losing them to a failed
       * write nobody could have anticipated. Nothing was half-saved — the rig
       * and its mirroring are one write — so pressing Apply again is the retry,
       * and it is idempotent.
       */
    } finally {
      finishing = false;
    }
  }

  /**
   * Where the camera sits, which decides what the lens step can measure.
   *
   * Presets already set this; the step used to assume the first answer for
   * every rig and offer a crosshair to line up with a webcam on top of a
   * monitor. The resolver ignores the vertical lens position for the other
   * three (`optical-resolve.ts`), so only the in-picture camera gets "Down".
   */
  const LENS_PLACEMENT_OPTIONS: Array<{ value: LensPlacement; label: string }> = [
    { value: 'in-panel', label: 'Behind the glass, in the picture' },
    { value: 'above', label: 'Above the screen' },
    { value: 'below', label: 'Below the screen' },
    { value: 'none', label: 'No camera' },
  ];

  const HARDWARE_OPTIONS = (Object.keys(OPTICAL_HARDWARE) as OpticalHardwareKind[]).map((kind) => ({
    value: kind,
    label: OPTICAL_HARDWARE[kind].label,
  }));
</script>

<div class="page">
  <Toolbar
    title="Calibrate this display"
    detail={display?.name ?? 'Display'}
    backLabel="Prompter display and rigs"
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
        class:good={stageLive && stageError === null}
        class:bad={stageError !== null}
        aria-live="polite"
      >
        <span class="state-dot" aria-hidden="true"></span>
        {#if stageLive && stageError}
          Prompter not updating
        {:else if stageLive}
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
    <!--
      The whole sequence, always visible, in the three tasks it adds up to. A
      wizard that hides its own length cannot be judged as worth starting, and
      every one of these can be skipped — which only helps if you can see what
      you are skipping, so each step says whether it is answered, skipped or
      still to do, in a glyph and in words.

      The rail names each step in a word or two; the question itself is the
      step's heading. Short names are what let every row stay on one line, and
      the rail narrow, down to the 720px minimum window.
    -->
    <nav class="steps" aria-label="Calibration steps">
      {#each railGroups as group, groupIndex (group.id)}
        <div class="phase" class:current-phase={group.id === step.phase}>
          <p class="phase-name" id="phase-{group.id}">
            <span class="phase-number" aria-hidden="true">{groupIndex + 1}</span>
            <span class="phase-title">{group.title}</span>
          </p>
          <ol class="phase-steps" aria-labelledby="phase-{group.id}">
            {#each group.steps as { entry, index } (entry.id)}
              {@const status = stepState(entry)}
              <li>
                <button
                  type="button"
                  class="step-item"
                  class:active={index === stepIndex}
                  data-state={status}
                  aria-current={index === stepIndex ? 'step' : undefined}
                  disabled={!hydrated && index !== stepIndex}
                  onclick={() => void showStep(index, false)}
                >
                  <span class="step-marker" aria-hidden="true">
                    {#if status === 'answered'}
                      <Icon name="check" size={12} />
                    {:else if status === 'skipped'}
                      <span class="skip-dash"></span>
                    {:else}
                      {index + 1}
                    {/if}
                  </span>
                  <span class="step-name">{entry.label}</span>
                  <span class="visually-hidden">, {STEP_STATE_WORDS[status]}</span>
                </button>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </nav>

    <div class="workspace">
      <div class="content" bind:this={contentElement}>
        {#if loadError}
          <div class="notice danger" role="alert">
            <p class="notice-title">CandidCue could not list the connected displays</p>
            <p class="notice-detail">
              {loadError} So it cannot recognise this panel, check a typed diagonal against it, or
              open the prompt window. Presets, the ruler and every other step still work, and Apply
              still saves. To try again, go back to Prompter display and rigs and open Calibrate.
            </p>
          </div>
        {:else if stageError}
          <div class="notice" role="status">
            <p class="notice-title">{stageError.title}</p>
            <p class="notice-detail">{stageError.detail}</p>
          </div>
        {/if}

        <header class="step-head">
          <p class="step-eyebrow">
            <span class="eyebrow-phase">{phase.title}</span>
            <span aria-hidden="true">·</span>
            <span>Step {stepIndex + 1} of {STEPS.length}</span>
          </p>
          <h2 class="step-title" tabindex="-1" bind:this={stepTitleElement}>{step.title}</h2>
          <p class="step-lead">{step.lead}</p>
        </header>

        {#if step.id === 'preset'}
          {#if !hydrated}
            <p class="status-line" role="status">
              Reading what CandidCue already knows about this display…
            </p>
            <div class="preset-grid" aria-hidden="true">
              {#each RIG_PRESETS as preset (preset.id)}
                <div class="preset-skeleton">
                  <span class="skeleton-line short"></span>
                  <span class="skeleton-line"></span>
                  <span class="skeleton-line"></span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="preset-grid" role="group" aria-label="Rig presets">
              {#each RIG_PRESETS as preset (preset.id)}
                {@const selected = matchesPreset(preset)}
                <button
                  type="button"
                  class="preset-card"
                  class:selected
                  aria-pressed={selected}
                  onclick={() => applyPreset(preset)}
                >
                  <span class="preset-head">
                    <span class="preset-name">{preset.label}</span>
                    {#if selected}
                      <span class="preset-check" aria-hidden="true"><Icon name="check" size={14} /></span>
                    {/if}
                  </span>
                  <span class="preset-description">{preset.description}</span>
                </button>
              {/each}
            </div>
            <p class="hint-line">
              None of these? Skip — CandidCue starts from what it already knows about this display,
              and every answer stays open to correction.
            </p>
          {/if}
        {:else if step.id === 'hardware'}
          <div class="field-pair">
            <TextField
              label="Rig name"
              value={profile.rigName}
              hint="One panel often holds several arrangements — “Desk hood” and “Boom arm” are two rigs, not one."
              error={rigNameError ?? undefined}
              oninput={(value) => {
                rigNameError = null;
                patchProfile({ rigName: value });
              }}
            />
            <div class="field-stack">
              <Select
                label="Hardware"
                value={profile.hardwareKind}
                options={HARDWARE_OPTIONS}
                onchange={(value) => patchProfile({ hardwareKind: value as OpticalHardwareKind })}
              />
              <p
                class="status-line"
                class:known={identification.confidence !== 'unknown'}
              >
                <span class="status-icon" aria-hidden="true">
                  <Icon name={identification.confidence === 'unknown' ? 'info' : 'check'} size={14} />
                </span>
                <span>
                  {#if identification.confidence === 'model'}
                    Recognised from the display’s own name: {identification.label}.
                  {:else if identification.confidence === 'resolution'}
                    Recognised as {identification.label}.
                  {:else if identification.confidence === 'panel'}
                    Not a model CandidCue knows, but the display reports its size ({identification.label}),
                    so text can be sized without measuring.
                  {:else}
                    CandidCue could not recognise this panel, so the next step asks you to measure it.
                  {/if}
                </span>
              </p>
            </div>
          </div>
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
            bind:ticked={sidecarTicks}
            bind:seeded={sidecarSeeded}
          />
        {:else if step.id === 'scale'}
          <!-- The answer first: what is in force now, in the unit a person can
               check against the box the panel came in. -->
          <div class="answer" class:unset={profile.scale === null} aria-live="polite">
            <span class="answer-mark" aria-hidden="true">
              <Icon name={profile.scale ? 'check' : 'info'} size={14} />
            </span>
            {#if profile.scale && impliedDiagonalInches !== null}
              <p class="answer-text">
                <strong>About {formatInches(impliedDiagonalInches)} inches across</strong>
                <span class="answer-note">
                  {scaleSourceLabel} · {profile.scale.mmPerCssPx.toFixed(4)} mm per pixel
                </span>
              </p>
            {:else}
              <p class="answer-text">
                <strong>Not measured yet</strong>
                <span class="answer-note">Until it is, text is sized by guesswork.</span>
              </p>
            {/if}
          </div>

          <!-- The preferred way, on its own: it is the only one that measures the
               finished optical path, which is the number every later step uses. -->
          <section class="method primary-method" aria-labelledby="ruler-title">
            <div class="method-text">
              <p class="method-title" id="ruler-title">
                Measure the bar on the prompter
                <span class="method-tag">Most accurate</span>
              </p>
              <p class="method-body">
                Hold a ruler against the glass and measure the bar on the card. It measures the
                whole optical path, so a magnifying beamsplitter or an overscanning panel is
                included.
              </p>
            </div>
            <div class="method-entry">
              <TextField
                label="Length of the bar on the prompter (mm)"
                value={rulerMmField}
                hint={`The bar is ${rulerBarPx} pixels long on the panel.`}
                error={rulerError ?? undefined}
                oninput={(value) => {
                  rulerMmField = value;
                  rulerError = null;
                  draftEdited('ruler');
                }}
                onsubmit={() => applyRulerMeasurement()}
              />
              <Button onclick={() => applyRulerMeasurement()}>Use measurement</Button>
            </div>
          </section>

          <section class="other-methods" aria-labelledby="other-methods-title">
            <p class="other-title" id="other-methods-title">Other ways to set the size</p>
            <ul class="methods">
              {#if identification.diagonalInches !== null}
                <li class="method inline">
                  <div class="method-text">
                    <p class="method-title">
                      {identification.confidence === 'panel'
                        ? `The size the display reports: ${formatInches(identification.diagonalInches)} inches`
                        : `The known size: ${formatInches(identification.diagonalInches)} inches`}
                    </p>
                    <p class="method-body">Describes the panel alone — right for a screen viewed directly.</p>
                  </div>
                  <div class="method-action">
                    <Button disabled={usingKnownSize} onclick={() => applyModelScale()}>
                      {usingKnownSize ? 'In use' : 'Use the known size'}
                    </Button>
                  </div>
                </li>
              {/if}
              <li class="method">
                <div class="method-text">
                  <p class="method-title">The panel’s diagonal, from its spec sheet</p>
                  <p class="method-body">Describes the panel alone, not the glass in front of it.</p>
                </div>
                <div class="method-entry">
                  <TextField
                    label="Diagonal (inches)"
                    value={diagonalField}
                    error={diagonalError ?? undefined}
                    oninput={(value) => {
                      diagonalField = value;
                      diagonalError = null;
                      draftEdited('diagonal');
                    }}
                    onsubmit={() => applyTypedDiagonal()}
                  />
                  <Button onclick={() => applyTypedDiagonal()}>Use diagonal</Button>
                </div>
              </li>
            </ul>
          </section>
        {:else if step.id === 'safe-area'}
          <div class="adjust">
            <div class="adjust-controls two-up">
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
            </div>
            <figure class="panel-figure" aria-hidden="true">
              <div class="panel-shape" style:aspect-ratio={panelAspect}>
                <div
                  class="panel-safe"
                  style:top="{profile.safeArea.top * 100}%"
                  style:bottom="{profile.safeArea.bottom * 100}%"
                  style:left="{profile.safeArea.left * 100}%"
                  style:right="{profile.safeArea.right * 100}%"
                >
                  <span class="panel-line"></span>
                  <span class="panel-line"></span>
                  <span class="panel-line short"></span>
                </div>
              </div>
            </figure>
          </div>
          <p class="result-line" aria-live="polite">
            Text area: <strong>{safeWidthPct}% × {safeHeightPct}%</strong> of the panel{#if visibleLines !== null}, about <strong>{visibleLines} lines</strong> visible at once{/if}.
          </p>
          <p class="hint-line">
            Everything that follows is laid out inside this frame, so a frame set too generously puts
            text under the bezel where you cannot read it.
          </p>
        {:else if step.id === 'orientation'}
          <div class="toggle-stack">
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
          </div>
          <p class="result-line" aria-live="polite">{orientationLine}</p>
          <p class="hint-line">
            Check through the glass: the eye marked <strong>L</strong> must sit on the left, and every
            word on the card must read the right way round.
          </p>
        {:else if step.id === 'lens'}
          <Select
            label="Where the camera is"
            value={profile.lensPlacement}
            options={LENS_PLACEMENT_OPTIONS}
            onchange={(value) => patchProfile({ lensPlacement: value as LensPlacement })}
          />
          <div class="adjust">
            <div class="adjust-controls">
              <Slider
                label="Across"
                value={Math.round(profile.lens.x * 100)}
                min={0}
                max={100}
                format={(v) => `${v}%`}
                onchange={(value) => patchProfile({ lens: { ...profile.lens, x: value / 100 } })}
              />
              {#if profile.lensPlacement === 'in-panel'}
                <Slider
                  label="Down"
                  value={Math.round(profile.lens.y * 100)}
                  min={10}
                  max={90}
                  format={(v) => `${v}%`}
                  onchange={(value) => patchProfile({ lens: { ...profile.lens, y: value / 100 } })}
                />
              {/if}
            </div>
            <figure class="panel-figure" aria-hidden="true">
              <div class="panel-shape" style:aspect-ratio={panelAspect}>
                <div
                  class="panel-safe"
                  style:top="{profile.safeArea.top * 100}%"
                  style:bottom="{profile.safeArea.bottom * 100}%"
                  style:left="{profile.safeArea.left * 100}%"
                  style:right="{profile.safeArea.right * 100}%"
                >
                  <span class="panel-line"></span>
                  <span class="panel-line"></span>
                  <span class="panel-line short"></span>
                </div>
                {#if profile.lensPlacement === 'in-panel'}
                  <span
                    class="panel-lens"
                    style:left="{lensOnPanel.x * 100}%"
                    style:top="{lensOnPanel.y * 100}%"
                  ></span>
                {:else}
                  <span class="panel-column" style:left="{lensOnPanel.x * 100}%"></span>
                {/if}
              </div>
            </figure>
          </div>
          <p class="hint-line">
            {#if profile.lensPlacement === 'in-panel'}
              Down is also the reading band — where your eyeline rests for the whole take. A camera
              off-centre pulls your gaze sideways, which a viewer notices about twice as readily as a
              vertical shift.
            {:else if profile.lensPlacement === 'none'}
              With no camera there is nothing to line up: the script sits at a comfortable reading
              height. Across still sets where the column is centred.
            {:else}
              A camera {profile.lensPlacement === 'above' ? 'above' : 'below'} the screen cannot be
              lined up inside it, so the script sits as close to that edge as reads comfortably. Across
              still centres the column under the lens.
            {/if}
          </p>
        {:else if step.id === 'distance'}
          <div class="chip-row" role="group" aria-label="Viewing distance">
            {#each DISTANCE_PRESETS_M as metres (metres)}
              {@const selected = profile.viewingDistanceMm === Math.round(metres * 1000)}
              <button
                type="button"
                class="chip"
                class:selected
                data-focus="control"
                aria-pressed={selected}
                onclick={() => {
                  // The chip is the newer answer: a number still typed below it
                  // is no longer what Next should apply.
                  distanceError = null;
                  draftSettled('distance');
                  setDistanceMm(Math.round(metres * 1000));
                }}
              >
                {metres.toFixed(1)} m
              </button>
            {/each}
          </div>
          {#if distanceWarning}
            <div class="notice warning" role="status">
              <p class="notice-title">Further away than this prompter is rated for</p>
              <p class="notice-detail">{distanceWarning}</p>
            </div>
          {/if}
          <div class="measure-row">
            <TextField
              label="Or type what you measured (metres)"
              value={distanceField}
              error={distanceError ?? undefined}
              oninput={(value) => {
                distanceField = value;
                distanceError = null;
                draftEdited('distance');
              }}
              onsubmit={() => applyTypedDistance()}
            />
            <Button onclick={() => applyTypedDistance()}>Use distance</Button>
          </div>
        {:else if step.id === 'text-size'}
          <div class="slider-with-ends">
            <Slider
              label="Text size"
              value={Math.round(profile.bias * 100)}
              min={0}
              max={100}
              format={(v) => textSizeAt(v)}
              onchange={(value) => patchProfile({ bias: value / 100 })}
            />
            <div class="slider-ends" aria-hidden="true">
              <span>More words on screen</span>
              <span>Larger, easier text</span>
            </div>
          </div>
          <p class="hint-line">
            One control rather than two: on a fixed panel, size and line length are the same decision —
            bigger type is fewer words at a time.
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
          <!-- The segmented control names its group for assistive tech only, so
               each gets the same words as a visible label above it. -->
          <div class="control-pair">
          <div class="labelled-control">
            <span class="control-label" aria-hidden="true">Text intensity</span>
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
          </div>
          <div class="labelled-control">
            <span class="control-label" aria-hidden="true">Reading cue</span>
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
            <span class="control-hint">What marks your reading position on the glass.</span>
          </div>
          </div>

          <!-- The last step is also the review: what Apply will keep, and the
               steps without an answer, each one click away. What the two
               buttons do comes first, because both of them are in view. -->
          <section class="review" aria-labelledby="review-title">
            <p class="review-title" id="review-title">Before you apply</p>
            <p class="review-body">
              Both buttons save “{profile.rigName.trim() || 'this rig'}” as the rig
              {display?.name ?? 'this display'} runs with. <strong>Apply this rig</strong> also marks
              this step answered; <strong>Finish without this</strong> saves it unanswered.
            </p>
            <p class="review-body">
              <strong>{review.answeredCount} of {STEPS.length}</strong> steps answered.
              {#if review.unanswered.length > 0}
                The others keep their current values:
              {/if}
            </p>
            {#if review.unanswered.length > 0}
              <ul class="review-list" aria-label="Steps without an answer">
                {#each review.unanswered as entry (entry.id)}
                  <li>
                    <button
                      type="button"
                      class="review-link"
                      data-focus="control"
                      onclick={() => void showStep(STEPS.indexOf(entry), true)}
                    >
                      {entry.label}
                    </button>
                    <span class="review-state">{unansweredWord(entry)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}

        <!-- The type on the glass, on the steps that change it. What makes the
             maths trustworthy is watching it move while you change something. -->
        {#if showsType && optics}
          <section class="type-result" aria-label="On the prompter" aria-live="polite">
            <dl class="type-stats">
              <div class="stat">
                <dt>Body text</dt>
                <dd>
                  {Math.round(optics.bodyFontSizePx)} px
                  {#if optics.bodyArcminutes !== null}
                    <span class="stat-sub">{optics.bodyArcminutes.toFixed(0)}′ of arc</span>
                  {/if}
                </dd>
              </div>
              <div class="stat">
                <dt>A line holds</dt>
                <dd>
                  {optics.charactersPerLine === null ? '—' : `${Math.round(optics.charactersPerLine)} characters`}
                </dd>
              </div>
              <div class="stat">
                <dt>Visible at once</dt>
                <dd>{visibleLines === null ? '—' : `${visibleLines} lines`}</dd>
              </div>
            </dl>
            <p class="fit fit-{FIT_TONE[optics.fitVerdict] ?? 'quiet'}">
              {FIT_PHRASES[optics.fitVerdict] ?? optics.fitVerdict}
            </p>
            {#if profile.scale === null}
              <p class="type-action">
                These are estimates until the panel is measured.
                <button
                  type="button"
                  class="inline-link"
                  data-focus="control"
                  onclick={() => void showStep(STEPS.findIndex((s) => s.id === 'scale'), true)}
                >
                  Measure it on the Scale step
                </button>
              </p>
            {/if}
            {#if (resolved?.warnings ?? []).length > 0}
              <!-- How the figures were reached. True and worth keeping, but not
                   something to act on, so it waits behind a click. -->
              <details class="type-notes">
                <summary data-focus="control">How these are worked out</summary>
                {#each resolved?.warnings ?? [] as warning (warning)}
                  <p class="type-note">{warning}</p>
                {/each}
              </details>
            {/if}
          </section>
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
        <!-- Nothing moves forward until `hydrate()` has installed the rig: it
             replaces the working profile wholesale, so an answer given before it
             lands would be quietly overwritten. -->
        <Button variant="ghost" disabled={finishing || !hydrated} onclick={() => goSkip()}>
          {isLastStep ? 'Finish without this' : 'Skip'}
        </Button>
        <!-- One width for Next and Apply, so the primary keeps its place and
             only the escape hatch beside it grows on the last step. -->
        <span class="primary-slot">
          <Button variant="primary" disabled={finishing || !hydrated} onclick={() => goNext()}>
            {isLastStep ? 'Apply this rig' : 'Next'}
          </Button>
        </span>
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

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
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

  /* ------------------------------------------------------------------ rail */

  .steps {
    /* The width of the Settings section rail beside it, so stepping into the
       wizard does not shift the content edge (§15.2). One-line labels are
       what let it stay this narrow. */
    flex: 0 0 calc(var(--space-5) * 9);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-2);
    overflow-y: auto;
  }
  .phase {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .phase-name {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
    margin: 0;
    padding: 0 var(--space-2);
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    font-weight: 650;
    color: var(--text-muted);
  }
  .current-phase .phase-name {
    color: var(--text-primary);
  }
  .phase-number {
    font-variant-numeric: tabular-nums;
  }
  .phase-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .step-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-height: var(--source-row-h);
    padding: 0 var(--space-2);
    text-align: left;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .step-item:hover:not(:disabled) {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  /* Only while the rig is still loading; see the footer. */
  .step-item:disabled {
    cursor: default;
    color: var(--text-muted);
  }
  /* Flat, per §15.2 — a tonal fill, no elevation, no raised card. The Settings
     rail's neutral "you are here", not an accent wash beside a grey hover. */
  .step-item.active,
  .step-item.active:hover {
    background: var(--bg-source-selected);
    color: var(--text-primary);
    font-weight: 600;
  }
  .step-name {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /*
   * The marker: a number still to do, a tick answered, a dash skipped.
   *
   * Shape carries the state as well as colour (SC 1.4.1), and the words ride
   * along for a screen reader. The ring is `--text-faint`, which clears 3:1 on
   * every rail fill, so the marker reads as a control boundary (SC 1.4.11).
   */
  .step-marker {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--space-5);
    height: var(--space-5);
    border-radius: 50%;
    border: 1px solid var(--text-faint);
    font-size: var(--text-2xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    background: var(--bg-app);
  }
  .step-item.active .step-marker {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-contrast);
  }
  /* Answered is a ring, not a disc. Petrol and the success green sit close in
     hue, so two filled discs — the step you are on and the ones you have done —
     read as one state; the current step keeps the only fill. */
  .step-item[data-state='answered'] .step-marker {
    border-color: var(--success);
    background: var(--bg-app);
    color: var(--success);
  }
  .step-item.active[data-state='answered'] .step-marker {
    background: var(--success);
    color: var(--accent-contrast);
  }
  .step-item[data-state='skipped'] .step-marker {
    border-style: dashed;
    color: var(--text-muted);
  }
  .skip-dash {
    width: var(--space-2);
    height: 2px;
    border-radius: var(--radius-pill);
    background: currentColor;
  }

  /* ------------------------------------------------------------- content */

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

  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-5) var(--page-x) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  /* A comfortable reading measure for the step, kept as a MAX on each child
     rather than on the column, so the column itself still scrolls edge to
     edge and its scrollbar sits at the window's edge, not mid-pane. */
  .content > :global(*) {
    width: 100%;
    max-width: calc(var(--space-8) * 20);
  }

  .step-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .step-eyebrow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .eyebrow-phase {
    color: var(--accent-strong);
  }
  .step-title {
    margin: 0;
    font-size: var(--text-xl);
    line-height: var(--lh-section);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }
  /* Focus is moved here so a screen reader announces the new step; the
     heading is not a control, so it draws no ring. */
  .step-title:focus {
    outline: none;
  }
  .step-lead {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }

  .hint-line {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .status-line {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .status-icon {
    flex: 0 0 auto;
    display: inline-flex;
    margin-top: 1px;
  }
  .status-line.known .status-icon {
    color: var(--success);
  }

  /*
   * A notice: why something is missing and what to do.
   * The leading rule is an inset ::before bar held off the corners, never a
   * one-sided border — the same shape FollowStatePanel's notices use.
   */
  .notice {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-4) var(--space-3) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .notice::before {
    content: '';
    position: absolute;
    left: var(--space-2);
    top: var(--space-3);
    bottom: var(--space-3);
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--warning);
  }
  .notice.danger::before {
    background: var(--danger);
  }
  .notice-title {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 650;
    color: var(--text-primary);
  }
  .notice-detail {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    max-width: var(--prose-measure);
  }

  /* -------------------------------------------------------------- presets */

  .preset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-10) * 4), 1fr));
    gap: var(--space-2);
  }
  .preset-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-control);
    background: var(--bg-panel);
    text-align: left;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .preset-card:hover {
    background: var(--bg-hover-surface);
    border-color: var(--border-strong);
  }
  /* Selected: the tinted fill and a firmer edge, with the tick in the
     corner saying it in a shape as well (SC 1.4.1). Not an accent border —
     that is the heavy accent box the house keeps off large surfaces. */
  .preset-card.selected,
  .preset-card.selected:hover {
    background: var(--bg-selected);
    border-color: var(--border-strong);
  }
  .preset-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .preset-name {
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .preset-check {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--space-5);
    height: var(--space-5);
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
  }
  .preset-description {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }

  /* Where the cards will be, so the step does not jump when they arrive. */
  .preset-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: calc(var(--space-10) * 2);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-faint);
    background: var(--bg-sunken);
  }
  .skeleton-line {
    height: var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--border);
  }
  .skeleton-line.short {
    width: 55%;
    height: var(--space-3);
    margin-bottom: var(--space-1);
  }

  /* ------------------------------------------------------------- hardware */

  .field-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
    align-items: start;
  }
  .field-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ---------------------------------------------------------------- scale */

  /* What is in force now, on one line: the answer, then where it came from. */
  .answer {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .answer-mark {
    flex: 0 0 auto;
    display: inline-flex;
    margin-top: 2px;
    color: var(--success);
  }
  .answer.unset .answer-mark {
    color: var(--text-muted);
  }
  .answer-text {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-variant-numeric: tabular-nums;
  }
  .answer-text strong {
    font-size: var(--text-base);
    font-weight: 650;
    color: var(--text-primary);
  }
  .answer.unset .answer-text strong {
    color: var(--text-secondary);
  }
  .answer-note {
    font-size: var(--text-meta);
    color: var(--text-muted);
  }

  /*
   * The preferred way on a white panel of its own; the others below it as one
   * quieter list in one frame, with rules between them rather than a card
   * each, so nothing is a border inside a border.
   */
  .method {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }
  .primary-method {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .other-methods {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .other-title {
    margin: 0;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    font-weight: 600;
    color: var(--text-muted);
  }
  .methods {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .methods .method {
    padding: var(--space-3) var(--space-4);
  }
  .methods .method + .method {
    border-top: 1px solid var(--border);
  }
  /* A method whose action is one button sits on one line with it. */
  .method.inline {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .method-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .method-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 650;
    color: var(--text-primary);
  }
  .method-tag {
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--accent-strong);
  }
  .method-body {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }
  .method-action {
    display: flex;
  }
  .method-entry,
  .measure-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: var(--space-2);
  }
  /* The button lines up with the field, not with the field's label above it:
     the label's line plus the gap beneath it. */
  .method-entry > :global(:last-child),
  .measure-row > :global(:last-child) {
    margin-top: calc(var(--lh-label) + var(--space-1));
  }

  /* -------------------------------------------------- safe area and lens */

  .adjust {
    display: grid;
    grid-template-columns: minmax(0, 1fr) calc(var(--space-10) * 3.5);
    gap: var(--space-5);
    align-items: start;
  }
  .adjust-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .adjust-controls.two-up {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4) var(--space-5);
  }

  /* A small picture of the panel: black glass, the visible frame as a dashed
     outline with a few lines of "text" in it, and where the lens sits. It
     mirrors what the card on the glass is showing, for the moment the
     presenter looks back at this window. */
  .panel-figure {
    margin: 0;
  }
  .panel-shape {
    position: relative;
    width: 100%;
    border-radius: var(--radius-sm);
    background: var(--text-primary);
    overflow: hidden;
  }
  .panel-safe {
    position: absolute;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    border: 1px dashed var(--bg-panel);
    border-radius: 2px;
    transition:
      top var(--dur-fast) var(--ease-out),
      bottom var(--dur-fast) var(--ease-out),
      left var(--dur-fast) var(--ease-out),
      right var(--dur-fast) var(--ease-out);
  }
  .panel-line {
    width: 64%;
    height: 3px;
    border-radius: var(--radius-pill);
    background: var(--border-control);
  }
  .panel-line.short {
    width: 44%;
  }

  /* Where the column centres, for a camera outside the picture. */
  .panel-column {
    position: absolute;
    top: 12%;
    bottom: 12%;
    width: 2px;
    margin-left: -1px;
    border-radius: var(--radius-pill);
    background: var(--accent);
    transition: left var(--dur-fast) var(--ease-out);
  }
  .panel-lens {
    position: absolute;
    width: var(--space-4);
    height: var(--space-4);
    margin: calc(var(--space-4) / -2) 0 0 calc(var(--space-4) / -2);
    border-radius: 50%;
    border: 2px solid var(--accent);
    background: var(--bg-panel);
    transition:
      left var(--dur-fast) var(--ease-out),
      top var(--dur-fast) var(--ease-out);
  }

  .result-line {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .result-line strong {
    color: var(--text-primary);
    font-weight: 650;
  }

  .toggle-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  /* ------------------------------------------------------------- distance */

  .chip-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .chip {
    min-height: var(--button-h);
    min-width: calc(var(--space-10) + var(--space-2));
    padding-inline: var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-control);
    background: var(--bg-panel);
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
    border-color: var(--border-strong);
  }
  .chip.selected,
  .chip.selected:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
  }

  /* ------------------------------------------------------------ text size */

  .slider-with-ends {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .slider-ends {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  /* --------------------------------------------------------- type result */

  .type-result {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .type-stats {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-4);
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .stat dt {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
  }
  .stat dd {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--lh-section);
    font-weight: 650;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
  .stat-sub {
    display: block;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    font-weight: 500;
    color: var(--text-muted);
  }
  .fit {
    margin: 0;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-faint);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }
  .fit-good {
    color: var(--success);
  }
  .fit-warn {
    color: var(--warning);
    font-weight: 600;
  }
  .type-action {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .inline-link {
    min-height: var(--space-6);
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    font-weight: 600;
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
  }
  .type-notes {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .type-notes summary {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    min-height: var(--space-6);
    list-style: none;
    cursor: pointer;
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-muted);
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 3px;
  }
  .type-notes summary::-webkit-details-marker {
    display: none;
  }
  .type-notes summary:hover {
    color: var(--text-primary);
  }
  .type-note {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  /* --------------------------------------------------------- brightness */

  .control-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4);
    align-items: start;
  }
  .labelled-control {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .control-label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .control-hint {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  /* --------------------------------------------------------------- review */

  .review {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .review-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .review-body {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .review-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
  }
  .review-list li {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
  }
  .review-link {
    min-height: var(--space-6);
    padding: 0;
    border: 0;
    background: transparent;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-thickness: 1px;
  }
  .review-state {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }
  .review-note {
    margin: 0;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-faint);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .review-note strong {
    font-weight: 600;
    color: var(--text-secondary);
  }

  /* --------------------------------------------------------------- footer */

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
  .primary-slot {
    display: flex;
  }
  .primary-slot :global(button) {
    /* One width, with room to spare for "Apply this rig", so Next and Apply
       are the same shape and the primary never moves. */
    width: calc(var(--space-10) * 2.75);
    justify-content: center;
  }

  /*
   * The minimum window. The rail keeps every label — they are one short word
   * or two now — but narrows to 140px and tightens its rows, so all ten steps
   * and their phases still fit the 480px height without scrolling, and the
   * content gets back the width a 180px rail was taking. The panel picture
   * narrows beside its sliders, and paired fields stack.
   */
  @media (max-width: 800px) {
    .steps {
      flex-basis: calc(var(--space-5) * 7);
      gap: var(--space-2);
      padding: var(--space-3) var(--space-1) var(--space-3) var(--space-2);
    }
    /* 26px rows are what let all ten rows and three phase names fit 480px
       without the rail scrolling (still >= 24px, SC 2.5.8). */
    .step-item {
      min-height: calc(var(--space-6) + var(--divider-w) * 2);
      gap: var(--space-2);
      padding: 0 var(--space-1);
    }
    .phase-name {
      padding: 0 var(--space-1);
    }
    .field-pair {
      grid-template-columns: minmax(0, 1fr);
    }
    .adjust {
      grid-template-columns: minmax(0, 1fr) calc(var(--space-10) * 2.5);
      gap: var(--space-4);
    }
    .adjust-controls.two-up {
      gap: var(--space-3) var(--space-4);
    }
    .type-stats {
      gap: var(--space-3);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel-safe,
    .panel-lens,
    .panel-column {
      transition: none;
    }
  }
</style>
