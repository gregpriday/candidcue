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
  import Toolbar from '../components/Toolbar.svelte';
  import { updateWorkspace } from '../stores/workspace';
  import Section from '../components/Section.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import Select from '../components/Select.svelte';
  import SettingReadout from '../components/SettingReadout.svelte';
  import SettingRow from '../components/SettingRow.svelte';
  import Slider from '../components/Slider.svelte';
  import SpeechLanguagePicker from '../components/SpeechLanguagePicker.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { chooseStageDisplay } from '../lib/start-take';
  import { stagePreviewSettingsFromSettings } from '../services/stage-envelope';
  import { displayName, resolvePrompterDisplay } from '../lib/take-destination';
  import { displayNumbers, identificationMatches } from '../lib/display-numbers';
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
    inputsWithheld,
    matchRememberedMicrophone,
    microphoneOptions,
  } from '../services/audio';
  import {
    MicTestSession,
    shouldAdoptRememberedMicrophone,
    type MicTestSnapshot,
  } from '../services/mic-test-session';
  import { VAD_SENSITIVITY_COPY } from '../services/settings-audio';
  import * as settingsService from '../services/settings';
  import * as stageService from '../services/stage';
  import { getSpeechEngineStatus, type SpeechEngineStatus } from '../services/stt/local';
  import {
    isBusy as isModelBusy,
    isDamaged as isModelDamaged,
    phaseLabel,
    type SpeechModelStatus,
  } from '../services/speech-models';
  import { getVoiceFacade } from '../services/voice-facade';
  import { isMicrophoneRefused, readMicrophonePermission } from '../services/microphone-permission';
  import { openMicrophonePrivacySettings } from '../lib/open-settings';
  import { osCopy } from '../lib/os-copy';
  import { showMaterialRail } from '../lib/window-material';
  import type { DisplayDescriptor } from '../services/stage-types';
  import {
    DEFAULT_STAGE_APPEARANCE,
    DEFAULT_TELEPROMPTER_FIXED_SPEED_WPM,
    activeOpticalProfile,
    opticalRigsForDisplay,
    panelMirrorFor,
    readerThemeFor,
    withOpticalProfile,
    withoutOpticalProfile,
    withPanelMirror,
    type ReaderTheme,
  } from '../services/settings-types';
  import { describeCalibrationProgress } from '../lib/optical-calibration';
  import { SESSION_MODE_LABELS, sessionModeLabel } from '../../shared/take-vocabulary';
  import {
    OPTICAL_HARDWARE,
    STAGE_EVENT,
    defaultOpticalProfile,
    type AudioDeviceInfo,
    type AudioLevelSnapshot,
    type FramingPreset,
    type MicrophonePermission,
    type OpticalOverrides,
    type OpticalProfile,
    type ReadingCueStyle,
    type StageEscapePayload,
    type TextIntensity,
  } from '../../shared/contracts';
  import { isMacPlatform, presentationModeShortcutLabel } from '../lib/shortcuts';
  import { formatAccelerator } from '../lib/commands';
  import { automaticProfile, discoverProfile } from '../../shared/optical-discovery';
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
    UNCALIBRATED_PROMPTER_WARNING,
    UNCALIBRATED_READER_WARNING,
    UNMEASURED_FONT_WARNING,
    resolveStageGeometry,
    resolveTargetArcminutes,
    resolveTargetCharacters,
  } from '../../shared/optical-resolve';
  import {
    ANGULAR_HARD_FLOOR_ARCMIN,
    MAX_COLUMN_FRACTION,
    MIN_RENDERABLE_FONT_SIZE_PX,
    MIN_VIEWING_DISTANCE_MM,
    MAX_VIEWING_DISTANCE_MM,
    READING_MEASURE,
    UNCALIBRATED_FIT_ADVICE,
    isPlausibleViewingDistanceMm,
  } from '../../shared/optics';
  import {
    AUTO_SCROLL_MAX_WPM,
    AUTO_SCROLL_MIN_WPM,
  } from '../../stage/renderer/autoscroll';
  import { requestConfirm } from '../stores/confirm';
  import { navigate, route, type SettingsSection } from '../stores/router';
  import { loadSettings, patchSettings, settings } from '../stores/settings';
  import { showToast } from '../stores/toasts';

  interface Props {
    section: SettingsSection;
    /**
     * Dismiss this surface (§14.1).
     *
     * Supplied by the Preferences window, where Settings is a WINDOW and the
     * gesture is "I am finished" rather than "take me back". Absent means the
     * route is being hosted somewhere with a place to return to, and the
     * toolbar shows the back control instead.
     */
    onclose?: () => void;
  }
  let { section, onclose }: Props = $props();

  /*
   * The Settings window's chrome on the window material (`lib/window-material
   * .ts`): the toolbar band and the section list are glass, the form column is
   * paper. For as long as this screen is up — Calibrate, which replaces it in
   * the same window, has no section list and keeps the opaque desk.
   */
  $effect(() => {
    const root = document.documentElement;
    showMaterialRail(root, true);
    return () => showMaterialRail(root, false);
  });

  /**
   * The sections, each with the words somebody might search for.
   *
   * `keywords` is the SECTION-level half of §14.2: it narrows the section list
   * to the sections that hold a match. The ROW-level half is `applyRowFilter`
   * below, which narrows the rows inside the section on screen and marks the
   * ones that matched.
   *
   * Both halves are needed and neither is sufficient. Section keywords answer
   * "where do I change the microphone" for somebody who does not know the word
   * the app uses; the row filter answers "which of these fourteen controls is
   * the one" once they are looking at the section.
   *
   * Deliberately written in the user's vocabulary rather than the code's —
   * somebody looking for the microphone types "mic", and somebody looking for
   * the teleprompter's mirror types "mirror", not "teleprompter".
   *
   * And they carry every visible setting NAME as well as the aliases. The
   * section list can only search what is written here — a section that is not
   * on screen has no rows to read — so a name left out of its keywords is a
   * setting that search says does not exist: "noise" from General used to find
   * nothing, with Noise suppression one section away. Add a row, add its name.
   */
  const sections: Array<{ id: SettingsSection; label: string; keywords: string }> = [
    {
      id: 'general',
      label: 'General',
      keywords:
        'on launch / open the script library / open the most recent script / startup / session mode / follow voice / remember the reading window / window position size restore / confirm before ending an active session / follow headings as spoken lines / headings read aloud',
    },
    {
      id: 'speech',
      label: 'Speech',
      keywords:
        'speech language / language / download / remove download / installed / ready / damaged / english / model / recogniser recognizer / transcription / offline / licence license / attribution',
    },
    {
      id: 'audio',
      label: 'Audio',
      keywords:
        'microphone / mic / input device / system default / input level / meter / quiet / clipping / permission / access / transcription test / test transcription / capture tuning / noise suppression / echo cancellation / automatic gain control / agc / voice-detection sensitivity / voice detection / vad',
    },
    {
      id: 'stage',
      /*
       * NOT "Stage display" (CCUX-003).
       *
       * That name read as "the display the separate stage window will appear
       * on", and the panel chosen here is more than that: it is where a
       * prompter take opens, it is what a rig is calibrated against, and the
       * preview aims at it. The section is named for the panel and its rigs
       * rather than for any one of the things that read it.
       *
       * The keywords keep "stage display" so anyone who learnt the old name, or
       * read it in an older note, still finds this section by searching for it.
       */
      label: 'Prompter display and rigs',
      /* Mirroring lives here, with the panel the glass is in front of — so
         "mirror" has to find this section, not Teleprompter (where it used to
         live and where it still sent people). */
      keywords:
        'prompter display and rigs / display / monitor / screen / panel / automatic / primary / identify displays / show test on this display / teleprompter / reading window / reader / presentation / f11 / stage display / destination / always on top / horizontal mirror / vertical mirror / flip / this rig / calibrate / calibration / re-calibrate / recalibrate / measure another rig / forget / body text / line holds / visible / fit / viewing distance / size balance / more text on screen / larger, easier text / how you are framed / framing / close-up / head and shoulders / waist up / full body / text intensity / soft / standard / strong / reading cue / ticks / wash / advanced / reset everything to automatic / size and measure / text size / apparent cap height / arcmin / characters per line / column width / widest the column may go / typography / line height / weight / letter spacing / paragraph spacing / vertical geometry / reading corridor / fade above / fade below / script kept below the band / gap after a sentence / treatment / spoken text / upcoming text / smallest readable label / reading band below the lens / optics / safe area',
    },
    {
      id: 'teleprompter',
      label: 'Teleprompter',
      keywords:
        'teleprompter / show on teleprompter / preview / sample / default font family / atkinson hyperlegible / system sans / humanist sans / serif / monospace / font / default text intensity / text intensity / soft / standard / strong / reading window appearance / dark / paper / default font size / line height / text column width / reading band position / fallback / auto-scroll pace / autoscroll / wpm / current phrase highlight / past-text dimming / break lines at phrase boundaries / diagnostic take / clean / readout / transcript / debug',
    },
    {
      id: 'following',
      label: 'Following',
      keywords:
        'following / follow feel / calm / balanced / responsive / scroll / smoothing / responsiveness / alignment / motion profile / developer diagnostics / why did it move / timeline',
    },
    {
      id: 'privacy',
      label: 'Data, privacy & updates',
      keywords:
        'data, privacy & updates / your data / privacy / location / backup / export all data / restore from export / your voice stays here / when the microphone is open / when speaking glass uses the network / network / download / updates / check for updates automatically / automatic update check / update check / install update / new version / updates.speakingglass.com / version / about / diagnostics / refresh / speaking glass version / platform / database check / scripts / sessions recorded / data folder / recent errors / copy diagnostics / export support bundle / support bundle / reveal bundle / clear logs / logs',
    },
  ];

  /** The settings search box (§14.2). */
  let sectionQuery = $state('');

  /*
   * The section on screen stays in the list whatever the query says. Dropping
   * it left a list with nothing selected beside a pane still showing that
   * section — searching made it LESS clear where you were. The row filter
   * below says how much of it matched.
   */
  const matchingSections = $derived(
    (() => {
      const query = sectionQuery.trim().toLowerCase();
      if (query === '') return sections;
      return sections.filter(
        (entry) =>
          entry.id === section ||
          entry.label.toLowerCase().includes(query) ||
          entry.keywords.includes(query),
      );
    })(),
  );
  const currentSectionLabel = $derived(sections.find((entry) => entry.id === section)?.label ?? '');
  /** Sections other than this one that the query found. */
  const otherMatches = $derived(matchingSections.filter((entry) => entry.id !== section).length);

  let sectionNav: HTMLElement | null = $state(null);

  /** The index's roving tab stop: the open pane's row (a search keeps it in
      the list), or the first row should it ever be missing. */
  function sectionTabIndex(index: number): 0 | -1 {
    const active = matchingSections.findIndex((entry) => entry.id === section);
    return index === (active < 0 ? 0 : active) ? 0 : -1;
  }

  function sectionKeydown(event: KeyboardEvent, index: number): void {
    const items = sectionNav
      ? [...sectionNav.querySelectorAll<HTMLElement>('.section-item')]
      : [];
    if (items.length === 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  /**
   * The section's own scroll container, for the row filter below.
   */
  let contentElement: HTMLElement | null = $state(null);
  /** How many rows the query matched, or `null` when there is no query. */
  let rowMatches = $state<number | null>(null);

  /**
   * The row-level half of the settings search (§14.2).
   *
   * ---------------------------------------------------------------------------
   * WHY THIS READS THE DOM RATHER THAN FILTERING A MODEL
   * ---------------------------------------------------------------------------
   * The obvious implementation is a searchable model — every row an entry with
   * a label, a description and synonyms, rendered from a list. This section is
   * not built that way and should not be rebuilt that way to get a search box:
   * the rows are hand-written because they explain each other, several are
   * conditional on hardware or on a downloaded model, and a few are whole
   * sub-forms. Reducing them to index entries would cost the thing §14 is
   * actually about.
   *
   * So the search reads what is rendered. That is exactly the text the user is
   * looking at — labels, descriptions, option names and units — which makes it
   * the most faithful index available, and it stays correct when a row is
   * added without anybody remembering an index.
   *
   * The selectors are the three shared field wrappers — `Select`/`TextField`'s
   * `.field`, `Toggle`'s `.toggle-row`, and `SettingReadout`'s `.readout`. Not
   * section headings, and not the hand-written sub-forms: a row with none of
   * these is simply never hidden, which is the safe direction to fail. A
   * control that stays visible during a search is a search that under-filters,
   * not a setting somebody cannot find.
   *
   * That direction failed visibly, though, once most of a section was
   * hand-written: searching "mirror" on the display section counted two
   * switches and left the display tiles, the test buttons and both mode tiles
   * standing above them, so the matches were off the bottom of the window. So
   * the sliders (`.slider`, and the `.override` rows that wrap them), the
   * segmented rows (`.setting-row`, `.control-block`), the hint lines, and any
   * hand-written block that says so with `data-search-row` are rows too.
   */
  const ROW_SELECTOR =
    '.field, .toggle-row, .readout, .slider, .override, .setting-row, .control-block, .hint-line, [data-search-row]';

  /**
   * Mark every row under `root` against `query` (already trimmed and
   * lower-cased), and return how many matched — `null` for no query, when the
   * marks come off instead.
   *
   * A row inside another row is part of it, not a second setting: Following's
   * motion profile wraps its readout — or its dropdown and a hint — in a
   * `.field` of its own. Only the outermost row is searched, counted and
   * hidden; the rows inside it go with it. Counted separately, one setting read
   * as two; marked separately, a query that matched only the hint would hide
   * the dropdown and leave its description standing.
   *
   * A row holding keyboard focus counts as a match until focus leaves it. Using
   * a row can change what it says: Follow feel matches "sluggish" only through
   * Balanced's description, and one arrow key to Responsive swaps it. Hiding the
   * row there hides the control the keyboard is on, and focus falls out to the
   * page in the middle of the gesture. So it stays as it was, washed and
   * counted — nothing on screen moves under the hands that moved it — and the
   * `focusout` pass below judges it again once focus is elsewhere.
   */
  function applyRowFilter(root: HTMLElement, query: string): number | null {
    const focused = root.ownerDocument.activeElement;
    let matched = 0;
    for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const outer = row.parentElement?.closest(ROW_SELECTOR) ?? null;
      if (query === '' || (outer !== null && root.contains(outer))) {
        row.removeAttribute('data-settings-search-miss');
        row.removeAttribute('data-settings-search-hit');
        continue;
      }
      const hit =
        (row.textContent ?? '').toLowerCase().includes(query) ||
        (focused !== null && row.contains(focused));
      if (hit) {
        matched += 1;
        row.setAttribute('data-settings-search-hit', '');
        row.removeAttribute('data-settings-search-miss');
      } else {
        row.setAttribute('data-settings-search-miss', '');
        row.removeAttribute('data-settings-search-hit');
      }
    }
    /*
     * A titled section with rows and no match goes too. Its heading standing
     * over an empty body is not context, it is a second thing to read past —
     * and a section that DID match keeps its heading, which is the context.
     * The same for a fold: an open Advanced with every row hidden is a
     * heading over nothing.
     */
    for (const block of root.querySelectorAll<HTMLElement>('section.section, details, .advanced-group')) {
      const searched = query !== '' && block.querySelector(ROW_SELECTOR) !== null;
      if (searched && block.querySelector('[data-settings-search-hit]') === null) {
        block.setAttribute('data-settings-search-miss', '');
      } else {
        block.removeAttribute('data-settings-search-miss');
      }
    }
    return query === '' ? null : matched;
  }

  $effect(() => {
    const query = sectionQuery.trim().toLowerCase();
    const root = contentElement;
    void section;
    if (!root) return;
    rowMatches = applyRowFilter(root, query);
    if (query === '') return;
    /*
     * Re-run when the ROWS change, not only when the query did — by watching
     * the rows rather than the state behind them.
     *
     * Rows arrive after the query for reasons this screen does not hold. The
     * rig form renders once `list_displays` answers, after the section switch
     * that asked for it; the Language dropdown once the speech picker's own
     * request does; others once a model is chosen or a toggle opens a group.
     * This effect used to re-run on the state it could name — the section, the
     * settings document, then the display list — and each row created by
     * anything else stayed visible and unmarked under a note counting fewer.
     * Naming one more dependency per bug report is a list that is never
     * finished, and a child component's state is not one this file can name.
     *
     * So the filter watches the DOM it reads. Child lists catch rows that
     * appear; character data catches a row whose text changes in place — the
     * mirror switch's description once a display resolves. Attributes are NOT
     * watched: the filter writes two, and would wake itself. The note is inside
     * `root` too, so a new count wakes it once more, finds the same count, and
     * settles — assigning `$state` its current value notifies nobody.
     *
     * The observer callback runs as a microtask, before the browser paints, so
     * a late row is marked before it is ever seen unmarked. It exists only
     * while there is a query: with none, a new row has nothing to be marked by.
     */
    const observer = new MutationObserver(() => {
      rowMatches = applyRowFilter(root, query);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    /*
     * And when focus leaves a row, so a row held for it is judged again.
     *
     * A task later rather than at once: `focusout` fires before focus has
     * landed anywhere, and a pass run inside it would read the page's body as
     * focused — dropping a row that focus is only moving within. When the
     * window itself loses focus, the element keeps it, so a presenter switching
     * apps does not come back to a row that vanished behind them.
     */
    let focusPass: ReturnType<typeof setTimeout> | null = null;
    const onFocusOut = (): void => {
      if (focusPass !== null) return;
      focusPass = setTimeout(() => {
        focusPass = null;
        rowMatches = applyRowFilter(root, query);
      }, 0);
    };
    root.addEventListener('focusout', onFocusOut);
    return () => {
      observer.disconnect();
      root.removeEventListener('focusout', onFocusOut);
      if (focusPass !== null) clearTimeout(focusPass);
    };
  });

  /*
   * A section opens at its top — or at the anchor a link asked for.
   *
   * `.content` is one scroller for every section, so without this a section
   * opened at whatever offset the last one was left at, clamped: arriving in
   * Prompter display and rigs from the bottom of Teleprompter landed partway
   * down it. A search starts at the top for the same reason: what it found is
   * at the top once the misses are gone.
   */
  let pendingAnchor: string | null = null;
  /*
   * Clearing a search goes back to where it started: somebody who searched
   * from deep in Advanced and pressed Show all should land in Advanced again,
   * not at the top of the section. Remembered only for the section the search
   * began in; a search that moved somewhere else starts that section fresh.
   */
  let searchOrigin: { section: SettingsSection; top: number } | null = null;
  let lastQuery = '';
  $effect(() => {
    const current = section;
    const query = sectionQuery.trim();
    const root = contentElement;
    if (!root) return;
    const anchor = pendingAnchor;
    pendingAnchor = null;
    let restore: number | null = null;
    if (lastQuery === '' && query !== '') {
      searchOrigin = { section: current, top: root.scrollTop };
    } else if (lastQuery !== '' && query === '') {
      if (searchOrigin?.section === current) restore = searchOrigin.top;
      searchOrigin = null;
    }
    lastQuery = query;
    void tick().then(() => {
      const target = anchor ? root.querySelector<HTMLElement>(`#${anchor}`) : null;
      if (target) target.scrollIntoView({ block: 'start' });
      else root.scrollTop = restore ?? 0;
    });
  });

  /*
   * Reopen where they were (§14.4).
   *
   * The section is recorded as the user moves through Settings, and the window
   * reads it back on mount — see `openSettingsWindow` in `lib/open-settings.ts`,
   * which flushes it before Rust is asked to open the window, and broadcasts it
   * for a window that is already up. Somebody
   * returning to Settings almost always wants the row they were last looking
   * at, and starting at General every time makes a seven-section screen feel
   * longer than it is.
   */
  $effect(() => {
    if ($route.name === 'settings') updateWorkspace({ settingsSection: section });
  });

  let engineStatus = $state<SpeechEngineStatus | null>(null);
  /** The running version, once Rust has said what it is (`app_version`). */
  let runningVersion = $state<string | null>(null);
  /**
   * The update policy sentence, filled in once the running version is known.
   * Derived, so flipping "Check for updates automatically" rewrites the
   * sentence under it rather than leaving it describing the old answer.
   */
  const updateNote = $derived(
    runningVersion === null
      ? ''
      : settingsService.describeUpdatePolicy(runningVersion, $settings.general.checkForUpdates),
  );
  let diagnostics = $state<SystemDiagnostics | null>(null);
  let diagnosticsError = $state<string | null>(null);
  let diagnosticsLoading = $state(false);
  /**
   * §44.12: the toast tells the user what to do in English; the stable code is
   * kept here, where a support request is actually assembled from. This is the
   * only surface in the app that shows a raw error code, and it is deliberate.
   */
  let recentErrors = $state<ErrorDiagnosticEntry[]>([]);

  /* ------------------------------------------------------- speech model
   *
   * What is left here is the SECTION PILL — "can a take follow me right now?" —
   * and nothing else. Choosing a language, downloading it, cancelling and
   * removing all moved into `SpeechLanguagePicker` when §153 turned this from
   * one model into a list of them.
   *
   * The status is REPORTED BY the picker rather than fetched here, and that
   * matters. This screen used to keep its own snapshot, its own listener and
   * its own event counter — and both halves were wrong once more than one model
   * could be installed: `getSpeechModelStatus()` with no argument asks about
   * the CATALOGUE DEFAULT rather than the selected language, and the listener
   * accepted a progress event for any model at all. Downloading an inactive
   * language would move a pill that was describing the active one. One owner,
   * one answer.
   */

  let modelStatus = $state<SpeechModelStatus | null>(null);

  /**
   * Whether the recogniser is loaded, which is a different question from
   * whether the model is on disk.
   *
   * Only ever upgrades the pill from Installed to Ready — `modelStatus` stays
   * authoritative for installed / not-installed. They used to be consulted the
   * other way round, which let the pill contradict the body beneath it whenever
   * the two disagreed, and they disagree for ordinary reasons.
   */
  async function refreshEngineStatus(): Promise<void> {
    try {
      engineStatus = await getSpeechEngineStatus();
    } catch {
      engineStatus = {
        available: false,
        loaded: false,
        model: 'unknown',
        detail: 'Speaking Glass could not ask the backend about the speech model.',
      };
    }
  }

  /**
   * The picker reports the ACTIVE language's install state; this reacts to it.
   *
   * A finished install changes what the engine can do, and only Rust knows it
   * finished — so the engine half is re-read whenever the model half settles.
   */
  function adoptSpeechStatus(status: SpeechModelStatus | null): void {
    modelStatus = status;
    if (status !== null && !isModelBusy(status)) void refreshEngineStatus();
  }

  /** For the screen opening, and after a language change. */
  async function refreshSpeechStatus(): Promise<void> {
    await refreshEngineStatus();
  }

  $effect(() => {
    void loadSettings();
  });

  $effect(() => {
    void refreshEngineStatus();
  });

  /** Diagnostics are only fetched for the screen that shows them (§47.10). */
  $effect(() => {
    if (section === 'privacy') void loadDiagnostics();
  });

  /** Same screen, same rule — the update policy sentence needs the version. */
  $effect(() => {
    if (section === 'privacy') void loadUpdatePolicy();
  });

  /* ------------------------------------------------------------- displays */

  let displays = $state<DisplayDescriptor[]>([]);
  /**
   * The panel the CONTROL window is on — not this one; Rust looks it up by
   * label. It is where a prompter take opens when nothing pinned is connected,
   * so it is read alongside the list and refreshed with it.
   */
  let windowDisplay = $state<DisplayDescriptor | null>(null);
  let displaysError = $state<string | null>(null);
  let displaysLoading = $state(false);
  /**
   * Which `loadDisplays` call is the latest, and the read itself while it is
   * in flight. A topology change, "Check again" and Identify can all be
   * reading the list at once: the slowest answer must not replace a newer one,
   * and Identify has to wait for the newest one before it compares anything
   * (`displaysSettled`).
   */
  let displaysRequest = 0;
  let displaysInFlight: Promise<void> | null = null;
  let identifying = $state(false);
  let stageTesting = $state(false);

  /**
   * The number Identify displays puts on each panel, so the tile can carry it
   * too (#237). Without it "2" on the glass named no tile: the tiles show a
   * model name two identical monitors share, and counting them is off by one
   * because Automatic comes first. Shown permanently, the way the operating
   * system's own display settings number theirs, because the overlays are
   * gone after 2.5 s and the operator is still finding the tile.
   */
  const numbers = $derived(displayNumbers(displays));

  /** A panel's name held on one line: "Pro / Display XDR" broke a product
      name in two inside the Automatic tile. The number, the dot and the name
      travel together too, so no line ends on a stray "·". */
  function unbroken(name: string): string {
    return name.replace(/ /g, '\u00a0');
  }

  const chosenFingerprint = $derived($settings.stage.displayFingerprint);
  /**
   * Where a prompter take opens right now: Present's own rule
   * (`resolvePrompterDisplay`), not a description of it. A picker that explains
   * a rule the take does not follow is how "it opened on the wrong screen"
   * becomes unanswerable — and this one did, for every case but one (#302).
   */
  const takeDisplay = $derived(
    resolvePrompterDisplay({ displays, pinnedFingerprint: chosenFingerprint, windowDisplay }),
  );
  /**
   * What "Automatic" resolves to right now, named on the tile: the panel the
   * Speaking Glass window is on. Taken from the list so the tile can carry the
   * number Identify puts on it.
   */
  const automaticDisplay = $derived.by(() => {
    const here = windowDisplay;
    return here === null ? null : (displays.find((d) => d.fingerprint === here.fingerprint) ?? null);
  });
  /**
   * The panel Settings previews, tests and calibrates against, pinned or not.
   *
   * Deliberately NOT `takeDisplay`. With a panel pinned and connected the two
   * normally agree; otherwise this is `chooseStageDisplay`'s guess, which prefers an
   * external display because a preview aimed at the editor's own screen would
   * cover the editor. The take never reads it: it is measured against the
   * panel it actually landed on, which Rust reports back as
   * `ControlPresentationState.displayFingerprint`.
   */
  const effectiveDisplay = $derived(chooseStageDisplay(displays, chosenFingerprint));
  /**
   * A pinned display that is not currently connected (§52 fingerprints),
   * matched the way Present matches it — so a panel whose twin was unplugged
   * is not called missing while the take fills it.
   */
  const pinnedMissing = $derived(displays.length > 0 && takeDisplay.reason === 'pin-missing');
  /**
   * The ordinary case of the same split: nothing missing, but takes open on one
   * panel and the test and calibration use another (Automatic on a laptop with
   * the prompter plugged in). Said beside the controls, because "this display"
   * under a tile that reads Automatic named the wrong one.
   */
  const targetsSplit = $derived(
    !pinnedMissing &&
      effectiveDisplay !== null &&
      // An unnamed window monitor is still somewhere other than the panel the
      // test opens on, and the note says so in words.
      (takeDisplay.display === null ||
        takeDisplay.display.fingerprint !== effectiveDisplay.fingerprint),
  );
  /** Where the take falls back to, named — or described, when the OS could not name it. */
  const windowPanel = $derived(
    windowDisplay === null
      ? 'the display the Speaking Glass window is on'
      : `${displayName(windowDisplay)}, where the Speaking Glass window is`,
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
   *
   * With one exception, and it is the glass: the preview fills the stage
   * display, so it is never drawn on a reading window's paper — see
   * `stagePreviewSettingsFromSettings`.
   */
  const previewStageSettings = $derived(
    stagePreviewSettingsFromSettings($settings, effectiveDisplay),
  );

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
        'No display is selected yet. Choose the teleprompter under Prompter display and rigs first.';
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
        stagePreviewError = `Speaking Glass could not show the preview on that display. ${describeError(err)}`;
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

  /**
   * Refresh when a monitor is plugged, unplugged or rearranged.
   *
   * Rust has always polled the topology and emitted
   * `app://device-or-display-change`; nothing listened, so the watcher was
   * burning a timer to tell nobody and this list went stale the moment
   * somebody unplugged a monitor mid-setup — the exact situation a display
   * picker exists for.
   */
  $effect(() => {
    if (section !== 'stage' && section !== 'teleprompter') return;
    /*
     * Coalesced: Rust also forwards the control window's moves onto this
     * event, so dragging it to another monitor is a burst of them — and that
     * drag is worth hearing, because it moves an unpinned take.
     */
    return stageService.watchDisplayChanges(() => void loadDisplays());
  });

  function loadDisplays(): Promise<void> {
    const load = readDisplays(++displaysRequest);
    displaysInFlight = load;
    return load;
  }

  /**
   * Resolve once no read of the display list is in flight — including one
   * that started while an earlier one was being waited for — so `displays`
   * and `displaysError` describe the newest answer and nothing is about to
   * replace them.
   */
  async function displaysSettled(): Promise<void> {
    while (displaysInFlight !== null) await displaysInFlight;
  }

  async function readDisplays(request: number): Promise<void> {
    displaysLoading = true;
    displaysError = null;
    try {
      const [listed, here] = await Promise.all([
        stageService.listDisplays(),
        // "Unknown", not a failed list: the list is what this section is for.
        stageService.currentWindowDisplay().catch(() => null),
      ]);
      if (request !== displaysRequest) return;
      displays = listed;
      windowDisplay = here;
      if (displays.length === 0) {
        displaysError = 'No displays were detected. Connect the teleprompter display and try again.';
      }
    } catch (err) {
      if (request !== displaysRequest) return;
      displays = [];
      windowDisplay = null;
      displaysError = `Speaking Glass could not list the connected displays. ${describeError(err)}`;
    } finally {
      if (request === displaysRequest) {
        displaysLoading = false;
        displaysInFlight = null;
      }
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
   *
   * Mirroring is the one exception, and it is not appearance: it is whether
   * there is a beamsplitter in front of the panel, so it is stored against the
   * panel (`optical.panelMirror`, #206) and pinning a different display shows
   * — and edits — that display's own answer. See `setPanelMirror`.
   */
  async function chooseDisplay(fingerprint: string | null): Promise<void> {
    await patchSettings('stage', { displayFingerprint: fingerprint });
  }

  /**
   * "Remember the reading window", and the frame it governs.
   *
   * Turning it OFF forgets the stored rectangle rather than merely declining to
   * use it. The toggle is a statement about whether this app keeps a note of
   * where the operator's windows sit, so leaving the note on disk — unused,
   * un-shown, and ready to be honoured again the moment the switch flips back —
   * would be keeping exactly the thing they asked us not to keep.
   *
   * Two writes because they are two sections, and ordered so the switch lands
   * first: if the second fails, the app has stopped remembering (which is what
   * was asked) and holds a stale frame it will never read (which is inert).
   * The other order could leave remembering ON with the frame already gone.
   */
  async function setRememberReadingWindow(enabled: boolean): Promise<void> {
    await patchSettings('general', { restoreWindows: enabled });
    if (!enabled && $settings.stage.readerFrame !== null) {
      await patchSettings('stage', { readerFrame: null });
    }
  }

  /**
   * Put a number on every panel, matching the number on its tile.
   *
   * Rust puts the numbered card on each physical panel; the tiles already
   * carry the same numbers (`numbers` above), so the toast only has to say
   * where to look. Listing display NAMES here cannot answer "which panel is
   * number 2?", which is the whole question.
   *
   * The overlays come from a fresh read of the displays and the tiles from an
   * older one. If a monitor was plugged, unplugged or rearranged in between,
   * the glass is numbered differently from the tiles, so the list is read once
   * more and compared again — and if it STILL disagrees the panels are
   * changing under us, which is said rather than papered over with a tile
   * wearing a number that another panel is showing.
   *
   * Every comparison waits for the newest read first. A read already in flight
   * (the section opening, a topology change) is about to replace the tiles,
   * so agreeing with the list it replaces proves nothing; and the re-read
   * below can itself be overtaken by a topology change, in which case its own
   * answer is never shown and the newer one is the list to judge.
   */
  async function identifyDisplays(): Promise<void> {
    if (identifying) return;
    identifying = true;
    try {
      const identification = await stageService.identifyDisplays();
      const count = identification.displays.length;
      if (count === 0) return;
      await displaysSettled();
      if (!identificationMatches(identification, displays)) {
        void loadDisplays();
        await displaysSettled();
        // The re-read failed and has already said why.
        if (displaysError !== null) return;
        if (!identificationMatches(identification, displays)) {
          displaysError =
            'The connected displays changed while they were being numbered. Press Identify displays again.';
          return;
        }
      }
      displaysError = null;
      showToast(`Each display shows the number on its tile here (${count} connected)`, 'info', {
        durationMs: 3000,
      });
    } catch (err) {
      displaysError = describeError(err);
    } finally {
      identifying = false;
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
      displaysError = `Speaking Glass could not create the prompt window on this display. ${describeError(err)}`;
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
   * for this panel. `discovered` is what Speaking Glass can work out on its own —
   * the panel model from the display name, the physical scale from that model,
   * a plausible distance for that hardware — and it is a PROPOSAL, not a rig.
   *
   * The proposal IS what a take runs on now, under the name "Automatic":
   * `prompterOpticalProfile` in services/stage-envelope.ts reaches for the
   * same discovery whenever no rig has been chosen for the panel. So what this
   * section shows for an unrigged display is not a preview of a button — it
   * is the geometry the next take opens with, and editing it turns it into a
   * stored rig that then takes precedence.
   */
  const displayShape = $derived(
    effectiveDisplay
      ? {
          name: effectiveDisplay.name,
          physicalSize: effectiveDisplay.physicalSize,
          scaleFactor: effectiveDisplay.scaleFactor,
          physicalSizeMm: effectiveDisplay.physicalSizeMm ?? null,
        }
      : null,
  );
  /** Rigs are stored per panel, so an unresolvable display has none. */
  const rigFingerprint = $derived(effectiveDisplay?.fingerprint ?? null);
  /**
   * The mirroring a prompter take on the panel above runs with (#206).
   *
   * Per panel, because the glass is in front of one display and not the others:
   * a take that falls back to the laptop with the glass unplugged reads the
   * laptop's answer, not this one. So the switches describe — and change — the
   * same panel the preview, the display test and Calibrate are about, and an
   * unresolvable display has nothing to switch.
   */
  const panelMirror = $derived(panelMirrorFor($settings.optical, rigFingerprint));

  /**
   * Set one mirror axis for the panel above, and only for it.
   *
   * Written as the whole optical section — see `withPanelMirror` for why a
   * mirror write must carry the rigs with it. A take already running on this
   * panel follows it (`installLiveSettingsFollow`); a take on another panel
   * does not, because this is not its glass.
   */
  function setPanelMirror(axis: 'horizontal' | 'vertical', value: boolean): void {
    const fingerprint = rigFingerprint;
    if (fingerprint === null || fingerprint === '') return;
    void patchSettings(
      'optical',
      withPanelMirror($settings.optical, fingerprint, {
        ...panelMirrorFor($settings.optical, fingerprint),
        [axis]: value,
      }),
    );
  }
  const rigs = $derived(opticalRigsForDisplay($settings.optical, rigFingerprint));
  const appliedRig = $derived(activeOpticalProfile($settings.optical, rigFingerprint));
  const discovered = $derived(discoverProfile(displayShape, null));
  /**
   * What a take on this panel actually runs on when no rig is chosen — the
   * same complete-or-null test `prompterOpticalProfile` applies, so the copy
   * cannot promise automatic sizing to a panel (an iPad, say) that discovery
   * recognises but cannot size.
   */
  const automaticRig = $derived(automaticProfile(displayShape));
  /**
   * The size bias an automatic take runs at: the presenter's loose preference,
   * defended the same way `automaticProfile` defends it, since the readout
   * built from it must not be able to show NaN.
   */
  const automaticBias = $derived.by(() => {
    const value = $settings.teleprompter.sizeBias;
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : defaultOpticalProfile().bias;
  });
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
    appliedRig ?? {
      ...discovered.profile,
      /*
       * The proposal carries the loose preferences, because on this panel they
       * are what a take is actually running: `prompterOpticalProfile` seeds all
       * three into the automatic profile. Leaving discovery's own values here
       * made the readout describe a stage the take would not produce — the one
       * thing its note promises it cannot do — and, worse, editing ANY control
       * stores this object as a rig, so a Soft/Wash presenter who changed their
       * framing was silently returned to Standard/Ticks by the rig they had
       * just created.
       */
      bias: automaticBias,
      intensity: $settings.teleprompter.textIntensity,
      readingCue: $settings.teleprompter.readingCue,
      rigName: unusedRigName(discovered.profile.rigName),
    },
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
   * The resolver's warnings, less the ones this screen already says.
   *
   * Settings never measures the stage font — a take does — so "could not be
   * measured" was true of every rig on every visit and the readout carries a
   * one-line caption instead. With no stored rig, the sentence above the
   * readout already says how the display is sized, so the resolver's
   * "uncalibrated" guess is a second copy of it; and the Fit row already says
   * an uncalibrated rig makes no claim, so its advice was a third. The panel
   * used to stack all three under one readout.
   */
  const rigWarnings = $derived(
    (resolvedRig?.warnings ?? []).filter(
      (warning) =>
        warning !== UNMEASURED_FONT_WARNING &&
        warning !== UNCALIBRATED_FIT_ADVICE &&
        !(
          appliedRig === null &&
          (warning === UNCALIBRATED_PROMPTER_WARNING || warning === UNCALIBRATED_READER_WARNING)
        ),
    ),
  );

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
      body: 'The measurements for this arrangement are deleted. Takes on this display go back to automatic sizing until another rig is chosen.',
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

  /**
   * The appearance sliders that have a fixed default worth naming.
   *
   * Four geometry fields plus the auto-scroll pace. Everything here resets to a
   * CONSTANT, which is what separates them from the rig overrides above: those
   * reset to a value the optical resolver works out afresh from a measured
   * distance, and can move when the distance does.
   */
  type AppearanceSliderKey =
    | 'fontSizePx'
    | 'lineHeight'
    | 'columnWidthPercent'
    | 'readingBandCenterPercent'
    | 'fixedSpeedWpm';

  /**
   * Read from the same constants `defaultAppSettings()` builds from, never
   * retyped here. A "Reset to default" carrying its own copy of the number is a
   * reset that can quietly disagree with the default it claims to restore.
   */
  const APPEARANCE_DEFAULTS: Record<AppearanceSliderKey, number> = {
    fontSizePx: DEFAULT_STAGE_APPEARANCE.fontSizePx,
    lineHeight: DEFAULT_STAGE_APPEARANCE.lineHeight,
    columnWidthPercent: DEFAULT_STAGE_APPEARANCE.columnWidthPercent,
    readingBandCenterPercent: DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
    fixedSpeedWpm: DEFAULT_TELEPROMPTER_FIXED_SPEED_WPM,
  };

  /**
   * The reading window owns these four in its own way: not through a rig
   * somebody can open, but through the reader preference, which is set in
   * Reading appearance during a read. Named separately so the sliders can say
   * where that is rather than "controlled by the reading window", which sends
   * somebody looking for a control on this screen.
   */
  const readerOwnsGeometry = $derived($settings.stage.presentationMode === 'reader');
  /** The size keys as this platform writes them — the native menu's own spelling. */
  const readerSizeKeys = `${formatAccelerator('Mod+=', isMacPlatform())} and ${formatAccelerator('Mod+-', isMacPlatform())}`;

  /**
   * Who decides the four geometry fields right now — or null for nobody.
   *
   * Read from the same two facts `stageSettingsFromSettings` branches on, and
   * in the same order, because anything else is a second opinion about a
   * question the stage has already answered.
   *
   * TWO OWNERS, NOT ONE. Gating on `appliedRig` alone was the obvious reading
   * and it is wrong in a way nobody would notice from the prompter path:
   * a READING WINDOW always runs its own rig. `readerOpticalProfile`
   * synthesises one when nothing is stored — deliberately, so a reader never
   * falls through to the uncalibrated layout — so in reader mode these four
   * fields are overridden whether or not a prompter rig was ever measured.
   * A presenter in reader mode with no calibration would otherwise have been
   * left with exactly the defect this change exists to remove.
   */
  /** The anchor on "This rig", for links that should land on the sizing itself. */
  const RIG_SECTION_ID = 'settings-this-rig';
  /* Explanations that live outside the controls they explain, by id, so the
     controls can point `aria-describedby` at them. One window, one of each. */
  const GEOMETRY_NOTE_ID = 'settings-geometry-note';
  const AUTOSCROLL_HINT_ID = 'settings-autoscroll-hint';
  const MIC_TEST_DESCRIPTION_IDS = 'settings-mic-test-prompt settings-mic-test-note';
  const INTENSITY_LABELS: Record<TextIntensity, string> = {
    soft: 'Soft',
    standard: 'Standard',
    strong: 'Strong',
  };

  const geometryOwner = $derived.by((): { label: string; toRig: boolean } | null => {
    if ($settings.stage.presentationMode === 'reader') {
      return { label: 'the reading window', toRig: false };
    }
    if (appliedRig !== null) return { label: `${appliedRig.rigName} calibration`, toRig: true };
    // Automatic sizing owns the geometry just as a rig does: these four
    // sliders would move and change nothing on a panel it can size.
    if (automaticRig !== null) return { label: 'automatic sizing', toRig: true };
    return null;
  });

  /**
   * Send somebody to whatever owns the geometry they just tried to change.
   *
   * The disabled sliders name the owner, which answers "why can I not move
   * this"; this answers "then where do I". Both destinations are the Stage
   * display section — where the applied rig sorts first and carries its own
   * Re-calibrate, and where the prompter/reader switch lives.
   *
   * It lands on the rig itself when a rig or automatic sizing is the owner:
   * the top of that section is the display picker, a screenful away from the
   * sizing that took the controls.
   */
  /** Down to "This rig", from the summary line at the top of the same section. */
  function jumpToRig(): void {
    contentElement?.querySelector<HTMLElement>(`#${RIG_SECTION_ID}`)?.scrollIntoView({ block: 'start' });
  }

  function openGeometryOwner(): void {
    pendingAnchor = geometryOwner?.toRig ? RIG_SECTION_ID : null;
    void navigate({ name: 'settings', section: 'stage' });
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

  /**
   * The presets as one segmented choice, with the rig's own distance as a
   * segment of its own when it is not a preset.
   *
   * They were loose chips whose selected state was the INVERSE of every
   * segmented control on the screen, and a measured 0.90 m selected nothing at
   * all — the only sign of it was a sentence underneath. Now the distance in
   * force is always the selected segment.
   */
  const distanceOptions = $derived.by(() => {
    const presets = DISTANCE_PRESETS_M.map((metres) => ({
      value: String(Math.round(metres * 1000)),
      label: `${metres.toFixed(1)} m`,
    }));
    const current = rig.viewingDistanceMm;
    if (current === null || presets.some((option) => option.value === String(current))) {
      return presets;
    }
    // In order among the presets, and written as they are (0.9 m, not 0.90 m)
    // unless it genuinely has a second decimal.
    const metres = Math.round(current / 10) / 100;
    return [...presets, { value: String(current), label: `${metres} m` }].sort(
      (a, b) => Number(a.value) - Number(b.value),
    );
  });

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
   * Imported rather than repeated. It was a copy of a module-private constant,
   * with a note admitting it would go stale if the resolver's value moved — and
   * then it did move, from 0.92 to 0.82, and the slider went on labelling
   * "Automatic" as 92%. It is exported from `shared/optics.ts` now, beside the
   * fit check that consumes it.
   */
  const AUTOMATIC_MAX_COLUMN_FRACTION = MAX_COLUMN_FRACTION;

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
  /**
   * The OS's own answer (#303), read passively by Rust. What the webview cannot
   * see — WKWebView has no Permissions API for the microphone — and so the only
   * way this screen knows a refusal it did not witness, or a grant made in
   * System Settings while it was in the background.
   */
  let micAccess = $state<MicrophonePermission>('unsupported');
  /**
   * Which native read may still land. Bumped by every read, by leaving the
   * section, and by a grant witnessed here — a read that was already in flight
   * then describes the OS from before the user said yes, and must not undo it.
   */
  let micAccessRead = 0;
  /** A request is in flight; the OS prompt may be up. */
  let micRequesting = $state(false);
  /**
   * "Try again" was refused again. Said, because macOS may not hand a running
   * webview a grant made since launch, and the remedy then is a reopen.
   */
  let micRetryRefused = $state(false);
  /**
   * The OS's words for all of the above (lib/os-copy.ts). The cards below are
   * one per permission state on every platform, but what each one says is not:
   * macOS asks once and may need a relaunch, Windows never asks and never does.
   */
  const os = osCopy();
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
   * The webview has not named the inputs yet — it does not until this window
   * has opened one (see `inputsWithheld`), which the meter does a moment after
   * the section opens. Until then an unmatched pin is unknown, not unplugged.
   */
  const micInputsWithheld = $derived(inputsWithheld(micDevices));
  /** The remembered pin is known NOT to be plugged in. */
  const micPinMissing = $derived(micPinned !== undefined && !micPinnedDevice && !micInputsWithheld);
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
  /** The Mac's own input, as it names it — without Chromium's "Default - ". */
  const micSystemDefaultLabel = $derived(
    micDevices
      .find((d) => d.isDefault)
      ?.label.replace(/^default\s+-\s+/i, '')
      .trim() || null,
  );
  /**
   * The physical microphone a take would open right now, by name.
   *
   * The picker can show a remembered microphone that is not plugged in, and a
   * native select clips a long name, so neither answers "which microphone is
   * this?" on its own. This does, and the meter and the test below are both
   * reading it.
   */
  const micActiveLabel = $derived(micPinnedDevice?.label ?? micSystemDefaultLabel);
  const micPickerDescription = $derived(
    micPinMissing
      ? 'Remembered for when it is plugged back in.'
      : micPinned
        ? 'Every take uses this microphone.'
        : os.micFollowsSystemInput,
  );
  /**
   * What changed about access or the input, as one sentence for the section's
   * permanent status region. The visible notices are mounted with their text
   * already in them, which is the case a screen reader is least reliable about.
   */
  const micAnnouncement = $derived.by((): string => {
    if (micPermission === 'granted') {
      return micPinned && micPinMissing
        ? `${micPinned.label} is not connected. Takes use ${micSystemDefaultLabel ?? os.defaultInput} until it is back.`
        : '';
    }
    if (micPermission === 'unknown') return micRequesting ? os.micRequestPending : '';
    if (micAccess === 'restricted') return `${os.micRestrictedTitle}.`;
    if (micAccess === 'granted') {
      return micRetryRefused ? os.micAllowedButRefusedAnnouncement : 'Microphone access is on.';
    }
    return micRetryRefused ? 'Microphone access is still off.' : 'Microphone access is off.';
  });

  /**
   * The microphone the last transcription test ran on.
   *
   * A pass is evidence about one input. Without its name beside it, a verdict
   * earned on the laptop microphone sat under a picker that had since been
   * changed to the headset, and read as though the headset had passed.
   */
  let micTestedLabel = $state<string | null>(null);
  /** A failure the test itself reported, as opposed to one opening the device. */
  const micTestError = $derived(
    micTestSnapshot.stoppedReason === 'error' ? micTestSnapshot.error : null,
  );
  /**
   * The failure as this screen shows it.
   *
   * The recogniser's messages are written for a take, and several end with
   * what to press during one ("In a take, press A to start or stop
   * auto-scroll…"). That is the wrong advice in Settings, where nothing is
   * scrolling; the rest of the sentence is still the diagnosis.
   */
  const micTestErrorText = $derived(
    micTestError
      ?.replace(/\s*In a take, press A to start or stop auto-scroll(?:, then [^.]*)?\./, '')
      .trim() ?? null,
  );
  /** The failure says to fix it in Speech, so offer the way there. */
  const micTestNeedsSpeech = $derived(
    micTestError !== null && /Settings\s*[→›]\s*Speech/.test(micTestError),
  );
  /**
   * One sentence for where the test is, in one place that never moves.
   *
   * These used to share the action row with the buttons and arrive one after
   * another underneath it, so the page grew and shrank by 120px across a single
   * test and the outcome of an automatic stop was a grey footnote.
   */
  const micVerdict = $derived.by(
    (): { tone: 'idle' | 'live' | 'good' | 'warn' | 'bad'; icon: 'check' | 'alert' | 'clock' | null; text: string } => {
      switch (micTest) {
        case 'opening':
          return { tone: 'live', icon: null, text: 'Starting speech recognition…' };
        case 'listening':
          return { tone: 'live', icon: null, text: 'Listening — say the sentence above' };
        case 'waiting':
          return { tone: 'live', icon: null, text: 'Receiving words…' };
        case 'success':
          return {
            tone: 'good',
            icon: 'check',
            text: micTestedLabel
              ? `Transcription is working with ${micTestedLabel}`
              : 'Transcription is working',
          };
      }
      switch (micTestSnapshot.stoppedReason) {
        case 'error':
          return { tone: 'bad', icon: 'alert', text: 'The test could not run' };
        case 'idle_timeout':
          return { tone: 'warn', icon: 'clock', text: 'Nothing was transcribed in 30 seconds' };
        case 'max_duration':
          return { tone: 'warn', icon: 'clock', text: 'The test stopped after two minutes' };
        case 'user':
          return { tone: 'idle', icon: null, text: 'Test stopped' };
        default:
          return { tone: 'idle', icon: null, text: 'Not tested yet' };
      }
    },
  );
  /** What the test asks for — said in the row, and spoken while it listens. */
  const MIC_TEST_SENTENCE = 'Speaking Glass is following my voice.';
  /** What the well under the verdict holds: words, a next step, or room for them. */
  const micTestWords = $derived.by((): { kind: 'final' | 'partial' | 'message' | 'empty'; text: string } => {
    if (micTestErrorText) return { kind: 'message', text: micTestErrorText };
    if (micTestSnapshot.final) return { kind: 'final', text: micTestSnapshot.final };
    if (micTestSnapshot.partial) return { kind: 'partial', text: micTestSnapshot.partial };
    if (micTestSnapshot.stoppedReason === 'idle_timeout') {
      return {
        kind: 'message',
        text: 'If the level above moves when you speak, the microphone is hearing you. Run the test again and say the sentence clearly.',
      };
    }
    if (micTestSnapshot.stoppedReason === 'max_duration') {
      return { kind: 'message', text: 'Start it again if you need another look.' };
    }
    return { kind: 'empty', text: 'Your words will appear here.' };
  });

  /**
   * The rest of the verdict, for the announcement only.
   *
   * The eye reads the sentence to say and the words that came back in the
   * well; somebody who pressed Test from the keyboard and stayed there hears
   * only the status region, so it carries them too — the final words once,
   * never the partials streaming in.
   */
  const micVerdictDetail = $derived.by((): string | null => {
    if (micTestWords.kind === 'message') return micTestWords.text;
    if (micTest === 'listening') return `Say: ${MIC_TEST_SENTENCE}`;
    if (micTest === 'success' && micTestSnapshot.final) return `Heard: ${micTestSnapshot.final}`;
    return null;
  });

  /**
   * A verdict belongs to the input that earned it, so choosing another one
   * clears it — and stops a test still listening on the old one.
   */
  function resetMicTest(): void {
    micTestStarts += 1;
    if (micTestRunning) micTestSession.stop('restart');
    micTestSnapshot = { state: 'idle', partial: '', final: '', error: null, stoppedReason: null };
    micTestedLabel = null;
  }

  /**
   * Capture tuning is folded away: it is rare, expert work, and it sat between
   * nothing and everything as a second section of equal weight. A search opens
   * it, because the row filter marks rows it cannot show inside a closed fold.
   */
  let captureTuningOpen = $state(false);
  /** Advanced, under This rig — folded for the same reason. */
  let advancedOpen = $state(false);
  /*
   * A search opens both folds — Advanced's rows were counted as matches while
   * the fold that holds them stayed shut — and clearing it puts each back the
   * way it was, so a search does not leave the panel unfolded behind it. A fold
   * with no match inside is hidden by the row filter, so opening both costs
   * nothing on screen.
   */
  let foldsBeforeSearch: { capture: boolean; advanced: boolean } | null = null;
  $effect(() => {
    const searching = sectionQuery.trim() !== '';
    untrack(() => {
      if (searching && foldsBeforeSearch === null) {
        foldsBeforeSearch = { capture: captureTuningOpen, advanced: advancedOpen };
        captureTuningOpen = true;
        advancedOpen = true;
      } else if (!searching && foldsBeforeSearch !== null) {
        captureTuningOpen = foldsBeforeSearch.capture;
        advancedOpen = foldsBeforeSearch.advanced;
        foldsBeforeSearch = null;
      }
    });
  });

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
    // A press still waiting for the meter never reached the session, so the
    // dispose above cannot cancel it: bump the start token so it never opens,
    // and clear the "opening" it left, or the meter would stay closed when the
    // section is opened again.
    micTestStarts += 1;
    untrack(() => {
      if (micTestSnapshot.state === 'opening') {
        micTestSnapshot = { state: 'idle', partial: '', final: '', error: null, stoppedReason: null };
      }
    });
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

  /*
   * #303. The OS's answer, on arriving here and on every return to the window.
   *
   * Focus is the moment that matters: "Open System Settings" sends the user to
   * another application, and they come back having flipped the switch — or
   * not. A refusal shows the remedy even to somebody who has never pressed a
   * button here. A grant while the refusal is showing changes what it says,
   * but does not clear it: the OS allowing Speaking Glass is not the same as this
   * running webview being given the microphone, and only Try again — a real
   * request — can tell the two apart. Passive throughout: nothing here opens a
   * device.
   */
  $effect(() => {
    if (section !== 'audio') return undefined;
    const read = async (): Promise<void> => {
      const mine = (micAccessRead += 1);
      const access = await readMicrophonePermission();
      if (mine !== micAccessRead) return;
      micAccess = access;
      if (isMicrophoneRefused(access)) {
        micAdopted = false;
        micPermission = 'denied';
      }
    };
    void read();
    const onFocus = (): void => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      micAccessRead += 1;
      window.removeEventListener('focus', onFocus);
    };
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
        // The OS saying so is as good as remembering it (#303): a grant made
        // from a take's prompt never set the flag, and asked again forever.
        remembered: $settings.audio.microphoneGranted || micAccess === 'granted',
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
    let relisted = false;
    // Chained, not called: changing the device or a processing toggle re-runs
    // this effect, and starting the replacement before the previous capture has
    // let go is the collision this baton exists to prevent.
    const opened = captureBaton.then(() => {
      if (cancelled) return;
      release = getVoiceFacade().observeLevels(
        deviceId,
        (snapshot) => {
          micLevel = snapshot;
          // A level means this window has a microphone open, so the webview
          // will name the inputs now. Asked once; the pin is re-bound from it,
          // and a pinned microphone that is found moves the meter onto itself.
          if (!relisted && !cancelled && micInputsWithheld) {
            relisted = true;
            void relistNamedMicrophones();
          }
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
    const mine = (micTestStarts += 1);
    micError = null;
    micTestedLabel = micActiveLabel;
    // Fresh, not the last run's words under a new "Starting…".
    micTestSnapshot = { state: 'opening', partial: '', final: '', error: null, stoppedReason: null };
    await microphoneQuiet();
    if (mine !== micTestStarts) return;
    await micTestSession.start(micDeviceId);
  }

  /**
   * Which press of Test may still open the session.
   *
   * Between the press and `start` there is the wait for the meter to let go,
   * and the session knows nothing of the test yet — so Stop pressed there
   * reached a session with nothing to stop, and the test opened anyway once
   * the meter was free. Stop, a new input and leaving the section all bump
   * this, and a start that finds it moved does not happen.
   */
  let micTestStarts = 0;

  /**
   * The Test/Stop slot, and whether focus was in it when the test started or
   * stopped.
   *
   * Start and Stop are two buttons, so the one that was pressed leaves the
   * page the moment it does its job. Somebody working from the keyboard would
   * be dropped to the top of the document mid-test; this puts focus on the
   * button that replaced it instead. Read BEFORE the swap (`$effect.pre`),
   * restored after it.
   */
  let micTestSlot = $state<HTMLElement | null>(null);
  let micTestFocusCarry = false;
  $effect.pre(() => {
    void micTestRunning;
    micTestFocusCarry = micTestSlot?.contains(document.activeElement) ?? false;
  });
  $effect(() => {
    void micTestRunning;
    if (!micTestFocusCarry) return;
    micTestFocusCarry = false;
    micTestSlot?.querySelector('button')?.focus();
  });

  function stopTranscriptionTest(): void {
    micTestStarts += 1;
    if (micTestSession.running) {
      micTestSession.stop('user');
      return;
    }
    // Still waiting for the meter: nothing opened, so it is simply stopped.
    micTestSnapshot = { state: 'idle', partial: '', final: '', error: null, stoppedReason: 'user' };
  }

  /** Enumerate inputs for an already-granted permission — never prompts. */
  async function adoptGrantedMicrophone(): Promise<void> {
    if (micAdopted) return;
    micAdopted = true;
    try {
      const devices = await getVoiceFacade().listMicrophones();
      // The OS said no while the list was coming back (#303). Listing inputs
      // proves nothing about access, so the refusal stands.
      if (isMicrophoneRefused(micAccess)) {
        micAdopted = false;
        return;
      }
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
   * List again once this window has a microphone open, to replace the withheld
   * list the section opened with (see `micInputsWithheld`). Never prompts: it
   * is only called while the meter holds a capture.
   */
  async function relistNamedMicrophones(): Promise<void> {
    try {
      const devices = await getVoiceFacade().listMicrophones();
      if (isMicrophoneRefused(micAccess)) return;
      micDevices = devices;
      repinRememberedMicrophone(devices);
    } catch {
      // The withheld list stands, and nothing is claimed from it.
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
    // Matched by id on a list that withholds names: its label is our own
    // placeholder, and must not replace the name the pin was remembered by.
    const label = match.withheld === true ? remembered.label : match.label;
    if (match.deviceId === remembered.deviceId && label === remembered.label) return;
    void patchSettings('audio', {
      preferredDeviceId: match.deviceId,
      preferredDeviceLabel: label,
    }).catch(() => {
      /* a remembered preference is a convenience, never a gate */
    });
  }

  /**
   * The one place the input choice is made — the system-default row included.
   */
  function chooseMicrophone(value: string): void {
    // A withheld input's empty id pins nothing; it is never offered, but a
    // stale picker must not be able to write it either.
    if (value === '') return;
    resetMicTest();
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
    if (micRequesting) return;
    const retrying = micPermission === 'denied';
    micRequesting = true;
    micError = null;
    try {
      const granted = await getVoiceFacade().requestMicrophoneAccess();
      if (granted === 'granted') {
        micAdopted = false;
        micRetryRefused = false;
        // Witnessed: the device opened, so the OS has said yes, whatever an
        // earlier read said — or one still in flight is about to (#303).
        micAccessRead += 1;
        micAccess = 'granted';
        await adoptGrantedMicrophone();
        // Remember it. WKWebView cannot report permission state, so this flag
        // is the only way a returning user is not asked again (§28.1).
        if (!$settings.audio.microphoneGranted) {
          void patchSettings('audio', { microphoneGranted: true }).catch(() => {});
        }
      } else {
        micPermission = 'denied';
        micRetryRefused = retrying;
      }
    } catch (err) {
      // A rejected request used to leave the row at "Testing…" forever. Only a
      // refusal answers 'denied' (#303); a missing or busy device lands here,
      // described as what it is rather than as blocked access.
      micPermission = 'unknown';
      micError = `Speaking Glass could not open the microphone. ${describeError(err)}`;
    } finally {
      micRequesting = false;
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
          ? 'Diagnostics need the Speaking Glass desktop app.'
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

  /**
   * Whether there is a bundle to reveal.
   *
   * The Reveal button is not shown before the first export of the session,
   * because `reveal_support_bundle` has nothing to point at until then and a
   * control whose only possible answer is an error is worse than no control.
   * It is not persisted either: the path lives in the Rust process, so a
   * relaunch legitimately has nothing to show.
   */
  let bundleExported = $state(false);

  async function runSupportBundle(): Promise<void> {
    await runMaintenance(
      () => diagnosticsService.exportSupportBundle(),
      // Rust runs the folder picker; cancelling is not a failure.
      (result) => {
        if (result.cancelled) return null;
        bundleExported = true;
        return 'Support bundle ready';
      },
    );
  }

  async function revealBundle(): Promise<void> {
    try {
      await diagnosticsService.revealSupportBundle();
    } catch (err) {
      showToast(describeError(err), 'danger');
    }
  }

  /**
   * C6: this used to invoke the Rust `all` cache kind, which emptied the
   * compiled/vocabulary/thumbnail/download caches and never touched a log
   * file — then reported "Logs cleared." It now calls the real `logs` arm,
   * the only kind Rust accepts since #219.
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

  /**
   * Export, and say what actually happened.
   *
   * This used to be `result.cancelled ? null : 'Export ready'` — a success
   * toast for any result that was not a cancelled picker. The adapter beneath
   * it discarded Rust's warnings, so a failed database snapshot produced the
   * word "ready" over a folder that could contain no database at all.
   *
   * `runMaintenance` only knows how to show a success toast, so an incomplete
   * export cannot go through it: it is a `danger` toast, and the sentence comes
   * from `describeExport`, which is pure and tested.
   */
  async function runExportAllData(): Promise<void> {
    try {
      const result = await settingsService.exportAllData();
      // A cancelled picker is not a failure and is not worth a toast.
      if (result.cancelled) return;
      const message = settingsService.describeExport(result);
      if (message) showToast(message, result.complete ? 'success' : 'danger');
    } catch (err) {
      showToast(describeError(err), 'danger');
    }
  }

  /**
   * Restore from an export folder.
   *
   * Rust validates the manifest and every checksum and then SCHEDULES the
   * restore; the swap happens at the next launch, before any database pool
   * exists. Swapping the file underneath the running pool is not something a
   * filesystem lets you do meaningfully.
   *
   * So the toast says "quit and reopen", and says that nothing has changed
   * yet — otherwise a successful schedule reads as a completed restore, and
   * the user closes the app believing the work is already done.
   */
  async function runRestoreAllData(): Promise<void> {
    try {
      const result = await settingsService.restoreAllData();
      if (result.cancelled) return;
      showToast(
        `Ready to restore ${result.scriptsInExport} scripts from the export taken on ` +
          `${result.createdAt?.slice(0, 10) ?? 'an earlier date'}. ` +
          `${os.quit} and reopen Speaking Glass to apply it — nothing has changed yet.`,
        'success',
      );
    } catch (err) {
      showToast(describeError(err), 'danger');
    }
  }

  /*
   * No "Check now" button here. Help › Check for Updates… is the action, and
   * its answer is drawn in the document window, where the install flow lives —
   * a second button here would have had to report into a window behind this
   * one (docs/updates.md).
   */
  async function loadUpdatePolicy(): Promise<void> {
    const version = await settingsService.getAppVersion().catch(() => null);
    // A version we could not read is worth saying plainly. Inventing one here
    // is how the old `'0.1.0'` fallbacks ended up in support pastes.
    runningVersion = version ?? 'an unknown version';
  }
</script>

<div class="page">
  <!--
    In a WINDOW there is nowhere to go back to (§14.1: "Remove Back to Library
    from Settings if it becomes a separate window"), and nothing to finish
    either. Every control here applies the moment it changes, so a Done button
    promised a commit step that does not exist — filled in clay, it was also a
    second primary action beside each pane's own. The window closes the way
    every Mac settings window does: its close button and ⌘W
    (`PreferencesApp.svelte` answers `file.close-script`). `onclose` stays a
    prop so the route still works if it is ever hosted in the control window
    again, where it is what removes the back control.
  -->
  <Toolbar
    title="Settings"
    backLabel={onclose ? undefined : 'Library'}
    onback={onclose ? undefined : () => navigate({ name: 'library', view: 'all' })}
  >
    {#snippet actions()}
      <!--
        Settings search (§14.2), in the toolbar where it is stable across every
        section. It filters BOTH: the section list narrows to the sections whose
        keywords match, and the rows of the section on screen narrow to the ones
        whose rendered text matches, with the matches washed. The structure is
        kept — sections stay in their order and the count says how much was
        hidden — which is what §14.2 asks for.
      -->
      <div class="settings-search">
        <span class="search-icon"><Icon name="search" size={14} /></span>
        <input
          class="search-input"
          type="search"
          placeholder="Search settings"
          aria-label="Search settings"
          bind:value={sectionQuery}
          onkeydown={(event) => {
            // Escape clears before it closes anything — §23.1's layered rule.
            if (event.key === 'Escape' && sectionQuery !== '') {
              event.preventDefault();
              event.stopPropagation();
              sectionQuery = '';
            }
          }}
        />
      </div>
    {/snippet}
  </Toolbar>

  <div class="body">
    <!--
      One tab stop, arrows inside — the main sidebar's contract (§23.1), so the
      app's two source lists are learnt once. Arrowing moves focus without
      changing the pane; Enter or Space opens it, as a click does.
    -->
    <nav
      class="section-nav"
      aria-label="Settings sections"
      bind:this={sectionNav}
    >
      {#each matchingSections as entry, index (entry.id)}
        <button
          type="button"
          class="section-item"
          class:active={($route.name === 'settings' ? section : 'general') === entry.id}
          aria-current={section === entry.id ? 'page' : undefined}
          tabindex={sectionTabIndex(index)}
          onkeydown={(event) => sectionKeydown(event, index)}
          onclick={() => navigate({ name: 'settings', section: entry.id })}
        >
          {entry.label}
        </button>
      {/each}
    </nav>

    <div class="content" bind:this={contentElement}>
      <!--
        What the search did, said out loud (§14.2, §18.1).

        A form that quietly loses eleven of its fourteen rows is a form that
        looks broken. Naming the count — and offering the way back — is what
        turns a filtered section into an obviously filtered section.
      -->
      {#if rowMatches !== null}
        <!-- One message for an empty result, here — the section list no
             longer carries a second one at another size and baseline. -->
        <p class="row-filter-note" role="status">
          <span>
            {#if rowMatches > 0}
              {rowMatches === 1 ? '1 setting' : `${rowMatches} settings`} in {currentSectionLabel}
              {rowMatches === 1 ? 'matches' : 'match'} “{sectionQuery.trim()}”.
            {:else if otherMatches > 0}
              Nothing in {currentSectionLabel} matches “{sectionQuery.trim()}”. The sections listed beside this may.
            {:else}
              No settings match “{sectionQuery.trim()}”.
            {/if}
          </span>
          <button type="button" class="row-filter-clear" onclick={() => (sectionQuery = '')}>
            {rowMatches > 0 ? 'Show all' : 'Clear search'}
          </button>
        </p>
      {/if}
      {#if section === 'general'}
        <Section title="General">
          <Select
          layout="row"
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
            is a fixed-pace transport, and Auto-scroll pace in Settings ›
            Teleprompter sets it. What is missing is a MODE — a take that opens
            with no microphone and no recogniser, and prompts by the clock
            alone. That is a different decision from "can the script roll", and
            until somebody makes it, a take always opens listening.
          -->
          <!--
            This was a Select with three entries, two of them permanently
            disabled and labelled "not available in this release".

            The reasoning below is unchanged and still right: a mode that
            silently behaves like another one is worse than a mode that is
            missing. What was wrong was the shape. A dropdown is a question, and
            opening this one to find both alternatives greyed out answers it with
            "there was never anything to decide" — every time, for every reader.

            So it says what the mode is. The sentence carries what the two
            disabled rows used to, which is the part worth keeping: somebody who
            came here looking for a fixed-speed mode learns that auto-scroll
            exists and where to find it, instead of learning only that they
            cannot have what they came for.
          -->
          <!--
            READ, not asserted. `defaultSessionMode` is still a real stored
            field: `fromRustDocument` accepts a persisted 'manual' or 'fixed',
            and `startTake` passes whatever it finds straight into the session.
            A readout hardcoded to "Follow voice" would therefore have been the
            same defect one layer along — a screen describing a state the app is
            not in — for anybody carrying such a document. So if an unsupported
            mode is stored, this says so and offers the way back that removing
            the Select would otherwise have taken away. The way back names the
            mode with the readout's own label, so the button and the value it
            produces say the same words.
          -->
          {#if $settings.general.defaultSessionMode === 'voice'}
            <SettingReadout
              layout="row"
              label="Session mode"
              value={SESSION_MODE_LABELS.voice}
              description="Every take opens listening. Auto-scroll can still roll the script at a set pace (Teleprompter › Auto-scroll pace)."
            />
          {:else}
            <!-- The way back sits tight under the row it belongs to, not a
                 row's gap away from it. -->
            <div class="readout-with-action" data-search-row>
              <SettingReadout
                layout="row"
                label="Session mode"
                value={sessionModeLabel($settings.general.defaultSessionMode)}
                description={`Saved by an earlier version. Takes in this mode do not follow your voice; switch back to ${SESSION_MODE_LABELS.voice} to prompt normally.`}
              />
              <p class="hint-line">
                <button
                  type="button"
                  class="inline-link"
                  onclick={() => void patchSettings('general', { defaultSessionMode: 'voice' })}
                >
                  Switch to {SESSION_MODE_LABELS.voice}
                </button>
              </p>
            </div>
          {/if}
          <!-- #218 removed "Revision retention": nothing prunes revisions, so
               every one is kept whatever the slider said. -->
          <!--
            This shipped with no reader anywhere in the tree — the same defect
            the retired "Full screen" switch was culled for. It governs the
            reading window's remembered position now, so the label says that
            rather than making a broader promise nothing keeps: nothing else in
            this app restores a window across launches.
          -->
          <Toggle
            checked={$settings.general.restoreWindows}
            label="Remember the reading window"
            description="A take presented in a window reopens at the size and position you last left it."
            onchange={(value) => void setRememberReadingWindow(value)}
          />
          <Toggle
            checked={$settings.general.confirmEndSession}
            label="Confirm before ending an active session"
            onchange={(value) => void patchSettings('general', { confirmEndSession: value })}
          />
          <!-- A compile switch, not a stage one: it changes what counts as a
               spoken token, so it is read when a take compiles the script. -->
          <!-- Named for what the PRESENTER does. "Read headings aloud" read as
               Speaking Glass speaking them. -->
          <Toggle
            checked={$settings.general.readHeadings}
            label="Follow headings as spoken lines"
            description="Turn on if you read your headings out, so following counts them as script."
            onchange={(value) => void patchSettings('general', { readHeadings: value })}
          />
        </Section>
      {:else if section === 'speech'}
        <Section
          title="Speech language"
          description="The language Speaking Glass listens in. Each one is a large download, fetched once; after that, speech is transcribed on this computer with no account or key."
        >
          <!--
            The pill answers "can a take follow me right now?", which needs both
            halves: `modelStatus` is authoritative for installed / not-installed
            and `engineStatus` only upgrades Installed to Ready. They used to be
            consulted the other way round, which let the pill contradict the
            body directly beneath it whenever the two disagreed — and they
            disagree for ordinary reasons, since one can fail while the other
            succeeds.
          -->
          {#snippet actions()}
            {#if !modelStatus}
              <StatusPill tone="neutral" label="Checking…" />
            {:else if isModelBusy(modelStatus)}
              <StatusPill tone="neutral" label={phaseLabel(modelStatus)} />
            {:else if modelStatus.installed}
              <StatusPill
                tone="success"
                label={engineStatus?.loaded ? 'Ready' : 'Installed'}
              />
            {:else if isModelDamaged(modelStatus)}
              <!-- Not "Not installed": it is, and that is the surprise (#258). -->
              <StatusPill tone="warning" label="Damaged" />
            {:else}
              <StatusPill tone="warning" label="Not installed" />
            {/if}
          {/snippet}

          <!--
            §153: changing the language afterwards should read as a deliberate,
            infrequent act rather than a toggle. Choosing a row in the dropdown
            saves nothing and downloads nothing; the explicit "Use …" button is
            the commitment, and it is refused while a take is open.
          -->
          <SpeechLanguagePicker
            revision={$settings.revision}
            onactivestatus={adoptSpeechStatus}
            onlanguagechange={async () => {
              // Forced AND awaited: the store is already loaded, and Rust has
              // just written a revision the screen would otherwise keep
              // patching against. The picker holds its button busy until this
              // resolves, so a second click cannot race the reload.
              await loadSettings(true);
              await refreshSpeechStatus();
            }}
          />

          <p class="hint-line">
            Your voice never leaves this computer. The audio is never saved, and the words are not
            saved either: they are used only to find your place in the script.
          </p>
        </Section>
      {:else if section === 'audio'}
        <!--
          Capture tuning sits directly under the meter it changes. At the foot of
          the section it was a screen away from the level it promises to move,
          so every adjustment meant scrolling back up to see what it did. When
          access is not granted there is no meter, and it falls back to the
          foot of the section.
        -->
        {#snippet captureTuning()}
          <!--
            "Follow system default microphone" used to be a toggle here, three
            controls away from the picker it disabled and blanked. One control
            now: it is the first row of the input picker above.
          -->
          <Disclosure label="Capture tuning: noise, echo, gain and voice detection" bind:open={captureTuningOpen}>
            <p class="mic-tuning-lead">
              For difficult rooms. The meter above shows each change straight away.
            </p>
            <Toggle
              checked={$settings.audio.noiseSuppression}
              label="Noise suppression"
              description="Filters out steady background noise, such as a fan or air conditioning."
              onchange={(value) => void patchSettings('audio', { noiseSuppression: value })}
            />
            <Toggle
              checked={$settings.audio.echoCancellation}
              label="Echo cancellation"
              description="Removes sound from your speakers that the microphone picks up."
              onchange={(value) => void patchSettings('audio', { echoCancellation: value })}
            />
            <Toggle
              checked={$settings.audio.autoGainControl}
              label="Automatic gain control"
              description="Evens out your level as you move nearer to or further from the microphone."
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
          </Disclosure>
        {/snippet}
        <Section
          title="Microphone"
          description="Choose the input your takes listen to, check its level, then check that Speaking Glass understands you. The input meter listens while this page is open."
        >
          <!-- Mounted for as long as the section is, so a notice that arrives
               is spoken into a region that was already there (the cards and
               the fallback below carry no live role of their own). -->
          <p class="visually-hidden" role="status" aria-atomic="true">{micAnnouncement}</p>

          {#if micPermission !== 'granted'}
            <!--
              #303. macOS asks once per application; after a refusal, asking
              again fails at once with no prompt. So the remedy is the privacy
              pane, opened from here, and "Try again" is for afterwards. Each
              branch leads with the one thing to do next, and its buttons are
              weighted the same way — the refusal that has since been lifted is
              good news, not another red error.
            -->
            {#if micPermission === 'unknown'}
              <div class="mic-access" data-search-row>
                <span class="mic-access-icon"><Icon name="mic" size={18} /></span>
                <div class="mic-access-body">
                  <p class="mic-access-title">Let Speaking Glass hear you</p>
                  <p class="mic-access-text">
                    {micRequesting ? os.micRequestPending : os.micAskIntro}
                  </p>
                  <div class="row-actions">
                    <Button variant="primary" disabled={micRequesting} onclick={() => allowMicrophone()}>
                      Allow and choose microphone
                    </Button>
                  </div>
                </div>
              </div>
            {:else if micAccess === 'restricted'}
              <div class="mic-access warn" data-search-row>
                <span class="mic-access-icon"><Icon name="alert" size={18} /></span>
                <div class="mic-access-body">
                  <p class="mic-access-title">{os.micRestrictedTitle}</p>
                  <p class="mic-access-text">{os.micRestrictedText}</p>
                  <div class="row-actions">
                    <Button onclick={() => void openMicrophonePrivacySettings()}>{os.openMicrophoneSettings}</Button>
                    <Button disabled={micRequesting} onclick={() => allowMicrophone()}>Try again</Button>
                  </div>
                </div>
              </div>
            {:else if micAccess === 'granted' && micRetryRefused}
              <div class="mic-access warn" data-search-row>
                <span class="mic-access-icon"><Icon name="refresh" size={18} /></span>
                <div class="mic-access-body">
                  <p class="mic-access-title">{os.micAllowedButRefusedTitle}</p>
                  <p class="mic-access-text">{os.micAllowedButRefusedText}</p>
                  <div class="row-actions">
                    <Button disabled={micRequesting} onclick={() => allowMicrophone()}>Try again</Button>
                  </div>
                </div>
              </div>
            {:else if micAccess === 'granted'}
              <div class="mic-access good" data-search-row>
                <span class="mic-access-icon"><Icon name="check" size={18} /></span>
                <div class="mic-access-body">
                  <p class="mic-access-title">Microphone access is on</p>
                  <p class="mic-access-text">{os.micAllowedText}</p>
                  <div class="row-actions">
                    <Button variant="primary" disabled={micRequesting} onclick={() => allowMicrophone()}>
                      Use the microphone
                    </Button>
                  </div>
                </div>
              </div>
            {:else}
              <div class="mic-access warn" data-search-row>
                <span class="mic-access-icon"><Icon name="alert" size={18} /></span>
                <div class="mic-access-body">
                  <p class="mic-access-title">
                    {micRetryRefused ? 'Microphone access is still off' : 'Microphone access is off'}
                  </p>
                  <p class="mic-access-text">
                    {os.micDeniedText}
                    {#if micRetryRefused}
                      {os.micDeniedRetryText}
                    {/if}
                  </p>
                  <!-- Where, as its own line: a path is one name, and set
                       inside the sentence it broke at the arrow or inside
                       "Privacy &". Absent where there is no one place to name. -->
                  {#if os.microphoneSettingsPath}
                    <p class="mic-path">{os.microphoneSettingsPath}</p>
                  {/if}
                  <div class="row-actions">
                    <Button variant="primary" onclick={() => void openMicrophonePrivacySettings()}>
                      {os.openMicrophoneSettings}
                    </Button>
                    <Button disabled={micRequesting} onclick={() => allowMicrophone()}>Try again</Button>
                  </div>
                </div>
              </div>
            {/if}
          {:else}
            <!--
              The setup is one sequence — choose, check, confirm — and reads
              top to bottom in that order. Each block keeps its height whatever
              state it is in, so nothing below it moves while you are using it.
            -->
            <div class="mic-flow" style="--settings-control-w: 320px">
              <div class="mic-input">
                <Select
                  layout="row"
                  label="Input device"
                  description={micPickerDescription}
                  value={micSelectValue}
                  options={micOptions}
                  onchange={(value) => chooseMicrophone(value)}
                />
                {#if micPinned && micPinMissing}
                  <!--
                    The pin is kept, not quietly dropped: this is a microphone
                    that is coming back. But until it does, a DIFFERENT microphone
                    is the one a take opens, and that is the fact a presenter
                    must not discover on stage — so it is named, here, as a
                    warning rather than a footnote.
                  -->
                  <div class="mic-fallback">
                    <span class="mic-fallback-icon"><Icon name="alert" size={16} /></span>
                    <div class="mic-fallback-body">
                      <p class="mic-fallback-title">{micPinned.label} is not connected</p>
                      <p class="mic-fallback-text">
                        Takes, the level and the test use {micSystemDefaultLabel ?? os.defaultInput}
                        until it is back.
                        <button
                          type="button"
                          class="inline-link"
                          onclick={() => chooseMicrophone(SYSTEM_DEFAULT_OPTION)}
                        >
                          Use the system default instead
                        </button>
                      </p>
                    </div>
                  </div>
                {/if}
              </div>

              <MicMeter level={micLevel} paused={micTestRunning} />

              <!-- Pulled in a little: the fold's own padding plus the flow's gap
                   left the closed row floating between the meter and the test. -->
              <div class="mic-tuning-slot">
                {@render captureTuning()}
              </div>

              <!--
                Costs nothing but holds the microphone, so it can always be
                stopped and it closes itself if it is forgotten (see
                services/mic-test-session.ts for the two deadlines). One button,
                mounted throughout, so the hand and keyboard focus stay where
                they are when Test becomes Stop.
              -->
              <div class="mic-test" data-tone={micVerdict.tone} data-phase={micTest} data-search-row>
                <div class="mic-test-head">
                  <div class="mic-test-label">
                    <span class="mic-test-name">Transcription test</span>
                    <span class="mic-test-prompt" id="settings-mic-test-prompt">Say “{MIC_TEST_SENTENCE}”</span>
                  </div>
                  <!-- One slot that holds the wider label's width, so Stop lands
                       exactly where Test was pressed. Start and Stop are separate
                       buttons — the start always goes through
                       runTranscriptionTest and its wait for the meter — and focus
                       is carried from one to the other (see `micTestSlot`). -->
                  <div class="mic-test-button" bind:this={micTestSlot}>
                    {#if micTestRunning}
                      <Button onclick={() => stopTranscriptionTest()}>
                        <span class="mic-stop-glyph" aria-hidden="true"></span>
                        Stop test
                      </Button>
                    {:else}
                      <Button describedby={MIC_TEST_DESCRIPTION_IDS} onclick={() => void runTranscriptionTest()}>
                        <Icon name="mic" size={14} />
                        Test transcription
                      </Button>
                    {/if}
                  </div>
                </div>
                <div class="mic-test-well">
                  <div class="mic-test-verdict-row">
                    <p class="mic-test-verdict" role="status" aria-atomic="true">
                      {#if micVerdict.tone === 'live'}
                        <span class="mic-test-dot" aria-hidden="true"></span>
                      {:else if micVerdict.icon}
                        <span class="mic-test-icon" aria-hidden="true">
                          <Icon name={micVerdict.icon} size={14} />
                        </span>
                      {/if}
                      <span>{micVerdict.text}</span>
                      {#if micVerdictDetail}<span class="visually-hidden">. {micVerdictDetail}</span>{/if}
                    </p>
                    {#if micTestNeedsSpeech}
                      <Button size="sm" onclick={() => navigate({ name: 'settings', section: 'speech' })}>
                        Open Speech settings
                      </Button>
                    {/if}
                  </div>
                  <!-- Two lines are reserved, which holds the test sentence and
                       every message; only an unusually long utterance grows it. -->
                  <p class="mic-test-words {micTestWords.kind}">{micTestWords.text}</p>
                </div>
                <p class="mic-test-note" id="settings-mic-test-note">
                  Stops by itself after 30 seconds with nothing transcribed, or after two minutes at
                  most.
                </p>
              </div>
            </div>
          {/if}
          {#if micError && micError !== micTestError}
            <p class="inline-alert" role="alert">{micError}</p>
          {/if}
          <p class="mic-privacy" data-search-row>
            <span class="mic-privacy-icon"><Icon name="info" size={14} /></span>
            <span>
              Speech is transcribed on {os.thisDevice} and never recorded, saved or uploaded. Speaking Glass
              uses the microphone during a test or a take, and while the input meter is on screen —
              which measures loudness and nothing else.
            </span>
          </p>
          {#if micPermission !== 'granted'}
            {@render captureTuning()}
          {/if}
        </Section>
      {:else if section === 'stage'}
        <!--
          What this section controls (#302).

          The pinned panel is where a prompter take opens: Present moves the
          Speaking Glass window onto it (`windows/present.rs`). With Automatic, or
          with the pinned panel unplugged, the take fills whichever monitor the
          Speaking Glass window is on instead. That is the rule `takeDisplay`
          states, and every sentence here comes from it — this copy once
          described a rule Present had stopped following, and the Automatic
          tile named an external display the take never opened on.

          Previews, the display test and calibration are aimed separately
          (`effectiveDisplay`), which only matters when the two disagree: the
          unplugged-pin alert names both.
        -->
        <Section
          title="Prompter display and rigs"
          description="Where takes open and how they present. The editor's Present button names the display a take will use."
        >
          {#snippet actions()}
            <Button size="sm" disabled={displaysLoading} onclick={() => void loadDisplays()}>
              {displaysLoading ? 'Checking…' : 'Check again'}
            </Button>
          {/snippet}
          <!-- One grid of equal tiles. They were content-sized and wrapped,
               so the third display fell onto a row of its own beside a wide
               empty gap, and no two tiles were the same width. -->
          <div class="display-grid" data-search-row>
            <button
              type="button"
              class="monitor-tile"
              class:selected={chosenFingerprint === null}
              aria-pressed={chosenFingerprint === null}
              onclick={() => void chooseDisplay(null)}
            >
              <span class="monitor-head">
                <span class="monitor-glyph"><Icon name="monitor" size={20} /></span>
              </span>
              <span class="monitor-name">Automatic</span>
              <!-- Automatic is not a panel, so it carries no number of its
                   own; it names the number of the one it resolves to, which
                   is wherever the Speaking Glass window is. -->
              <span class="monitor-meta">
                {automaticDisplay
                  ? `Currently display ${numbers.get(automaticDisplay.fingerprint)}${automaticDisplay.name ? `\u00a0·\u00a0${unbroken(automaticDisplay.name)}` : ''}`
                  : 'The display the Speaking Glass window is on'}
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
                <!-- The number Identify displays puts on this panel. A sibling
                     of the name, never inside it: the name is what the tile is
                     found by, and two identical monitors share it. -->
                <span class="monitor-head">
                  <span class="monitor-glyph"><Icon name="monitor" size={20} /></span>
                  <span class="monitor-number">
                    <!-- An expression, because Svelte trims a literal
                         trailing space and the name would read "Display2". -->
                    <span class="visually-hidden">{'Display '}</span>{numbers.get(display.fingerprint)}
                  </span>
                </span>
                <span class="monitor-name">{display.name ?? 'Display'}</span>
                <span class="monitor-meta">
                  {display.physicalSize.width} × {display.physicalSize.height} · {display.scaleFactor}×
                </span>
                {#if display.primary}
                  <span class="monitor-badges">
                    <StatusPill tone="neutral" size="sm" dot={false} label="Primary" />
                  </span>
                {/if}
              </button>
            {/each}
            {#if pinnedMissing}
              <!-- The choice the user made stays on screen, selected, while
                   its panel is away — rather than vanishing and leaving a
                   picker with nothing chosen. Not a button: there is nothing
                   to choose until it is back. -->
              <div class="monitor-tile selected missing" aria-current="true">
                <span class="monitor-head">
                  <span class="monitor-glyph"><Icon name="monitor" size={20} /></span>
                </span>
                <span class="monitor-name">Your chosen display</span>
                <span class="monitor-meta">Not connected</span>
              </div>
            {/if}
          </div>
          {#if pinnedMissing}
            <!-- Said here rather than discovered at Present: the fingerprint
                 is panel identity, so a display that is unplugged simply stops
                 matching. Both fallbacks are named, because they differ — the
                 take goes where the Speaking Glass window is, previews prefer an
                 external display. A notice in the house warning shape, not a
                 bold red paragraph: nothing failed, a panel is unplugged. -->
            <div class="notice" role="alert" data-search-row>
              <span class="notice-icon"><Icon name="alert" size={16} /></span>
              <p class="notice-text">
                <strong>Your chosen display is not connected.</strong> Until it is back, prompter
                takes open on {windowPanel}, and previews, tests and calibration use {effectiveDisplay
                  ? displayName(effectiveDisplay)
                  : 'another display'}.
              </p>
            </div>
          {/if}
          {#if targetsSplit}
            <p class="hint-line target-note" data-search-row>
              Takes open on <strong
                >{takeDisplay.display ? displayName(takeDisplay.display) : windowPanel}</strong
              >. Tests and calibration
              use <strong>{displayName(effectiveDisplay)}</strong>, so a preview never covers the
              editor.
            </p>
          {/if}
          <div class="row-actions" data-search-row>
            <Button disabled={identifying} onclick={() => void identifyDisplays()}>Identify displays</Button>
            <!-- Named by the number Identify paints on the panel, which is short
                 at any monitor name and is the one the tiles carry. -->
            <Button disabled={!effectiveDisplay || stageTesting} onclick={() => void runDisplayTest()}>
              {stageTesting
                ? 'Opening…'
                : effectiveDisplay && numbers.has(effectiveDisplay.fingerprint)
                  ? `Show test on display ${numbers.get(effectiveDisplay.fingerprint)}`
                  : 'Show test on this display'}
            </Button>
          </div>
          {#if displaysError}
            <p class="inline-alert" role="alert">{displaysError}</p>
          {/if}
          <!--
            How the text on this panel is sized, in one line, with a way down to
            it. The sizing is what somebody returning mid-take comes to change,
            and "This rig" starts a screenful below the picker; this line puts
            the answer at the top and the controls one click away.
          -->
          {#if rigFingerprint !== null && rigOptics}
            <p class="sizing-summary" data-search-row>
              <span>
                Prompter text on <strong>{effectiveDisplay?.name ?? 'this display'}</strong>:
                {#if appliedRig}
                  the “{appliedRig.rigName}” rig, {Math.round(rigOptics.bodyFontSizePx)} px{rigOptics.charactersPerLine === null
                    ? ''
                    : `, about ${Math.round(rigOptics.charactersPerLine)} characters a line`}.
                {:else if automaticRig}
                  sized automatically, {Math.round(rigOptics.bodyFontSizePx)} px{rigOptics.charactersPerLine === null
                    ? ''
                    : `, about ${Math.round(rigOptics.charactersPerLine)} characters a line`}.
                {:else}
                  the {$settings.teleprompter.fontSizePx} px fallback — this display is not sized by distance.
                {/if}
              </span>
              <button type="button" class="inline-link" onclick={() => jumpToRig()}>
                {appliedRig || automaticRig ? 'Adjust sizing' : 'Calibrate'}
              </button>
            </p>
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
          <div class="mode-grid" data-search-row>
            <button
              type="button"
              class="monitor-tile"
              class:selected={$settings.stage.presentationMode === 'prompter'}
              aria-pressed={$settings.stage.presentationMode === 'prompter'}
              onclick={() => void patchSettings('stage', { presentationMode: 'prompter' })}
            >
              <span class="mode-head">
                <span class="monitor-glyph"><Icon name="monitor" size={18} /></span>
                <span class="monitor-name">Teleprompter</span>
              </span>
              <span class="monitor-meta">
                Fills the prompter display, above everything, for reading off glass at a distance.
              </span>
            </button>
            <button
              type="button"
              class="monitor-tile"
              class:selected={$settings.stage.presentationMode === 'reader'}
              aria-pressed={$settings.stage.presentationMode === 'reader'}
              onclick={() => void patchSettings('stage', { presentationMode: 'reader' })}
            >
              <span class="mode-head">
                <span class="monitor-glyph"><Icon name="book-open" size={18} /></span>
                <span class="monitor-name">Reading window</span>
              </span>
              <span class="monitor-meta">
                Stays a window you can size and move. Wider lines, desk distance, never mirrored.
              </span>
            </button>
          </div>
          <p class="hint-line">
            Either way, {presentationModeShortcutLabel()} switches between them during a take.
          </p>
          <!-- One column. In a two-column grid Vertical mirror landed under
               Always on top, away from the Horizontal mirror it pairs with. -->
          <div class="toggle-list">
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
                ? 'Always on — the teleprompter must sit above other windows.'
                : 'Off for a reading window, so you can work beside it.'}
            />
            <!-- Per panel (#206): these describe the glass in front of the
                 display named above, and a take on any other display ignores
                 them. -->
            <Toggle
              checked={panelMirror.horizontal}
              disabled={!rigFingerprint}
              label="Horizontal mirror"
              description={effectiveDisplay
                ? `For the glass in front of ${effectiveDisplay.name}. Each display keeps its own mirroring.`
                : 'Connect a display to set how it is mirrored.'}
              onchange={(value) => setPanelMirror('horizontal', value)}
            />
            <Toggle
              checked={panelMirror.vertical}
              disabled={!rigFingerprint}
              label="Vertical mirror"
              onchange={(value) => setPanelMirror('vertical', value)}
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
          opens showing what Speaking Glass worked out on its own, every derived
          value can be pinned, and every pinned value says so and offers its way
          back to automatic.
        -->
        <Section
          id={RIG_SECTION_ID}
          title="This rig"
          description={`How the text on ${effectiveDisplay?.name ?? 'the panel above'} is sized — from how far away you stand, not a pixel default.`}
        >
          <!--
            One button used to sit here and it always started a NEW rig.

            `calibrate()` with no argument mints a name no stored rig is using,
            which is right for measuring a second arrangement and wrong for
            everything else. Somebody with "Desk hood" applied who pressed the
            most prominent button on the panel got "Desk hood 2" — a second rig
            they did not ask for, leaving the one they meant to adjust untouched.
            The row-level "Re-calibrate" already did the right thing, but it is
            not where the eye goes.

            So the primary action now names the rig it will change, and measuring
            another stays reachable beside it. Both paths matter: one panel
            legitimately holds several rigs, and the store keys on (panel, name),
            so the two must never be the same button.
          -->
          {#snippet actions()}
            <!-- Not while searching: a search that found one Advanced row has
                 nothing to do with recalibrating, and the two buttons stood
                 over the single match. -->
            {#if sectionQuery.trim() !== ''}
              <!-- nothing -->
            {:else if appliedRig}
              <!-- The full name is in the tooltip; the label ellipsizes rather
                   than dictate the width of the panel. A discovered rig is
                   named for how it was identified ("Elgato Prompter (9-inch)
                   (identified by its 1024 x 600 panel)"), which is a sentence,
                   not a button. -->
              <Button
                size="sm"
                title={`Re-calibrate ${appliedRig.rigName}`}
                onclick={() => calibrate(appliedRig.rigName)}
              >
                <span class="rig-action-label">Re-calibrate {appliedRig.rigName}…</span>
              </Button>
              <Button size="sm" variant="ghost" onclick={() => calibrate()}>
                Measure another rig…
              </Button>
            {:else}
              <Button size="sm" disabled={!rigFingerprint} onclick={() => calibrate()}>
                Calibrate…
              </Button>
            {/if}
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
              <div class="rig-list" data-search-row>
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
                        <!-- Not `completedSteps.length` against a literal 8.
                             That counted tokens rather than answers, so a rig
                             with no measured scale still read "8 of 8" — done,
                             with the one number every angular result is
                             multiplied by never taken. See lib/optical-calibration.ts. -->
                        · {describeCalibrationProgress(entry.profile)}
                      </span>
                    </button>
                    <div class="row-actions">
                      <Button size="sm" onclick={() => calibrate(entry.profile.rigName)}>
                        Re-calibrate
                      </Button>
                      <!-- Deletes measurements (after a confirmation), so it
                           wears the low-emphasis danger treatment rather than
                           the neutral one Re-calibrate beside it has. -->
                      <Button
                        size="sm"
                        variant="danger"
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
              <!-- Automatic sizing: what an unrigged panel actually prompts at.
                   The same discovery a take runs (`prompterOpticalProfile`),
                   so the readout below is the next take's geometry, not a
                   proposal. -->
              <p class="rig-lead">
                {#if automaticRig === null}
                  <strong>Using the {$settings.teleprompter.fontSizePx} px fallback.</strong>
                  {discovered.identification.confidence === 'unknown'
                    ? 'Speaking Glass does not recognise this panel and it does not report its size'
                    : `Speaking Glass recognised ${discovered.identification.label} but cannot assume its size`},
                  so it cannot size text by distance until you calibrate it.
                {:else}
                  <strong>Sized automatically</strong> for {discovered.identification.label}, assuming
                  you stand about {(automaticRig.viewingDistanceMm ?? 0) / 1000} m away. Changing
                  anything below except the size balance — or calibrating — stores a rig for this
                  display, and measuring the real distance is what turns the size from an estimate
                  into a measurement.
                {/if}
              </p>
            {/if}

            <!-- The resolved answer, live. This is what makes the maths
                 trustworthy: it is the same `resolveStageGeometry` a take runs
                 through, against the same panel, so it cannot describe a stage
                 the take would not produce. -->
            {#if rigOptics}
              <!-- "arcmin", spelt out: a bare prime read as feet at this size. -->
              <div class="readout">
              <dl class="readout-list">
                <div class="readout-row">
                  <dt class="readout-label">Body text</dt>
                  <dd class="readout-value">
                    {Math.round(rigOptics.bodyFontSizePx)} px
                    {#if rigOptics.bodyArcminutes !== null}
                      · {rigOptics.bodyArcminutes.toFixed(0)} arcmin cap height
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
              <!-- True of every visit: this window does not render the stage
                   font, so these are proportions, and a take measures. -->
              <p class="readout-note">
                What takes on this display open with — estimated here from standard font
                proportions; a take measures the stage font itself.
              </p>
              </div>
              {#each rigWarnings as warning (warning)}
                <p class="hint-line">{warning}</p>
              {/each}
            {/if}

            <!-- Distance. The one fact that genuinely cannot be discovered, and
                 the one every angular result is multiplied by. -->
            <div class="control-block">
              <span class="control-label">Viewing distance</span>
              <div class="distance-row">
                <SegmentedControl
                  label="Viewing distance"
                  size="sm"
                  value={rig.viewingDistanceMm === null ? '' : String(rig.viewingDistanceMm)}
                  options={distanceOptions}
                  onchange={(value) => void updateRig({ viewingDistanceMm: Number(value) })}
                />
                <span class="distance-other">
                  <input
                    class="distance-input"
                    type="text"
                    inputmode="decimal"
                    placeholder="Other"
                    aria-label="Other viewing distance, in metres"
                    value={distanceField}
                    oninput={(event) => (distanceField = event.currentTarget.value)}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') applyTypedDistance();
                    }}
                  />
                  <span class="distance-unit" aria-hidden="true">m</span>
                </span>
                <Button disabled={distanceField.trim() === ''} onclick={() => applyTypedDistance()}>
                  Use
                </Button>
              </div>
              {#if rig.viewingDistanceMm !== null && rig.scale === null}
                <p class="hint-line">
                  This panel has no physical scale yet, so the distance changes nothing until it is
                  calibrated.
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
            <!--
              The one control on this panel that an UNRIGGED display can move
              without becoming a rigged one.

              Everything else here is a measurement, and editing a measurement
              is a statement that you measured it — so it stores a rig, which is
              what the copy above promises. This is not a measurement, it is a
              preference about type, and making it cost the presenter their
              automatic sizing was the reason a 9-inch panel could not simply be
              asked for a wider line.
            -->
            {#if appliedRig === null && automaticRig === null}
              <!--
                Nothing to balance. This panel cannot be sized at all, so it
                takes the flat fallback pixel size and the angular model never
                runs — a live slider here would move its thumb, change nothing
                on the glass in front of the presenter, and quietly restyle
                every OTHER automatic display they own.
              -->
              <!-- No line here: the lead above already says this display runs
                   at the fallback until it is calibrated, and a caption for a
                   control that is not drawn read as a caption for the distance
                   presets above it. -->
            {:else}
              <!-- Named, with its two ends under the track. The label used to be
                   both ends joined by a ⟷ that rendered as a subscript, and the
                   copy around it called the control "size balance" — a name
                   nothing on screen carried. -->
              <Slider
                label="Size balance"
                minLabel="More text on screen"
                maxLabel="Larger, easier text"
                value={Math.round((appliedRig ? rig.bias : automaticBias) * 100)}
                min={0}
                max={100}
                format={(v) => `${v}%`}
                spoken={(v) => `${v}% toward larger text`}
                description={appliedRig === null
                  ? 'Shared by every display Speaking Glass sizes automatically. A calibrated rig carries its own.'
                  : undefined}
                onchange={(value) =>
                  void (appliedRig
                    ? updateRig({ bias: value / 100 })
                    : patchSettings('teleprompter', { sizeBias: value / 100 }))}
              />
            {/if}

            <Select
              layout="row"
              label="How you are framed"
              description="Tighter framing asks for a narrower column, so eye movement stays invisible on camera."
              value={rig.framing}
              options={[
                { value: 'close-up', label: 'Close-up' },
                { value: 'head-and-shoulders', label: 'Head and shoulders' },
                { value: 'waist-up', label: 'Waist up' },
                { value: 'full-body', label: 'Full body' },
              ]}
              onchange={(value) => void updateRig({ framing: value as FramingPreset })}
            />

            <SettingRow label="Text intensity" description="How bright the words are on the glass.">
              {#snippet control(describedby)}
                <SegmentedControl
                  label="Text intensity for this rig"
                  {describedby}
                  value={rig.intensity}
                  options={[
                    { value: 'soft', label: 'Soft' },
                    { value: 'standard', label: 'Standard' },
                    { value: 'strong', label: 'Strong' },
                  ]}
                  onchange={(value) => void updateRig({ intensity: value as TextIntensity })}
                />
              {/snippet}
            </SettingRow>

            <SettingRow
              label="Reading cue"
              description="What marks the line you are reading: ticks in the margins, or the ticks with a soft band across the line."
            >
              {#snippet control(describedby)}
                <SegmentedControl
                  label="Reading cue for this rig"
                  {describedby}
                  value={rig.readingCue}
                  options={[
                    { value: 'ticks', label: 'Ticks' },
                    { value: 'wash', label: 'Wash' },
                    { value: 'none', label: 'None' },
                  ]}
                  onchange={(value) => void updateRig({ readingCue: value as ReadingCueStyle })}
                />
              {/snippet}
            </SettingRow>

            <!--
              Every derived value, reachable.

              Behind a disclosure because almost nobody needs any of it, and
              present because the person standing at the glass can see something
              the maths cannot. Each row says whether it is automatic or set by
              hand, shows what automatic currently RESOLVES to rather than what
              the constant is, and offers its way back.
            -->
            <Disclosure
              label={pinnedCount === 0 ? 'Advanced' : `Advanced — ${pinnedCount} set by hand`}
              bind:open={advancedOpen}
            >
              {#if pinnedCount > 0}
                <div class="row-actions" data-search-row>
                  <Button size="sm" onclick={() => void clearAllOverrides()}>
                    Reset everything to automatic
                  </Button>
                </div>
              {/if}

              <p class="hint-line">
                Each value follows the optical model until you move it; a moved value says <em
                  >Set by you</em
                > and can be reset. The model still runs, so if a size you pin costs the reading
                measure, the readout above says so.
              </p>

              <!-- Each group is one block, so a search that matches nothing in it
                   takes its heading away too instead of leaving it standing over
                   nothing. -->
              <div class="advanced-group">
              <h4 class="advanced-head">Size and measure</h4>
              {@render override('fontSizePx', 'Text size', MIN_RENDERABLE_FONT_SIZE_PX, ADVANCED_FONT_SIZE_CEILING_PX, 1, (v) => `${Math.round(v)} px`)}
              {@render override('arcminutes', 'Apparent cap height', ANGULAR_HARD_FLOOR_ARCMIN, 60, 0.5, (v) => `${v.toFixed(1)} arcmin`)}
              {@render override('characters', 'Characters per line', READING_MEASURE.hardFloor, READING_MEASURE.bandMax, 1, (v) => `${Math.round(v)}`)}
              {@render override('columnCh', 'Column width', 8, 80, 0.5, (v) => `${v.toFixed(1)} ch`, (v) => `${v.toFixed(1)} character widths`)}
              {@render override('maxColumnFraction', 'Widest the column may go', 0.1, 1, 0.01, (v) => `${Math.round(v * 100)}% of the safe width`)}
              </div>

              <div class="advanced-group">
              <h4 class="advanced-head">Typography</h4>
              {@render override('lineHeight', 'Line height', 1, 2, 0.01, (v) => v.toFixed(2))}
              {@render override('fontWeight', 'Weight', 300, 800, 50, (v) => String(Math.round(v)))}
              {@render override('letterSpacingEm', 'Letter spacing', -0.02, 0.08, 0.005, (v) => `${v.toFixed(3)} em`)}
              {@render override('paragraphSpacingEm', 'Paragraph spacing', 0, 2, 0.05, (v) => `${v.toFixed(2)} em`)}
              </div>

              <div class="advanced-group">
              <h4 class="advanced-head">Vertical geometry</h4>
              <p class="hint-line">
                Measured in lines, not pixels, so each means the same on a 600 px panel and a 1080 px
                one.
              </p>
              {@render override('deadZoneLines', 'Reading corridor', 0.3, 2, 0.02, (v) => `${v.toFixed(2)} lines`)}
              {@render override('topFadeLines', 'Fade above', 0, 4, 0.05, (v) => `${v.toFixed(2)} lines`)}
              {@render override('bottomFadeLines', 'Fade below', 0, 4, 0.05, (v) => `${v.toFixed(2)} lines`)}
              {@render override('futureReserveLines', 'Script kept below the band', 0, 10, 0.25, (v) => `${v.toFixed(2)} lines`)}
              {@render override('sentenceMicrogapLines', 'Gap after a sentence', 0, 1, 0.05, (v) => `${v.toFixed(2)} lines`)}
              </div>

              <div class="advanced-group">
              <h4 class="advanced-head">Treatment</h4>
              {@render override('pastOpacity', 'Spoken text', 0.15, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
              {@render override('futureOpacity', 'Upcoming text', 0.3, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
              {@render override('secondaryMinPx', 'Smallest readable label', 8, 120, 1, (v) => `${Math.round(v)} px`)}
              {@render override('lensOffsetDegrees', 'Reading band below the lens', -3, 3, 0.1, (v) => `${v.toFixed(1)}°`, (v) => `${v.toFixed(1)} degrees`)}
              <p class="hint-line">
                A small downward offset can read as more direct on camera than the exact centre of
                the lens. It needs a physical scale, so an uncalibrated rig leaves it out rather than
                guess.
              </p>
              </div>
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
        <!--
          An automatic row shows its value once, in the slider's own readout.
          It used to repeat it underneath ("Automatic · 1.38") on every one of
          eighteen rows, so the panel read twice as long as it was and the one
          row somebody HAD changed looked like all the others. Now only a moved
          value carries a line, with its way back.
        -->
        {#snippet override(
          key: keyof OpticalOverrides,
          label: string,
          min: number,
          max: number,
          step: number,
          format: (value: number) => string,
          spoken?: (value: number) => string,
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
              {spoken}
              onchange={(value) => void setOverride(key, value)}
            />
            {#if pinned}
              <div class="override-state">
                <span class="override-tag">
                  {applied ? 'Set by you' : 'Set by you — same as automatic'}
                </span>
                <!-- No number: with a pin in place the resolver's answer IS the
                     pin, so "(58 px)" named the value being reset, not the one
                     it resets to. -->
                <button type="button" class="inline-link" onclick={() => void setOverride(key, null)}>
                  Reset to automatic
                </button>
              </div>
            {/if}
          </div>
        {/snippet}
      {:else if section === 'teleprompter'}
        <!--
          One appearance slider, with the two things every one of them was
          missing: what the default is, and who owns the value right now.

          It deliberately mirrors the rig `override` snippet above rather than
          reusing it — that one is keyed on `rig.overrides` and resets to an
          automatic value the resolver recomputes, while these are flat
          `teleprompter` fields resetting to a fixed constant. Same vocabulary,
          different data path; sharing the implementation would mean one snippet
          that had to ask which kind of setting it was holding.

          `rigOwned` is the honest part. With a rig applied, `resolveStageGeometry`
          decides size, line height, column and band from a measured distance and
          `buildStageSettings` writes its answer over these same fields — so the
          control is inert and says so, naming the rig that took it. The reset
          row is hidden in that state rather than disabled: offering to restore a
          default that would not be used either is a second dead control under
          the first.
        -->
        {#snippet appearanceSlider(
          key: AppearanceSliderKey,
          label: string,
          min: number,
          max: number,
          step: number,
          format: (value: number) => string,
          rigOwned: boolean,
          describedby?: string,
        )}
          {@const value = $settings.teleprompter[key]}
          {@const defaultValue = APPEARANCE_DEFAULTS[key]}
          {@const owner = rigOwned ? geometryOwner : null}
          {@const owned = owner !== null}
          {@const atDefault = value === defaultValue}
          <div class="override">
            <Slider
              {label}
              {value}
              {min}
              {max}
              {step}
              {format}
              disabled={owned}
              {describedby}
              onchange={(next) => void patchSettings('teleprompter', { [key]: next })}
            />
            <!-- A value at its default says nothing: the readout already shows
                 it, and "Default · 64 px" under "64 px" was the same number
                 twice. A moved value says so and offers the way back. -->
            {#if !owned && !atDefault}
              <div class="override-state">
                <span class="override-tag">Set by you</span>
                <button
                  type="button"
                  class="inline-link"
                  onclick={() => void patchSettings('teleprompter', { [key]: defaultValue })}
                >
                  Reset to default ({format(defaultValue)})
                </button>
              </div>
            {/if}
          </div>
        {/snippet}
        <Section title="Teleprompter">
          <!--
            The controls below describe the glass, so they are set at the glass.
            Sizes and positions on a prompter are angles from where the presenter
            stands, and no number on a laptop at arm's length can be judged as
            one. The reading band especially: it wants to sit over the lens, and
            that is an alignment somebody performs by watching it move.
          -->
          <div class="preview-row" data-search-row>
            <Button
              variant={stagePreview ? 'default' : 'primary'}
              disabled={stagePreviewBusy || displays.length === 0}
              onclick={() => void toggleStagePreview()}
            >
              {stagePreview ? 'Stop preview' : 'Show on teleprompter'}
            </Button>
            <!--
              "Everything below updates it as you drag" was the sentence this
              screen's whole defect hid behind: with a rig applied it is false
              for the four geometry sliders, and it was making the promise at
              the exact moment the preview was running to be believed.
            -->
            <p class="hint-line preview-note">
              <!-- Where the sample is and who sizes it — no promise about which
                   of the rows below it follows. "Everything" was false for the
                   geometry a rig owns, "the rest" for an intensity a rig
                   overrides and for the reading window's own appearance. -->
              {#if stagePreview && geometryOwner}
                Sample text is on <strong>{effectiveDisplay?.name ?? 'the stage display'}</strong>.
                Size, line height, column width and reading band come from
                <strong>{geometryOwner.label}</strong>.
              {:else if stagePreview}
                Sample text is on <strong>{effectiveDisplay?.name ?? 'the stage display'}</strong>.
              {:else if displays.length === 0}
                No displays detected — connect the teleprompter and open Prompter display and rigs.
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
          <!-- "(bundled)" left the option name for the description: in the
               220px column it clipped the name mid-word ("…(bunc"). -->
          <Select
            layout="row"
            label="Default font family"
            description={$settings.teleprompter.fontFamilyId === 'high-legibility'
              ? 'Bundled with Speaking Glass, and drawn to keep I, l and 1 — and 0 and O — apart at a distance.'
              : 'Atkinson Hyperlegible is bundled and drawn for reading at a distance.'}
            value={$settings.teleprompter.fontFamilyId}
            options={[
              { value: 'high-legibility', label: 'Atkinson Hyperlegible' },
              { value: 'system-sans', label: 'System Sans' },
              { value: 'humanist-sans', label: 'Humanist Sans' },
              { value: 'serif', label: 'Serif' },
              { value: 'monospace', label: 'Monospace' },
            ]}
            onchange={(value) => void patchSettings('teleprompter', { fontFamilyId: value })}
          />
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
          <!-- It had no visible label at all, and stretched the width of the
               column with its three segments bunched at one end. -->
          <!-- "Default", like the font family and size around it: on a display
               with a calibrated rig the rig's own intensity is the one in force,
               and the row says which rig and what it is. -->
          <SettingRow
            label="Default text intensity"
            description={appliedRig && $settings.stage.presentationMode === 'prompter'
              ? `${appliedRig.rigName} on ${effectiveDisplay?.name ?? 'this display'} uses its own (${INTENSITY_LABELS[appliedRig.intensity]}). This is for displays without a rig, and for reading windows until you set one in Reading appearance.`
              : 'How bright the words are on the stage. A calibrated rig keeps its own; reading windows use this until you set one in Reading appearance.'}
          >
            {#snippet control(describedby)}
              <SegmentedControl
                label="Text intensity"
                {describedby}
                value={$settings.teleprompter.textIntensity}
                options={[
                  { value: 'soft', label: 'Soft' },
                  { value: 'standard', label: 'Standard' },
                  { value: 'strong', label: 'Strong' },
                ]}
                onchange={(value) =>
                  void patchSettings('teleprompter', { textIntensity: value as TextIntensity })}
              />
            {/snippet}
          </SettingRow>
          <!--
            The one field choice there is, and it is a reading window's.

            A prompter stays black whatever this says — a bright field pours
            light onto the beamsplitter — so the control names the surface it
            reaches rather than pretending to be a stage background. Reading
            appearance offers the same choice during a read, and its Done saves
            here. Absent means Dark: nothing is written until somebody picks.
          -->
          <SettingRow
            label="Reading window appearance"
            description="Light text on black, or dark text on warm paper. A teleprompter always stays black."
          >
            {#snippet control(describedby)}
              <SegmentedControl
                label="Reading window appearance"
                {describedby}
                value={readerThemeFor($settings.teleprompter)}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'paper', label: 'Paper' },
                ]}
                onchange={(value) =>
                  void patchSettings('teleprompter', {
                    readerTheme: (value === 'paper' ? 'paper' : 'dark') satisfies ReaderTheme,
                  })}
              />
            {/snippet}
          </SettingRow>
          <!--
            Who owns the four geometry sliders, said ONCE, above them, with the
            way to the owner beside it. It used to be the same two-line sentence
            under each of the four, with the link after the last of them. Each
            slider still names its owner in one short line. The note and the
            four share one well, so they read as the one group they are rather
            than as four rows somebody forgot to switch on.

            On the uncalibrated path nothing owns them, and the note says what
            they are instead: the fallback — and, for the band, how to set it.
          -->
          <div class="geometry-group" data-search-row>
          <div class="geometry-note">
            {#if geometryOwner && readerOwnsGeometry}
              <p class="geometry-note-text" id={GEOMETRY_NOTE_ID}>
                <strong>A reading window sets its own text.</strong> During a read, use Reading
                appearance; {readerSizeKeys} change the size. These four are the teleprompter's
                fallback.
              </p>
            {:else if geometryOwner}
              <p class="geometry-note-text" id={GEOMETRY_NOTE_ID}>
                <strong>Size, line height, column width and reading band come from {geometryOwner.label}</strong
                > on {effectiveDisplay?.name ?? 'this display'}. These four are only the fallback for a
                display Speaking Glass cannot size.
              </p>
              <button type="button" class="inline-link" onclick={() => void openGeometryOwner()}>
                {geometryOwner.toRig ? `Open ${geometryOwner.label}` : 'Open prompter displays'}
              </button>
            {:else}
              <p class="geometry-note-text" id={GEOMETRY_NOTE_ID}>
                <strong>These four are the fallback</strong> for a display Speaking Glass can neither
                recognise nor measure. With the preview running, drag Reading band position until the
                marks at the sides of the stage sit over your camera lens — or calibrate the display
                for a crosshair that does it for you.
              </p>
            {/if}
          </div>
          <!--
            The ceiling was 160px, which is not a taste limit — it was short of
            what the product's own hardware needs. A Prompter XL at its rated
            4.6 m wants roughly 234px for a comfortable angular size, so this
            control could not reach a legible size on a rig Speaking Glass ships
            knowledge of, and the operator had no way to tell that the slider
            had run out rather than the display.
          -->
          {@render appearanceSlider(
            'fontSizePx',
            'Default font size',
            MIN_FONT_SIZE_PX,
            sizeCeilingPx,
            1,
            (v) => `${v} px`,
            true,
            GEOMETRY_NOTE_ID,
          )}
          <!-- Bounds from APPEARANCE_LIMITS, not literals: the in-session sheet
               sets these same four values, and a range that lives on one screen
               is a range that drifts from the other. -->
          {@render appearanceSlider(
            'lineHeight',
            'Line height',
            APPEARANCE_LIMITS.lineHeight.min,
            APPEARANCE_LIMITS.lineHeight.max,
            APPEARANCE_LIMITS.lineHeight.step,
            (v) => v.toFixed(2),
            true,
            GEOMETRY_NOTE_ID,
          )}
          {@render appearanceSlider(
            'columnWidthPercent',
            'Text column width',
            APPEARANCE_LIMITS.columnWidthPercent.min,
            APPEARANCE_LIMITS.columnWidthPercent.max,
            1,
            (v) => `${v}%`,
            true,
            GEOMETRY_NOTE_ID,
          )}
          {@render appearanceSlider(
            'readingBandCenterPercent',
            'Reading band position',
            APPEARANCE_LIMITS.readingBandCenterPercent.min,
            APPEARANCE_LIMITS.readingBandCenterPercent.max,
            1,
            (v) => `${v}%`,
            true,
            GEOMETRY_NOTE_ID,
          )}
          </div>
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
          <!-- Not rig-owned: a calibrated rig decides geometry, not pace. So
               this one stays live whatever is applied. -->
          {@render appearanceSlider(
            'fixedSpeedWpm',
            'Auto-scroll pace',
            AUTO_SCROLL_MIN_WPM,
            AUTO_SCROLL_MAX_WPM,
            1,
            (v) => `${v} wpm`,
            false,
            AUTOSCROLL_HINT_ID,
          )}
          <p class="hint-line" id={AUTOSCROLL_HINT_ID}>
            Rolls the script at this pace when your voice is not getting through. During a take,
            <kbd>A</kbd> starts and stops it, and <kbd>[</kbd> <kbd>]</kbd> change the pace; voice
            following pauses while it runs.
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
          <Toggle
            checked={$settings.teleprompter.semanticLineBreaks}
            label="Break lines at phrase boundaries"
            description="Ends each line where a phrase ends, in columns of about 48 characters or more — most reading windows. Narrower columns, like an automatically sized prompter, wrap normally either way."
            onchange={(value) => void patchSettings('teleprompter', { semanticLineBreaks: value })}
          />
          <!-- #218 removed "When a session ends" and "Hide the pointer on the
               stage". Nothing read the first, and a take runs in the control
               window, so there is no stage window for it to close. The stage
               hides the pointer 1.5 s after it stops moving whatever the second
               said. -->
          <!-- The only writer of `diagnosticTake` (#300), and it reaches a take
               that is already running through `installLiveSettingsFollow`.
               Named for what it changes on the stage, because two other
               controls already say "diagnostics" and neither touches it. -->
          <Toggle
            checked={$settings.teleprompter.diagnosticTake}
            label="Diagnostic Take"
            description="Adds the follow engine's readouts and the raw transcript to the stage, and shows tables, code and images in full rather than as cues. For checking a rig or a script that will not follow."
            onchange={(value) => void patchSettings('teleprompter', { diagnosticTake: value })}
          />
        </Section>
      {:else if section === 'following'}
        <Section
          title="Following"
          description="How quickly the stage follows your voice. Section jumps and retakes keep their safety rules whatever you pick."
        >
          <FollowSettingsFields
            following={$settings.following}
            onchange={(patch) => void patchSettings('following', patch)}
          />
        </Section>
      {:else}
        <Section title="Data, privacy & updates">
          <!--
            The tasks first, then the statements. Four paragraphs of privacy
            prose used to stand between the window and Export, so the one thing
            somebody opens this section to DO was a scroll away.
          -->
          <div class="privacy" data-search-row>
            <h3 class="privacy-head">Your data</h3>
            <p class="privacy-body">
              Scripts and their saved versions, imported images, settings, a history of your takes
              (when each ran and where it stopped) and diagnostic logs are kept on this computer.
              An export holds all of it, with a checksum per file, and can be restored.
            </p>
          </div>
          <!--
            "Export all scripts" was the honest name for what this used to
            do. It exports everything now — the database, the whole canonical
            scripts tree, and the settings and calibrations that used to be
            left out entirely — with a manifest and a checksum per file, so
            it can be restored rather than only looked at.

            Restore is the same weight as Export: it is half of the same job, not
            a lesser action. Clear logs moved to Diagnostics, where logs are.
          -->
          <div class="row-actions" data-search-row>
            <Button onclick={() => void runExportAllData()}>Export all data</Button>
            <Button onclick={() => void runRestoreAllData()}>Restore from export…</Button>
          </div>

          <!--
            A "Save session transcripts" row used to sit here (§36.2): Off, 1
            day, 7 days, 30 days or Forever, with a confirmation before a
            shorter window deleted anything. Takes stopped writing transcripts
            (#214), so it decided nothing and went with #215, along with the
            Speech settings line that pointed people at it. Rust still holds the
            field and sweeps what older builds kept until #217.
          -->
          <!-- One block per topic, so a search for "updates" keeps Updates
               and not every privacy paragraph with it. -->
          <div class="privacy" data-search-row>
            <h3 class="privacy-head">Your voice stays here</h3>
            <p class="privacy-body">
              Speech recognition and script matching happen on this computer. Microphone audio and
              recognised words are not saved, and there is no transcription account, API key or third
              party.
            </p>
          </div>
          <div class="privacy" data-search-row>
            <h3 class="privacy-head">When the microphone is open</h3>
            <p class="privacy-body">
              Briefly when you grant access, during a take or a microphone test, and while the input
              meter is on screen in Audio settings — which measures loudness only. None of it is
              uploaded or kept.
            </p>
          </div>
          <div class="privacy" data-search-row>
            <h3 class="privacy-head">When Speaking Glass uses the network</h3>
            <p class="privacy-body">
              When you download a speech language, from Welcome or Speech settings, and when it
              checks updates.speakingglass.com for a newer version (Updates, below). Neither carries
              your script or your audio.
            </p>
          </div>
          <div class="privacy" data-search-row>
            <!--
              #180 removed a "Diagnostic logging" toggle and an "Update channel"
              dropdown from here: neither reached Rust, so logging ran either way
              and the channel selected nothing. The switch below is the opposite
              case, and it is allowed here for that reason: it is Rust-owned
              (`general.checkForUpdates`), and Rust refuses an automatic check
              while it is off (`commands::check_for_update`), so turning it off
              is a promise about the network kept by the code that owns it.

              There is no channel to choose: a build follows the channel its own
              version names (`updater.rs`). The version comes from Rust, which
              reads it from the bundle, so the sentence is also what a support
              request should be asked to quote.
            -->
            <h3 class="privacy-head">Updates</h3>
            <Toggle
              checked={$settings.general.checkForUpdates}
              label="Check for updates automatically"
              description="Shortly after Speaking Glass opens, then every six hours while it runs. An update is installed only when you choose, never during a take."
              onchange={(value) => void patchSettings('general', { checkForUpdates: value })}
            />
            <p class="privacy-body" data-testid="update-policy">
              {updateNote || 'Reading the installed version…'}
            </p>
          </div>
        </Section>

        <!-- §44.11 / §47.10 diagnostics: the facts a support request needs. -->
        <Section
          title="Diagnostics"
          description="What Speaking Glass knows about this installation. Useful when something is not working and you need to report it."
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
            <dl class="diag" data-search-row>
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
          <div class="recent-errors" data-search-row>
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

          <div class="row-actions" data-search-row>
            <Button size="sm" disabled={!diagnostics} onclick={() => void copyDiagnostics()}>
              Copy diagnostics
            </Button>
            <Button size="sm" onclick={() => void runSupportBundle()}>
              Export support bundle
            </Button>
            {#if bundleExported}
              <Button size="sm" variant="ghost" onclick={() => void revealBundle()}>
                Reveal bundle
              </Button>
            {/if}
            <!-- #218 removed "Clear analysis cache": it emptied a directory
                 nothing has ever written. Clear logs deletes (after asking), so
                 it is the low-emphasis danger trigger and sits apart. -->
            <span class="row-actions-end">
              <Button size="sm" variant="danger" onclick={() => clearLogs()}>Clear logs</Button>
            </span>
          </div>
          <!-- The version line that closed this section went: the version is
               the first row of the table above and the subject of Updates. -->
          <div class="bundle" data-search-row>
            <p class="bundle-lead">A support bundle contains:</p>
            <ul class="bundle-contents">
              {#each SUPPORT_BUNDLE_CONTENTS as line (line)}
                <li>{line}</li>
              {/each}
            </ul>
            <p class="bundle-lead">{SUPPORT_BUNDLE_EXCLUSIONS}</p>
          </div>
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
    /* The section list's width, read by the list and by the paper beside it. */
    --section-nav-w: 212px;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }

  /*
   * A compact source list, matching the sidebar's (§14.4, §7.1).
   *
   * It was a 208px rail of 34px rows whose selected item was a raised white
   * pill — the same SaaS-nav treatment the sidebar carried, and wrong for the
   * same reason. The rows are source-list height now and the selected one is a
   * tonal fill with no border and no elevation.
   */
  /* Wide enough for "Prompter display and rigs" on one line. At 180px it and
     "Data, privacy & updates" wrapped, and their second lines read as items
     of their own. The rail is the main sidebar's paper with the same straight
     divider, so the two source lists in the app look like one idea. */
  .section-nav {
    flex: 0 0 var(--section-nav-w);
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-3) var(--space-2);
    overflow-y: auto;
    background: var(--bg-chrome);
    border-right: var(--divider-w) solid var(--divider);
  }
  .section-item {
    display: flex;
    align-items: center;
    width: 100%;
    text-align: left;
    min-height: var(--source-row-h);
    padding: 0 var(--space-2);
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .section-item:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .section-item.active,
  .section-item.active:hover {
    background: var(--bg-source-selected);
    color: var(--text-primary);
    font-weight: 600;
  }

  /*
   * On the window's material (tokens.css, WINDOW MATERIAL): the section list
   * is the glass under the toolbar band, and everything beside it is paper.
   * The body paints the paper from the list's edge rather than the form column
   * doing it, because the column stops at its reading measure and the window
   * goes on past it. The list's divider and hover go translucent with it, as
   * the main window's sidebar does.
   */
  :global(html[data-window-material][data-material-rail]) .body {
    background: linear-gradient(
      to right,
      transparent 0 var(--section-nav-w),
      var(--bg-app) var(--section-nav-w)
    );
  }
  :global(html[data-window-material][data-material-rail]) .section-nav {
    --bg-hover-chrome: var(--material-hover);
    background: var(--material-tint);
    border-right-color: var(--material-rule);
  }

  /*
   * The row filter's marks (§14.2).
   *
   * `:global`, because these attributes are set on the ROOT elements of shared
   * field components — `Select`, `Toggle`, `SettingReadout` — and Svelte's
   * scoped styles do not reach into a child component's markup.
   *
   * Scoped by an attribute NOBODY ELSE WRITES rather than by a `.content`
   * ancestor: `.content` is also the app shell's main region and Calibrate's
   * body, so a rule hung off it would be global in the way that matters and
   * specific only by accident. These two attributes are set in exactly one
   * function, `applyRowFilter`, in this file.
   *
   * `!important`, because every row this marks lays itself out: each wrapper's
   * own scoped rule sets `display: flex`, and the scoping class makes that rule
   * (two classes) outrank a bare attribute (one). Without it the mark was set,
   * the note counted the row out, and the row stayed on screen. A miss is a
   * state that has to beat whatever layout the row declares, so it is stated as
   * one rather than out-specified by a selector the next wrapper could tie.
   */
  :global([data-settings-search-miss]) {
    display: none !important;
  }
  /*
   * A wash rather than a highlighted substring. Marking the matched words
   * inside a label would mean rewriting the label's text nodes, which breaks
   * every `for`/`aria-describedby` relationship in the row; marking the ROW
   * says the same thing and leaves the control intact.
   */
  :global([data-settings-search-hit]) {
    background: var(--accent-wash);
    border-radius: var(--radius-sm);
    /* The wash reaches 4px past the row on every side, so its text and its
       switch do not sit flush against the band's edges — without moving the
       row, which a padding would. No more than 4px: rows 12px apart would
       merge into one band. */
    box-shadow: 0 0 0 4px var(--accent-wash);
  }

  /* Sits close over what it counts. Below it the column's 40px section gap
     applied as well, and the note floated a band of empty space away from
     the first match. */
  .row-filter-note {
    margin: 0 0 calc(var(--space-4) - var(--space-9));
    font-size: var(--text-sm);
    color: var(--text-secondary);
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
  }
  .row-filter-clear {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--text-primary);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
  }
  .row-filter-clear:hover {
    text-decoration-color: currentColor;
  }

  /* The toolbar's search field — same shape as the Library's. */
  .settings-search {
    position: relative;
    display: flex;
    align-items: center;
    width: 200px;
  }
  .settings-search .search-icon {
    position: absolute;
    left: var(--space-2);
    display: inline-flex;
    color: var(--text-muted);
    pointer-events: none;
  }
  .settings-search .search-input {
    width: 100%;
    height: var(--toolbar-control-h);
    padding: 0 var(--space-2) 0 26px;
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .settings-search .search-input::placeholder {
    color: var(--text-faint);
  }
  /* Quiet focus — never an accent ring (the house rule). The 2px inset edge
     comes from the focus policy in tokens.css, as it does for the Library's
     search field; cancelling it left a border shift identical to hover. */
  .settings-search .search-input:focus,
  .settings-search .search-input:focus-visible {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  /*
   * The scroller runs to the window's edge and the COLUMN inside it is held to
   * 640px. With the cap on the scroller itself, a visible scroll bar (a mouse
   * attached, or "Always show scroll bars") hung in the margin 28px short of
   * the edge, where the editor's and the Library's sit flush.
   */
  .content {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--page-x) var(--space-8);
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
    /*
      Every field label in Settings takes the switch's treatment — 13px,
      medium, primary ink. Selects, sliders and readouts used to wear the
      grey semibold of a stacked form label, so one section mixed two label
      styles row by row.
    */
    --field-label-color: var(--text-primary);
    --field-label-weight: 500;
  }
  .content > :global(*) {
    max-width: calc(640px - 2 * var(--page-x));
  }
  /* No last word alone on a line, in any of the section's prose — its own and
     its fields' descriptions alike. */
  .content :global(p),
  .content :global(.description) {
    text-wrap: pretty;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  /* A destructive trigger at the far end of its row, apart from the rest. */
  .row-actions-end {
    margin-left: auto;
  }
  .readout-with-action {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
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
    max-width: var(--prose-measure);
  }
  .target-note strong {
    font-weight: 600;
    color: var(--text-secondary);
  }
  /* Keys named in a hint, as the keys they are. */
  .hint-line kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 var(--space-1);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 1;
    color: var(--text-primary);
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    vertical-align: 1px;
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
    color: var(--text-primary);
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

  .bundle {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: var(--prose-measure);
  }
  .bundle-lead {
    margin: 0;
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
    max-width: var(--prose-measure);
  }
  /* Ink with a quiet underline that firms on hover — the website's inline
     link. Petrol is left to Present and to chosen controls. */
  .inline-link {
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    color: var(--text-primary);
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .inline-link:hover {
    text-decoration-color: currentColor;
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

  .toggle-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* A notice that is not an error: a panel is away, or something is
     standing in. The house warning shape — tinted, an icon, ink body. */
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--warning-soft);
  }
  .notice-icon {
    display: inline-flex;
    flex: 0 0 auto;
    margin-top: 1px;
    color: var(--warning);
  }
  .notice-text {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-primary);
  }
  .notice-text strong {
    font-weight: 600;
    color: var(--warning);
  }

  /* --- displays --- */
  /* Equal columns, as many as fit: the Automatic tile and two displays sit on
     one row at the window's normal width, and every tile is the same size. */
  .display-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
    gap: var(--space-2);
  }
  /* The two presentation modes, side by side as the pair they are. */
  .mode-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }
  /*
   * Selection is the raised white tile, as it is the raised white segment in
   * every segmented control on this screen. It used to be the reverse — the
   * chosen tile tinted beige among white ones — and a tinted tile among bright
   * ones reads as the one that is switched off.
   */
  .monitor-tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: transparent;
    text-align: left;
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  /* The chosen display while it is unplugged: still the selection, not a
     button — the dashed edge says it is away. */
  .monitor-tile.missing {
    border-style: dashed;
  }
  .monitor-tile:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover-chrome);
  }
  /* The state edge, not the hover one: --border-strong is under 3:1 on the
     porcelain around the tile, so the choice leaned on the glyph's colour.
     No resting shadow: a tile is chosen, not floating, and the state edge and
     the panel face say so in both appearances. */
  .monitor-tile.selected,
  .monitor-tile.selected:hover {
    border-color: var(--border-state);
    background: var(--bg-panel);
  }
  .monitor-glyph {
    color: var(--text-muted);
  }
  /* The glyph and, on a display tile, its number. The number sits at the far
     edge, where an eye coming back from the glass lands on it before the
     name: it is the one thing on the tile that matches what the panel showed. */
  /* Every tile has the same head, number or not, so the names below line up
     across a row. */
  .monitor-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    align-self: stretch;
    gap: var(--space-2);
    min-height: 26px;
    margin-bottom: var(--space-1);
  }
  /* A disc, not a key. Outlined and square-cornered it was the shortcut
     sheet's keycap, and a "1" on a key reads as a key to press. */
  .monitor-number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 26px;
    padding: 0 var(--space-1);
    border-radius: var(--radius-pill);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--text-base);
    font-weight: 650;
    line-height: 1;
    font-variant-numeric: tabular-nums;
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
    line-height: var(--lh-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    /* The Automatic tile holds a panel's name together (`unbroken`), and a
       name longer than the tile must still break rather than run into the
       next one: only where nothing else fits. */
    overflow-wrap: anywhere;
  }
  .monitor-badges {
    display: flex;
    gap: var(--space-1);
    margin-top: var(--space-1);
  }
  /* A mode tile's icon sits beside its name: the head row a display tile
     needs for its number is height a mode tile does not. */
  .mode-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: 2px;
  }
  .mode-head .monitor-glyph {
    display: inline-flex;
  }

  /* The sizing in force, one line, under the display picker. */
  .sizing-summary {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }
  .sizing-summary strong {
    font-weight: 600;
    color: var(--text-primary);
  }

  /* --- the optical rig --- */
  /* The primary rig action, which names a rig whose name can be a sentence.
     It shortens with an ellipsis; the tooltip carries the whole thing. */
  .rig-action-label {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rig-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .rig-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: transparent;
  }
  /* The rig in force: raised white with a firm edge, like a selected tile
     above it, and no accent bar — selection is never marked with one here. */
  .rig-row.active {
    border-color: var(--border-strong);
    background: var(--bg-panel);
    box-shadow: var(--shadow-card);
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

  /* How the display is sized, in one sentence above the numbers. */
  .rig-lead {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure);
  }
  .rig-lead strong {
    font-weight: 600;
    color: var(--text-primary);
  }

  .readout {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .readout-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .readout-note {
    margin: 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-faint);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
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
  /* The answer in ink, the question in grey — here and in Diagnostics. */
  .readout-value {
    margin: 0;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-primary);
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
    /* A setting's name — the same treatment as Select's and Toggle's labels. */
    font-weight: var(--field-label-weight, 500);
    color: var(--field-label-color, var(--text-primary));
  }

  /* The distance presets, then a typed distance on the same line. */
  .distance-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .distance-other {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .distance-input {
    width: 92px;
    height: var(--control-h);
    padding: 0 22px 0 var(--space-2);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .distance-input::placeholder {
    color: var(--text-faint);
  }
  .distance-input:hover {
    border-color: var(--border-strong);
  }
  /* Quiet focus, as every field here: the inset edge comes from tokens.css. */
  .distance-input:focus,
  .distance-input:focus-visible {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }
  .distance-unit {
    position: absolute;
    right: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    pointer-events: none;
  }

  /* The Advanced panel's groups, in the app's small-caps group label (the
     shortcuts sheet's index titles). As 13px bold they differed from the
     slider labels under them by colour alone. */
  .advanced-head {
    margin: var(--space-3) 0 calc(-1 * var(--space-1));
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }

  .advanced-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .override {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* One size for the whole line: the tag was 11px and the reset link beside
     it inherited 15px. */
  .override-state {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
  }
  .override-tag {
    font-weight: 600;
    /* Small accent TEXT takes the strong step on the light desk. */
    color: var(--accent-strong);
    font-variant-numeric: tabular-nums;
  }

  /* The four geometry sliders and the note that says who owns them, in one
     sunken well — not a bordered card: it groups, it does not frame. */
  .geometry-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  .geometry-note {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    padding-bottom: var(--space-1);
  }
  .geometry-note-text {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure);
  }
  .geometry-note-text strong {
    font-weight: 600;
    color: var(--text-primary);
  }
  .geometry-note .inline-link {
    font-size: var(--text-sm);
  }

  /* --- microphone --- */

  /* Permission. One card per remedy: an icon in the remedy's tone, a title
     that names the next step, one or two sentences, and the buttons weighted
     the same way. Tone colours the icon and title only — never the body. */
  .mic-access {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
  }
  .mic-access-icon {
    display: inline-flex;
    flex: 0 0 auto;
    margin-top: 1px;
    color: var(--text-muted);
  }
  .mic-access.warn .mic-access-icon {
    color: var(--warning);
  }
  .mic-access.good .mic-access-icon {
    color: var(--success);
  }
  .mic-access-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .mic-access-title {
    margin: 0;
    font-size: var(--text-base);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .mic-access-text {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }
  /* A path is one name; it must not break at the arrow or inside "Privacy &". */
  .mic-path {
    margin: calc(-1 * var(--space-1)) 0 var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .mic-flow {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-width: 0;
  }
  .mic-input {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  /* A short window spends its height on the sequence, not the air between. */
  @media (max-height: 560px) {
    .mic-flow {
      gap: var(--space-5);
    }
  }

  /* The remembered microphone is missing and another one is standing in. */
  .mic-fallback {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--warning-soft);
  }
  .mic-fallback-icon {
    display: inline-flex;
    flex: 0 0 auto;
    margin-top: 1px;
    color: var(--warning);
  }
  .mic-fallback-body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
  }
  .mic-fallback-title {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--warning);
  }
  .mic-fallback-text {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-primary);
  }

  /* The transcription test: a label row like every other row, then one well
     whose height is reserved for any state, then a note that never changes. */
  .mic-test {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .mic-test-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-width: 0;
  }
  .mic-test-label {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .mic-test-button {
    display: flex;
    flex: 0 0 auto;
    min-width: 164px;
  }
  .mic-test-button :global(.button) {
    flex: 1 1 auto;
  }
  /* Stop, drawn as the transport's filled square — the outline glyph read as
     an empty checkbox at this size. */
  .mic-stop-glyph {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    background: currentColor;
  }
  .mic-test-name {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    /* A setting's name — the same treatment as Select's and Toggle's labels. */
    font-weight: var(--field-label-weight, 500);
    color: var(--field-label-color, var(--text-primary));
  }
  .mic-test-prompt {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .mic-test-well {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
    /* Verdict + two lines of transcript, so words arriving never push the
       page and a pass never pulls it back up. */
    min-height: calc(var(--control-h-sm) + var(--space-2) + 2 * var(--lh-transcript) + 2 * var(--space-3));
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  /* As tall as the small button that can sit on it, in every state, so the
     words below start on the same line whether or not it is there. */
  .mic-test-verdict-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    min-height: var(--control-h-sm);
    min-width: 0;
  }
  .mic-test-verdict {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-muted);
  }
  .mic-test[data-tone='idle'] .mic-test-verdict {
    font-weight: 500;
  }
  /* A live session must be unmistakable at a glance: the verdict in ink, and
     the on-air dot beside it in --live, the token kept for an open microphone.
     Not petrol, which is never a status. */
  .mic-test[data-tone='live'] .mic-test-verdict {
    color: var(--text-primary);
  }
  .mic-test[data-tone='good'] .mic-test-verdict {
    color: var(--success);
  }
  .mic-test[data-tone='warn'] .mic-test-verdict {
    color: var(--warning);
  }
  .mic-test[data-tone='bad'] .mic-test-verdict {
    color: var(--danger);
  }
  .mic-test-icon {
    display: inline-flex;
  }
  /* The verdict's leading mark sits in a 14px slot whatever it is, so the
     words start at the same x in every state. */
  .mic-test-icon,
  .mic-test-dot {
    flex: 0 0 14px;
    justify-content: center;
  }
  .mic-test-dot {
    display: inline-flex;
    align-items: center;
  }
  .mic-test-dot::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    /* Steady. It pulsed, forever, beside the input meter that already moves
       with the voice — a second, competing motion while somebody judges their
       microphone, and the house allows no perpetual motion. A filled mark is
       "listening"; the words beside it say so too. */
    background: var(--live);
  }
  /* Starting is not yet listening: a hollow mark until the microphone is live. */
  .mic-test[data-phase='opening'] .mic-test-dot::before {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--live);
  }
  .mic-test-words {
    margin: 0;
    font-size: var(--text-transcript);
    line-height: var(--lh-transcript);
    color: var(--prose-text-warm);
    overflow-wrap: anywhere;
  }
  .mic-test-words.partial {
    color: var(--prose-secondary-warm);
  }
  /* Room for words, set apart from words: smaller, and the faint ramp. */
  .mic-test-words.empty {
    font-size: var(--text-base);
    color: var(--text-faint);
  }
  /* A next step or a failure is an instruction, not a transcript. */
  .mic-test-words.message {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }
  .mic-test-note {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

  .mic-privacy {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure);
  }
  .mic-privacy-icon {
    display: inline-flex;
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .mic-tuning-slot {
    margin: calc(-1 * var(--space-3)) 0;
  }
  .mic-tuning-lead {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }

</style>
