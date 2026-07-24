<!--
  Preflight (spec §14): one scrollable page with sections A–G, F.10 status
  labels, and a sticky footer whose Start button explains exactly why it is
  disabled. Section statuses flow through the preflight store; hardware and
  provider checks run through the service layer (mock-backed until the Rust /
  audio integrations land).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from '../components/Button.svelte';
  import Disclosure from '../components/Disclosure.svelte';
  import FollowSettingsFields from '../components/FollowSettingsFields.svelte';
  import Icon from '../components/Icon.svelte';
  import MicMeter from '../components/MicMeter.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import SegmentedControl from '../components/SegmentedControl.svelte';
  import Section from '../components/Section.svelte';
  import Select from '../components/Select.svelte';
  import Slider from '../components/Slider.svelte';
  import StatusPill, { type PillTone } from '../components/StatusPill.svelte';
  import TextField from '../components/TextField.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { estimateDurationSeconds, formatSpeakingDuration } from '../lib/format';
  import { openExternal } from '../lib/app-actions';
  import { describeError } from '../services/errors';
  import * as scriptsService from '../services/scripts';
  import * as secretsService from '../services/secrets';
  import * as stageService from '../services/stage';
  import { buildStageEnvelope, buildStageSettings, resolveDocumentAssets } from '../services/stage-envelope';
  import {
    applyProfileToStageOverrides,
    buildDisplayProfile,
    listDisplayProfiles,
    profileForDisplay,
    saveDisplayProfile,
  } from '../services/display-profiles';
  import {
    buildListenerSelection,
    listInstalledListeners,
    resolveListenerMedia,
    type InstalledListener,
  } from '../services/listeners';
  import { offsetSliderBound } from '../../shared/listener/geometry';
  import { endSessionRecord, startSessionRecord } from '../services/session-records';
  import { acquireCancellable, runCheck } from './preflight-load';
  import { getVoiceFacade } from '../services/voice-facade';
  import type { DisplayDescriptor } from '../services/stage-types';
  import type { OpenAiKeyStatus } from '../services/secrets-types';
  import type { SessionMode } from '../services/settings-types';
  import type { ListenerStageSelection } from '../../shared/contracts';
  import { compiled, requestCompile } from '../stores/compiled';
  import {
    computeReadiness,
    preflightChecks,
    preflightReadiness,
    resetPreflight,
    scriptStatusFromDiagnostics,
    updatePreflight,
    type CheckStatus,
  } from '../stores/preflight';
  import { saveNow } from '../stores/editor';
  import { navigate } from '../stores/router';
  import { settings, loadSettings, patchSettings } from '../stores/settings';
  import { clearSession, startLiveSession, stopSession } from '../stores/session';
  import { showToast } from '../stores/toasts';
  import type { AudioDeviceInfo, AudioLevelSnapshot } from '../../shared/contracts';

  interface Props {
    scriptId: string;
  }
  let { scriptId }: Props = $props();

  /* ------------------------------------------------------------- script */
  let scriptTitle = $state('');
  let scriptSource = $state('');

  /* -------------------------------------------------------------- stage */
  let displays = $state<DisplayDescriptor[]>([]);
  let selectedFingerprint = $state<string | null>(null);
  /** §52: the profile this display's appearance was restored from, so saving updates it rather than accumulating duplicates. */
  let rememberedProfileId = $state<string | null>(null);
  let stageValidated = $state(false);
  let stageTesting = $state(false);
  /*
   * Inline, persistent failure text beside the control that failed. A toast
   * that clears itself takes the reason away with it, and the reason is the
   * only thing that tells the operator what to do next.
   */
  let stageError = $state<string | null>(null);
  let micError = $state<string | null>(null);
  let scriptError = $state<string | null>(null);
  let openAiError = $state<string | null>(null);
  let startError = $state<string | null>(null);
  let fullscreen = $state(true);
  let mirrorX = $state(false);
  let mirrorY = $state(false);
  let starting = $state(false);

  /* ------------------------------------------------------------- openai */
  let keyStatus = $state<OpenAiKeyStatus | null>(null);
  let keyField = $state('');
  let keyBusy = $state(false);
  let keyMessage = $state<{ tone: PillTone; text: string } | null>(null);
  let replacingKey = $state(false);

  /* ---------------------------------------------------------------- mic */
  let micPermission = $state<'unknown' | 'granted' | 'denied'>('unknown');
  /** Guards the one-shot adoption of an already-granted permission. */
  let micAdopted = false;
  let micDevices = $state<AudioDeviceInfo[]>([]);
  let micDeviceId = $state<string | undefined>(undefined);
  let followSystemDefault = $state(true);
  let micLevel = $state<AudioLevelSnapshot | null>(null);
  let micTest = $state<'idle' | 'listening' | 'waiting' | 'success'>('idle');
  let micPartial = $state('');
  let micFinal = $state('');
  let stopMicTest: (() => void) | null = null;
  /**
   * Cancellation token for microphone acquisition. `startTranscriptionTest`
   * only hands back its disposer after the capture is already running, so a
   * navigation during acquisition used to leak the microphone for the lifetime
   * of the app.
   */
  let micTestGeneration = 0;

  /* ----------------------------------------------------------- tracking */
  let mode = $state<SessionMode>('voice');
  let language = $state('en');
  let latency = $state<'fast' | 'balanced' | 'accurate'>('balanced');
  let readHeadings = $state(false);
  let commandListening = $state(true);

  /* --------------------------------------------------------- appearance */
  let fontFamilyId = $state('system-sans');
  let fontSizePx = $state(64);
  let lineHeight = $state(1.32);
  let columnWidthPercent = $state(78);
  let horizontalOffsetPercent = $state(0);
  let readingBandCenterPercent = $state(38);
  let phraseHighlight = $state(true);
  let pastDimming = $state(true);
  let focusFade = $state(true);
  let stageBackground = $state('near-black');

  /* ------------------------------------------------------------ listener */
  let listenerEnabled = $state(false);
  let listenerPack = $state<'none' | 'mira'>('none');
  let listenerDim = $state(40);
  let listenerBlur = $state(0);
  let listenerScale = $state(100);
  let listenerX = $state(0);
  let listenerY = $state(0);
  let installedListeners = $state<InstalledListener[]>([]);
  let listenersLoaded = $state(false);

  const result = $derived($compiled.result);
  const diagnostics = $derived(result?.diagnostics ?? []);
  const wordCount = $derived(result?.spokenWordCount ?? 0);
  const durationSeconds = $derived(estimateDurationSeconds(wordCount));

  const overallLabel = $derived(
    (
      {
        not_ready: 'Not ready',
        checking: 'Checking',
        ready: 'Ready',
        ready_warning: 'Ready with warning',
      } as const
    )[$preflightReadiness.overall],
  );
  const overallTone = $derived(
    (
      {
        not_ready: 'neutral',
        checking: 'neutral',
        ready: 'success',
        ready_warning: 'warning',
      } as const satisfies Record<string, PillTone>
    )[$preflightReadiness.overall],
  );

  /* ------------------------------------------------------- initial load */

  /**
   * Load generation. Every step of the load can reject, and each rejection has
   * to leave a row in a state the operator can act on — the whole page used to
   * hang on `stage: 'checking'` ("Opening…", forever) if display enumeration
   * threw, with no error text and no way to retry. The generation also makes
   * `scriptId` a real dependency: a preflight → preflight move for a different
   * script re-runs the load and discards anything still in flight for the old
   * one.
   */
  let loadGeneration = 0;

  $effect(() => {
    const id = scriptId; // tracked: a different script re-runs the whole load
    resetPreflight('voice');
    void loadPreflight(id);
    return () => {
      loadGeneration += 1; // invalidate whatever is still in flight
    };
  });

  /** Microphone capture is disposed on unmount even mid-acquisition. */
  $effect(() => {
    return () => {
      micTestGeneration += 1;
      stopMicTest?.();
      stopMicTest = null;
    };
  });

  async function loadPreflight(id: string): Promise<void> {
    const generation = (loadGeneration += 1);
    const stale = (): boolean => generation !== loadGeneration;

    startError = null;
    await loadSettings().catch(() => {});
    if (stale()) return;
    mode = $settings.general.defaultSessionMode;
    fontSizePx = $settings.teleprompter.fontSizePx;
    lineHeight = $settings.teleprompter.lineHeight;
    readingBandCenterPercent = $settings.teleprompter.readingBandCenterPercent;
    followSystemDefault = $settings.audio.followSystemDefault;

    await loadScript(id, generation);
    if (stale()) return;
    await loadDisplays(generation);
    if (stale()) return;
    await refreshKeyStatus(generation);
  }

  async function loadScript(id = scriptId, generation = loadGeneration): Promise<void> {
    await runCheck({
      isStale: () => generation !== loadGeneration,
      onStart: () => {
        scriptError = null;
        updatePreflight({ script: 'checking' });
      },
      run: async () => {
        // §29.2 step 1: flush any pending editor autosave before reading.
        await saveNow().catch(() => {});
        return scriptsService.getScript(id);
      },
      onSuccess: (doc) => {
        scriptTitle = doc.title;
        scriptSource = doc.source;
        compiledWithHeadings = readHeadings;
        void requestCompile(doc.id, doc.source, 0, { readHeadings });
      },
      onFailure: (err) => {
        updatePreflight({ script: 'blocked' });
        scriptError = `CandidCue could not open this script. ${describeError(err)}`;
      },
    });
  }

  async function loadDisplays(generation = loadGeneration): Promise<void> {
    await runCheck({
      isStale: () => generation !== loadGeneration,
      onStart: () => {
        stageError = null;
        stageValidated = false;
        updatePreflight({ stage: 'checking' });
      },
      run: () => stageService.listDisplays(),
      onSuccess: async (found) => {
        displays = found;
        const preferred = found.find((d) => !d.primary) ?? found[0];
        const fingerprint = preferred?.fingerprint ?? null;
        selectedFingerprint = fingerprint;
        if (fingerprint === null) {
          updatePreflight({ stage: 'blocked' });
          stageError = 'No displays were detected. Connect the teleprompter display and try again.';
          return;
        }
        // Claim the probe here rather than leaving it to the auto-readiness
        // effect: on a retry the fingerprint is usually unchanged, so the
        // effect would not re-run and the row would sit at "Opening…" again.
        stageCheckedFingerprint = fingerprint;
        await restoreDisplayProfile(fingerprint);
        await validateStageDisplay(fingerprint);
      },
      onFailure: (err) => {
        displays = [];
        selectedFingerprint = null;
        stageCheckedFingerprint = null;
        updatePreflight({ stage: 'blocked' });
        stageError = `CandidCue could not list the connected displays. ${describeError(err)}`;
      },
    });
  }

  async function refreshKeyStatus(generation = loadGeneration): Promise<void> {
    await runCheck({
      isStale: () => generation !== loadGeneration,
      onStart: () => {
        openAiError = null;
        updatePreflight({ openai: 'checking' });
      },
      run: () => secretsService.getOpenAiKeyStatus(),
      onSuccess: (status) => {
        keyStatus = status;
        updatePreflight({ openai: openAiStatusToCheck(status) });
      },
      onFailure: (err) => {
        keyStatus = null;
        updatePreflight({ openai: 'blocked' });
        openAiError = `CandidCue could not check the OpenAI connection. ${describeError(err)}`;
      },
    });
  }

  /* Script section reflects the compiler (F.10 row 1). */
  $effect(() => {
    const { status, warnings } = scriptStatusFromDiagnostics(diagnostics, $compiled.status);
    updatePreflight({ script: status, warnings });
  });

  /*
   * "Read headings aloud" changes what counts as a spoken token, so it has to
   * go through the compiler — the toggle used to set a variable nothing read.
   * The session starts from this compile result, so the flag really does reach
   * the take.
   */
  let compiledWithHeadings = false;
  $effect(() => {
    const wanted = readHeadings;
    const source = scriptSource;
    if (source === '' || wanted === compiledWithHeadings) return;
    compiledWithHeadings = wanted;
    void requestCompile(scriptId, source, 0, { readHeadings: wanted });
  });

  const installedMira = $derived(
    installedListeners.find((l) => l.packId === 'mira' && l.state === 'installed') ?? null,
  );

  /*
   * Listener framing range (see src/shared/listener/geometry.ts). The position
   * sliders are percent of the visible frame, and the amount of travel that
   * exists at all is bought by the zoom: clips are object-fit: cover, so at
   * zoom z there is only (z-1)/2 of the frame to spend on each side before the
   * media edge shows as a black bar. The range therefore GROWS WITH ZOOM and is
   * recomputed whenever the zoom slider moves, clamping the current position.
   */
  let listenerDefaultZoom = $state(1.15);
  $effect(() => {
    if (listenerPack !== 'mira') return;
    const version = installedMira?.version ?? '1.0.0';
    let cancelled = false;
    void resolveListenerMedia('mira', version)
      .then((media) => {
        if (!cancelled && media.defaultZoom > 0) listenerDefaultZoom = media.defaultZoom;
      })
      .catch(() => {
        /* keep the fallback zoom; Start resolves the real media anyway */
      });
    return () => {
      cancelled = true;
    };
  });
  const listenerCropZoom = $derived(listenerDefaultZoom * (listenerScale / 100));
  const listenerOffsetBound = $derived(offsetSliderBound(listenerCropZoom));
  $effect(() => {
    const bound = listenerOffsetBound;
    untrack(() => {
      if (Math.abs(listenerX) > bound) listenerX = Math.sign(listenerX) * bound;
      if (Math.abs(listenerY) > bound) listenerY = Math.sign(listenerY) * bound;
    });
  });

  /* Keep the derived mode/listener requirement in the store. */
  $effect(() => {
    const listenerStatus = !listenerEnabled
      ? 'idle'
      : listenerPack !== 'mira'
        ? 'blocked'
        : !listenersLoaded
          ? 'checking'
          : installedMira
            ? 'ready'
            : 'blocked';
    updatePreflight({ mode, listenerEnabled, listener: listenerStatus });
  });

  /* Resolve the installed pack list the first time a Listener is wanted. */
  $effect(() => {
    if (!listenerEnabled || listenersLoaded) return;
    void listInstalledListeners()
      .then((packs) => {
        installedListeners = packs;
      })
      .catch(() => {
        installedListeners = [];
      })
      .finally(() => {
        listenersLoaded = true;
      });
  });

  /*
   * §28.1: never prompt on mount, but DO notice a permission that is already
   * granted — otherwise a returning user is asked to re-click "Allow" before
   * every session. The subscription also catches a grant made in System
   * Settings while this screen is open. Platforms that cannot report the
   * state ('unsupported') simply leave the explicit button in place.
   */
  $effect(() => {
    return getVoiceFacade().watchMicrophonePermission((state) => {
      if (state === 'granted') {
        void adoptGrantedMicrophone();
      } else if (state === 'denied') {
        micAdopted = false;
        micPermission = 'denied';
        updatePreflight({ microphone: 'blocked' });
      }
      // 'prompt' / 'unsupported' → keep the explicit request action visible.
    });
  });

  /*
   * Stage readiness runs itself once a display is known — there is no
   * separate "prepare" step the user has to discover, and stage 'idle' blocks
   * Start. The probe opens the stage window HIDDEN and closes it again, so
   * nothing flashes on the panel; the visible "Show test on this display"
   * action remains for confirming which physical monitor it lands on.
   */
  let stageCheckedFingerprint: string | null = null;
  $effect(() => {
    const fingerprint = selectedFingerprint;
    if (fingerprint === null || stageTesting) return;
    if (stageCheckedFingerprint === fingerprint) return;
    stageCheckedFingerprint = fingerprint;
    void validateStageDisplay(fingerprint);
  });

  /* Mic level meter while permission is granted (local, pre-OpenAI). */
  $effect(() => {
    if (micPermission !== 'granted') return undefined;
    const unsub = getVoiceFacade().observeLevels(micDeviceId, (snapshot) => {
      micLevel = snapshot;
    });
    return unsub;
  });

  function openAiStatusToCheck(status: OpenAiKeyStatus | null): CheckStatus {
    if (!status || !status.present) return 'blocked';
    switch (status.state) {
      case 'connected':
        return 'ready';
      case 'rate_limited':
      case 'network_unavailable':
        return 'warning';
      default:
        return 'blocked';
    }
  }

  /* ------------------------------------------------------ stage actions */
  function selectDisplay(fingerprint: string): void {
    selectedFingerprint = fingerprint;
    stageValidated = false;
    stageError = null;
    updatePreflight({ stage: 'idle' });
    void restoreDisplayProfile(fingerprint);
  }

  /**
   * Spec §52. Re-apply the appearance this display was last used with.
   *
   * Without this, every session began by re-positioning the Listener and
   * re-setting type from scratch — the settings were saved and then read by
   * nothing. Matching is by display fingerprint only: a profile with no
   * fingerprint is never auto-applied, because silently restyling the stage
   * for the *wrong* monitor is worse than not restoring at all.
   *
   * Failure is deliberately silent. A remembered preference is a convenience,
   * and not being able to read one must never block getting to a take.
   */
  async function restoreDisplayProfile(fingerprint: string): Promise<void> {
    try {
      const profile = profileForDisplay(await listDisplayProfiles(), fingerprint);
      if (profile === null) {
        rememberedProfileId = null;
        return;
      }
      rememberedProfileId = profile.id;
      const stage = applyProfileToStageOverrides(profile.stage);
      fontFamilyId = stage.fontFamilyId;
      fontSizePx = stage.fontSizePx;
      lineHeight = stage.lineHeight;
      columnWidthPercent = stage.columnWidthPercent;
      readingBandCenterPercent = stage.readingBandCenterPercent;
      mirrorX = stage.mirrorX;
      mirrorY = stage.mirrorY;
      pastDimming = stage.pastDimming;
      phraseHighlight = stage.phraseHighlight;
      stageBackground = stage.background === '#000000' ? 'high-contrast' : 'near-black';
      if (profile.listener) {
        // The profile stores the resolved geometry; these controls hold the
        // percent-scale inputs `buildListenerSelection` converts from, so the
        // conversion is inverted here rather than storing a second copy.
        listenerScale = Math.round(profile.listener.cropZoom * 100);
        listenerX = profile.listener.cropX;
        listenerY = profile.listener.cropY;
        listenerDim = Math.round((1 - profile.listener.opacity) * 100);
        listenerBlur = profile.listener.blurPx;
      }
    } catch {
      rememberedProfileId = null;
    }
  }

  /**
   * Headless readiness probe: open the stage on the selected display (hidden)
   * and close it. §14.2 A — "a display is not considered validated until the
   * stage window reports that it opened on the requested monitor" — so the
   * window really has to open; it just never has to be shown.
   */
  async function validateStageDisplay(fingerprint: string): Promise<void> {
    stageError = null;
    stageTesting = true;
    updatePreflight({ stage: 'checking' });
    const probeSessionId = `stage-check-${Date.now().toString(36)}`;
    try {
      await stageService.openStage({ displayFingerprint: fingerprint, sessionId: probeSessionId });
      stageValidated = true;
      updatePreflight({ stage: 'ready' });
    } catch (err) {
      stageValidated = false;
      updatePreflight({ stage: 'blocked' });
      // F.15 "Stage did not open".
      stageError = `CandidCue could not create the prompt window on this display. ${describeError(err)}`;
    } finally {
      stageTesting = false;
      await stageService.closeStage(probeSessionId).catch(() => {});
    }
  }

  async function identifyDisplays(): Promise<void> {
    try {
      // Rust puts the actual numbered card on each physical panel; the toast
      // only tells the operator where to look. Listing display NAMES here
      // cannot answer "which panel is number 2?" — that is the whole question.
      const identification = await stageService.identifyDisplays();
      const count = identification?.displays.length ?? 0;
      if (count > 0) {
        stageError = null;
        showToast(`Look for the number shown on each display (${count} connected)`, 'info', {
          durationMs: 3000,
        });
      } else {
        stageError = 'No displays were detected. Connect the teleprompter display and try again.';
      }
    } catch (err) {
      stageError = describeError(err);
    }
  }

  /**
   * Display test (§14.2 A): opens a real stage window on the selected
   * display under a throwaway session id, shows it, and closes it again.
   */
  async function runDisplayTest(windowedPreview: boolean): Promise<void> {
    if (!selectedFingerprint) return;
    stageTesting = true;
    stageError = null;
    updatePreflight({ stage: 'checking' });
    const testSessionId = `display-test-${Date.now().toString(36)}`;
    try {
      await stageService.openStage({
        displayFingerprint: selectedFingerprint,
        sessionId: testSessionId,
      });
      await stageService.setStageFullscreen(testSessionId, !windowedPreview && fullscreen);
      stageValidated = true;
      updatePreflight({ stage: 'ready' });
      window.setTimeout(() => {
        void stageService.closeStage(testSessionId).catch(() => {});
      }, 4000);
    } catch (err) {
      stageValidated = false;
      updatePreflight({ stage: 'blocked' });
      // F.15 "Stage did not open" — stated inline, next to the action.
      stageError = `CandidCue could not create the prompt window on this display. ${describeError(err)}`;
    } finally {
      stageTesting = false;
    }
  }

  /* ----------------------------------------------------- OpenAI actions */
  async function saveAndTestKey(): Promise<void> {
    const candidate = keyField.trim();
    if (!candidate) return;
    keyBusy = true;
    keyMessage = null;
    updatePreflight({ openai: 'checking' });
    try {
      const validation = await secretsService.validateOpenAiKey(candidate);
      if (validation.status === 'valid') {
        keyStatus = await secretsService.saveOpenAiKey(candidate);
        keyMessage = { tone: 'success', text: 'Key saved. Realtime transcription is available.' };
        replacingKey = false;
      } else if (validation.status === 'partial') {
        keyStatus = await secretsService.saveOpenAiKey(candidate);
        keyMessage = {
          tone: 'warning',
          text: `The key is valid, but CandidCue could not access ${validation.missing ?? 'a required model'}. Manual and fixed-speed modes are still available.`,
        };
      } else if (validation.status === 'quota') {
        keyMessage = {
          tone: 'warning',
          text: 'The key is valid, but the OpenAI project has no available quota or billing access.',
        };
      } else if (validation.status === 'network') {
        keyMessage = {
          tone: 'warning',
          text: 'CandidCue could not reach OpenAI to verify the key. Check your connection and try again.',
        };
      } else {
        keyMessage = {
          tone: 'danger',
          text: 'OpenAI rejected this key. Check that it is active and belongs to the project you intend to bill.',
        };
      }
    } finally {
      // One-shot field: always purge the plaintext after submission.
      keyField = '';
      keyBusy = false;
      updatePreflight({ openai: openAiStatusToCheck(keyStatus) });
    }
  }

  async function removeKey(): Promise<void> {
    keyMessage = null;
    try {
      await secretsService.deleteOpenAiKey();
    } catch (err) {
      keyMessage = { tone: 'danger', text: `Could not remove the key. ${describeError(err)}` };
      return;
    }
    await refreshKeyStatus();
  }

  async function testConnection(): Promise<void> {
    keyBusy = true;
    try {
      await refreshKeyStatus();
    } finally {
      keyBusy = false;
    }
  }

  /* -------------------------------------------------------- mic actions */

  /** Enumerate inputs for an already-granted permission — never prompts. */
  async function adoptGrantedMicrophone(): Promise<void> {
    if (micAdopted) return;
    micAdopted = true;
    updatePreflight({ microphone: 'checking' });
    try {
      micDevices = await getVoiceFacade().listMicrophones();
      micDeviceId = micDevices.find((d) => d.isDefault)?.deviceId ?? micDevices[0]?.deviceId;
      micPermission = 'granted';
      micError = null;
      updatePreflight({ microphone: micDevices.length > 0 ? 'ready' : 'blocked' });
      if (micDevices.length === 0) {
        micError = 'No microphone was found. Connect an input device and try again.';
      }
    } catch (err) {
      micAdopted = false;
      updatePreflight({ microphone: 'blocked' });
      micError = describeError(err);
    }
  }

  async function allowMicrophone(): Promise<void> {
    micError = null;
    updatePreflight({ microphone: 'checking' });
    try {
      const granted = await getVoiceFacade().requestMicrophoneAccess();
      if (granted === 'granted') {
        micAdopted = false;
        await adoptGrantedMicrophone();
      } else {
        micPermission = 'denied';
        updatePreflight({ microphone: 'blocked' });
      }
    } catch (err) {
      // A rejected request used to leave the row at "Testing…" forever.
      micPermission = 'unknown';
      updatePreflight({ microphone: 'blocked' });
      micError = `CandidCue could not ask for microphone access. ${describeError(err)}`;
    }
  }

  async function runTranscriptionTest(): Promise<void> {
    stopMicTest?.();
    stopMicTest = null;
    const generation = (micTestGeneration += 1);
    micTest = 'listening';
    micPartial = '';
    micFinal = '';
    micError = null;
    const acquisition = await acquireCancellable(
      () =>
        getVoiceFacade().startTranscriptionTest(micDeviceId, {
          onPartial(text) {
            if (generation !== micTestGeneration) return;
            micTest = 'waiting';
            micPartial = text;
          },
          onFinal(text) {
            if (generation !== micTestGeneration) return;
            micTest = 'success';
            micFinal = text;
          },
          onError(message) {
            if (generation !== micTestGeneration) return;
            micTest = 'idle';
            micError = message;
          },
        }),
      () => generation !== micTestGeneration,
    );
    // Cancelled (unmount, or a second press) while the capture was opening:
    // `acquireCancellable` has already disposed it.
    if (acquisition.cancelled) return;
    if (acquisition.error !== null) {
      // The button is disabled while 'listening'; leaving it there on a
      // rejection made it permanently unusable with nothing said.
      micTest = 'idle';
      micError = `The transcription test could not start. ${describeError(acquisition.error)}`;
      return;
    }
    stopMicTest = acquisition.stop;
  }

  /* ------------------------------------------------------------- start */

  /** Latency preset → Realtime delay profile (spec A.6). */
  function delayForLatency(): 'minimal' | 'low' | 'high' {
    return latency === 'fast' ? 'minimal' : latency === 'accurate' ? 'high' : 'low';
  }

  /**
   * Start sequence (spec §29.2 / §43.3): compile is already flushed to the
   * store; open the stage hidden → publish the session envelope → await the
   * stage handshake → full screen → route to Live. The realtime transport is
   * started by the session store (voice mode only).
   */
  async function startSession(): Promise<void> {
    const readiness = computeReadiness($preflightChecks);
    if (!readiness.canStart || starting) return;
    const compiledScript = result?.script ?? null;
    if (!compiledScript) {
      startError = 'The script has not finished compiling yet.';
      return;
    }
    starting = true;
    startError = null;
    const display = displays.find((d) => d.fingerprint === selectedFingerprint);
    /*
     * C1: open the session record FIRST.
     *
     * `start_session` is the only path to `AppCoordinator::begin_session`, which
     * is the only writer of the Rust-side session generation. Skipping it left
     * the coordinator at generation 0 while control stamped every stage payload
     * with a hard-coded 1, so `validate_stage_payload_header` rejected the whole
     * stage stream: the hydration envelope was dropped (an ack saying
     * `accepted: false`, which nothing checked), `waitForStageReady` then sat out
     * its full 12 s timeout, and the start sequence failed. No session could be
     * started at all in a packaged build.
     *
     * Rust assigns, control adopts — both the generation and the session id,
     * so there is exactly one writer of each. It also takes the §21.4
     * pre-session revision snapshot before anything can change underneath it.
     */
    let sessionId = '';
    try {
      const record = await startSessionRecord({
        scriptId,
        scriptSourceHash: compiledScript.sourceHash,
        mode,
        startTokenIndex: 0,
        compileHash: compiledScript.sourceHash,
      });
      sessionId = record.id;
      const sessionGeneration = record.sessionGeneration;

      // Listener selection (§14.2 F): resolve real pack media through Rust.
      let listener: ListenerStageSelection | undefined;
      if (listenerEnabled && listenerPack === 'mira') {
        const version = installedMira?.version ?? '1.0.0';
        listener = await buildListenerSelection('mira', version, {
          zoomPercent: listenerScale,
          offsetXPercent: listenerX,
          offsetYPercent: listenerY,
          dimPercent: listenerDim,
          blurPx: listenerBlur,
        });
      }

      const stageSettings = buildStageSettings({
        fontFamilyId,
        fontSizePx,
        lineHeight,
        columnWidthPercent,
        readingBandCenterPercent,
        mirrorX,
        mirrorY,
        pastDimming,
        phraseHighlight,
        background: stageBackground === 'high-contrast' ? '#000000' : '#050505',
      });

      // Spec §52: remember this appearance for this display. Fire-and-forget
      // with an explicit catch — a preference that fails to save must never
      // stop a take from starting.
      const profileFingerprint = selectedFingerprint;
      if (profileFingerprint !== null) {
        void saveDisplayProfile(
          buildDisplayProfile(
            display?.name ?? 'Stage display',
            profileFingerprint,
            stageSettings,
            listener?.geometry,
            rememberedProfileId ?? undefined,
          ),
        )
          .then((saved) => {
            rememberedProfileId = saved.id;
          })
          .catch(() => {
            /* remembered settings are a convenience, never a gate */
          });
      }

      // 1. Open the stage hidden on the chosen display.
      const opened = await stageService.openStage({
        displayFingerprint: selectedFingerprint,
        sessionId,
      });

      // 2. Publish the full session envelope and await the handshake.
      const assets = await resolveDocumentAssets(compiledScript);
      const envelope = buildStageEnvelope({
        script: compiledScript,
        sessionId,
        sessionGeneration,
        stageGeneration: opened.stageGeneration,
        stageSettings,
        ...(listener ? { listener } : {}),
        assets,
      });
      const ready = stageService.waitForStageReady(opened.stageGeneration);
      await stageService.publishStageDocument(sessionId, envelope);
      await ready;

      // 3. Show it (full screen unless the user opted out).
      await stageService.setStageFullscreen(sessionId, fullscreen);

      // 4. Bind the tracking worker + realtime pipeline and go live.
      startLiveSession({
        scriptId,
        scriptTitle,
        mode,
        displayLabel: display?.name ?? 'Stage display',
        outline: result?.outline ?? [],
        sentences: result?.sentences ?? [],
        totalTokens: Math.max(wordCount, 1),
        sessionId,
        compiled: compiledScript,
        sessionGeneration,
        stageGeneration: opened.stageGeneration,
        transcriptRetained: record.transcriptRetained,
        stageSettings,
        listener: listener ?? null,
        transcription: {
          model: $settings.openai.realtimeModel,
          language,
          delay: delayForLatency(),
          requestLogprobs: true,
        },
        commandSettings: {
          wakePhrase: $settings.commands.wakePhrase,
          wakeAliases: [
            $settings.commands.wakePhrase.toLowerCase(),
            ...$settings.commands.wakeAliases.map((a) => a.toLowerCase()),
          ],
          wakeMode: $settings.commands.strictWake ? 'strict' : 'double_gate',
          lunaFallback: $settings.openai.commandFallback,
          commandModel: $settings.openai.commandModel,
        },
        commandsEnabled: commandListening && $settings.commands.enabled,
        following: $settings.following,
        // "Follow system default" means exactly that: no pinned device id, so
        // the pipeline opens (and keeps following) the system input.
        ...(followSystemDefault ? {} : { micDeviceId }),
        audioProcessing: {
          echoCancellation: $settings.audio.echoCancellation,
          noiseSuppression: $settings.audio.noiseSuppression,
          autoGainControl: $settings.audio.autoGainControl,
        },
      });
      const arrived = await navigate({ name: 'live', sessionId, scriptId });
      if (!arrived) {
        // A guard vetoed the move. The session is already live behind this
        // screen — tear it down rather than leave the mic, the worker and the
        // billing meter running under a Preflight page.
        await abandonSession(sessionId);
        startError = 'Could not open the Live screen, so the session was stopped.';
      }
    } catch (err) {
      await abandonSession(sessionId);
      startError = `Could not start the session: ${describeError(err)}`;
    } finally {
      starting = false;
    }
  }

  /**
   * Undo a partially-started session. `closeStage` alone left the tracking
   * worker, the realtime transport, the microphone capture, the billing meter,
   * the elapsed clock and the heartbeat all running.
   */
  async function abandonSession(sessionId: string): Promise<void> {
    stopSession();
    clearSession();
    // The record may have been opened before the failure. Closing it twice is
    // harmless (it rewrites `ended_at`); leaving it open is not — an unfinished
    // row is indistinguishable from a crash and would be closed at next launch.
    if (sessionId) await endSessionRecord(sessionId).catch(() => {});
    if (sessionId) await stageService.closeStage(sessionId).catch(() => {});
  }

  function sectionTone(status: CheckStatus): PillTone {
    switch (status) {
      case 'ready':
        return 'success';
      case 'warning':
        return 'warning';
      case 'blocked':
        return 'danger';
      case 'checking':
        return 'neutral';
      default:
        return 'neutral';
    }
  }

  /* F.10 status labels per check row. */
  function sectionLabel(row: 'script' | 'openai' | 'mic' | 'stage' | 'listener', status: CheckStatus): string {
    const table = {
      script: { checking: 'Compiling…', ready: 'Script ready', problem: 'Script needs attention' },
      openai: { checking: 'Connecting…', ready: 'OpenAI ready', problem: 'OpenAI unavailable' },
      mic: { checking: 'Testing…', ready: 'Microphone ready', problem: 'Microphone unavailable' },
      stage: { checking: 'Opening…', ready: 'Stage ready', problem: 'Stage display unavailable' },
      listener: { checking: 'Loading…', ready: 'Listener ready', problem: 'Listener unavailable' },
    } as const;
    const entry = table[row];
    if (status === 'checking') return entry.checking;
    if (status === 'ready' || status === 'warning') return entry.ready;
    if (status === 'blocked') return entry.problem;
    return 'Not checked yet';
  }
</script>

<div class="page">
  <PageHeader
    title={scriptTitle || 'Preflight'}
    meta={wordCount > 0 ? `${formatSpeakingDuration(durationSeconds)} at a natural pace` : undefined}
    backLabel="Editor"
    onback={() => navigate({ name: 'editor', scriptId })}
  >
    {#snippet status()}
      <StatusPill tone={overallTone} label={overallLabel} />
    {/snippet}
  </PageHeader>

  <div class="scroll">
    <!-- A. Stage display -->
    <Section
      title="Stage display"
      description="Select the display placed next to or inside your teleprompter."
    >
      {#snippet actions()}
        <StatusPill
          tone={sectionTone($preflightChecks.stage)}
          label={sectionLabel('stage', $preflightChecks.stage)}
        />
      {/snippet}
      <div class="display-grid">
        {#each displays as display (display.fingerprint)}
          <button
            type="button"
            class="monitor-tile"
            class:selected={selectedFingerprint === display.fingerprint}
            onclick={() => selectDisplay(display.fingerprint)}
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
      <div class="row-actions">
        <Button onclick={() => identifyDisplays()}>Identify displays</Button>
        <Button disabled={!selectedFingerprint || stageTesting} onclick={() => runDisplayTest(false)}>
          {stageTesting ? 'Opening…' : 'Show test on this display'}
        </Button>
        <Button variant="ghost" disabled={!selectedFingerprint} onclick={() => runDisplayTest(true)}>
          Open stage preview
        </Button>
        {#if stageValidated}
          <span class="validated"><Icon name="check" size={14} /> Stage opened on the selected display</span>
        {/if}
      </div>
      {#if stageError}
        <p class="inline-alert" role="alert">{stageError}</p>
        <div class="row-actions">
          <Button disabled={stageTesting} onclick={() => loadDisplays()}>
            Check displays again
          </Button>
        </div>
      {/if}
      <div class="toggle-grid">
        <Toggle bind:checked={fullscreen} label="Full screen" />
        <!-- The stage window is created always-on-top and re-asserts it on
             every show (§52.7); there is no command to turn that off, so the
             switch is shown as the fixed behaviour it is rather than a lie. -->
        <Toggle
          checked={true}
          disabled
          label="Always on top"
          description="Always on in this release — the stage must sit above other windows"
        />
        <Toggle bind:checked={mirrorX} label="Horizontal mirror" />
        <Toggle bind:checked={mirrorY} label="Vertical mirror" />
      </div>
    </Section>

    <!-- B. OpenAI connection -->
    <Section
      title="OpenAI connection"
      description="CandidCue is bring-your-own-key. Your key is stored in your operating system's secure credential store and is used directly from this app. CandidCue does not send it to CandidCue servers."
    >
      {#snippet actions()}
        <StatusPill
          tone={sectionTone($preflightChecks.openai)}
          label={sectionLabel('openai', $preflightChecks.openai)}
        />
      {/snippet}
      {#if !keyStatus?.present || replacingKey}
        <div class="key-form">
          <TextField
            bind:value={keyField}
            type="password"
            label="OpenAI API key"
            placeholder="sk-…"
            hint="Voice tracking uses OpenAI Realtime transcription. Smart command interpretation and vocabulary analysis use GPT-5.6 Luna. A dedicated project key is recommended."
            onsubmit={() => void saveAndTestKey()}
          />
          <div class="row-actions">
            <Button variant="primary" disabled={keyBusy || keyField.trim() === ''} onclick={() => saveAndTestKey()}>
              {keyBusy ? 'Validating…' : 'Save and test'}
            </Button>
            {#if replacingKey}
              <Button variant="ghost" onclick={() => (replacingKey = false)}>Cancel</Button>
            {:else}
              <Button variant="ghost" onclick={() => (mode = 'manual')}>Use manual mode for now</Button>
            {/if}
            <Button
              variant="ghost"
              onclick={() => openExternal('https://platform.openai.com/api-keys')}
            >
              <Icon name="external" size={14} />
              OpenAI API keys
            </Button>
          </div>
        </div>
      {:else}
        <div class="key-row">
          <span class="key-mask">••••••••{keyStatus.lastFour ?? '····'}</span>
          <div class="row-actions">
            <Button size="sm" disabled={keyBusy} onclick={() => testConnection()}>Test connection</Button>
            <Button size="sm" onclick={() => (replacingKey = true)}>Replace</Button>
            <Button variant="danger" size="sm" onclick={() => removeKey()}>Remove</Button>
          </div>
        </div>
      {/if}
      {#if keyMessage}
        <p class="key-message {keyMessage.tone}">{keyMessage.text}</p>
      {/if}
      {#if openAiError}
        <p class="inline-alert" role="alert">{openAiError}</p>
        <div class="row-actions">
          <Button disabled={keyBusy} onclick={() => refreshKeyStatus()}>Try again</Button>
        </div>
      {/if}
    </Section>

    <!-- C. Microphone -->
    <Section
      title="Microphone"
      description="CandidCue uses your microphone only while a test or voice-tracking session is active. During voice tracking, audio is sent to OpenAI for live transcription. Audio is not recorded or saved by CandidCue by default."
    >
      {#snippet actions()}
        <StatusPill
          tone={sectionTone($preflightChecks.microphone)}
          label={sectionLabel('mic', $preflightChecks.microphone)}
        />
      {/snippet}
      {#if micPermission === 'unknown'}
        <div class="row-actions">
          <Button variant="primary" onclick={() => allowMicrophone()}>Allow and choose microphone</Button>
          <Button variant="ghost" onclick={() => (mode = mode === 'voice' ? 'manual' : mode)}>Not now</Button>
        </div>
      {:else if micPermission === 'denied'}
        <p class="denied" role="alert">
          Microphone access is blocked. Allow CandidCue in your system privacy settings, then try
          again.
        </p>
        <div class="row-actions">
          <!-- Names the remedy rather than repeating the failed attempt. -->
          <Button onclick={() => allowMicrophone()}>Fix microphone access</Button>
          <Button variant="ghost" onclick={() => (mode = mode === 'voice' ? 'manual' : mode)}>
            Use manual mode for now
          </Button>
        </div>
      {:else}
        <div class="mic-grid">
          <Select
            label="Input device"
            value={micDeviceId ?? ''}
            disabled={followSystemDefault}
            options={micDevices.map((d) => ({ value: d.deviceId, label: d.label }))}
            onchange={(value) => (micDeviceId = value)}
          />
          <!-- Persisted AND honoured at Start: following the system default
               means the session pins no device id at all. -->
          <Toggle
            bind:checked={followSystemDefault}
            label="Follow system default"
            description="Use whichever input macOS is set to, including changes mid-session"
            onchange={(value) => void patchSettings('audio', { followSystemDefault: value })}
          />
        </div>
        <MicMeter level={micLevel} />
        <div class="row-actions">
          <Button onclick={() => runTranscriptionTest()} disabled={micTest === 'listening' || micTest === 'waiting'}>
            Test transcription
          </Button>
          {#if micTest !== 'idle'}
            <span class="mic-test-state" aria-live="polite">
              {#if micTest === 'listening'}
                Say: “CandidCue is following my voice.” — Listening…
              {:else if micTest === 'waiting'}
                Audio detected. Waiting for transcription…
              {:else}
                Transcription is working.
              {/if}
            </span>
          {/if}
        </div>
        {#if micPartial || micFinal}
          <p class="transcript" class:final={Boolean(micFinal)}>{micFinal || micPartial}</p>
        {/if}
        <!-- §28.3 capture processing. These are the saved audio settings and
             they are applied to the session's getUserMedia constraints at
             Start; they were previously hardcoded switches nothing read. -->
        <Disclosure label="Advanced audio processing">
          <div class="toggle-grid">
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
          </div>
        </Disclosure>
      {/if}
      {#if micError}
        <!-- Outside the permission branches: a failure while asking for access
             (or while the row still reads 'unknown') has to be visible too. -->
        <p class="inline-alert" role="alert">{micError}</p>
      {/if}
    </Section>

    <!-- D. Voice tracking -->
    <Section title="Voice tracking" description="How the stage follows you.">
      <div class="tracking-grid">
        <div class="labeled">
          <span class="mini-label">Mode</span>
          <SegmentedControl
            label="Tracking mode"
            options={[
              { value: 'voice', label: 'Voice follow' },
              { value: 'manual', label: 'Manual' },
              { value: 'fixed', label: 'Fixed speed' },
            ]}
            bind:value={mode}
          />
        </div>
        <div class="labeled">
          <span class="mini-label">Latency</span>
          <SegmentedControl
            label="Latency preset"
            options={[
              { value: 'fast', label: 'Fast' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'accurate', label: 'Accurate' },
            ]}
            bind:value={latency}
          />
        </div>
        <Select
          label="Language"
          bind:value={language}
          options={[
            { value: 'en', label: 'English' },
            { value: 'de', label: 'German' },
            { value: 'es', label: 'Spanish' },
            { value: 'fr', label: 'French' },
          ]}
        />
      </div>
      <div class="toggle-grid">
        <Toggle bind:checked={readHeadings} label="Read headings aloud" description="Track heading text as spoken words" />
        <Toggle
          bind:checked={commandListening}
          label="Voice commands"
          description={`Wake phrase: “${$settings.commands.wakePhrase}”`}
        />
      </div>
      {#if mode === 'voice'}
        <!-- Companion §47 subset that matters before a session; the rest lives
             in Settings → Following. Changes save immediately and apply to
             this session. -->
        <Disclosure label="Following feel and intelligent assist">
          <FollowSettingsFields
            compact
            following={$settings.following}
            onchange={(patch) => void patchSettings('following', patch)}
          />
        </Disclosure>
      {/if}
    </Section>

    <!-- E. Appearance -->
    <Section
      title="Appearance"
      description="These apply to the stage when the session starts. Use Open stage preview above to see them on the display."
    >
      <div class="appearance-grid">
        <Select
          label="Font family"
          bind:value={fontFamilyId}
          options={[
            { value: 'system-sans', label: 'System Sans' },
            { value: 'humanist-sans', label: 'Humanist Sans' },
            { value: 'serif', label: 'Serif' },
            { value: 'monospace', label: 'Monospace' },
          ]}
        />
        <Select
          label="Stage background"
          bind:value={stageBackground}
          options={[
            { value: 'near-black', label: 'Near black' },
            { value: 'high-contrast', label: 'High contrast black' },
          ]}
        />
        <Slider label="Font size" bind:value={fontSizePx} min={24} max={160} format={(v) => `${v} px`} />
        <Slider
          label="Line height"
          bind:value={lineHeight}
          min={1.05}
          max={1.8}
          step={0.01}
          format={(v) => v.toFixed(2)}
        />
        <Slider label="Text column width" bind:value={columnWidthPercent} min={40} max={100} format={(v) => `${v}%`} />
        <!-- `StageSettings` carries no horizontal offset, so there is nothing
             to send: shown disabled rather than live-looking and inert. -->
        <Slider
          label="Horizontal offset"
          bind:value={horizontalOffsetPercent}
          min={-20}
          max={20}
          disabled
          format={(v) => `${v}%`}
        />
        <Slider
          label="Reading band position"
          bind:value={readingBandCenterPercent}
          min={20}
          max={70}
          format={(v) => `${v}%`}
        />
      </div>
      <div class="toggle-grid">
        <Toggle bind:checked={phraseHighlight} label="Current phrase highlight" />
        <Toggle bind:checked={pastDimming} label="Past-text dimming" />
        <Toggle
          bind:checked={focusFade}
          label="Top/bottom focus fade"
          description="Not adjustable yet — the stage applies its own fade"
          disabled
        />
      </div>
      <p class="field-note">
        Horizontal offset and the focus fade are not part of the stage settings this release sends;
        both use the stage's own values.
      </p>
    </Section>

    <!-- F. Listener -->
    <Section
      title="Listener"
      description="A Listener is a silent looping person behind the script. They do not hear you, respond, or use your camera. The purpose is simply to give you someone to look at while you speak."
    >
      {#snippet actions()}
        {#if listenerEnabled}
          <StatusPill
            tone={sectionTone($preflightChecks.listener)}
            label={sectionLabel('listener', $preflightChecks.listener)}
          />
        {/if}
      {/snippet}
      <div class="listener-row">
        <button
          type="button"
          class="listener-tile"
          class:selected={listenerPack === 'none'}
          onclick={() => {
            listenerPack = 'none';
            listenerEnabled = false;
          }}
        >
          <span class="listener-thumb none"><Icon name="eye-off" size={20} /></span>
          <span class="listener-name">None</span>
        </button>
        <button
          type="button"
          class="listener-tile"
          class:selected={listenerPack === 'mira'}
          onclick={() => {
            listenerPack = 'mira';
            listenerEnabled = true;
          }}
        >
          <span class="listener-thumb"><Icon name="user" size={20} /></span>
          <span class="listener-name">Mira</span>
          <span class="listener-meta">Installed</span>
        </button>
        <Button variant="ghost" disabled title="Listener packs arrive with the catalogue service">
          Browse Listener packs
        </Button>
      </div>
      {#if listenerEnabled}
        <!-- Every Listener control lives here (spec §14.2 F): dim, blur,
             scale, and horizontal/vertical position. Scale is bound to
             ListenerGeometry (cropZoom = defaultZoom × scale%) and the
             position sliders are cropX/cropY offsets as a percent of the
             visible frame; their range is the scale-derived safe window, so
             scaling up is what buys room to move her. -->
        <div class="appearance-grid">
          <Slider label="Dim" bind:value={listenerDim} min={0} max={80} format={(v) => `${v}%`} />
          <Slider label="Blur" bind:value={listenerBlur} min={0} max={24} format={(v) => `${v} px`} />
          <Slider label="Scale" bind:value={listenerScale} min={60} max={160} format={(v) => `${v}%`} />
          <Slider
            label="Horizontal position"
            bind:value={listenerX}
            min={-listenerOffsetBound}
            max={listenerOffsetBound}
            step={0.1}
            disabled={listenerOffsetBound === 0}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
          />
          <Slider
            label="Vertical position"
            bind:value={listenerY}
            min={-listenerOffsetBound}
            max={listenerOffsetBound}
            step={0.1}
            disabled={listenerOffsetBound === 0}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
          />
          {#if listenerOffsetBound === 0}
            <p class="field-note">Scale past 100% to gain room to move Mira around the frame.</p>
          {/if}
        </div>
        <Toggle checked={true} disabled label="Random playback" description="Always on in this release" />
      {/if}
    </Section>

    <!-- G. Script readiness -->
    <Section title="Script readiness" description="What the compiler found in this script.">
      {#snippet actions()}
        <StatusPill
          tone={sectionTone($preflightChecks.script)}
          label={sectionLabel('script', $preflightChecks.script)}
        />
      {/snippet}
      {#if scriptError}
        <p class="inline-alert" role="alert">{scriptError}</p>
        <div class="row-actions">
          <Button onclick={() => loadScript()}>Try again</Button>
        </div>
      {/if}
      <p class="readiness-meta">
        {wordCount.toLocaleString()} spoken words · {formatSpeakingDuration(durationSeconds)} at a
        natural pace
      </p>
      {#if diagnostics.length > 0}
        <ul class="readiness-list">
          {#each diagnostics as diagnostic (diagnostic.code + String(diagnostic.source?.utf16Start ?? ''))}
            <li class="readiness-item {diagnostic.severity}">
              <Icon name={diagnostic.severity === 'error' ? 'alert' : 'info'} size={14} />
              <span>{diagnostic.message}</span>
            </li>
          {/each}
        </ul>
      {:else if $compiled.status === 'ready'}
        <p class="readiness-ok"><Icon name="check" size={14} /> Script compiled and ready to present.</p>
      {/if}
    </Section>
  </div>

  <!-- Sticky footer (spec §14.3) -->
  <footer class="footer">
    {#if startError}
      <span class="inline-alert" role="alert">{startError}</span>
    {:else}
      <span class="summary">{$preflightReadiness.summary}</span>
    {/if}
    <div class="footer-actions">
      {#if !$preflightReadiness.canStart && $preflightReadiness.blockedReason}
        <span class="blocked-reason">{$preflightReadiness.blockedReason}</span>
      {/if}
      <Button variant="ghost" onclick={() => navigate({ name: 'editor', scriptId })}>Cancel</Button>
      <Button
        variant="primary"
        disabled={!$preflightReadiness.canStart || starting}
        onclick={() => startSession()}
      >
        {starting ? 'Preparing stage…' : $preflightReadiness.startLabel}
      </Button>
    </div>
  </footer>
</div>

<style>
  .page {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-6) var(--page-x) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    max-width: 860px;
  }

  .row-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
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

  .validated {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-meta);
    font-weight: 600;
    color: var(--success);
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

  /* --- OpenAI --- */
  .key-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 520px;
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
  .key-message {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }
  .key-message.success {
    color: var(--success);
  }
  .key-message.warning {
    color: var(--warning);
  }
  .key-message.danger {
    color: var(--danger);
  }

  /* --- mic --- */
  .mic-grid {
    display: grid;
    grid-template-columns: minmax(0, 320px) auto;
    align-items: end;
    gap: var(--space-4);
  }
  .denied {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--danger);
  }
  .mic-test-state {
    font-size: var(--text-sm);
    color: var(--text-secondary);
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

  /* --- tracking + appearance --- */
  .tracking-grid {
    display: flex;
    align-items: end;
    gap: var(--space-5);
    flex-wrap: wrap;
  }
  .labeled {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .mini-label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .appearance-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-4) var(--space-6);
  }
  .field-note {
    grid-column: 1 / -1;
    margin: 0;
    font-size: var(--text-label);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }

  /* --- listener --- */
  .listener-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .listener-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    width: 108px;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .listener-tile:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover-surface);
  }
  .listener-tile.selected,
  .listener-tile.selected:hover {
    border-color: var(--border-strong);
    background: var(--accent-wash);
  }
  .listener-thumb {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--bg-secondary);
    color: var(--text-muted);
  }
  .listener-tile.selected .listener-thumb {
    color: var(--accent);
  }
  .listener-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .listener-meta {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }

  /* --- readiness --- */
  .readiness-meta {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .readiness-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .readiness-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
  }
  .readiness-item.error {
    color: var(--danger);
  }
  .readiness-item.warning {
    color: var(--warning);
  }
  .readiness-item.info {
    color: var(--text-muted);
  }
  .readiness-ok {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--success);
  }

  /* --- sticky footer --- */
  .footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--page-x);
    background: var(--bg-canvas);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-transport);
  }
  .summary {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .footer-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .blocked-reason {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
