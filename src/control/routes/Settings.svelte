<!--
  Settings (spec §18). The Inworld key field is one-shot and masked — it
  submits through the secrets service, is stored in the OS credential store,
  and is never displayed or returned to JavaScript (§18.2). Privacy copy is
  Appendix F.18 verbatim.

  This screen is now the ONLY place a take is configured. There used to be a
  Preflight page that asked the same questions again, one screen before every
  session — the display, the microphone, the tracking mode, the type, the
  Listener — and answering them twice meant one of the two answers silently
  stopped mattering. Present opens the stage from what is set here
  (lib/start-take.ts).
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../components/Button.svelte';
  import Disclosure from '../components/Disclosure.svelte';
  import FollowSettingsFields from '../components/FollowSettingsFields.svelte';
  import Icon from '../components/Icon.svelte';
  import MicMeter from '../components/MicMeter.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Section from '../components/Section.svelte';
  import Select from '../components/Select.svelte';
  import Slider from '../components/Slider.svelte';
  import StatusPill from '../components/StatusPill.svelte';
  import TextField from '../components/TextField.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { openExternal } from '../lib/app-actions';
  import { chooseStageDisplay } from '../lib/start-take';
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
  import { BackendUnavailableError } from '../services/ipc';
  import {
    DOWNLOADS_SUPPORTED,
    DOWNLOADS_UNAVAILABLE_NOTE,
    formatPackSize,
    getListenerCatalogue,
    mergeCatalogue,
    removeListener,
    type ListenerPackRow,
  } from '../services/listeners-catalogue';
  import {
    listInstalledListeners,
    resolveListenerMedia,
    type InstalledListener,
  } from '../services/listeners';
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
  import * as secretsService from '../services/secrets';
  import * as settingsService from '../services/settings';
  import * as stageService from '../services/stage';
  import { SPEECH_LANGUAGES } from '../services/stt/inworld';
  import { getVoiceFacade } from '../services/voice-facade';
  import { offsetSliderBound } from '../../shared/listener/geometry';
  import {
    LISTENER_PLACEMENTS,
    listenerLensTarget,
    listenerOverlapsScriptColumn,
    listenerPlacementBox,
    listenerPlacementDescriptor,
  } from '../../shared/listener/placement';
  import type { DisplayDescriptor } from '../services/stage-types';
  import type { InworldKeyStatus } from '../services/secrets-types';
  import type { StageBackground } from '../services/settings-types';
  import type {
    AudioDeviceInfo,
    AudioLevelSnapshot,
    ListenerPlacementMode,
  } from '../../shared/contracts';
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
    { id: 'inworld', label: 'Speech' },
    { id: 'audio', label: 'Audio' },
    { id: 'stage', label: 'Stage display' },
    { id: 'teleprompter', label: 'Teleprompter' },
    { id: 'following', label: 'Following' },
    { id: 'listeners', label: 'Listeners' },
    { id: 'privacy', label: 'Data, privacy & updates' },
  ];

  let keyStatus = $state<InworldKeyStatus | null>(null);
  let keyField = $state('');
  let keyBusy = $state(false);
  let keyNote = $state('');
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
    void secretsService.getInworldKeyStatus().then((status) => (keyStatus = status));
  });

  let packs = $state<ListenerPackRow[]>([]);
  let packsError = $state<string | null>(null);
  let packsLoading = $state(false);
  /**
   * What is on disk, read independently of the catalogue.
   *
   * The catalogue supplies descriptions, posters and sizes and is allowed to
   * fail; the installed list is the authority on what can actually be put on a
   * stage. Deriving the PICKER from the merged rows made a catalogue failure
   * look like "no Listeners installed" — which is the same class of lie as a
   * setting that is written and never read, since choosing a Listener is now
   * the only way one reaches a take.
   */
  let installedPacks = $state<InstalledListener[]>([]);

  /**
   * The remembered pack, named. `defaultPackId` is what a take opens with, so
   * naming it here is the only place the user can see what "automatically"
   * means — and the only way an unexpected Listener has a visible cause.
   */
  const rememberedPackLabel = $derived.by(() => {
    const packId = $settings.listeners.defaultPackId;
    if (packId === null) return null;
    return (
      packs.find((p) => p.packId === packId)?.displayName ??
      installedPacks.find((p) => p.packId === packId)?.displayName ??
      packId
    );
  });

  /** Diagnostics are only fetched for the screen that shows them (§47.10). */
  $effect(() => {
    if (section === 'privacy') void loadDiagnostics();
  });

  $effect(() => {
    if (section === 'listeners') void loadPacks();
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

  $effect(() => {
    if (section === 'stage') void loadDisplays();
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
      await stageService.setStageFullscreen(testSessionId, $settings.stage.fullscreen);
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

  /* ------------------------------------------------------ listener framing */

  const framing = $derived($settings.listenerFraming);
  /** The installed pack that is remembered — its version resolves the media. */
  const framingPack = $derived(
    installedPacks.find((p) => p.packId === $settings.listeners.defaultPackId) ?? null,
  );

  /*
   * Listener framing range (src/shared/listener/geometry.ts). The position
   * sliders are percent of the visible frame, and the travel that exists at all
   * is bought by the zoom: clips are object-fit: cover, so at zoom z there is
   * only (z-1)/2 of the frame to spend on each side before the media edge shows
   * as a black bar. The range therefore GROWS WITH ZOOM.
   */
  const LISTENER_FALLBACK_ZOOM = 1.15;
  let listenerDefaultZoom = $state(LISTENER_FALLBACK_ZOOM);
  $effect(() => {
    const packId = $settings.listeners.defaultPackId;
    const version = framingPack?.version ?? '1.0.0';
    if (packId === null || section !== 'listeners') return undefined;
    /*
     * Reset before resolving, never after.
     *
     * The zoom is per-PACK, and it decides how far the position sliders can
     * travel. Leaving the previous pack's value in place while the new one
     * resolves — or keeping it when the lookup fails — offers a range the pack
     * does not have, and the offsets it lets you save are the ones the stage
     * then clamps back. The slider and the glass would quietly disagree.
     */
    listenerDefaultZoom = LISTENER_FALLBACK_ZOOM;
    let cancelled = false;
    void resolveListenerMedia(packId, version)
      .then((media) => {
        if (!cancelled && media.defaultZoom > 0) listenerDefaultZoom = media.defaultZoom;
      })
      .catch(() => {
        /* keep the fallback zoom; the take resolves the real media anyway */
      });
    return () => {
      cancelled = true;
    };
  });

  const listenerCropZoom = $derived(listenerDefaultZoom * (framing.zoomPercent / 100));
  const listenerOffsetBound = $derived(offsetSliderBound(listenerCropZoom));
  const listenerPlacementInfo = $derived(listenerPlacementDescriptor(framing.placement));
  const listenerPreviewGeometry = $derived({
    anchorX: listenerPlacementInfo.anchorX,
    anchorY: listenerPlacementInfo.anchorY,
    scale: framing.sizePercent / 100,
    cropX: framing.offsetXPercent,
    cropY: framing.offsetYPercent,
    cropZoom: listenerCropZoom,
    mirrorVideo: framing.mirrorVideo,
  });
  const listenerPreviewBox = $derived(
    listenerPlacementBox(framing.placement, listenerPreviewGeometry),
  );
  const listenerPreviewTarget = $derived(
    listenerLensTarget(framing.placement, listenerPreviewGeometry),
  );
  const listenerColumnOverlap = $derived(
    listenerOverlapsScriptColumn(
      framing.placement,
      $settings.teleprompter.columnWidthPercent,
      listenerPreviewGeometry,
    ),
  );

  /**
   * Clamp the position sliders when the zoom shrinks the window they move in.
   *
   * The bound is derived from the zoom, so lowering the zoom can leave a saved
   * offset outside it — which the stage renders as a black bar down one side of
   * the Listener rather than as an error.
   */
  function patchFraming(patch: Partial<typeof framing>): void {
    const next = { ...framing, ...patch };
    const bound = offsetSliderBound(listenerDefaultZoom * (next.zoomPercent / 100));
    next.offsetXPercent = clampOffset(next.offsetXPercent, bound);
    next.offsetYPercent = clampOffset(next.offsetYPercent, bound);
    void patchSettings('listenerFraming', next);
  }

  function clampOffset(value: number, bound: number): number {
    return Math.abs(value) > bound ? Math.sign(value) * bound : value;
  }

  async function loadPacks(): Promise<void> {
    packsLoading = true;
    packsError = null;
    try {
      // The installed list is the authority on what is on disk; the catalogue
      // supplies the description, poster and size.
      const installed = await listInstalledListeners();
      installedPacks = installed.filter((p) => p.state === 'installed');
      const catalogue = await getListenerCatalogue();
      packs = mergeCatalogue(catalogue, installed);
    } catch (err) {
      // The installed list above may have succeeded; only the catalogue half is
      // cleared, so the picker still offers what is genuinely on disk.
      packs = [];
      packsError = describeError(err);
    } finally {
      packsLoading = false;
    }
  }

  async function removePack(pack: ListenerPackRow): Promise<void> {
    const accepted = await requestConfirm({
      title: `Remove ${pack.displayName}?`,
      body: 'The downloaded media is deleted from this device. Scripts are unaffected.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!accepted) return;
    await runMaintenance(
      () => removeListener(pack.packId, pack.version),
      () => `${pack.displayName} removed`,
    );
    await loadPacks();
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

  async function submitKey(): Promise<void> {
    const candidate = keyField.trim();
    if (!candidate) return;
    keyBusy = true;
    keyNote = '';
    try {
      const validation = await secretsService.validateInworldKey(candidate);
      if (validation.status === 'valid') {
        keyStatus = await secretsService.saveInworldKey(candidate);
        keyNote = 'Key saved. Voice tracking is ready.';
      } else if (validation.status === 'quota') {
        keyNote = 'The key is valid, but the Inworld account has no available quota.';
      } else if (validation.status === 'network') {
        keyNote = 'CandidCue could not reach Inworld to check the key. Check your connection and try again.';
      } else {
        keyNote = validation.message ?? 'Inworld rejected this key. Check that it is active.';
      }
    } catch (err) {
      // Rust refuses the save outright when a development build is running with
      // INWORLD_API_KEY set, and its message says so; showing it beats an
      // unhandled rejection and a field that silently clears.
      keyNote = describeError(err);
    } finally {
      keyField = ''; // one-shot: purge the plaintext after submission
      keyBusy = false;
    }
  }

  /**
   * Ask Inworld whether the stored key still works.
   *
   * This used to re-read the local key STATUS, which can only say "a key is
   * stored" — the one thing the screen was already showing. A key that has
   * been revoked since it was saved looked identical to a working one, and the
   * first the presenter heard of it was a take that transcribed nothing. There
   * is no command that validates the stored key without exposing it, so this
   * round-trips through Rust's own `validate` path using the key it holds.
   */
  async function testKey(): Promise<void> {
    keyBusy = true;
    keyNote = '';
    try {
      const result = await secretsService.testStoredInworldKey();
      keyNote =
        result.status === 'valid'
          ? 'The key works. Inworld answered.'
          : result.status === 'quota'
            ? 'The key is valid, but the Inworld account has no available quota.'
            : result.status === 'network'
              ? 'Could not reach Inworld. Check your connection and try again.'
              : (result.message ?? 'Inworld rejected the stored key.');
      keyStatus = await secretsService.getInworldKeyStatus();
    } catch (err) {
      keyNote = describeError(err);
    } finally {
      keyBusy = false;
    }
  }

  async function removeKey(): Promise<void> {
    // Removing the stored key does not — and cannot — unset an environment
    // override, so promising that following will stop would be false whenever
    // one is in play.
    const fromEnvironment = keyStatus?.source === 'environment';
    const accepted = await requestConfirm({
      title: 'Remove Inworld key?',
      body: fromEnvironment
        ? 'This clears the key stored in your credential store. The INWORLD_API_KEY environment variable is outside CandidCue’s reach, so voice tracking will keep using it. Your scripts are unaffected.'
        : 'Voice tracking will stop until a key is added again. Your scripts are unaffected.',
      confirmLabel: 'Remove key',
      danger: true,
    });
    if (!accepted) return;
    await secretsService.deleteInworldKey();
    keyStatus = await secretsService.getInworldKeyStatus();
    keyNote = '';
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
          <Select
            label="Default session mode"
            value={$settings.general.defaultSessionMode}
            options={[
              { value: 'voice', label: 'Voice follow' },
              { value: 'manual', label: 'Manual' },
              { value: 'fixed', label: 'Fixed speed' },
            ]}
            onchange={(value) =>
              void patchSettings('general', {
                defaultSessionMode: value as 'voice' | 'manual' | 'fixed',
              })}
          />
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
      {:else if section === 'inworld'}
        <Section
          title="Speech"
          description="CandidCue transcribes with Inworld and is bring-your-own-key. The key is stored in your operating system's secure credential store and is read only by CandidCue's backend — it never reaches the app's interface, and the transcription connection is made from there."
        >
          {#snippet actions()}
            {#if keyStatus?.present}
              <StatusPill
                tone={keyStatus.state === 'connected' ? 'success' : 'warning'}
                label={keyStatus.state === 'connected' ? 'Connected' : 'Needs attention'}
              />
            {:else}
              <StatusPill tone="neutral" label="No key stored" />
            {/if}
          {/snippet}

          {#if keyStatus?.source === 'environment'}
            <p class="hint-line">
              This development build is using the key from the <code>INWORLD_API_KEY</code>
              environment variable. It takes precedence over the credential store, so a key saved
              here would have no effect until you unset it.
            </p>
          {/if}

          {#if keyStatus?.present}
            <div class="key-row">
              <span class="key-mask">••••••••{keyStatus.lastFour ?? '····'}</span>
              <div class="row-actions">
                <Button size="sm" disabled={keyBusy} onclick={() => void testKey()}>
                  {keyBusy ? 'Checking…' : 'Test key'}
                </Button>
                <Button variant="danger" size="sm" onclick={() => removeKey()}>Remove</Button>
              </div>
            </div>
            {#if keyStatus.source !== 'environment'}
              <p class="hint-line">To replace the key, enter a new one below. The stored key is never displayed.</p>
            {/if}
          {/if}
          <div class="key-form">
            <TextField
              bind:value={keyField}
              type="password"
              label="Inworld API key"
              placeholder="Paste your Inworld key"
              hint="Used for streaming speech-to-text while you present. Nothing else is sent."
              onsubmit={() => void submitKey()}
            />
            <div class="row-actions">
              <Button variant="primary" disabled={keyBusy || keyField.trim() === ''} onclick={() => submitKey()}>
                {keyBusy ? 'Validating…' : 'Validate and save'}
              </Button>
              <Button variant="ghost" onclick={() => openExternal('https://platform.inworld.ai/')}>
                Inworld dashboard
              </Button>
            </div>
            {#if keyNote}<p class="hint-line">{keyNote}</p>{/if}
          </div>

          <Select
            label="Transcription model"
            value={$settings.inworld.transcriptionModel}
            options={[{ value: 'inworld/inworld-stt-1', label: 'inworld-stt-1 (default)' }]}
            onchange={(value) => void patchSettings('inworld', { transcriptionModel: value })}
          />
          <Select
            label="Spoken language"
            value={$settings.inworld.language}
            options={SPEECH_LANGUAGES}
            onchange={(value) => void patchSettings('inworld', { language: value })}
          />
          <p class="hint-line">
            Audio is streamed to Inworld only while a take is running, and only the words that come
            back are used. Usage is billed by Inworld at their published rates.
          </p>
        </Section>
      {:else if section === 'audio'}
        <Section
          title="Microphone"
          description="CandidCue uses your microphone only while a test or a voice-tracking take is running. During voice tracking, audio is streamed to Inworld for live transcription. Audio is not recorded or saved by CandidCue."
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
              A billable Inworld session, so it says so while it is open, it can
              always be stopped, and it closes itself if it is forgotten (see
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
                Connected to Inworld and billing your key. It stops on its own after 30 seconds with
                nothing transcribed, and after two minutes in any case.
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
          <div class="toggle-grid">
            <Toggle
              checked={$settings.stage.fullscreen}
              label="Full screen"
              onchange={(value) => void patchSettings('stage', { fullscreen: value })}
            />
            <!-- The stage window is created always-on-top and re-asserts it on
                 every show (§52.7); there is no command to turn that off, so it
                 is shown as the fixed behaviour it is rather than as a lie. -->
            <Toggle
              checked={true}
              disabled
              label="Always on top"
              description="Always on in this release — the stage must sit above other windows"
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
      {:else if section === 'teleprompter'}
        <Section title="Teleprompter">
          <Select
            label="Default font family"
            value={$settings.teleprompter.fontFamilyId}
            options={[
              { value: 'system-sans', label: 'System Sans' },
              { value: 'humanist-sans', label: 'Humanist Sans' },
              { value: 'serif', label: 'Serif' },
              { value: 'monospace', label: 'Monospace' },
            ]}
            onchange={(value) => void patchSettings('teleprompter', { fontFamilyId: value })}
          />
          <Select
            label="Stage background"
            value={$settings.teleprompter.background}
            options={[
              { value: 'near-black', label: 'Near black' },
              { value: 'high-contrast', label: 'High contrast black' },
            ]}
            onchange={(value) =>
              void patchSettings('teleprompter', { background: value as StageBackground })}
          />
          <Slider
            label="Default font size"
            value={$settings.teleprompter.fontSizePx}
            min={24}
            max={160}
            format={(v) => `${v} px`}
            onchange={(value) => void patchSettings('teleprompter', { fontSizePx: value })}
          />
          <Slider
            label="Line height"
            value={$settings.teleprompter.lineHeight}
            min={1.05}
            max={1.8}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onchange={(value) => void patchSettings('teleprompter', { lineHeight: value })}
          />
          <Slider
            label="Text column width"
            value={$settings.teleprompter.columnWidthPercent}
            min={40}
            max={100}
            format={(v) => `${v}%`}
            onchange={(value) => void patchSettings('teleprompter', { columnWidthPercent: value })}
          />
          <Slider
            label="Reading band position"
            value={$settings.teleprompter.readingBandCenterPercent}
            min={20}
            max={70}
            format={(v) => `${v}%`}
            onchange={(value) =>
              void patchSettings('teleprompter', { readingBandCenterPercent: value })}
          />
          <Slider
            label="Fixed-speed default"
            value={$settings.teleprompter.fixedSpeedWpm}
            min={60}
            max={260}
            format={(v) => `${v} wpm`}
            onchange={(value) => void patchSettings('teleprompter', { fixedSpeedWpm: value })}
          />
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
      {:else if section === 'listeners'}
        <Section
          title="Listeners"
          description="A Listener is a silent looping person behind the script. Installed packs are stored on this device."
        >
          {#snippet actions()}
            <Button size="sm" disabled={packsLoading} onclick={() => void loadPacks()}>
              {packsLoading ? 'Loading…' : 'Refresh'}
            </Button>
          {/snippet}

          {#if packsError}
            <p class="hint-line">{packsError}</p>
          {:else if packsLoading && packs.length === 0}
            <p class="hint-line">Loading Listener packs…</p>
          {:else if packs.length === 0}
            <p class="hint-line">No Listener packs are available on this device.</p>
          {:else}
            <ul class="packs">
              {#each packs as pack (pack.packId + pack.version)}
                <li class="pack">
                  <div class="pack-text">
                    <span class="pack-name">{pack.displayName}</span>
                    <span class="pack-desc">{pack.description}</span>
                    <span class="pack-meta">
                      {pack.statusLabel} · v{pack.version}
                      {#if formatPackSize(pack.approximateBytes)}
                        · {formatPackSize(pack.approximateBytes)}
                      {/if}
                    </span>
                  </div>
                  <!--
                    No download button: `download_listener` is an honest
                    NOT_IMPLEMENTED stub in this build, and a control that
                    silently does nothing is worse than an absent one.
                  -->
                  {#if pack.removable}
                    <Button variant="danger" size="sm" onclick={() => void removePack(pack)}>
                      Remove
                    </Button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if !DOWNLOADS_SUPPORTED}
            <p class="hint-line">{DOWNLOADS_UNAVAILABLE_NOTE}</p>
          {/if}
          <!--
            These are the values every take runs with — there is no per-session
            Listener picker any more, so this toggle and the remembered pack ARE
            the decision. Choosing a pack here is what puts a person on the
            stage; nothing else does.
          -->
          <Select
            label="Listener"
            value={$settings.listeners.defaultPackId ?? ''}
            options={[
              { value: '', label: 'None' },
              ...installedPacks.map((p) => ({ value: p.packId, label: p.displayName })),
            ]}
            onchange={(value) =>
              void patchSettings('listeners', {
                defaultPackId: value === '' ? null : value,
                // Choosing a person and then not showing them is not a state
                // anyone means to be in; clearing the choice turns it off.
                autoplay: value !== '',
              })}
          />
          <Toggle
            checked={$settings.listeners.autoplay}
            disabled={$settings.listeners.defaultPackId === null}
            label="Turn the Listener on automatically"
            description={rememberedPackLabel
              ? `Every take opens with ${rememberedPackLabel} on the stage.`
              : 'Choose a Listener above to turn this on.'}
            onchange={(value) => void patchSettings('listeners', { autoplay: value })}
          />
          <Slider
            label="Default dim"
            value={$settings.listeners.dimPercent}
            min={0}
            max={80}
            format={(v) => `${v}%`}
            onchange={(value) => void patchSettings('listeners', { dimPercent: value })}
          />
          <Slider
            label="Default blur"
            value={$settings.listeners.blurPx}
            min={0}
            max={24}
            format={(v) => `${v} px`}
            onchange={(value) => void patchSettings('listeners', { blurPx: value })}
          />
          <Slider
            label="Default colour"
            value={Math.round($settings.listeners.saturation * 100)}
            min={0}
            max={100}
            format={(v) => (v === 0 ? 'Black and white' : `${v}%`)}
            onchange={(value) => void patchSettings('listeners', { saturation: value / 100 })}
          />
          <!--
            §37.4. `keepListener` on the stage `blank` directive was hard-coded
            false, so blanking always took the person with it. The two reasons
            to blank want opposite things — clearing a shared screen wants the
            face gone, blanking between takes on a lens rig wants it to stay —
            which is what makes this a preference rather than a constant.
            The session reads it when it builds the directive.
          -->
          <Toggle
            checked={$settings.listeners.keepWhenBlanked}
            label="Keep the Listener when the stage is blanked"
            description="Blanking always hides the script. With this on, the person stays on screen."
            onchange={(value) => void patchSettings('listeners', { keepWhenBlanked: value })}
          />

          {#if $settings.listeners.defaultPackId !== null}
            <!--
              Placement (§37.4). Four of these five modes existed only as CSS:
              the producer hard-coded 'background', so nothing could reach them.
              The copy is written around EYELINE rather than layout, because
              that is the decision — a teleprompter Listener is a place to look,
              and the lens modes exist so the presenter can look at a face
              beside the lens instead of through the text.
            -->
            <Disclosure label="Framing and placement">
              <div class="placement">
                <div class="placement-choices" role="radiogroup" aria-label="Listener placement">
                  {#each LISTENER_PLACEMENTS as option (option.id)}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={framing.placement === option.id}
                      class="placement-option"
                      class:selected={framing.placement === option.id}
                      onclick={() => patchFraming({ placement: option.id as ListenerPlacementMode })}
                    >
                      <span class="placement-label">{option.label}</span>
                      <span class="placement-summary">{option.summary}</span>
                    </button>
                  {/each}
                </div>
                <!--
                  The diagram is drawn from the same `listenerPlacementBox` the
                  stage layer positions itself with, and the marker from
                  `listenerLensTarget`, so it cannot describe a layout the stage
                  does not produce.
                -->
                <div class="placement-preview">
                  <div class="stage-mini" aria-hidden="true">
                    <div
                      class="mini-box"
                      class:pip={framing.placement === 'pip'}
                      style:left="{listenerPreviewBox.left * 100}%"
                      style:top="{listenerPreviewBox.top * 100}%"
                      style:width="{listenerPreviewBox.width * 100}%"
                      style:height="{listenerPreviewBox.height * 100}%"
                      style:opacity={Math.max(0.15, 1 - $settings.listeners.dimPercent / 100)}
                    ></div>
                    <!-- Drawn at the column width actually configured under
                         Teleprompter, so the overlap the note describes is the
                         overlap shown. -->
                    <div
                      class="mini-script"
                      style:left="{(100 - $settings.teleprompter.columnWidthPercent) / 2}%"
                      style:right="{(100 - $settings.teleprompter.columnWidthPercent) / 2}%"
                    ></div>
                    <div
                      class="mini-target"
                      style:left="{listenerPreviewTarget.x * 100}%"
                      style:top="{listenerPreviewTarget.y * 100}%"
                    ></div>
                  </div>
                  <p class="hint-line">{listenerPlacementInfo.eyeline}</p>
                  {#if listenerColumnOverlap}
                    <!-- Said out loud rather than claimed away: at the default
                         column width the script really does run across a lens
                         panel. -->
                    <p class="hint-line">
                      The script column is {$settings.teleprompter.columnWidthPercent}% wide, so the
                      text runs across this panel. Narrow it under Teleprompter to keep the Listener
                      clear of the script.
                    </p>
                  {/if}
                </div>
              </div>
              {#if framing.placement !== 'background'}
                <!-- Only meaningful when the Listener has a box of her own:
                     'background' is the whole stage, so there is nothing for a
                     size to change. -->
                <Slider
                  label="Size on stage"
                  value={framing.sizePercent}
                  min={50}
                  max={200}
                  format={(v) => `${v}%`}
                  onchange={(value) => patchFraming({ sizePercent: value })}
                />
              {/if}
              <Slider
                label="Zoom"
                value={framing.zoomPercent}
                min={60}
                max={160}
                format={(v) => `${v}%`}
                onchange={(value) => patchFraming({ zoomPercent: value })}
              />
              <Slider
                label="Horizontal position"
                value={framing.offsetXPercent}
                min={-listenerOffsetBound}
                max={listenerOffsetBound}
                step={0.1}
                disabled={listenerOffsetBound === 0}
                format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                onchange={(value) => patchFraming({ offsetXPercent: value })}
              />
              <Slider
                label="Vertical position"
                value={framing.offsetYPercent}
                min={-listenerOffsetBound}
                max={listenerOffsetBound}
                step={0.1}
                disabled={listenerOffsetBound === 0}
                format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                onchange={(value) => patchFraming({ offsetYPercent: value })}
              />
              {#if listenerOffsetBound === 0}
                <p class="hint-line">
                  Zoom past 100% to gain room to move the Listener around the frame.
                </p>
              {/if}
              <!--
                Mirroring the VIDEO is independent of mirroring the script. A
                glass rig flips everything on the panel optically, so a Listener
                that reads correctly on the desk reads backwards through the
                glass; this flips the media back. It lives inside the crop
                transform, so it never inverts the position sliders
                (src/shared/listener/geometry.ts).
              -->
              <Toggle
                checked={framing.mirrorVideo}
                label="Mirror the Listener"
                description="Flips the video only. Use it on a glass rig, where the script is already mirrored."
                onchange={(value) => patchFraming({ mirrorVideo: value })}
              />
            </Disclosure>
          {/if}
        </Section>
      {:else}
        <Section title="Data, privacy & updates">
          <div class="privacy">
            <h3 class="privacy-head">Local by default</h3>
            <p class="privacy-body">
              Your Markdown scripts, imported images, settings, and downloaded Listeners are stored
              on this device.
            </p>
            <h3 class="privacy-head">While voice tracking is active</h3>
            <p class="privacy-body">
              Your selected microphone audio is streamed to Inworld for live transcription, and
              only while a take or a microphone test is running. CandidCue does not save the audio.
            </p>
            <h3 class="privacy-head">Your script stays here</h3>
            <p class="privacy-body">
              Only the audio leaves this device. The script itself is never sent anywhere — the
              matching between what you say and what you wrote is done locally, on this machine.
            </p>
            <h3 class="privacy-head">CandidCue servers</h3>
            <p class="privacy-body">
              CandidCue checks for software updates and downloads optional Listener media. Your
              Inworld API key and your scripts are not sent to CandidCue servers.
            </p>
            <h3 class="privacy-head">Inworld retention</h3>
            <p class="privacy-body">
              Inworld's current API data controls and retention rules apply to the audio sent for
              transcription.
              <button type="button" class="inline-link" onclick={() => openExternal('https://inworld.ai/privacy')}>
                Open the current policy
              </button>
              for details.
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
            <Button
              variant="ghost"
              onclick={() =>
                void runMaintenance(
                  () => settingsService.clearCache('listeners'),
                  () => 'Listener downloads cleared',
                )}
            >
              Clear Listener downloads
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

  .packs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .pack {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  .pack-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pack-name {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .pack-desc {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .pack-meta {
    font-size: var(--text-2xs);
    color: var(--text-muted);
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

  /* --- listener placement --- */
  .placement {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(200px, 260px);
    gap: var(--space-5);
    align-items: start;
  }
  .placement-choices {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .placement-option {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    text-align: left;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .placement-option:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover-surface);
  }
  .placement-option.selected,
  .placement-option.selected:hover {
    border-color: var(--border-strong);
    background: var(--accent-wash);
  }
  /* Inset bar, never a one-sided border on a rounded box. */
  .placement-option.selected::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 10px;
    bottom: 10px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .placement-label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .placement-summary {
    font-size: var(--text-2xs);
    line-height: var(--lh-label);
    color: var(--text-secondary);
  }
  .placement-preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .stage-mini {
    position: relative;
    aspect-ratio: 16 / 9;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: #0b0b0c;
    overflow: hidden;
  }
  .mini-box {
    position: absolute;
    background: var(--accent);
    transition:
      left var(--dur-fast) var(--ease-out),
      top var(--dur-fast) var(--ease-out),
      width var(--dur-fast) var(--ease-out),
      height var(--dur-fast) var(--ease-out);
  }
  .mini-box.pip {
    border-radius: 4px;
  }
  /* Where the script column sits, so the trade-off with the text is visible. */
  .mini-script {
    position: absolute;
    top: 30%;
    height: 3px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.72);
    box-shadow:
      0 10px 0 rgba(255, 255, 255, 0.4),
      0 20px 0 rgba(255, 255, 255, 0.28);
  }
  .mini-target {
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.55);
    transition:
      left var(--dur-fast) var(--ease-out),
      top var(--dur-fast) var(--ease-out);
  }
  @media (max-width: 760px) {
    .placement {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
