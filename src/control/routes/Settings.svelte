<!--
  Settings (spec §18). The Speech section no longer asks for anything: the
  recogniser is bundled with the app, so there is no key to store and no
  provider to choose. What is left is a readout of whether the model is
  installed and warm.

  This screen is now the ONLY place a take is configured. There used to be a
  Preflight page that asked the same questions again, one screen before every
  session — the display, the microphone, the tracking mode, the type — and
  answering them twice meant one of the two answers silently
  stopped mattering. Present opens the stage from what is set here
  (lib/start-take.ts).
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Button from '../components/Button.svelte';
  import Disclosure from '../components/Disclosure.svelte';
  import FollowSettingsFields from '../components/FollowSettingsFields.svelte';
  import Icon from '../components/Icon.svelte';
  import MicMeter from '../components/MicMeter.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Section from '../components/Section.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import Select from '../components/Select.svelte';
  import Slider from '../components/Slider.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import TextField from '../components/TextField.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { openExternal } from '../lib/app-actions';
  import { chooseStageDisplay, stageSettingsFromSettings } from '../lib/start-take';
  import {
    ADVANCED_FONT_SIZE_CEILING_PX,
    APPEARANCE_LIMITS,
    MIN_FONT_SIZE_PX,
    typeCeilingPx,
  } from '../lib/stage-appearance';
  import {
    openStagePreview,
    type StagePreviewHandle,
  } from '../services/stage-preview-session';
  import {
    SUPPORT_BUNDLE_CONTENTS,
    SUPPORT_BUNDLE_EXCLUSIONS,
    diagnosticRows,
    diagnosticsClipboardText,
    type SystemDiagnostics,
  } from '../lib/diagnostics-format';
  import * as diagnosticsService from '../services/diagnostics';
  import {
    describeError,
    recentErrorDiagnostics,
    type ErrorDiagnosticEntry,
  } from '../services/errors';
  import { BackendUnavailableError, isTauriRuntime } from '../services/ipc';
  import {
    SYSTEM_DEFAULT_OPTION,
    matchRememberedMicrophone,
    microphoneOptions,
  } from '../services/audio';
  import {
    MicTestSession,
    micTestStopNotice,
    shouldAdoptRememberedMicrophone,
    type MicTestSnapshot,
  } from '../services/mic-test-session';
  import { VAD_SENSITIVITY_COPY } from '../services/settings-audio';
  import * as settingsService from '../services/settings';
  import * as stageService from '../services/stage';
  import { getSpeechEngineStatus, type SpeechEngineStatus } from '../services/stt/local';
  import { getVoiceFacade } from '../services/voice-facade';
  import type { DisplayDescriptor } from '../services/stage-types';
  import {
    activeOpticalProfile,
    opticalRigsForDisplay,
    withOpticalProfile,
    withoutOpticalProfile,
  } from '../services/settings-types';
  import {
    OPTICAL_HARDWARE,
    STAGE_EVENT,
    type AudioDeviceInfo,
    type AudioLevelSnapshot,
    type FramingPreset,
    type OpticalOverrides,
    type OpticalProfile,
    type ReadingCueStyle,
    type StageEscapePayload,
    type TextIntensity,
  } from '../../shared/contracts';
  import { presentationModeShortcutLabel } from '../lib/shortcuts';
  import { discoverProfile } from '../../shared/optical-discovery';
  import {
    DEFAULT_BOTTOM_FADE_LINES,
    DEFAULT_DEAD_ZONE_LINES,
    DEFAULT_FONT_WEIGHT,
    DEFAULT_FUTURE_OPACITY,
    DEFAULT_FUTURE_RESERVE_LINES,
    DEFAULT_LETTER_SPACING_EM,
    DEFAULT_PARAGRAPH_SPACING_EM,
    DEFAULT_PAST_OPACITY,
    DEFAULT_SENTENCE_MICROGAP_LINES,
    DEFAULT_TOP_FADE_LINES,
    NO_LENS_READING_BAND_FRACTION,
    resolveStageGeometry,
    resolveTargetArcminutes,
    resolveTargetCharacters,
  } from '../../shared/optical-resolve';
  import {
    ANGULAR_HARD_FLOOR_ARCMIN,
    MIN_RENDERABLE_FONT_SIZE_PX,
    MIN_VIEWING_DISTANCE_MM,
    MAX_VIEWING_DISTANCE_MM,
    READING_MEASURE,
    isPlausibleViewingDistanceMm,
  } from '../../shared/optics';
  import {
    AUTO_SCROLL_MAX_WPM,
    AUTO_SCROLL_MIN_WPM,
  } from '../../stage/renderer/autoscroll';
  import { appStatus } from '../stores/app-status';
  import { requestConfirm } from '../stores/confirm';
  import { navigate, route, type SettingsSection } from '../stores/router';
  import { loadSettings, patchSettings, settings } from '../stores/settings';
  import { showToast } from '../stores/toasts';

  interface Props {
    section: SettingsSection;
  }
  let { section }: Props = $props();

  const sections: Array<{ id: SettingsSection; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'speech', label: 'Speech' },
    { id: 'audio', label: 'Audio' },
    { id: 'stage', label: 'Stage display' },
    { id: 'teleprompter', label: 'Teleprompter' },
    { id: 'following', label: 'Following' },
    { id: 'privacy', label: 'Data, privacy & updates' },
  ];

  let engineStatus = $state<SpeechEngineStatus | null>(null);
  let updateNote = $state('');
  let diagnostics = $state<SystemDiagnostics | null>(null);
  let diagnosticsError = $state<string | null>(null);
  let diagnosticsLoading = $state(false);
  /**
   * §44.12: the toast tells the user what to do in English; the stable code is
   * kept here, where a support request is actually assembled from. This is the
   * only surface in the app that shows a raw error code, and it is deliberate.
   */
  let recentErrors = $state<ErrorDiagnosticEntry[]>([]);

  $effect(() => {
    void loadSettings();
    // A rejection here is an IPC failure rather than a broken bundle — a
    // missing model comes back as data — but without this the readout sits on
    // "Checking…" forever and raises an unhandled rejection behind it.
    void getSpeechEngineStatus()
      .then((status) => (engineStatus = status))
      .catch(() => {
        engineStatus = {
          available: false,
          loaded: false,
          model: 'unknown',
          detail: 'CandidCue could not ask the backend about the speech model.',
        };
      });
  });

  /** Diagnostics are only fetched for the screen that shows them (§47.10). */
  $effect(() => {
    if (section === 'privacy') void loadDiagnostics();
  });

  /* ------------------------------------------------------------- displays */

  let displays = $state<DisplayDescriptor[]>([]);
  let displaysError = $state<string | null>(null);
  let displaysLoading = $state(false);
  let stageTesting = $state(false);

  /**
   * What "Automatic" resolves to right now, named on the tile.
   *
   * The same function the take uses, not a description of it: a picker that
   * explains a rule the start sequence does not actually follow is how "it
   * opened on the wrong screen" becomes unanswerable.
   */
  const automaticDisplay = $derived(chooseStageDisplay(displays, null));
  const chosenFingerprint = $derived($settings.stage.displayFingerprint);
  /** The panel a take would open on, pinned or not. */
  const effectiveDisplay = $derived(chooseStageDisplay(displays, chosenFingerprint));
  /** A pinned display that is not currently connected (§52 fingerprints). */
  const pinnedMissing = $derived(
    chosenFingerprint !== null &&
      displays.length > 0 &&
      !displays.some((d) => d.fingerprint === chosenFingerprint),
  );

  /* --------------------------------------------- the live teleprompter view */

  /**
   * The open preview window, or null.
   *
   * Held rather than derived: it owns an OS window and a stage session, and
   * nothing about the settings document can be used to work out whether that
   * window exists. Its lifetime is this screen's — see the teardown below.
   */
  let stagePreview = $state<StagePreviewHandle | null>(null);
  let stagePreviewBusy = $state(false);
  let stagePreviewError = $state<string | null>(null);

  /**
   * The appearance the preview should be showing, from the same function a take
   * uses. Deriving it — rather than assembling one for the preview — is what
   * makes the window trustworthy: there is no arrangement of settings that can
   * look one way here and another way when the presenter hits Present.
   */
  const previewStageSettings = $derived(stageSettingsFromSettings($settings, effectiveDisplay));

  /**
   * Push every change straight to the glass.
   *
   * The point of the feature is dragging a slider and watching the band move,
   * so this deliberately does not debounce. Ordering is guaranteed by the
   * handle, which keeps one directive in flight and coalesces to the latest
   * value behind it — no delay, and the last value the operator chose is the
   * last one the stage is told about.
   *
   * `stagePreview` is TRACKED, not untracked. Untracking it opened a window
   * where a setting changed during the open — the effect ran with no handle,
   * and assigning the handle afterwards did not re-run it, so the window sat on
   * the click-time appearance until something else moved. Tracking costs one
   * redundant directive immediately after opening, which is a message the stage
   * applies to the settings it already has.
   */
  $effect(() => {
    const settings = previewStageSettings;
    const preview = stagePreview;
    if (!preview) return;
    void preview.applySettings(settings).catch(() => {
      /*
       * A dropped directive is not worth an error banner: the window is still
       * showing the previous appearance and the next change sends another. A
       * stage that has genuinely gone surfaces when "Stop preview" is pressed,
       * which is where an error can be both accurate and actionable.
       */
    });
  });

  /**
   * Open the preview, or close it if it is already up.
   *
   * One control for both directions, because there is only ever one preview and
   * the operator's question is "is it on the glass or not".
   */
  async function toggleStagePreview(): Promise<void> {
    if (stagePreviewBusy) return;
    stagePreviewError = null;

    const open = stagePreview;
    if (open) {
      stagePreviewBusy = true;
      try {
        /*
         * Ownership is released only once the window is CONFIRMED gone.
         *
         * Clearing the handle first and then awaiting would lose the only
         * reference that can close this window if the close fails — leaving a
         * frameless always-on-top rectangle over the prompter with nothing left
         * in the app able to address it. Keeping it means the button still says
         * "Stop preview" and pressing it again is a real retry.
         */
        await open.close();
        stagePreview = null;
      } catch (err) {
        stagePreviewError = `The preview window did not close. ${describeError(err)} Press Stop preview again to retry.`;
      } finally {
        stagePreviewBusy = false;
      }
      return;
    }

    const fingerprint = effectiveDisplay?.fingerprint;
    if (fingerprint === undefined) {
      stagePreviewError =
        'No display is selected yet. Choose the teleprompter under Stage display first.';
      return;
    }

    stagePreviewBusy = true;
    // Claimed before the await: if this screen (or this section) goes away
    // while the window is still opening, the teardown below bumps the token and
    // the handle that eventually arrives is closed instead of stranded.
    previewEpoch += 1;
    const epoch = previewEpoch;
    try {
      const handle = await openStagePreview({
        displayFingerprint: fingerprint,
        settings: previewStageSettings,
        /*
         * Always full-screen, and this is not the presentation mode.
         *
         * `openStagePreview`'s `fullscreen` is the SEPARATE stage window's flag —
         * "show this window on that panel, filling it" — and a preview exists to
         * answer "what will this rig look like on that display?". Sizing it to
         * whatever shape a reader-mode take would use would answer a different
         * question about a different window. Reader mode never opens a stage
         * window at all; it presents this one in place.
         */
        fullscreen: true,
      });
      if (epoch !== previewEpoch) {
        void handle.close().catch(() => {});
        return;
      }
      stagePreview = handle;
    } catch (err) {
      if (epoch === previewEpoch) {
        stagePreview = null;
        stagePreviewError = `CandidCue could not show the preview on that display. ${describeError(err)}`;
      }
    } finally {
      stagePreviewBusy = false;
    }
  }

  /**
   * Which open attempt is current.
   *
   * Opening is several awaits long (compile, open, publish, handshake, present)
   * and the screen can be left at any point in it. A handle that arrives after
   * that belongs to nobody, so it is closed rather than assigned.
   */
  let previewEpoch = 0;

  /** Release the preview and stop anything still opening from taking hold. */
  function abandonStagePreview(): void {
    previewEpoch += 1;
    const open = stagePreview;
    stagePreview = null;
    /*
     * The handle is dropped even if this close fails, because there is nobody
     * left to hand it to — a destroyed component has no state and a section
     * that has gone has no button. The service keeps the session id in its
     * orphan set for exactly this case, and the next preview sweeps it.
     */
    void open?.close().catch(() => {});
  }

  /**
   * "End session", pressed on the preview window itself.
   *
   * The stage's exit button emits the same double-Escape a presenter's second
   * Escape does, and for a TAKE the live-session bridge is what answers it. A
   * preview starts no bridge, so without this the button on a preview window is
   * dead — a control that invites a click and does nothing, which is the exact
   * defect it was added to remove, reappearing one window along.
   *
   * Generation-checked like every other stage payload: this must answer for
   * THIS preview's window and never for a take running beside it.
   */
  $effect(() => {
    const preview = stagePreview;
    if (!preview || !isTauriRuntime()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<StageEscapePayload>(STAGE_EVENT.escapeRequested, (event) => {
        if (event.payload.stageGeneration !== preview.stageGeneration) return;
        if (event.payload.presses < 2) return;
        void toggleStagePreview();
      });
      if (cancelled) unlisten();
      else stop = unlisten;
    })().catch(() => {
      // No listener means the stage's own button will not work; the Stop button
      // on this screen still does, so the preview is never unclosable.
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  });

  /*
   * The preview never outlives the screen it is driven from.
   *
   * It is a frameless, always-on-top window covering a monitor, and it is not a
   * take — so nothing else in the app has any reason to close it. TWO exits
   * have to be covered, because they are different events: leaving Settings
   * destroys this component, while moving to another SECTION does not. The
   * second is the easier one to hit and the worse one to suffer: the Stop
   * button goes away with the Teleprompter panel, leaving a black rectangle on
   * the prompter and no visible control anywhere that owns it.
   */
  $effect(() => {
    /*
     * Unconditional, not gated on a handle already existing.
     *
     * Opening is several awaits long, and during it `stagePreview` is still
     * null — so a guard on "is one open" does nothing about the one that is on
     * its way. The epoch bump is precisely what covers that: leave the section
     * mid-open and the handle that eventually arrives is closed rather than
     * installed behind a panel whose Stop button is no longer on screen.
     */
    if (section !== 'teleprompter') abandonStagePreview();
  });

  $effect(() => {
    return () => abandonStagePreview();
  });

  /*
   * Teleprompter needs the display list too.
   *
   * This used to load only for Stage display, and the preview button is
   * disabled while the list is empty — so opening Settings and going straight
   * to Teleprompter presented a permanently dead button on a machine with the
   * prompter plugged in, curable only by visiting an unrelated section first.
   */
  $effect(() => {
    if (section === 'stage' || section === 'teleprompter') void loadDisplays();
  });

  async function loadDisplays(): Promise<void> {
    displaysLoading = true;
    displaysError = null;
    try {
      displays = await stageService.listDisplays();
      if (displays.length === 0) {
        displaysError = 'No displays were detected. Connect the teleprompter display and try again.';
      }
    } catch (err) {
      displays = [];
      displaysError = `CandidCue could not list the connected displays. ${describeError(err)}`;
    } finally {
      displaysLoading = false;
    }
  }

  /**
   * Choose the stage display.
   *
   * There is no per-display appearance memory behind this any more, and that is
   * deliberate. §52 profiles were restored only when a display was PINNED by
   * hand — so the default "Automatic" workflow wrote a row for every take and
   * read none of them, and switching from a pinned display to Automatic carried
   * the pinned display's type across and then saved it over the other panel's
   * row. A memory that only sometimes remembers, and sometimes overwrites the
   * wrong thing, is worse than no memory: what is on this screen is what the
   * stage runs, always.
   */
  async function chooseDisplay(fingerprint: string | null): Promise<void> {
    await patchSettings('stage', { displayFingerprint: fingerprint });
  }

  async function identifyDisplays(): Promise<void> {
    try {
      // Rust puts the numbered card on each physical panel; the toast only
      // tells the operator where to look. Listing display NAMES here cannot
      // answer "which panel is number 2?", which is the whole question.
      const identification = await stageService.identifyDisplays();
      const count = identification?.displays.length ?? 0;
      if (count > 0) {
        displaysError = null;
        showToast(`Look for the number shown on each display (${count} connected)`, 'info', {
          durationMs: 3000,
        });
      }
    } catch (err) {
      displaysError = describeError(err);
    }
  }

  /**
   * Open a real stage window on the chosen display and close it again (§14.2 A).
   *
   * This is the one check that survived Preflight, because it is the only one
   * that answers a question the operator actually has — which physical panel is
   * this? — and because they ask for it rather than being made to wait for it.
   */
  async function runDisplayTest(): Promise<void> {
    const fingerprint = effectiveDisplay?.fingerprint;
    if (fingerprint === undefined) return;
    stageTesting = true;
    displaysError = null;
    const testSessionId = `display-test-${Date.now().toString(36)}`;
    try {
      await stageService.openStage({ displayFingerprint: fingerprint, sessionId: testSessionId });
      // Filling the panel, always. The whole question this button answers is
      // "which physical display is this?", and a window that did not cover the
      // panel would be a worse answer to it — see the note in `openStagePreview`
      // above about why this flag is not the presentation mode.
      await stageService.setStageFullscreen(testSessionId, true);
      window.setTimeout(() => {
        void stageService.closeStage(testSessionId).catch(() => {});
      }, 4000);
    } catch (err) {
      // F.15 "Stage did not open" — stated inline, next to the action.
      displaysError = `CandidCue could not create the prompt window on this display. ${describeError(err)}`;
    } finally {
      stageTesting = false;
    }
  }

  /* ------------------------------------------------------------ the rig */

  /**
   * The calibrated arrangement this panel runs with, and what it resolves to.
   *
   * ------------------------------------------------------------------------
   * TWO PROFILES, AND THE DIFFERENCE MATTERS
   * ------------------------------------------------------------------------
   * `appliedRig` is what a take actually uses: a rig somebody stored AND chose
   * for this panel. `discovered` is what CandidCue can work out on its own —
   * the panel model from the display name, the physical scale from that model,
   * a plausible distance for that hardware — and it is a PROPOSAL, not a rig.
   *
   * The proposal is deliberately not adopted silently. Doing so would resize
   * the stage of every existing Elgato owner the first time they launched a new
   * build, which is the one thing the uncalibrated path is preserved verbatim
   * to prevent. So it is shown, with what it would give them, behind one button.
   */
  const displayShape = $derived(
    effectiveDisplay
      ? {
          name: effectiveDisplay.name,
          physicalSize: effectiveDisplay.physicalSize,
          scaleFactor: effectiveDisplay.scaleFactor,
        }
      : null,
  );
  /** Rigs are stored per panel, so an unresolvable display has none. */
  const rigFingerprint = $derived(effectiveDisplay?.fingerprint ?? null);
  const rigs = $derived(opticalRigsForDisplay($settings.optical, rigFingerprint));
  const appliedRig = $derived(activeOpticalProfile($settings.optical, rigFingerprint));
  const discovered = $derived(discoverProfile(displayShape, null));
  /**
   * The profile the panel below describes — the applied rig, or the proposal.
   *
   * The proposal is given a name no rig stored against this panel is already
   * using. Editing it is what applies it, and `withOpticalProfile` keys on
   * (panel, name) — so a proposal that reused the name of a rig somebody had
   * measured would replace those measurements with discovery's guesses the
   * first time a slider moved, from a panel that says "nothing is applied to
   * this display yet". `calibrate()` below already spells this rule out for the
   * wizard; the proposal reaches the same store by a shorter path, and there is
   * no version of it that may reach it with a name already spoken for.
   *
   * Reachable rather than theoretical: forgetting the rig in force clears the
   * panel's choice without deleting the others, which lands exactly here with a
   * named rig still stored.
   */
  const rig = $derived<OpticalProfile>(
    appliedRig ?? { ...discovered.profile, rigName: unusedRigName(discovered.profile.rigName) },
  );

  /**
   * The resolved geometry, live.
   *
   * The same `resolveStageGeometry` a take runs through, against the same
   * panel, so the readout cannot describe a stage the take would not produce.
   * Font metrics are not supplied and must not be: control does not render the
   * stage font, so what comes back is marked `metricsMeasured: false` and the
   * warnings say so rather than presenting DIN ratios as a measurement.
   */
  const resolvedRig = $derived.by(() => {
    const d = effectiveDisplay;
    if (!d) return null;
    const widthPx = d.logicalSize.width;
    const heightPx = d.logicalSize.height;
    if (!(widthPx > 0) || !(heightPx > 0)) return null;
    return resolveStageGeometry({ profile: rig, viewport: { widthPx, heightPx } });
  });
  const rigOptics = $derived(resolvedRig?.optics ?? null);

  /**
   * Lines of script visible at once.
   *
   * Not a field of `ResolvedOptics`, because the stage measures its own line
   * pitch and this is only an estimate of it — but it is the number that
   * decides whether a size is generous or claustrophobic, and it is invisible
   * in "60 px" and "23 arcminutes". Six lines is a paragraph of context to read
   * ahead into; three is a card being read one phrase at a time.
   */
  const rigVisibleLines = $derived.by(() => {
    const o = rigOptics;
    const d = effectiveDisplay;
    if (!o || !d) return null;
    const safeHeightPx = d.logicalSize.height * (1 - o.safeArea.top - o.safeArea.bottom);
    const linePx = o.bodyFontSizePx * o.lineHeight;
    if (!(linePx > 0) || !(safeHeightPx > 0)) return null;
    return Math.floor(safeHeightPx / linePx);
  });

  const FIT_PHRASES: Record<string, string> = {
    ok: 'The size asked for and a full reading line both fit on this panel.',
    width_limited: 'Type is at the size asked for; the line is narrower than ideal.',
    angle_limited: 'A readable line needs the type smaller than asked for.',
    impossible: 'This panel cannot do both at this distance.',
    uncalibrated: 'Not calibrated, so no claim about apparent size can be made.',
  };

  /**
   * Store a change to the rig, and make it the one this panel runs with.
   *
   * Editing the discovered PROPOSAL is what applies it — which is stated on the
   * panel rather than left to be discovered. The alternative, disabling every
   * control until an Apply button is pressed, makes the proposal unexplorable:
   * the whole reason to show it is so somebody can see what it would do.
   */
  async function updateRig(patch: Partial<OpticalProfile>): Promise<void> {
    const fingerprint = rigFingerprint;
    if (fingerprint === null) return;
    const next: OpticalProfile = { ...rig, ...patch };
    await patchSettings('optical', withOpticalProfile($settings.optical, fingerprint, next));
  }

  /** Set one override, or clear it — `null` is the reset to automatic. */
  async function setOverride(key: keyof OpticalOverrides, value: number | null): Promise<void> {
    const overrides: OpticalOverrides = { ...rig.overrides };
    if (value === null) delete overrides[key];
    else overrides[key] = value;
    await updateRig({ overrides });
  }

  async function clearAllOverrides(): Promise<void> {
    await updateRig({ overrides: {} });
  }

  async function chooseRig(name: string): Promise<void> {
    const fingerprint = rigFingerprint;
    const entry = rigs.find((r) => r.profile.rigName === name);
    if (fingerprint === null || !entry) return;
    await patchSettings(
      'optical',
      withOpticalProfile($settings.optical, fingerprint, entry.profile),
    );
  }

  async function forgetRig(name: string): Promise<void> {
    const fingerprint = rigFingerprint;
    if (fingerprint === null) return;
    const accepted = await requestConfirm({
      title: `Forget ${name}?`,
      body: 'The measurements for this arrangement are deleted. Takes on this display go back to the uncalibrated size until another rig is chosen.',
      confirmLabel: 'Forget rig',
      danger: true,
    });
    if (!accepted) return;
    await patchSettings(
      'optical',
      withoutOpticalProfile($settings.optical, fingerprint, name),
    );
  }

  /**
   * Open the calibration wizard for a rig on this panel.
   *
   * A new rig gets a name that does not collide with an existing one, because
   * the store is keyed on (panel, name): reusing a name silently REPLACES the
   * other arrangement, and nobody re-measures a distance they believe is saved.
   */
  function calibrate(name?: string): void {
    const fingerprint = rigFingerprint;
    if (fingerprint === null) return;
    void navigate({
      name: 'calibrate',
      displayFingerprint: fingerprint,
      rigName: name ?? unusedRigName(discovered.profile.rigName),
    });
  }

  function unusedRigName(preferred: string): string {
    const taken = new Set(rigs.map((r) => r.profile.rigName));
    if (!taken.has(preferred)) return preferred;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${preferred} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${preferred} ${Date.now().toString(36)}`;
  }

  /** Metres, because that is the unit somebody pacing out a studio thinks in. */
  const DISTANCE_PRESETS_M = [0.8, 1.0, 1.2, 1.5, 1.8];
  let distanceField = $state('');

  function applyTypedDistance(): void {
    const mm = Math.round(Number(distanceField.trim()) * 1000);
    if (!isPlausibleViewingDistanceMm(mm)) {
      showToast(
        `A viewing distance has to be between ${MIN_VIEWING_DISTANCE_MM / 1000} m and ${MAX_VIEWING_DISTANCE_MM / 1000} m.`,
        'danger',
      );
      return;
    }
    void updateRig({ viewingDistanceMm: mm });
  }

  /**
   * The largest fraction of the safe width the resolver will give a column.
   *
   * Mirrors `MAX_COLUMN_FRACTION` in shared/optical-resolve.ts, which is module
   * -private. It is repeated here only so the override slider can show what
   * "Automatic" currently means; if the resolver's value moves, this is a
   * label that goes stale rather than a behaviour that changes.
   */
  const AUTOMATIC_MAX_COLUMN_FRACTION = 0.92;

  /**
   * The ceiling on the uncalibrated size slider — see `typeCeilingPx` in
   * lib/stage-appearance.ts, which the in-session sheet draws its own size
   * slider against. The two screens set the same value and must offer the same
   * range: a limit that lives on one of them is a limit that drifts.
   */
  const sizeCeilingPx = $derived(typeCeilingPx($settings.teleprompter.fontSizePx));

  /**
   * How many hand-set values this rig carries.
   *
   * Counted from the profile's own `overrides` map rather than from
   * `ResolvedOptics.overriddenFields`, because the two answer different
   * questions and only one of them is what a reset acts on. The resolver
   * records what it APPLIED — a pinned value that happens to equal the derived
   * one is not listed — while the map records what somebody TYPED. Keying the
   * reset off the resolver would leave a stored override with no control
   * offering to clear it, which is the trap the override block is written
   * against.
   */
  const pinnedCount = $derived(Object.keys(rig.overrides).length);

  /**
   * What "Automatic" currently means for one override.
   *
   * Read off the RESOLVED block wherever there is one, never off the defaults
   * table. The point of putting a number beside the word "Automatic" is that it
   * is what THIS panel at THIS distance actually produces — and for size,
   * measure, the secondary-text floor and the fade depths that is nothing like
   * the constant. A control that showed 0.84 for the dead zone while the stage
   * ran 71 px of corridor would be describing a different instrument.
   */
  function automaticValue(key: keyof OpticalOverrides): number {
    const o = rigOptics;
    switch (key) {
      case 'fontSizePx':
        return o ? Math.round(o.bodyFontSizePx) : $settings.teleprompter.fontSizePx;
      case 'arcminutes':
        return o?.bodyArcminutes ?? resolveTargetArcminutes(rig);
      case 'characters':
        return o?.charactersPerLine ?? resolveTargetCharacters(rig);
      case 'columnCh':
        return o?.columnCh ?? 30;
      case 'maxColumnFraction':
        return AUTOMATIC_MAX_COLUMN_FRACTION;
      case 'lineHeight':
        return o?.lineHeight ?? $settings.teleprompter.lineHeight;
      case 'fontWeight':
        return o?.fontWeight ?? DEFAULT_FONT_WEIGHT;
      case 'letterSpacingEm':
        return o?.letterSpacingEm ?? DEFAULT_LETTER_SPACING_EM;
      case 'paragraphSpacingEm':
        return o?.paragraphSpacingEm ?? DEFAULT_PARAGRAPH_SPACING_EM;
      case 'deadZoneLines':
        return o?.deadZoneLines ?? DEFAULT_DEAD_ZONE_LINES;
      case 'topFadeLines':
        return o?.topFadeLines ?? DEFAULT_TOP_FADE_LINES;
      case 'bottomFadeLines':
        return o?.bottomFadeLines ?? DEFAULT_BOTTOM_FADE_LINES;
      case 'futureReserveLines':
        return o?.futureReserveLines ?? DEFAULT_FUTURE_RESERVE_LINES;
      case 'sentenceMicrogapLines':
        return o?.sentenceMicrogapLines ?? DEFAULT_SENTENCE_MICROGAP_LINES;
      case 'pastOpacity':
        return o?.pastOpacity ?? DEFAULT_PAST_OPACITY;
      case 'futureOpacity':
        return o?.futureOpacity ?? DEFAULT_FUTURE_OPACITY;
      case 'secondaryMinPx':
        return o?.secondaryMinPx ?? 28;
      case 'readingBandY':
        // Where the band actually resolved to, which on a lens rig is derived
        // from the crosshair and on a reader rig is the no-lens default — so the
        // constant is the fallback rather than the answer, same as every case
        // above it.
        return o?.readingBandY ?? NO_LENS_READING_BAND_FRACTION;
      case 'lensOffsetDegrees':
        // Zero, and the default is zero: the evidence supports OFFERING a small
        // downward shift, not applying one.
        return 0;
    }
  }

  /* ----------------------------------------------------------- microphone */

  let micPermission = $state<'unknown' | 'granted' | 'denied'>('unknown');
  /** Guards the one-shot adoption of an already-granted permission. */
  let micAdopted = false;
  let micDevices = $state<AudioDeviceInfo[]>([]);
  let micLevel = $state<AudioLevelSnapshot | null>(null);
  let micError = $state<string | null>(null);
  let micTestSnapshot = $state<MicTestSnapshot>({
    state: 'idle',
    partial: '',
    final: '',
    error: null,
    stoppedReason: null,
  });
  const micTest = $derived(micTestSnapshot.state);
  const micTestRunning = $derived(
    micTest === 'opening' || micTest === 'listening' || micTest === 'waiting',
  );
  const micTestNotice = $derived(micTestStopNotice(micTestSnapshot.stoppedReason));
  /**
   * The pin as REMEMBERED — whether or not that microphone is plugged in now.
   * `undefined` means the choice is "follow the system default".
   */
  const micPinned = $derived(
    $settings.audio.followSystemDefault ||
      $settings.audio.preferredDeviceId === undefined ||
      // Older builds auto-pinned the browser's own `default` pseudo-device,
      // which is the system-default choice spelled a second way.
      $settings.audio.preferredDeviceId === 'default'
      ? undefined
      : {
          deviceId: $settings.audio.preferredDeviceId,
          label: $settings.audio.preferredDeviceLabel ?? 'The remembered microphone',
        },
  );
  /** The remembered pin among the inputs that are connected right now. */
  const micPinnedDevice = $derived(micPinned ? matchRememberedMicrophone(micDevices, micPinned) : undefined);
  /**
   * The input a take would actually open — which is not always the one named in
   * the picker.
   *
   * "Follow system default" means the take pins no device id at all, so a meter
   * or a transcription test run against the remembered `preferredDeviceId`
   * would be measuring an input the session will not use. A diagnostic that
   * exercises a different microphone from the one under test is worse than no
   * diagnostic: it answers a question nobody asked, convincingly.
   *
   * A remembered device that is UNPLUGGED resolves the same way, for the same
   * reason: the meter has to read the input the session will really open.
   */
  const micDeviceId = $derived(micPinnedDevice?.deviceId);
  /**
   * §28.1. One control, not two.
   *
   * "Follow the system default" is a choice ABOUT the input device, so it is a
   * row in the input picker rather than a toggle in a different section further
   * down the page. It used to be the latter, and the picker was DISABLED AND
   * BLANK whenever it was on — which is the default — so the screen's answer to
   * "which microphone is this using?" was an empty, dead dropdown, and the
   * control that explained it was somewhere else with no visible connection to
   * it.
   */
  const micOptions = $derived(
    microphoneOptions(
      micDevices,
      micPinned && !micPinnedDevice
        ? { deviceId: micPinned.deviceId, label: micPinned.label }
        : undefined,
    ),
  );
  const micSelectValue = $derived(
    micPinned ? (micPinnedDevice?.deviceId ?? micPinned.deviceId) : SYSTEM_DEFAULT_OPTION,
  );

  /**
   * One capture at a time, and the next one waits for the last to let go.
   *
   * The meter, the transcription test and a take all open the SAME device, and
   * `observeLevels`' disposer is asynchronous — it does not return until the
   * capture it started has been acquired and then released (services/
   * voice-live.ts). Firing it and moving on is what produces the documented
   * 9.8-second contention: WKWebView asked for a second concurrent stream on a
   * granted device does not fail and does not reject, it HANGS, and the caller
   * sits at "opening the microphone" until its deadline.
   *
   * Svelte discards whatever an effect's cleanup returns, so the teardown alone
   * can only START the release. This baton is what lets the next acquisition
   * wait for it: every open is chained behind the previous close, so the two
   * can never overlap however fast the section, the device or the settings
   * change underneath them.
   */
  let captureBaton: Promise<unknown> = Promise.resolve();

  /**
   * §14.2 C. A BILLABLE realtime session, so its whole lifecycle — Stop, the
   * idle timeout and the duration cap — lives in `services/mic-test-session.ts`
   * where each closing path is provable. This screen only renders what it says.
   */
  const micTestSession = new MicTestSession({
    open: (deviceId, events) => getVoiceFacade().startTranscriptionTest(deviceId, events),
    onChange: (snapshot) => {
      micTestSnapshot = snapshot;
      if (snapshot.error !== null) micError = snapshot.error;
    },
    describe: describeError,
  });

  /** Disposed on unmount even mid-acquisition, and on leaving the section. */
  $effect(() => {
    if (section === 'audio') return;
    micTestSession.dispose();
  });
  $effect(() => {
    return () => micTestSession.dispose();
  });

  /*
   * §28.1: never prompt on mount, but DO notice a permission that is already
   * granted — otherwise a returning user is asked to re-click "Allow". The
   * subscription also catches a grant made in System Settings while this screen
   * is open. Platforms that cannot report the state ('unsupported') fall
   * through to the remembered-grant effect below.
   */
  $effect(() => {
    if (section !== 'audio') return undefined;
    return getVoiceFacade().watchMicrophonePermission((state) => {
      if (state === 'granted') {
        void adoptGrantedMicrophone();
      } else if (state === 'denied') {
        micAdopted = false;
        micPermission = 'denied';
      }
    });
  });

  /**
   * §28.1. Adopt a grant this machine has already made.
   *
   * THE ONLY WEBVIEW THIS APP SHIPS IN CANNOT ANSWER THE QUESTION ABOVE.
   * `navigator.permissions.query({ name: 'microphone' })` is not implemented in
   * WKWebView, so the watcher reports 'unsupported' every single launch, the
   * 'granted' branch never runs, and the screen asks a returning user to click
   * "Allow and choose microphone" again — forever, on the one platform that
   * matters. macOS grants the microphone to the APPLICATION, so the grant is
   * genuinely still there; only the webview's ability to see it is missing.
   *
   * `audio.microphoneGranted` is the record of that grant and this is what
   * reads it. The predicate is pure and lives in services/mic-test-session.ts
   * because getting it wrong is silent: it was first written INSIDE the watcher
   * callback above, which fires once at mount — usually before the settings
   * store has loaded, so the flag was still false and no second callback ever
   * came. An `$effect` re-runs when the store lands, which is the whole point.
   */
  let micAdoptAttempted = false;
  $effect(() => {
    if (section !== 'audio') return;
    if (
      !shouldAdoptRememberedMicrophone({
        remembered: $settings.audio.microphoneGranted,
        attempted: micAdoptAttempted,
        adopted: micAdopted,
        permission: micPermission,
      })
    ) {
      return;
    }
    // One try per visit: enumeration cannot prompt, but a grant revoked in
    // System Settings must not turn this into a loop.
    micAdoptAttempted = true;
    void adoptGrantedMicrophone();
  });

  /*
   * §28.2. Keep the picker honest about what is plugged in.
   *
   * Someone opening this screen to choose a better microphone very often plugs
   * it in while they are looking at it, and a list enumerated once cannot show
   * it. Reporting only — a new input is never switched to on its own.
   */
  $effect(() => {
    if (section !== 'audio' || micPermission !== 'granted') return undefined;
    return getVoiceFacade().watchInputDevices((devices) => {
      micDevices = devices;
      micError = null;
      // The remembered microphone may be exactly what was just connected, and
      // its id will not be the one that was saved.
      repinRememberedMicrophone(devices);
    });
  });

  /*
   * The level meter, while this section is open and permission is granted.
   *
   * Scoped to the section on purpose. The meter holds an open capture, and a
   * capture held by a screen nobody is looking at is a microphone the next take
   * has to prise away — the documented 9.8-second contention. Leaving Audio
   * releases it.
   */
  $effect(() => {
    // The test owns the device while it runs — one capture, not two, on the
    // one path where both controls are a click apart.
    if (section !== 'audio' || micPermission !== 'granted' || micTestRunning) return undefined;
    // §28.4/§28.3: the meter reads the same sensitivity AND the same capture
    // processing a take will use, so what is shown is a reading of the
    // configuration that is about to run rather than of a default one.
    const deviceId = micDeviceId;
    const options = {
      vadSensitivity: $settings.audio.vadSensitivity,
      processing: {
        echoCancellation: $settings.audio.echoCancellation,
        noiseSuppression: $settings.audio.noiseSuppression,
        autoGainControl: $settings.audio.autoGainControl,
      },
    };

    let cancelled = false;
    let release: (() => void | Promise<void>) | null = null;
    // Chained, not called: changing the device or a processing toggle re-runs
    // this effect, and starting the replacement before the previous capture has
    // let go is the collision this baton exists to prevent.
    const opened = captureBaton.then(() => {
      if (cancelled) return;
      release = getVoiceFacade().observeLevels(
        deviceId,
        (snapshot) => {
          micLevel = snapshot;
        },
        options,
      );
    });
    captureBaton = opened;

    return () => {
      cancelled = true;
      micLevel = null;
      captureBaton = opened
        .then(async () => {
          if (release) await release();
        })
        .catch(() => {
          // Failing to hang up cleanly must never wedge the baton, or every
          // later capture on this screen would wait on a promise that never
          // settles.
        });
    };
  });

  /**
   * Wait for the microphone to be genuinely free.
   *
   * Setting a flag is not releasing a device, and neither is `await tick()` —
   * that flushes Svelte, not `getUserMedia`. Anything that wants the input to
   * itself has to await the baton.
   */
  async function microphoneQuiet(): Promise<void> {
    await tick();
    await captureBaton;
  }

  /**
   * Open the billable transcription test, once the meter has let go.
   *
   * `micTestRunning` closes the meter through the effect above; `tick()` runs
   * that teardown, and the baton is what waits for the capture the teardown
   * started to let go of. Both halves are needed — the gap between them is
   * exactly where the contention lives.
   */
  async function runTranscriptionTest(): Promise<void> {
    micError = null;
    micTestSnapshot = { ...micTestSnapshot, state: 'opening' };
    await microphoneQuiet();
    await micTestSession.start(micDeviceId);
  }

  /** Enumerate inputs for an already-granted permission — never prompts. */
  async function adoptGrantedMicrophone(): Promise<void> {
    if (micAdopted) return;
    micAdopted = true;
    try {
      const devices = await getVoiceFacade().listMicrophones();
      micDevices = devices;
      micPermission = 'granted';
      micError = devices.length === 0
        ? 'No microphone was found. Connect an input device and try again.'
        : null;
      repinRememberedMicrophone(devices);
    } catch (err) {
      micAdopted = false;
      micError = describeError(err);
    }
  }

  /**
   * §28.1. Re-bind the remembered microphone to the id it has TODAY.
   *
   * Device ids are salted per origin and per session and can change when
   * hardware is replugged, so the id written last week may name nothing now
   * while the microphone itself is sitting right there. Matching by label and
   * writing the fresh id back is what turns "remember my microphone" into
   * something that survives a restart.
   *
   * What it deliberately does NOT do is overwrite a remembered choice with a
   * fallback when the device is absent. The old code did: an unplugged Yeti
   * became a pin on the built-in microphone, permanently, so plugging the Yeti
   * back in changed nothing. A pin for something that is not here is kept and
   * SAID (see the notice under the picker) — it costs nothing, because
   * `micDeviceId` already resolves to the system default meanwhile.
   */
  function repinRememberedMicrophone(devices: AudioDeviceInfo[]): void {
    const remembered = micPinned;
    if (!remembered) return;
    const match = matchRememberedMicrophone(devices, remembered);
    if (!match) return;
    if (match.deviceId === remembered.deviceId && match.label === remembered.label) return;
    void patchSettings('audio', {
      preferredDeviceId: match.deviceId,
      preferredDeviceLabel: match.label,
    }).catch(() => {
      /* a remembered preference is a convenience, never a gate */
    });
  }

  /**
   * The one place the input choice is made — the system-default row included.
   */
  function chooseMicrophone(value: string): void {
    if (value === SYSTEM_DEFAULT_OPTION) {
      void patchSettings('audio', { followSystemDefault: true }).catch(() => {});
      return;
    }
    const chosen = micDevices.find((d) => d.deviceId === value);
    void patchSettings('audio', {
      followSystemDefault: false,
      preferredDeviceId: value,
      // Chosen from the "(not connected)" row: keep the label already stored,
      // which is the only name that device has here.
      ...(chosen ? { preferredDeviceLabel: chosen.label } : {}),
    }).catch(() => {});
  }

  async function allowMicrophone(): Promise<void> {
    micError = null;
    try {
      const granted = await getVoiceFacade().requestMicrophoneAccess();
      if (granted === 'granted') {
        micAdopted = false;
        await adoptGrantedMicrophone();
        // Remember it. WKWebView cannot report permission state, so this flag
        // is the only way a returning user is not asked again (§28.1).
        if (!$settings.audio.microphoneGranted) {
          void patchSettings('audio', { microphoneGranted: true }).catch(() => {});
        }
      } else {
        micPermission = 'denied';
      }
    } catch (err) {
      // A rejected request used to leave the row at "Testing…" forever.
      micPermission = 'unknown';
      micError = `CandidCue could not ask for microphone access. ${describeError(err)}`;
    }
  }

  /** Local time, seconds resolution — enough to match a code to "just now". */
  function errorTime(atMs: number): string {
    return new Date(atMs).toLocaleTimeString();
  }

  async function loadDiagnostics(): Promise<void> {
    diagnosticsLoading = true;
    diagnosticsError = null;
    recentErrors = recentErrorDiagnostics();
    try {
      diagnostics = await diagnosticsService.getSystemDiagnostics();
    } catch (err) {
      diagnostics = null;
      diagnosticsError =
        err instanceof BackendUnavailableError
          ? 'Diagnostics need the CandidCue desktop app.'
          : describeError(err);
    } finally {
      diagnosticsLoading = false;
    }
  }

  async function copyDiagnostics(): Promise<void> {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(diagnosticsClipboardText(diagnostics));
      showToast('Diagnostics copied', 'success');
    } catch {
      showToast('Could not copy to the clipboard', 'danger');
    }
  }

  async function runSupportBundle(): Promise<void> {
    await runMaintenance(
      () => diagnosticsService.exportSupportBundle(),
      // Rust runs the folder picker; cancelling is not a failure.
      (result) => (result.cancelled ? null : 'Support bundle ready'),
    );
  }

  /**
   * C6: this used to invoke the Rust `all` cache kind, which empties the
   * compiled/vocabulary/thumbnail/download caches and never touches a log
   * file — then reported "Logs cleared." It now calls the real `logs` arm.
   */
  async function clearLogs(): Promise<void> {
    const accepted = await requestConfirm({
      title: 'Clear all logs?',
      body: 'This may make an existing issue harder to diagnose. Scripts and settings are unaffected.',
      confirmLabel: 'Clear logs',
      danger: true,
    });
    if (!accepted) return;
    await runMaintenance(
      () => settingsService.clearCache('logs'),
      (result) => (result.clearedFiles === 0 ? 'No logs to clear' : 'Logs cleared'),
    );
  }

  /**
   * C5/C6: every one of these buttons was `void …then(showToast)` with no
   * `.catch`, so a rejected command produced no export, no toast and no error.
   * A failure is now reported, and a cancelled picker says nothing at all.
   */
  async function runMaintenance<T>(
    run: () => Promise<T>,
    describeSuccess: (result: T) => string | null,
  ): Promise<void> {
    try {
      const message = describeSuccess(await run());
      if (message) showToast(message, 'success');
    } catch (err) {
      showToast(describeError(err), 'danger');
    }
  }

  async function runExportAllData(): Promise<void> {
    await runMaintenance(
      () => settingsService.exportAllData(),
      // Rust runs the folder picker; a cancelled picker is not a failure and
      // is not worth a toast.
      (result) => (result.cancelled ? null : 'Export ready'),
    );
  }

  async function runUpdateCheck(): Promise<void> {
    updateNote = 'Checking…';
    try {
      const result = await settingsService.checkForUpdate();
      updateNote =
        result.status === 'available'
          ? `Update available: ${result.availableVersion}`
          : result.status === 'up_to_date'
            ? 'CandidCue is up to date.'
            : result.status === 'unsupported'
              ? 'Update checks are not available in this build.'
              : `Could not check for updates: ${result.message ?? 'unknown error'}`;
    } catch (err) {
      updateNote = `Could not check for updates. ${describeError(err)}`;
    }
  }
</script>

<div class="page">
  <PageHeader title="Settings" backLabel="Library" onback={() => navigate({ name: 'library', view: 'all' })} />

  <div class="body">
    <nav class="section-nav" aria-label="Settings sections">
      {#each sections as entry (entry.id)}
        <button
          type="button"
          class="section-item"
          class:active={($route.name === 'settings' ? section : 'general') === entry.id}
          aria-current={section === entry.id ? 'page' : undefined}
          onclick={() => navigate({ name: 'settings', section: entry.id })}
        >
          {entry.label}
        </button>
      {/each}
    </nav>

    <div class="content">
      {#if section === 'general'}
        <Section title="General">
          <Select
            label="On launch"
            value={$settings.general.launchBehavior}
            options={[
              { value: 'library', label: 'Open the script library' },
              { value: 'recent', label: 'Open the most recent script' },
            ]}
            onchange={(value) =>
              void patchSettings('general', { launchBehavior: value as 'library' | 'recent' })}
          />
          <!--
            One mode, said out loud.

            'manual' and 'fixed' are still in the `SessionMode` union because a
            session RECORD carries the mode it ran in and old rows have to keep
            parsing — but nothing STARTS a take in either of them. Offering all
            three made the mode look like a choice, and choosing one of the two
            that do nothing produced a take that behaved exactly like voice
            follow without saying so.

            Constant-rate motion is no longer the thing that is missing: there
            is a fixed-pace transport, and the pace slider further down this
            section sets it. What is missing is a MODE — a take that opens with
            no microphone, no socket and no meter, and prompts by the clock
            alone. That is a different decision from "can the script roll", and
            until somebody makes it, a take always opens listening.
          -->
          <Select
            label="Default session mode"
            value={$settings.general.defaultSessionMode}
            options={[
              { value: 'voice', label: 'Voice follow' },
              { value: 'manual', label: 'Manual — not available in this release', disabled: true },
              { value: 'fixed', label: 'Fixed speed — not available in this release', disabled: true },
            ]}
            onchange={(value) =>
              void patchSettings('general', {
                defaultSessionMode: value as 'voice' | 'manual' | 'fixed',
              })}
          />
          <p class="hint-line">
            Every take opens listening. Auto-scroll can roll the script at a set pace from inside
            any take (see the pace below), but there is no mode that starts one without a
            microphone — so these two are shown here rather than offered, because a mode that
            silently behaves like another one is worse than a mode that is missing.
          </p>
          <Slider
            label="Revision retention"
            value={$settings.general.revisionRetentionDays}
            min={7}
            max={90}
            format={(v) => `${v} days`}
            onchange={(value) => void patchSettings('general', { revisionRetentionDays: value })}
          />
          <Toggle
            checked={$settings.general.restoreWindows}
            label="Restore open windows"
            onchange={(value) => void patchSettings('general', { restoreWindows: value })}
          />
          <Toggle
            checked={$settings.general.confirmEndSession}
            label="Confirm before ending an active session"
            onchange={(value) => void patchSettings('general', { confirmEndSession: value })}
          />
          <!-- A compile switch, not a stage one: it changes what counts as a
               spoken token, so it is read when a take compiles the script. -->
          <Toggle
            checked={$settings.general.readHeadings}
            label="Read headings aloud"
            description="Track heading text as spoken words"
            onchange={(value) => void patchSettings('general', { readHeadings: value })}
          />
        </Section>
      {:else if section === 'speech'}
        <Section
          title="Speech"
          description="CandidCue transcribes on this machine. The recogniser is part of the app — there is no account to create, no key to paste, and no audio leaves your computer."
        >
          {#snippet actions()}
            {#if engineStatus?.available}
              <StatusPill
                tone="success"
                label={engineStatus.loaded ? 'Ready' : 'Installed'}
              />
            {:else if engineStatus}
              <StatusPill tone="warning" label="Not installed" />
            {:else}
              <StatusPill tone="neutral" label="Checking…" />
            {/if}
          {/snippet}

          {#if engineStatus && !engineStatus.available}
            <p class="inline-alert" role="alert">
              The speech model is missing from this installation, so voice tracking cannot run.
              Reinstalling CandidCue will restore it.
            </p>
            {#if engineStatus.detail}<p class="hint-line">{engineStatus.detail}</p>{/if}
          {/if}

          <p class="hint-line">
            Recogniser: <code>{engineStatus?.model ?? '—'}</code>. English only. It runs while a take
            is running and uses a small fraction of one CPU core.
          </p>
          <p class="hint-line">
            Your voice is never uploaded, and nothing is recorded or saved — the words are used only
            to work out where in the script you are. They are kept only if you turn on
            transcript saving under Data &amp; privacy.
          </p>
        </Section>
      {:else if section === 'audio'}
        <Section
          title="Microphone"
          description="CandidCue uses your microphone only while a test or a voice-tracking take is running. The audio is transcribed on this machine and is not recorded, saved, or uploaded."
        >
          {#if micPermission === 'unknown'}
            <div class="row-actions">
              <Button variant="primary" onclick={() => allowMicrophone()}>
                Allow and choose microphone
              </Button>
            </div>
          {:else if micPermission === 'denied'}
            <p class="inline-alert" role="alert">
              Microphone access is blocked. Allow CandidCue in your system privacy settings, then
              try again.
            </p>
            <div class="row-actions">
              <!-- Names the remedy rather than repeating the failed attempt. -->
              <Button onclick={() => allowMicrophone()}>Fix microphone access</Button>
            </div>
          {:else}
            <Select
              label="Input device"
              value={micSelectValue}
              options={micOptions}
              onchange={(value) => chooseMicrophone(value)}
            />
            {#if micPinned && !micPinnedDevice}
              <!--
                The pin is kept, not quietly dropped: this is a microphone that
                is coming back, and saying so beats a picker that silently
                reverts to the default and leaves the presenter to notice on
                stage.
              -->
              <p class="hint-line">
                {micPinned.label} is not connected. CandidCue is using the system default until it
                is plugged back in.
              </p>
            {/if}
            <MicMeter level={micLevel} />
            <!--
              Costs nothing but holds the microphone, so it can always be
              stopped and it closes itself if it is forgotten (see
              services/mic-test-session.ts for the two deadlines).
            -->
            <div class="row-actions">
              <Button onclick={() => void runTranscriptionTest()} disabled={micTestRunning}>
                Test transcription
              </Button>
              {#if micTestRunning}
                <Button variant="danger" onclick={() => micTestSession.stop('user')}>Stop test</Button>
              {/if}
              {#if micTest !== 'idle'}
                <span class="mic-test-state" class:live={micTestRunning} aria-live="polite">
                  {#if micTestRunning}<span class="mic-test-dot" aria-hidden="true"></span>{/if}
                  {#if micTest === 'opening'}
                    Connecting…
                  {:else if micTest === 'listening'}
                    Say: “CandidCue is following my voice.” — Listening…
                  {:else if micTest === 'waiting'}
                    Audio detected. Waiting for transcription…
                  {:else}
                    Transcription is working.
                  {/if}
                </span>
              {/if}
            </div>
            {#if micTestRunning}
              <p class="hint-line">
                Listening on this machine. It stops on its own after 30 seconds with nothing
                transcribed, and after two minutes in any case.
              </p>
            {:else if micTestNotice}
              <p class="hint-line">{micTestNotice}</p>
            {/if}
            {#if micTestSnapshot.partial || micTestSnapshot.final}
              <p class="transcript" class:final={Boolean(micTestSnapshot.final)}>
                {micTestSnapshot.final || micTestSnapshot.partial}
              </p>
            {/if}
          {/if}
          {#if micError}
            <p class="inline-alert" role="alert">{micError}</p>
          {/if}
        </Section>
        <!--
          "Follow system default microphone" used to be a toggle here, three
          controls away from the picker it disabled and blanked. One control
          now: it is the first row of the input picker above.
        -->
        <Section title="Capture">
          <Toggle
            checked={$settings.audio.noiseSuppression}
            label="Noise suppression"
            onchange={(value) => void patchSettings('audio', { noiseSuppression: value })}
          />
          <Toggle
            checked={$settings.audio.echoCancellation}
            label="Echo cancellation"
            onchange={(value) => void patchSettings('audio', { echoCancellation: value })}
          />
          <Toggle
            checked={$settings.audio.autoGainControl}
            label="Automatic gain control"
            onchange={(value) => void patchSettings('audio', { autoGainControl: value })}
          />
          <!--
            §28.4. It is a property of a room and a microphone, not of a take,
            and the meter above observes at this value — so a change to it shows
            immediately instead of being discovered mid-take.
          -->
          <Slider
            label={VAD_SENSITIVITY_COPY.label}
            description={VAD_SENSITIVITY_COPY.description}
            value={Math.round($settings.audio.vadSensitivity * 100)}
            min={0}
            max={100}
            format={VAD_SENSITIVITY_COPY.format}
            onchange={(value) => void patchSettings('audio', { vadSensitivity: value / 100 })}
          />
        </Section>
      {:else if section === 'stage'}
        <Section
          title="Stage display"
          description="Where the prompt window opens. Present goes straight here — this is set once, not before every take."
        >
          {#snippet actions()}
            <Button size="sm" disabled={displaysLoading} onclick={() => void loadDisplays()}>
              {displaysLoading ? 'Checking…' : 'Check again'}
            </Button>
          {/snippet}
          <div class="display-grid">
            <button
              type="button"
              class="monitor-tile"
              class:selected={chosenFingerprint === null}
              aria-pressed={chosenFingerprint === null}
              onclick={() => void chooseDisplay(null)}
            >
              <span class="monitor-glyph"><Icon name="monitor" size={22} /></span>
              <span class="monitor-name">Automatic</span>
              <span class="monitor-meta">
                {automaticDisplay
                  ? `Currently ${automaticDisplay.name ?? 'the connected display'}`
                  : 'An external display when one is connected'}
              </span>
            </button>
            {#each displays as display (display.fingerprint)}
              <button
                type="button"
                class="monitor-tile"
                class:selected={chosenFingerprint === display.fingerprint}
                aria-pressed={chosenFingerprint === display.fingerprint}
                onclick={() => void chooseDisplay(display.fingerprint)}
              >
                <span class="monitor-glyph"><Icon name="monitor" size={22} /></span>
                <span class="monitor-name">{display.name ?? 'Display'}</span>
                <span class="monitor-meta">
                  {display.physicalSize.width} × {display.physicalSize.height} · {display.scaleFactor}×
                </span>
                <span class="monitor-badges">
                  {#if display.primary}<StatusPill tone="neutral" dot={false} label="Primary" />{/if}
                </span>
              </button>
            {/each}
          </div>
          {#if pinnedMissing}
            <!-- Said here rather than discovered at Present: the fingerprint is
                 panel identity, so a display that is unplugged simply stops
                 matching and the take quietly lands somewhere else. -->
            <p class="inline-alert" role="alert">
              The display you chose is not connected. Takes will open on
              {effectiveDisplay?.name ?? 'another display'} until it is back.
            </p>
          {/if}
          <div class="row-actions">
            <Button onclick={() => void identifyDisplays()}>Identify displays</Button>
            <Button disabled={!effectiveDisplay || stageTesting} onclick={() => void runDisplayTest()}>
              {stageTesting ? 'Opening…' : 'Show test on this display'}
            </Button>
          </div>
          {#if displaysError}
            <p class="inline-alert" role="alert">{displaysError}</p>
          {/if}
          <!--
            How a take presents.

            This replaced a "Full screen" switch that had no effect on any take:
            it was read by the preview and the display test and by nothing on the
            path `Present` actually takes. These two do something, and they are
            tiles rather than a toggle because they are not more-and-less of one
            thing — a prompter and a reading window differ in the viewing
            distance, the mirror, the hood and where the reading line sits.
          -->
          <div class="display-grid">
            <button
              type="button"
              class="monitor-tile"
              class:selected={$settings.stage.presentationMode === 'prompter'}
              aria-pressed={$settings.stage.presentationMode === 'prompter'}
              onclick={() => void patchSettings('stage', { presentationMode: 'prompter' })}
            >
              <span class="monitor-glyph"><Icon name="monitor" size={22} /></span>
              <span class="monitor-name">Teleprompter</span>
              <span class="monitor-meta">
                Fills the display it is on, above everything, for reading off glass at a distance.
              </span>
            </button>
            <button
              type="button"
              class="monitor-tile"
              class:selected={$settings.stage.presentationMode === 'reader'}
              aria-pressed={$settings.stage.presentationMode === 'reader'}
              onclick={() => void patchSettings('stage', { presentationMode: 'reader' })}
            >
              <span class="monitor-glyph"><Icon name="book-open" size={22} /></span>
              <span class="monitor-name">Reading window</span>
              <span class="monitor-meta">
                Stays a window you can size and move. Wider lines, desk distance, never mirrored.
              </span>
            </button>
          </div>
          <p class="hint-line">
            Either way, {presentationModeShortcutLabel()} switches between them during a take.
          </p>
          <div class="toggle-grid">
            <!-- The stage window is created always-on-top and re-asserts it on
                 every show (§52.7); there is no command to turn that off, so it
                 is shown as the fixed behaviour it is rather than as a lie.

                 True of the teleprompter only: a reading window is an ordinary
                 window and is deliberately not pinned, because a script that
                 floated over every other application would be unusable beside
                 the one thing people read scripts next to. -->
            <Toggle
              checked={$settings.stage.presentationMode === 'prompter'}
              disabled
              label="Always on top"
              description={$settings.stage.presentationMode === 'prompter'
                ? 'Always on in this release — the teleprompter must sit above other windows'
                : 'Off for a reading window, so you can work beside it'}
            />
            <Toggle
              checked={$settings.teleprompter.mirrorX}
              label="Horizontal mirror"
              description="For a glass rig, where the panel is reflected"
              onchange={(value) => void patchSettings('teleprompter', { mirrorX: value })}
            />
            <Toggle
              checked={$settings.teleprompter.mirrorY}
              label="Vertical mirror"
              onchange={(value) => void patchSettings('teleprompter', { mirrorY: value })}
            />
          </div>
        </Section>

        <!--
          The optical rig.

          A teleprompter is an instrument, and what matters to the eye is not
          how many pixels a letter occupies but the ANGLE it subtends. This is
          where the panel is told how far away the presenter stands, and every
          number below it is a consequence of that rather than a preference.

          Everything here is optional and everything is reversible: the panel
          opens showing what CandidCue worked out on its own, every derived
          value can be pinned, and every pinned value says so and offers its way
          back to automatic.
        -->
        <Section
          title="This rig"
          description="How the text is sized for the panel above — worked out from how far away you stand, not from a pixel default."
        >
          {#snippet actions()}
            <Button size="sm" disabled={rigFingerprint === null} onclick={() => calibrate()}>
              Calibrate…
            </Button>
          {/snippet}

          {#if rigFingerprint === null}
            <p class="hint-line">
              Connect the prompter display to calibrate it. A rig is a measurement of one physical
              arrangement, so it is stored against the panel it was measured on.
            </p>
          {:else}
            <!-- The rig in force, and the others measured for this panel. One
                 monitor routinely holds several: the same Elgato on the desk
                 for a seated waist-up shot and on the boom arm for a standing
                 close-up are two different rigs sharing one fingerprint. -->
            {#if rigs.length > 0}
              <div class="rig-list">
                {#each rigs as entry (entry.key)}
                  <div class="rig-row" class:active={entry.active}>
                    <button
                      type="button"
                      class="rig-choose"
                      aria-pressed={entry.active}
                      onclick={() => void chooseRig(entry.profile.rigName)}
                    >
                      <span class="rig-name">{entry.profile.rigName}</span>
                      <span class="rig-meta">
                        {entry.profile.viewingDistanceMm === null
                          ? 'No distance measured'
                          : `${(entry.profile.viewingDistanceMm / 1000).toFixed(2)} m`}
                        · {OPTICAL_HARDWARE[entry.profile.hardwareKind].label}
                        · {entry.profile.completedSteps.length} of 8 steps
                      </span>
                    </button>
                    <div class="row-actions">
                      <Button size="sm" onclick={() => calibrate(entry.profile.rigName)}>
                        Re-calibrate
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onclick={() => void forgetRig(entry.profile.rigName)}
                      >
                        Forget
                      </Button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if appliedRig === null}
              <!-- The proposal. Not applied silently, because doing so would
                   resize the stage of everyone who already owns one of these
                   panels the first time they launched a build that knew how. -->
              <p class="hint-line">
                <strong>Nothing is applied to this display yet</strong>, so takes run at the
                uncalibrated size ({$settings.teleprompter.fontSizePx} px).
                {#if discovered.identification.confidence === 'unknown'}
                  CandidCue does not recognise this panel, so it cannot work out how physically
                  large a pixel is — calibrating is the only way to size the text by distance.
                {:else}
                  CandidCue recognised it as {discovered.identification.label} and can size the text
                  from that. The numbers below are what it would give you; changing any of them, or
                  finishing the calibration, applies the rig.
                {/if}
              </p>
            {/if}

            <!-- The resolved answer, live. This is what makes the maths
                 trustworthy: it is the same `resolveStageGeometry` a take runs
                 through, against the same panel, so it cannot describe a stage
                 the take would not produce. -->
            {#if rigOptics}
              <dl class="readout">
                <div class="readout-row">
                  <dt class="readout-label">Body text</dt>
                  <dd class="readout-value">
                    {Math.round(rigOptics.bodyFontSizePx)} px
                    {#if rigOptics.bodyArcminutes !== null}
                      · {rigOptics.bodyArcminutes.toFixed(0)}′ of cap height
                    {/if}
                  </dd>
                </div>
                <div class="readout-row">
                  <dt class="readout-label">Line holds</dt>
                  <dd class="readout-value">
                    {rigOptics.charactersPerLine === null
                      ? '—'
                      : `about ${Math.round(rigOptics.charactersPerLine)} characters`}
                  </dd>
                </div>
                <div class="readout-row">
                  <dt class="readout-label">Visible</dt>
                  <dd class="readout-value">
                    {rigVisibleLines === null ? '—' : `about ${rigVisibleLines} lines`}
                  </dd>
                </div>
                <div class="readout-row">
                  <dt class="readout-label">Fit</dt>
                  <dd class="readout-value">
                    {FIT_PHRASES[rigOptics.fitVerdict] ?? rigOptics.fitVerdict}
                  </dd>
                </div>
              </dl>
              {#each resolvedRig?.warnings ?? [] as warning (warning)}
                <p class="hint-line">{warning}</p>
              {/each}
            {/if}

            <!-- Distance. The one fact that genuinely cannot be discovered, and
                 the one every angular result is multiplied by. -->
            <div class="control-block">
              <span class="control-label">Viewing distance</span>
              <div class="chip-row" role="group" aria-label="Viewing distance">
                {#each DISTANCE_PRESETS_M as metres (metres)}
                  <button
                    type="button"
                    class="chip"
                    class:selected={rig.viewingDistanceMm === Math.round(metres * 1000)}
                    aria-pressed={rig.viewingDistanceMm === Math.round(metres * 1000)}
                    onclick={() => void updateRig({ viewingDistanceMm: Math.round(metres * 1000) })}
                  >
                    {metres.toFixed(1)} m
                  </button>
                {/each}
                <div class="chip-field">
                  <TextField
                    label="Custom (metres)"
                    value={distanceField}
                    oninput={(value) => (distanceField = value)}
                    onsubmit={() => applyTypedDistance()}
                  />
                </div>
                <Button onclick={() => applyTypedDistance()}>Use</Button>
              </div>
              {#if rig.viewingDistanceMm !== null}
                <p class="hint-line">
                  Currently {(rig.viewingDistanceMm / 1000).toFixed(2)} m.
                  {#if rig.scale === null}
                    CandidCue still has no physical scale for this panel, so the distance changes
                    nothing until one is measured.
                  {/if}
                </p>
              {/if}
            </div>

            <!--
              One control, not two.

              Angular size and reading measure are not independent on a fixed
              panel: bigger type is fewer characters per line, and what the
              presenter is really choosing is a point on that trade-off. Asking
              them to reason about arcminutes AND characters is asking them to
              solve the constrained optimisation themselves.
            -->
            <Slider
              label="More text on screen ⟷ Larger, easier text"
              value={Math.round(rig.bias * 100)}
              min={0}
              max={100}
              format={(v) => `${v}%`}
              onchange={(value) => void updateRig({ bias: value / 100 })}
            />

            <Select
              label="How you are framed"
              value={rig.framing}
              options={[
                { value: 'close-up', label: 'Close-up' },
                { value: 'head-and-shoulders', label: 'Head and shoulders' },
                { value: 'waist-up', label: 'Waist up' },
                { value: 'full-body', label: 'Full body' },
              ]}
              onchange={(value) => void updateRig({ framing: value as FramingPreset })}
            />
            <p class="hint-line">
              A sideways eye movement that is invisible in a waist-up shot is obvious in a tight
              headshot, so tighter framing asks for a narrower column.
            </p>

            <div class="control-block">
              <span class="control-label">Text intensity</span>
              <SegmentedControl
                label="Text intensity for this rig"
                value={rig.intensity}
                options={[
                  { value: 'soft', label: 'Soft' },
                  { value: 'standard', label: 'Standard' },
                  { value: 'strong', label: 'Strong' },
                ]}
                onchange={(value) => void updateRig({ intensity: value as TextIntensity })}
              />
            </div>

            <div class="control-block">
              <span class="control-label">Reading cue</span>
              <SegmentedControl
                label="Reading cue for this rig"
                value={rig.readingCue}
                options={[
                  { value: 'ticks', label: 'Ticks' },
                  { value: 'wash', label: 'Wash' },
                  { value: 'none', label: 'None' },
                ]}
                onchange={(value) => void updateRig({ readingCue: value as ReadingCueStyle })}
              />
              <p class="hint-line">
                What marks the line you are reading. Ticks sit in the margins; a wash lifts the band
                itself.
              </p>
            </div>

            <!--
              Every derived value, reachable.

              Behind a disclosure because almost nobody needs any of it, and
              present because the person standing at the glass can see something
              the maths cannot. Each row says whether it is automatic or set by
              hand, shows what automatic currently RESOLVES to rather than what
              the constant is, and offers its way back.
            -->
            <Disclosure label={pinnedCount === 0 ? 'Advanced' : `Advanced — ${pinnedCount} set by hand`}>
              {#if pinnedCount > 0}
                <div class="row-actions">
                  <Button size="sm" onclick={() => void clearAllOverrides()}>
                    Reset everything to automatic
                  </Button>
                </div>
              {/if}

              <p class="hint-line">
                These shadow what the optical model works out. The model still runs — so if a size
                you pin costs you the reading measure, the readout above still says so.
              </p>

              <h4 class="advanced-head">Size and measure</h4>
              {@render override('fontSizePx', 'Text size', MIN_RENDERABLE_FONT_SIZE_PX, ADVANCED_FONT_SIZE_CEILING_PX, 1, (v) => `${Math.round(v)} px`)}
              {@render override('arcminutes', 'Apparent cap height', ANGULAR_HARD_FLOOR_ARCMIN, 60, 0.5, (v) => `${v.toFixed(1)}′`)}
              {@render override('characters', 'Characters per line', READING_MEASURE.hardFloor, READING_MEASURE.bandMax, 1, (v) => `${Math.round(v)}`)}
              {@render override('columnCh', 'Column width', 8, 80, 0.5, (v) => `${v.toFixed(1)} ch`)}
              {@render override('maxColumnFraction', 'Widest the column may go', 0.1, 1, 0.01, (v) => `${Math.round(v * 100)}% of the safe width`)}

              <h4 class="advanced-head">Typography</h4>
              {@render override('lineHeight', 'Line height', 1, 2, 0.01, (v) => v.toFixed(2))}
              {@render override('fontWeight', 'Weight', 300, 800, 50, (v) => String(Math.round(v)))}
              {@render override('letterSpacingEm', 'Letter spacing', -0.02, 0.08, 0.005, (v) => `${v.toFixed(3)} em`)}
              {@render override('paragraphSpacingEm', 'Paragraph spacing', 0, 2, 0.05, (v) => `${v.toFixed(2)} em`)}

              <h4 class="advanced-head">Vertical geometry</h4>
              <p class="hint-line">
                In line pitches, not pixels — so the stage behaves the same on a 600px panel and a
                1080px one instead of meaning two different things on the two displays this app is
                actually used on.
              </p>
              {@render override('deadZoneLines', 'Reading corridor', 0.3, 2, 0.02, (v) => `${v.toFixed(2)} lines`)}
              {@render override('topFadeLines', 'Fade above', 0, 4, 0.05, (v) => `${v.toFixed(2)} lines`)}
              {@render override('bottomFadeLines', 'Fade below', 0, 4, 0.05, (v) => `${v.toFixed(2)} lines`)}
              {@render override('futureReserveLines', 'Script kept below the band', 0, 10, 0.25, (v) => `${v.toFixed(2)} lines`)}
              {@render override('sentenceMicrogapLines', 'Gap after a sentence', 0, 1, 0.05, (v) => `${v.toFixed(2)} lines`)}

              <h4 class="advanced-head">Treatment</h4>
              {@render override('pastOpacity', 'Spoken text', 0.15, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
              {@render override('futureOpacity', 'Upcoming text', 0.3, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
              {@render override('secondaryMinPx', 'Smallest readable label', 8, 120, 1, (v) => `${Math.round(v)} px`)}
              {@render override('lensOffsetDegrees', 'Reading band below the lens', -3, 3, 0.1, (v) => `${v.toFixed(1)}°`)}
              <p class="hint-line">
                A small downward offset can read as more direct on camera than looking at the exact
                centre of the lens. It needs a physical scale to convert the angle, so an
                uncalibrated rig cannot honour it — and says nothing rather than applying a wrong
                number.
              </p>
            </Disclosure>
          {/if}
        </Section>

        <!--
          One row of the advanced panel.

          `pinned` comes from the profile's own `overrides` map rather than from
          `ResolvedOptics.overriddenFields`, because only the map is what a reset
          acts on: the resolver lists what it APPLIED, and a value pinned to
          exactly the number the model would have chosen is not listed. Keying
          the reset off the resolver would leave a stored override that no
          control offers to clear — an override you cannot undo, which is the
          one thing the override block must never become. `applied` is the
          resolver's answer, and it is worth saying when the two differ.
        -->
        {#snippet override(
          key: keyof OpticalOverrides,
          label: string,
          min: number,
          max: number,
          step: number,
          format: (value: number) => string,
        )}
          {@const pinnedValue = rig.overrides[key]}
          {@const pinned = typeof pinnedValue === 'number'}
          {@const applied = rigOptics?.overriddenFields.includes(key) ?? false}
          {@const shown = pinned ? pinnedValue : automaticValue(key)}
          <div class="override">
            <Slider
              {label}
              value={Math.min(max, Math.max(min, shown))}
              {min}
              {max}
              {step}
              {format}
              onchange={(value) => void setOverride(key, value)}
            />
            <div class="override-state">
              {#if pinned}
                <span class="override-tag">
                  {applied ? 'Set by you' : 'Set by you — same as automatic'}
                </span>
                <button type="button" class="inline-link" onclick={() => void setOverride(key, null)}>
                  Reset to automatic
                </button>
              {:else}
                <span class="override-tag automatic">
                  Automatic · {format(automaticValue(key))}
                </span>
              {/if}
            </div>
          </div>
        {/snippet}
      {:else if section === 'teleprompter'}
        <Section title="Teleprompter">
          <!--
            The controls below describe the glass, so they are set at the glass.
            Sizes and positions on a prompter are angles from where the presenter
            stands, and no number on a laptop at arm's length can be judged as
            one. The reading band especially: it wants to sit over the lens, and
            that is an alignment somebody performs by watching it move.
          -->
          <div class="preview-row">
            <Button
              variant={stagePreview ? 'default' : 'primary'}
              disabled={stagePreviewBusy || displays.length === 0}
              onclick={() => void toggleStagePreview()}
            >
              {stagePreview ? 'Stop preview' : 'Show on teleprompter'}
            </Button>
            <p class="hint-line preview-note">
              {#if stagePreview}
                Sample text is on <strong>{effectiveDisplay?.name ?? 'the stage display'}</strong>.
                Everything below updates it as you drag.
              {:else if displays.length === 0}
                No displays detected — connect the teleprompter and open Stage display.
              {:else}
                Puts a sample script on <strong
                  >{effectiveDisplay?.name ?? 'the stage display'}</strong
                > so you can judge these settings where they apply.
              {/if}
            </p>
          </div>
          {#if stagePreviewError}
            <p class="inline-alert" role="alert">{stagePreviewError}</p>
          {/if}
          <!--
            The bundled face was unreachable.

            `stageFontStack('high-legibility')` has resolved Atkinson Hyperlegible
            Next since the woff2 files were bundled, `font-hash.test.ts` pins the
            family name against the stack character for character — and this menu
            never offered it. The one face in the app chosen for legibility
            through glass, shipped, tested, and impossible to select.
          -->
          <Select
            label="Default font family"
            value={$settings.teleprompter.fontFamilyId}
            options={[
              { value: 'high-legibility', label: 'Atkinson Hyperlegible (bundled)' },
              { value: 'system-sans', label: 'System Sans' },
              { value: 'humanist-sans', label: 'Humanist Sans' },
              { value: 'serif', label: 'Serif' },
              { value: 'monospace', label: 'Monospace' },
            ]}
            onchange={(value) => void patchSettings('teleprompter', { fontFamilyId: value })}
          />
          <p class="hint-line">
            Atkinson Hyperlegible travels with the app, so it renders the same on every machine
            and needs no network. It disambiguates the characters a prompter gets wrong at
            distance — capital I from lowercase l from 1, and 0 from O — which is the whole
            reason to prefer it over whatever <em>System Sans</em> resolves to today.
          </p>
          <!--
            What used to be "Stage background".

            That menu offered near black and high-contrast black and delivered
            neither: `src/styles/stage.css` hard-codes `--stage-bg`, so both of
            its options rendered identically, for as long as it existed. What a
            presenter is actually reaching for when they go looking for a
            background control on a prompter is how hot the type burns against
            the glass — a bright rig washes out a soft face, a dark studio makes
            a strong one bloom. That is the control that exists now, and the
            stage reads it as `data-text-intensity` on `.stage-root`.
          -->
          <SegmentedControl
            label="Text intensity"
            value={$settings.teleprompter.textIntensity}
            options={[
              { value: 'soft', label: 'Soft' },
              { value: 'standard', label: 'Standard' },
              { value: 'strong', label: 'Strong' },
            ]}
            onchange={(value) =>
              void patchSettings('teleprompter', { textIntensity: value as TextIntensity })}
          />
          <p class="hint-line">
            How bright the words burn over the stage's black field. A calibrated rig carries its
            own choice, made at the glass; this is what everything else runs with.
          </p>
          <!--
            The ceiling was 160px, which is not a taste limit — it was short of
            what the product's own hardware needs. A Prompter XL at its rated
            4.6 m wants roughly 234px for a comfortable angular size, so this
            control could not reach a legible size on a rig CandidCue ships
            knowledge of, and the operator had no way to tell that the slider
            had run out rather than the display.
          -->
          <Slider
            label="Default font size"
            value={$settings.teleprompter.fontSizePx}
            min={MIN_FONT_SIZE_PX}
            max={sizeCeilingPx}
            format={(v) => `${v} px`}
            onchange={(value) => void patchSettings('teleprompter', { fontSizePx: value })}
          />
          <!-- Bounds from APPEARANCE_LIMITS, not literals: the in-session sheet
               sets these same four values, and a range that lives on one screen
               is a range that drifts from the other. -->
          <Slider
            label="Line height"
            value={$settings.teleprompter.lineHeight}
            min={APPEARANCE_LIMITS.lineHeight.min}
            max={APPEARANCE_LIMITS.lineHeight.max}
            step={APPEARANCE_LIMITS.lineHeight.step}
            format={(v) => v.toFixed(2)}
            onchange={(value) => void patchSettings('teleprompter', { lineHeight: value })}
          />
          <Slider
            label="Text column width"
            value={$settings.teleprompter.columnWidthPercent}
            min={APPEARANCE_LIMITS.columnWidthPercent.min}
            max={APPEARANCE_LIMITS.columnWidthPercent.max}
            format={(v) => `${v}%`}
            onchange={(value) => void patchSettings('teleprompter', { columnWidthPercent: value })}
          />
          <Slider
            label="Reading band position"
            value={$settings.teleprompter.readingBandCenterPercent}
            min={APPEARANCE_LIMITS.readingBandCenterPercent.min}
            max={APPEARANCE_LIMITS.readingBandCenterPercent.max}
            format={(v) => `${v}%`}
            onchange={(value) =>
              void patchSettings('teleprompter', { readingBandCenterPercent: value })}
          />
          <!--
            The one control on this screen that is aligning against a physical
            object. Said here rather than in the shared note below, because the
            others are judged (does that read easily?) and this one is measured
            (is it over the lens?) — and because somebody who wants it exact
            should be sent to the wizard that puts a crosshair on the glass
            rather than left estimating a percentage.
          -->
          <p class="hint-line">
            The marks at the sides of the stage are the band. With the preview running, drag this
            until they sit over your camera lens — that is where your eyes rest, so it is where the
            lens should be. <strong>Calibrate</strong> under Stage display does the same alignment with
            a crosshair and remembers it per rig.
          </p>
          <!--
            Said once, here, because it is the honest scope of the four sliders
            above and it is otherwise invisible: a calibrated rig OVERRULES all
            of them. `resolveStageGeometry` decides size, line height, column
            and band from a measured distance, and `buildStageSettings` writes
            its answer into these same flat fields. Somebody who has calibrated
            their prompter and then drags "Text column width" would otherwise be
            moving a control that changes nothing on the glass — which is the
            precise defect this screen exists to remove, reappearing one layer
            along.
          -->
          <p class="hint-line">
            These four are what an <strong>uncalibrated</strong> display prompts at. Calibrate one
            under Stage display and its size, line height, column and reading band are worked out
            from how far away you stand instead — which is the only way they can be right on two
            panels of different sizes at once.
          </p>
          <!--
            "Fixed-speed default" was a slider onto nothing, and then a sentence
            saying so. It is a control again, because there is finally something
            reading it.

            What changed is narrow and worth stating precisely: this is not a
            second way to prompt. Auto-scroll is the FALLBACK for the takes voice
            following cannot carry — no speech key, no network, a room loud
            enough that finals stop arriving — and the reason it earns a setting
            is that the pace has to be dialled in before it is needed, by
            somebody who is not yet standing at a camera with a script that has
            stopped moving.
          -->
          <Slider
            label="Auto-scroll pace"
            value={$settings.teleprompter.fixedSpeedWpm}
            min={AUTO_SCROLL_MIN_WPM}
            max={AUTO_SCROLL_MAX_WPM}
            format={(v) => `${v} wpm`}
            onchange={(value) =>
              void patchSettings('teleprompter', { fixedSpeedWpm: value })}
          />
          <p class="hint-line">
            Auto-scroll rolls the script at this pace when your voice is not getting through.
            Press <kbd>A</kbd> during a take to start or stop it; <kbd>[</kbd> and <kbd>]</kbd>
            change the pace while it runs. Starting it pauses voice following, and stopping it
            hands the script back.
          </p>
          <!-- Mirroring lives with the display it is a property of (Stage
               display), not here: it describes the rig, not the type. -->
          <Toggle
            checked={$settings.teleprompter.phraseHighlight}
            label="Current phrase highlight"
            onchange={(value) => void patchSettings('teleprompter', { phraseHighlight: value })}
          />
          <Toggle
            checked={$settings.teleprompter.pastDimming}
            label="Past-text dimming"
            onchange={(value) => void patchSettings('teleprompter', { pastDimming: value })}
          />
          <Select
            label="When a session ends"
            value={$settings.teleprompter.stageEndBehavior}
            options={[
              { value: 'close', label: 'Close the stage window' },
              { value: 'blank', label: 'Keep the stage open, blanked' },
            ]}
            onchange={(value) =>
              void patchSettings('teleprompter', { stageEndBehavior: value as 'close' | 'blank' })}
          />
          <Toggle
            checked={$settings.teleprompter.hidePointer}
            label="Hide the pointer on the stage"
            onchange={(value) => void patchSettings('teleprompter', { hidePointer: value })}
          />
        </Section>
      {:else if section === 'following'}
        <Section
          title="Following"
          description="How the stage follows your voice. These are feel choices — CandidCue keeps its own safety rules for section jumps and retakes whatever you pick."
        >
          <FollowSettingsFields
            following={$settings.following}
            onchange={(patch) => void patchSettings('following', patch)}
          />
        </Section>
      {:else}
        <Section title="Data, privacy & updates">
          <div class="privacy">
            <h3 class="privacy-head">Local by default</h3>
            <p class="privacy-body">
              Your Markdown scripts, imported images, and settings are stored on this device.
            </p>
            <h3 class="privacy-head">While voice tracking is active</h3>
            <p class="privacy-body">
              Your microphone is open only while a take or a microphone test is running, and the
              audio is transcribed on this machine by a recogniser built into CandidCue. It is not
              uploaded, and CandidCue does not save it.
            </p>
            <h3 class="privacy-head">Nothing leaves this device</h3>
            <p class="privacy-body">
              Neither your voice nor your script is sent anywhere. The words are recognised here and
              matched against your script here — there is no transcription account, no API key, and
              no third party involved in following you.
            </p>
            <h3 class="privacy-head">CandidCue servers</h3>
            <p class="privacy-body">
              CandidCue checks for software updates. Your scripts and your audio are not sent to
              CandidCue servers.
            </p>
          </div>

          <div class="row-actions">
            <Button onclick={() => void runExportAllData()}>
              Export all scripts
            </Button>
            <Button
              variant="ghost"
              onclick={() =>
                void runMaintenance(
                  () => settingsService.clearCache('analysis'),
                  () => 'Analysis cache cleared',
                )}
            >
              Clear analysis cache
            </Button>
            <Button variant="ghost" onclick={() => clearLogs()}>Clear logs</Button>
          </div>

          <Toggle
            checked={$settings.privacy.diagnosticLogging}
            label="Diagnostic logging"
            description="Keeps redacted local logs to help diagnose problems"
            onchange={(value) => void patchSettings('privacy', { diagnosticLogging: value })}
          />
          <Select
            label="Update channel"
            value={$settings.privacy.updateChannel}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]}
            onchange={(value) =>
              void patchSettings('privacy', { updateChannel: value as 'stable' | 'beta' })}
          />
          <div class="row-actions">
            <Button size="sm" onclick={() => runUpdateCheck()}>Check for updates</Button>
            {#if updateNote}<span class="hint-line">{updateNote}</span>{/if}
          </div>
        </Section>

        <!-- §44.11 / §47.10 diagnostics: the facts a support request needs. -->
        <Section
          title="Diagnostics"
          description="What CandidCue knows about this installation. Useful when something is not working and you need to report it."
        >
          {#snippet actions()}
            <Button size="sm" disabled={diagnosticsLoading} onclick={() => void loadDiagnostics()}>
              {diagnosticsLoading ? 'Checking…' : 'Refresh'}
            </Button>
          {/snippet}

          {#if diagnosticsError}
            <p class="hint-line">{diagnosticsError}</p>
          {:else if !diagnostics}
            <p class="hint-line">{diagnosticsLoading ? 'Checking…' : 'No diagnostics yet.'}</p>
          {:else}
            <dl class="diag">
              {#each diagnosticRows(diagnostics) as row (row.label)}
                <div class="diag-row">
                  <dt class="diag-label">{row.label}</dt>
                  <dd class="diag-value">
                    <span class="diag-figure {row.tone}">{row.value}</span>
                    {#if row.note}<span class="diag-note">{row.note}</span>{/if}
                  </dd>
                </div>
              {/each}
            </dl>
          {/if}

          <!--
            §44.12: user-facing failures are shown as English everywhere else in
            the app. The stable code is what a bug report needs, so it lives
            here — one place, clearly labelled as a technical detail.
          -->
          <div class="recent-errors">
            <p class="recent-errors-title">Recent errors</p>
            {#if recentErrors.length === 0}
              <p class="hint-line">Nothing has failed in this session.</p>
            {:else}
              <ul class="recent-errors-list">
                {#each recentErrors as entry, index (String(entry.atMs) + String(index))}
                  <li class="recent-error">
                    <span class="recent-error-time">{errorTime(entry.atMs)}</span>
                    <span class="recent-error-code">{entry.code ?? 'no code'}</span>
                    <span class="recent-error-shown">{entry.shown}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="row-actions">
            <Button size="sm" disabled={!diagnostics} onclick={() => void copyDiagnostics()}>
              Copy diagnostics
            </Button>
            <Button size="sm" variant="ghost" onclick={() => void runSupportBundle()}>
              Export support bundle
            </Button>
          </div>
          <ul class="bundle-contents">
            {#each SUPPORT_BUNDLE_CONTENTS as line (line)}
              <li>{line}</li>
            {/each}
          </ul>
          <p class="hint-line">{SUPPORT_BUNDLE_EXCLUSIONS}</p>
          <p class="hint-line">CandidCue {$appStatus.version}</p>
        </Section>
      {/if}
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

  .section-nav {
    flex: 0 0 208px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-5) var(--space-4);
    overflow-y: auto;
  }
  .section-item {
    display: block;
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
      border-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .section-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .section-item.active,
  .section-item.active:hover {
    background: var(--bg-panel);
    border-color: var(--border);
    box-shadow: var(--shadow-card);
    color: var(--text-primary);
  }

  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--page-x) var(--space-8);
    max-width: 640px;
    /*
      Sections stacked as plain blocks had NO space between them: the next
      section's heading sat directly on the previous section's last control —
      "Audio" landing on the Test transcription button. A section heading needs
      more air above it than the fields inside a section have between them, so
      this is deliberately larger than Section's own --space-4 body gap.
    */
    display: flex;
    flex-direction: column;
    gap: var(--space-9);
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .key-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .key-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .key-mask {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    letter-spacing: 0.08em;
  }

  .hint-line {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  /*
   * The preview control sits above the settings it previews, on one line with
   * its own explanation, so the button reads as the mode switch it is rather
   * than as another setting in the list.
   */
  .preview-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .preview-note {
    flex: 1 1 24ch;
    min-width: 24ch;
  }

  .diag {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .diag-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
  }
  .diag-label {
    flex: 0 0 148px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .diag-value {
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .diag-figure {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    word-break: break-word;
  }
  .diag-figure.good {
    color: var(--success);
    font-weight: 600;
  }
  .diag-figure.bad {
    color: var(--danger);
    font-weight: 600;
  }
  .diag-note {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-faint);
  }

  .recent-errors {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .recent-errors-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .recent-errors-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .recent-error {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: baseline;
    gap: var(--space-2) var(--space-3);
  }
  .recent-error-time {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  .recent-error-code {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
    word-break: break-word;
  }
  .recent-error-shown {
    min-width: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .bundle-contents {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .command-examples {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .examples {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .privacy {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .privacy-head {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .privacy-head:first-child {
    margin-top: 0;
  }
  .privacy-body {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }
  .inline-link {
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  /* Persistent inline failure text. Sits beside the control that failed and
     stays until the user acts on it — no timer, no accent ring, no border. */
  .inline-alert {
    margin: 0;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--danger);
  }

  .toggle-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2) var(--space-6);
  }

  /* --- displays --- */
  .display-grid {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .monitor-tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    min-width: 200px;
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    text-align: left;
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .monitor-tile:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover-surface);
  }
  .monitor-tile.selected,
  .monitor-tile.selected:hover {
    border-color: var(--border-strong);
    background: var(--accent-wash);
  }
  .monitor-glyph {
    color: var(--text-muted);
  }
  .monitor-tile.selected .monitor-glyph {
    color: var(--accent);
  }
  .monitor-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .monitor-meta {
    font-size: var(--text-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .monitor-badges {
    display: flex;
    gap: var(--space-1);
    margin-top: var(--space-1);
  }

  /* --- the optical rig --- */
  .rig-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .rig-row {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .rig-row.active {
    border-color: var(--border-strong);
    background: var(--accent-wash);
  }
  /* Inset bar, never a one-sided border on a rounded box. */
  .rig-row.active::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 10px;
    bottom: 10px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .rig-choose {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    border: none;
    background: transparent;
    padding: 0;
  }
  .rig-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .rig-meta {
    font-size: var(--text-2xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
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
    flex: 0 0 116px;
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

  .control-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-start;
  }
  .control-label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .chip-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    flex-wrap: wrap;
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
  .chip-field {
    flex: 0 1 160px;
    min-width: 120px;
  }

  .advanced-head {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }

  .override {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .override-state {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .override-tag {
    font-size: var(--text-2xs);
    font-weight: 600;
    /* Small terracotta TEXT has to use the strong ramp to clear AA in light. */
    color: var(--accent-strong);
    font-variant-numeric: tabular-nums;
  }
  .override-tag.automatic {
    font-weight: 500;
    color: var(--text-faint);
  }

  /* --- microphone --- */
  .mic-test-state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  /* A live billable session must be unmistakable at a glance. */
  .mic-test-state.live {
    color: var(--accent-strong);
    font-weight: 600;
  }
  .mic-test-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-strong);
    animation: mic-test-pulse 1.4s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .mic-test-dot {
      animation: none;
    }
  }
  @keyframes mic-test-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  .transcript {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    border: 1px solid var(--border-faint);
    font-size: var(--text-lg);
    line-height: var(--lh-transcript);
    color: var(--prose-secondary-warm);
  }
  .transcript.final {
    color: var(--prose-text-warm);
  }

</style>
