/**
 * Whether to say anything before a take opens, and what (CCUX-013).
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT PREFLIGHT, AND MUST NOT BECOME IT
 * ---------------------------------------------------------------------------
 * The old Preflight page was removed on purpose: it repeated one-time choices,
 * users skipped it, and it became a gate they did not understand. Present now
 * runs it and goes, which is the right rejection of a large mandatory form.
 *
 * The cost of the opposite extreme is that the most expensive moment in the
 * whole product — after the creator is in position, or has already started
 * recording externally — is the first time they discover a missing model, the
 * wrong microphone, or a script with nothing speakable in it. Those are not
 * preferences; they are conditions under which the take cannot do what was
 * asked.
 *
 * So the rule this module encodes is:
 *
 *   A HEALTHY, FAMILIAR SETUP LAUNCHES IMMEDIATELY. Every time. No sheet, no
 *   confirmation, no extra click.
 *
 * and everything else is subordinate to it. A readiness surface that appears on
 * ordinary takes is worse than none at all, because the click to dismiss it
 * becomes reflex and the one time it mattered is the time it was dismissed
 * without being read.
 *
 * Pure: facts in, findings out. No IPC, no stores, no rendering.
 */

import type { MicrophonePermission } from '../../shared/contracts';
import type { SettingsSection } from '../stores/router';

/** How serious a finding is, which decides whether it can be launched past. */
export type ReadinessSeverity =
  /** The take cannot do what was asked. Launching produces a broken take. */
  | 'blocking'
  /** Worth knowing before committing; Start anyway is always offered. */
  | 'warning'
  /** Context only. Never on its own a reason to interrupt. */
  | 'info';

export interface ReadinessFinding {
  id: string;
  severity: ReadinessSeverity;
  /** The row's label, e.g. "Voice following". */
  label: string;
  /** What is true — stated as narrowly as it is known. */
  detail: string;
  /**
   * Where to go, when there is somewhere.
   *
   * `settingsSection` is the router's own section id rather than a free string,
   * so a row cannot deep-link somewhere that does not exist — the sections are
   * a closed set and a typo would be a dead button on the one screen whose job
   * is to be actionable.
   */
  action?: {
    label: string;
    settingsSection?: SettingsSection;
    /**
     * A microphone remedy rather than a Settings section (#303). `allow` asks
     * the OS — an explicit action, so the prompt may appear, and it appears
     * here rather than over the prompter. `privacy` opens the OS pane, and the
     * sheet offers a re-check beside it for when the user comes back.
     */
    microphone?: 'allow' | 'privacy';
  };
}

export interface ReadinessInput {
  /** Voice take? A manual take needs neither model nor microphone. */
  voiceTake: boolean;
  /** Whether the chosen speech model is installed and loadable. */
  modelInstalled: boolean;
  modelSupported: boolean;
  /**
   * Whether the chosen model WAS downloaded here and has since been damaged
   * (#258) — not installed, and not something to describe as never fetched.
   * Optional so a caller that cannot tell keeps the plain "missing" wording.
   */
  modelDamaged?: boolean;
  /**
   * Whether an install of the chosen model is running right now (#301).
   * Optional for the same reason as `modelDamaged`.
   */
  modelInstalling?: boolean;
  /**
   * The microphone Settings pins, and whether it is present right now.
   *
   * Null when nothing is pinned, which is the "follow the system default"
   * case — not a problem, and not reported as one.
   */
  pinnedMicLabel: string | null;
  pinnedMicAvailable: boolean;
  /**
   * What the OS says about the microphone (#303), read without asking.
   *
   * Optional, and absent or `unsupported` says nothing: a platform that cannot
   * answer is not a platform that refused, and a sheet on every take for
   * everybody whose OS is silent would be the reflex-dismissal this module
   * exists to avoid.
   */
  micPermission?: MicrophonePermission;
  /** Words the compiler found. Zero means there is nothing to read aloud. */
  spokenWordCount: number;
  /** Compile problems that stop a document rendering at all. */
  blockingDiagnostics: number;
  /** The destination mismatch, already resolved. Null when there is none. */
  destinationMismatch: { title: string; suggestion: string } | null;
  /** The user asked for this sheet from the Present menu. */
  requested: boolean;
}

export interface ReadinessVerdict {
  /** Show the sheet? False on every healthy familiar setup. */
  show: boolean;
  /** True when nothing here can be launched past. */
  blocked: boolean;
  findings: ReadinessFinding[];
}

/**
 * Decide.
 *
 * The findings are collected unconditionally and the DECISION to show is made
 * separately, so a caller that wants the list — the requested "Review setup"
 * case — gets the same list a blocking case would produce. Two code paths
 * building two lists is how a review screen ends up disagreeing with the gate.
 */
export function resolveReadiness(input: ReadinessInput): ReadinessVerdict {
  const findings: ReadinessFinding[] = [];

  /*
   * A script with nothing speakable is the one condition that makes a take
   * meaningless rather than degraded: the stage opens, the aligner is handed an
   * empty token list, and everything reports healthy over a take that could
   * never have followed anything.
   */
  if (input.blockingDiagnostics > 0) {
    findings.push({
      id: 'script_blocked',
      severity: 'blocking',
      label: 'Script',
      detail:
        input.blockingDiagnostics === 1
          ? 'One problem stops this script being rendered.'
          : `${input.blockingDiagnostics} problems stop this script being rendered.`,
      action: { label: 'Show me' },
    });
  } else if (input.spokenWordCount === 0) {
    findings.push({
      id: 'script_silent',
      severity: 'blocking',
      label: 'Script',
      detail: 'There are no spoken words in this script, so there is nothing to follow.',
      action: { label: 'Back to the script' },
    });
  }

  if (input.voiceTake) {
    const model = voiceModelFinding(input);
    if (model !== null) findings.push(model);

    const access = microphoneAccessFinding(input.micPermission);
    if (access !== null) findings.push(access);

    /*
     * Only a PINNED microphone can go missing. "Follow the system default" is
     * the ordinary configuration and has nothing to report — reporting it would
     * put a row on every take of every user who never opened audio settings.
     *
     * And not while access is the problem: without it the webview lists inputs
     * with no labels and no stable ids, so the pin cannot be matched, and
     * "not connected" would blame hardware for what the OS withheld.
     */
    if (access === null && input.pinnedMicLabel !== null && !input.pinnedMicAvailable) {
      findings.push({
        id: 'mic_missing',
        severity: 'warning',
        label: 'Microphone',
        detail: `“${input.pinnedMicLabel}” is not connected. The take will use the system default input instead.`,
        action: { label: 'Choose an input', settingsSection: 'audio' },
      });
    }
  }

  if (input.destinationMismatch !== null) {
    findings.push({
      id: 'destination',
      severity: 'warning',
      label: 'Display',
      detail: input.destinationMismatch.title,
      action: { label: 'Prompter displays', settingsSection: 'stage' },
    });
  }

  const blocked = findings.some((f) => f.severity === 'blocking');

  /*
   * WHEN TO INTERRUPT.
   *
   * Blocking always. A request always. Otherwise only when something is
   * actually wrong — and `info` deliberately does not count, so adding a
   * context row later cannot quietly turn the sheet on for everybody.
   */
  const show =
    blocked || input.requested || findings.some((f) => f.severity === 'warning');

  return { show, blocked, findings };
}

/**
 * Why the speech model cannot follow a voice take, or null when it can.
 *
 * Its own function because the sheet is not the only thing that has to say it:
 * the editor's footer used to read "Ready to present." off the compile alone,
 * on a machine with no model at all, beside a sheet saying the opposite (#301).
 * Both now ask this, so they cannot word it — or decide it — differently.
 *
 * Not conditional on `voiceTake`; the caller decides whether a manual take
 * cares.
 */
export function voiceModelFinding(
  input: Pick<
    ReadinessInput,
    'modelInstalled' | 'modelSupported' | 'modelDamaged' | 'modelInstalling'
  >,
): ReadinessFinding | null {
  if (!input.modelSupported) {
    /*
     * WARNING, not blocking — corrected.
     *
     * It was blocking on the reasoning that no action fixes it in place, and
     * that is true of the MODEL. It is not true of the take: an unloadable
     * recogniser leaves exactly the same take a missing model leaves, one
     * that rolls at a pace and is driven by hand. Blocking it removed Start
     * anyway and made this a gate over a take the product otherwise supports,
     * which is the one thing this surface must never become.
     */
    return {
      id: 'model_unsupported',
      severity: 'warning',
      label: 'Voice following',
      detail:
        'This build cannot load the selected speech model, so this take cannot follow your voice.',
      action: { label: 'Choose a language', settingsSection: 'speech' },
    };
  }
  if (input.modelInstalled) return null;
  if (input.modelInstalling) {
    // Said as what is happening: "no model is installed" is true for the
    // length of a download and reads as though nobody had started one.
    return {
      id: 'model_installing',
      severity: 'warning',
      label: 'Voice following',
      detail:
        'The speech model is still installing, so this take cannot follow your voice yet.',
      action: { label: 'Show progress', settingsSection: 'speech' },
    };
  }
  if (input.modelDamaged) {
    // A warning for the same reason as a missing model, below. Said as what
    // it is: "no model is installed" would be news to somebody who
    // downloaded one, and "install" is not quite the remedy.
    return {
      id: 'model_damaged',
      severity: 'warning',
      label: 'Voice following',
      detail:
        'The speech data on this computer is damaged, so this take cannot follow your voice.',
      action: { label: 'Download it again', settingsSection: 'speech' },
    };
  }
  /*
   * WARNING, not blocking. A take with no model still rolls at a fixed pace
   * and can be driven by hand, and somebody who is already on camera is
   * better served by a take that works differently than by no take at all.
   */
  return {
    id: 'model_missing',
    severity: 'warning',
    label: 'Voice following',
    detail: 'No speech model is installed, so this take cannot follow your voice.',
    action: { label: 'Install a language', settingsSection: 'speech' },
  };
}

/**
 * Why this application cannot use the microphone yet, or null when nothing is
 * known to stand in the way (#303).
 *
 * WARNING, never blocking. A take with no microphone still rolls at a pace and
 * can be driven by hand, and Start anyway is how somebody who knows what they
 * are doing goes past it. What this changes is WHEN they find out: before
 * Present turns the window into the prompter, rather than from a prompt or a
 * refusal on top of it.
 */
export function microphoneAccessFinding(
  permission: MicrophonePermission | undefined,
): ReadinessFinding | null {
  switch (permission) {
    case 'denied':
      return {
        id: 'mic_permission_denied',
        severity: 'warning',
        label: 'Microphone',
        detail:
          'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. Allow it in System Settings → Privacy & Security → Microphone, then try again. If it is already allowed there, quit and reopen CandidCue.',
        action: { label: 'Open System Settings', microphone: 'privacy' },
      };
    case 'restricted':
      return {
        id: 'mic_permission_restricted',
        severity: 'warning',
        label: 'Microphone',
        detail:
          'Microphone access is restricted on this Mac, by Screen Time or a device management profile, so this take cannot follow your voice.',
        action: { label: 'Open System Settings', microphone: 'privacy' },
      };
    case 'prompt':
      return {
        id: 'mic_permission_prompt',
        severity: 'warning',
        label: 'Microphone',
        detail:
          'CandidCue has not been allowed to use the microphone yet. Allow it now, so your Mac asks here rather than over the prompter.',
        action: { label: 'Allow microphone', microphone: 'allow' },
      };
    default:
      return null;
  }
}

/**
 * A one-line summary for the sheet's header.
 *
 * Says what is true rather than how many rows there are: "2 issues" makes
 * somebody count, and the count is not the decision.
 */
export function summariseReadiness(verdict: ReadinessVerdict): string {
  if (verdict.blocked) return 'This take cannot start as it is.';
  const warnings = verdict.findings.filter((f) => f.severity === 'warning').length;
  if (warnings === 0) return 'Everything needed for this take is ready.';
  return 'This take can start, but not everything is set up.';
}
