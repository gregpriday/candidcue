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
  action?: { label: string; settingsSection?: SettingsSection };
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
   * The microphone Settings pins, and whether it is present right now.
   *
   * Null when nothing is pinned, which is the "follow the system default"
   * case — not a problem, and not reported as one.
   */
  pinnedMicLabel: string | null;
  pinnedMicAvailable: boolean;
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
      findings.push({
        id: 'model_unsupported',
        severity: 'warning',
        label: 'Voice following',
        detail:
          'This build cannot load the selected speech model, so this take cannot follow your voice.',
        action: { label: 'Choose a language', settingsSection: 'speech' },
      });
    } else if (!input.modelInstalled && input.modelDamaged) {
      // A warning for the same reason as a missing model, below. Said as what
      // it is: "no model is installed" would be news to somebody who
      // downloaded one, and "install" is not quite the remedy.
      findings.push({
        id: 'model_damaged',
        severity: 'warning',
        label: 'Voice following',
        detail:
          'The speech data on this computer is damaged, so this take cannot follow your voice.',
        action: { label: 'Download it again', settingsSection: 'speech' },
      });
    } else if (!input.modelInstalled) {
      /*
       * WARNING, not blocking. A take with no model still rolls at a fixed pace
       * and can be driven by hand, and somebody who is already on camera is
       * better served by a take that works differently than by no take at all.
       */
      findings.push({
        id: 'model_missing',
        severity: 'warning',
        label: 'Voice following',
        detail: 'No speech model is installed, so this take cannot follow your voice.',
        action: { label: 'Install a language', settingsSection: 'speech' },
      });
    }

    /*
     * Only a PINNED microphone can go missing. "Follow the system default" is
     * the ordinary configuration and has nothing to report — reporting it would
     * put a row on every take of every user who never opened audio settings.
     */
    if (input.pinnedMicLabel !== null && !input.pinnedMicAvailable) {
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
