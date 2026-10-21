/**
 * Conditional take readiness (CCUX-013) — mostly a test of RESTRAINT.
 *
 * The old Preflight page was removed because it repeated one-time choices,
 * users skipped it, and it became a gate they did not understand. The opposite
 * extreme makes the most expensive moment in the product — after the creator is
 * in position, or already recording — the first time they find out the model is
 * missing or the script has nothing speakable in it.
 *
 * So the rule is that a healthy familiar setup launches immediately, every
 * time, and everything else is subordinate to it. Most of what follows checks
 * that the sheet stays SHUT, because a readiness surface that appears on
 * ordinary takes becomes a reflex click, and the one time it mattered is the
 * time it was dismissed unread.
 */
import { describe, expect, it } from 'vitest';
import {
  hasReadinessWarnings,
  microphoneAccessFinding,
  resolveReadiness,
  summariseReadiness,
  voiceModelFinding,
  type ReadinessFinding,
  type ReadinessInput,
  type ReadinessVerdict,
} from '../../../src/control/lib/take-readiness';

/** A healthy voice take on a familiar rig. Each test breaks one thing. */
function ready(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    voiceTake: true,
    modelInstalled: true,
    modelSupported: true,
    pinnedMicLabel: null,
    pinnedMicAvailable: true,
    spokenWordCount: 800,
    blockingDiagnostics: 0,
    destinationMismatch: null,
    requested: false,
    ...over,
  };
}

describe('resolveReadiness', () => {
  it('stays out of the way of a healthy take', () => {
    const verdict = resolveReadiness(ready());
    expect(verdict.show).toBe(false);
    expect(verdict.blocked).toBe(false);
    expect(verdict.findings).toEqual([]);
  });

  it('says nothing about following the system default input', () => {
    // No pinned device is the ordinary configuration, not a degradation. A row
    // here would appear for every user who never opened audio settings.
    expect(resolveReadiness(ready({ pinnedMicLabel: null })).show).toBe(false);
  });

  it('says nothing about a manual take having no model or microphone', () => {
    // Neither is used. Reporting their absence is reporting the absence of a
    // subsystem the take never starts.
    const verdict = resolveReadiness(
      ready({ voiceTake: false, modelInstalled: false, pinnedMicLabel: 'Gone', pinnedMicAvailable: false }),
    );
    expect(verdict.show).toBe(false);
  });

  /* -------------------------------------------------------------------- *
   * When it must speak
   * -------------------------------------------------------------------- */

  it('blocks a script with nothing to say', () => {
    /*
     * The one condition that makes a take meaningless rather than degraded: the
     * stage opens, the aligner gets an empty token list, and every readout
     * reports health over a take that could never have followed anything.
     */
    const verdict = resolveReadiness(ready({ spokenWordCount: 0 }));
    expect(verdict.blocked).toBe(true);
    expect(verdict.show).toBe(true);
    expect(verdict.findings[0]!.detail).toMatch(/no spoken words/i);
  });

  it('blocks a script that will not render', () => {
    const verdict = resolveReadiness(ready({ blockingDiagnostics: 2 }));
    expect(verdict.blocked).toBe(true);
    expect(verdict.findings[0]!.detail).toContain('2 problems');
  });

  it('counts one blocking problem in the singular', () => {
    expect(resolveReadiness(ready({ blockingDiagnostics: 1 })).findings[0]!.detail).toMatch(
      /^One problem/,
    );
  });

  it('warns about a missing model without blocking the take', () => {
    /*
     * A take with no model still rolls at a fixed pace and can be driven by
     * hand. Somebody already on camera is better served by a take that works
     * differently than by no take at all.
     */
    const verdict = resolveReadiness(ready({ modelInstalled: false }));
    expect(verdict.show).toBe(true);
    expect(verdict.blocked).toBe(false);
  });

  /*
   * #258: a download damaged after install is not "no model installed" — the
   * person reading this downloaded one — and its remedy is to download it
   * again. Still a warning: the take rolls without voice following.
   */
  it('names a damaged model as damaged, not missing, and does not block', () => {
    const verdict = resolveReadiness(ready({ modelInstalled: false, modelDamaged: true }));
    expect(verdict.blocked).toBe(false);
    expect(verdict.findings.map((f) => f.id)).toEqual(['model_damaged']);
    const [finding] = verdict.findings;
    expect(finding?.detail).toMatch(/damaged/);
    expect(finding?.detail).not.toMatch(/No speech model is installed/);
    expect(finding?.action?.settingsSection).toBe('speech');
  });

  it('keeps the missing-model wording when damage is not known', () => {
    const verdict = resolveReadiness(ready({ modelInstalled: false, modelDamaged: false }));
    expect(verdict.findings.map((f) => f.id)).toEqual(['model_missing']);
  });

  /*
   * #301: "No speech model is installed" is true for the length of a download
   * and reads as though nobody had started one. Still a warning — the take
   * would roll without following, and the presenter may not want to wait.
   */
  it('says an installing model is installing, and does not block', () => {
    const verdict = resolveReadiness(ready({ modelInstalled: false, modelInstalling: true }));
    expect(verdict.blocked).toBe(false);
    expect(verdict.findings.map((f) => f.id)).toEqual(['model_installing']);
    expect(verdict.findings[0]?.detail).toMatch(/still installing/);
    expect(verdict.findings[0]?.action?.settingsSection).toBe('speech');
  });

  it('calls a repair of a damaged download installing, while it runs', () => {
    const verdict = resolveReadiness(
      ready({ modelInstalled: false, modelDamaged: true, modelInstalling: true }),
    );
    expect(verdict.findings.map((f) => f.id)).toEqual(['model_installing']);
  });

  it('says nothing while a usable copy is in place, even mid-install', () => {
    const verdict = resolveReadiness(ready({ modelInstalled: true, modelInstalling: true }));
    expect(verdict.show).toBe(false);
  });

  it('warns about an unloadable model without blocking the take', () => {
    /*
     * This blocked at first, reasoning that no user action fixes it in place.
     * True of the MODEL and false of the TAKE: an unloadable recogniser leaves
     * exactly the take a missing model leaves — one that rolls at a pace and is
     * driven by hand. Blocking removed Start anyway and made this a gate over a
     * take the product supports.
     */
    const verdict = resolveReadiness(ready({ modelSupported: false }));
    expect(verdict.show).toBe(true);
    expect(verdict.blocked).toBe(false);
  });

  it('warns when a pinned microphone has gone, and says what will happen', () => {
    const verdict = resolveReadiness(
      ready({ pinnedMicLabel: 'RØDE NT-USB Mini', pinnedMicAvailable: false }),
    );
    expect(verdict.show).toBe(true);
    expect(verdict.blocked).toBe(false);
    const finding = verdict.findings.find((f) => f.id === 'mic_missing')!;
    expect(finding.detail).toContain('RØDE NT-USB Mini');
    // What it will DO, not just what is missing. A row that only reports a
    // fault leaves the presenter guessing whether the take is worth starting.
    expect(finding.detail).toMatch(/system default/i);
  });

  it('carries the destination mismatch through rather than re-deriving it', () => {
    const verdict = resolveReadiness(
      ready({ destinationMismatch: { title: 'This take will open on Built-in.', suggestion: 'Drag it.' } }),
    );
    expect(verdict.findings.find((f) => f.id === 'destination')!.detail).toContain('Built-in');
  });

  it('opens on request even when everything is fine', () => {
    // "Review take setup" must show the same list a fault would, or the review
    // screen and the gate are two different opinions about one setup.
    const verdict = resolveReadiness(ready({ requested: true }));
    expect(verdict.show).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('is not opened by information alone', () => {
    /*
     * `info` deliberately does not trigger the sheet. The failure mode of this
     * feature is scope creep — somebody adds a helpful context row and the sheet
     * quietly starts appearing on every take — so the severity that means
     * "context" cannot open it by construction.
     */
    const verdict = resolveReadiness(ready());
    expect(verdict.findings.every((f) => f.severity !== 'info')).toBe(true);
    expect(verdict.show).toBe(false);
  });

  it('reports several conditions at once', () => {
    const verdict = resolveReadiness(
      ready({
        modelInstalled: false,
        pinnedMicLabel: 'USB mic',
        pinnedMicAvailable: false,
        destinationMismatch: { title: 'Opens on Built-in.', suggestion: 'Drag it.' },
      }),
    );
    expect(verdict.findings.map((f) => f.id)).toEqual(['model_missing', 'mic_missing', 'destination']);
    expect(verdict.blocked).toBe(false);
  });
});

describe('the sheet cannot become a gate', () => {
  /*
   * The regression this guards is specific and was real: `wordCount` comes off
   * the EDITOR's debounced compile, and mid-compile it reads zero — which is a
   * BLOCKING finding. Wired unconditionally, that refuses to present a
   * perfectly good script for as long as somebody had recently typed in it.
   *
   * The caller now passes optimistic values while the compile is unsettled.
   * These assert the property that makes that safe: only a KNOWN-empty script
   * blocks, and a script with words never does.
   */
  it('blocks only on a script known to be empty', () => {
    expect(resolveReadiness(ready({ spokenWordCount: 1 })).blocked).toBe(false);
    expect(resolveReadiness(ready({ spokenWordCount: 0 })).blocked).toBe(true);
  });

  it('never blocks a healthy take for any device or display condition', () => {
    // Everything else on this surface is launch-past-able by construction.
    for (const modelInstalled of [true, false]) {
      for (const modelSupported of [true, false]) {
        for (const modelInstalling of [true, false]) {
          for (const pinnedMicAvailable of [true, false]) {
            for (const destinationMismatch of [null, { title: 'x', suggestion: 'y' }]) {
              const verdict = resolveReadiness(
                ready({
                  modelInstalled,
                  modelSupported,
                  modelInstalling,
                  pinnedMicLabel: 'Mic',
                  pinnedMicAvailable,
                  destinationMismatch,
                }),
              );
              expect(
                verdict.blocked,
                JSON.stringify({
                  modelInstalled,
                  modelSupported,
                  modelInstalling,
                  pinnedMicAvailable,
                }),
              ).toBe(false);
            }
          }
        }
      }
    }
  });
});

/*
 * #301: the editor's footer said "Ready to present." off the compile alone,
 * beside a sheet saying the take could not follow a voice. Both now ask
 * `voiceModelFinding`, so they say the same thing.
 */
describe('voiceModelFinding', () => {
  it('is what the sheet shows for a voice take', () => {
    const cases: Array<Partial<ReadinessInput>> = [
      { modelInstalled: false },
      { modelInstalled: false, modelDamaged: true },
      { modelInstalled: false, modelInstalling: true },
      { modelSupported: false },
    ];
    for (const over of cases) {
      const input = ready(over);
      expect(voiceModelFinding(input), JSON.stringify(over)).toEqual(
        resolveReadiness(input).findings[0],
      );
    }
  });

  it('is null for a model that can follow', () => {
    expect(voiceModelFinding(ready())).toBeNull();
  });
});

describe('summariseReadiness', () => {
  it('says what is true rather than counting rows', () => {
    // "2 issues" makes somebody count, and the count is not the decision.
    expect(summariseReadiness(resolveReadiness(ready({ spokenWordCount: 0 })))).toMatch(
      /cannot start/i,
    );
    expect(summariseReadiness(resolveReadiness(ready({ modelInstalled: false })))).toMatch(
      /can start/i,
    );
    expect(summariseReadiness(resolveReadiness(ready({ requested: true })))).toMatch(/ready/i);
  });

  it('calls an information-only sheet ready', () => {
    // Nothing emits `info` yet, so the verdict is built by hand: a context row
    // must not turn "ready" into "not everything is set up".
    expect(summariseReadiness(verdictOf([finding('info')]))).toBe(
      'Everything needed for this take is ready.',
    );
  });

  it('puts a block ahead of any warning beside it', () => {
    const verdict = resolveReadiness(ready({ spokenWordCount: 0, modelInstalled: false }));
    expect(hasReadinessWarnings(verdict)).toBe(true);
    expect(summariseReadiness(verdict)).toBe('This take cannot start as it is.');
  });
});

/** A hand-built finding, for severities the resolver does not emit today. */
function finding(severity: ReadinessFinding['severity']): ReadinessFinding {
  return { id: `${severity}-row`, severity, label: 'Row', detail: 'Detail.' };
}

function verdictOf(findings: ReadinessFinding[]): ReadinessVerdict {
  return { show: true, blocked: findings.some((f) => f.severity === 'blocking'), findings };
}

describe('hasReadinessWarnings', () => {
  /*
   * The sheet's start button reads "Start anyway" on this and "Present"
   * without it (#283), so it has to agree with the summary line above it: a
   * sheet that says everything is ready must not offer to start "anyway".
   */
  it('is false for a reviewed healthy setup', () => {
    const verdict = resolveReadiness(ready({ requested: true }));
    expect(verdict.show).toBe(true);
    expect(hasReadinessWarnings(verdict)).toBe(false);
  });

  it('is true when the sheet is warning about something', () => {
    expect(hasReadinessWarnings(resolveReadiness(ready({ modelInstalled: false })))).toBe(true);
    expect(hasReadinessWarnings(verdictOf([finding('info'), finding('warning')]))).toBe(true);
  });

  it('does not count context rows as warnings', () => {
    expect(hasReadinessWarnings(verdictOf([finding('info')]))).toBe(false);
  });

  it('does not count a block as a warning', () => {
    // The blocked case is decided by `blocked`, which the button checks first.
    expect(hasReadinessWarnings(verdictOf([finding('blocking')]))).toBe(false);
  });
});

/*
 * #303 — the OS's answer about the microphone, before the window becomes the
 * prompter. A first take used to meet the macOS prompt over the prompter, and a
 * refused one learned it only after Present had already reshaped the window.
 */
describe('microphone access', () => {
  it('says nothing when access is granted, or the platform cannot say', () => {
    // `unsupported` is not a refusal. A sheet on every take for everybody whose
    // OS is silent is the reflex click this module exists to avoid.
    for (const micPermission of ['granted', 'unsupported', undefined] as const) {
      const verdict = resolveReadiness(ready({ micPermission }));
      expect(verdict.show, String(micPermission)).toBe(false);
      expect(verdict.findings).toEqual([]);
    }
  });

  it('warns about a refusal, with the pane as the remedy — never blocks', () => {
    const verdict = resolveReadiness(ready({ micPermission: 'denied' }));
    expect(verdict.show).toBe(true);
    expect(verdict.blocked).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    const [finding] = verdict.findings;
    expect(finding!.id).toBe('mic_permission_denied');
    expect(finding!.severity).toBe('warning');
    expect(finding!.detail).toContain('System Settings');
    expect(finding!.action).toEqual({ label: 'Open System Settings', microphone: 'privacy' });
  });

  it('names a policy restriction as one, with the same pane', () => {
    const verdict = resolveReadiness(ready({ micPermission: 'restricted' }));
    expect(verdict.blocked).toBe(false);
    expect(verdict.findings[0]!.id).toBe('mic_permission_restricted');
    expect(verdict.findings[0]!.detail).toMatch(/restricted/i);
    expect(verdict.findings[0]!.action?.microphone).toBe('privacy');
  });

  it('offers to ask before the take, for a microphone never asked for', () => {
    const verdict = resolveReadiness(ready({ micPermission: 'prompt' }));
    expect(verdict.show).toBe(true);
    expect(verdict.blocked).toBe(false);
    expect(verdict.findings[0]!.id).toBe('mic_permission_prompt');
    expect(verdict.findings[0]!.action).toEqual({ label: 'Allow microphone', microphone: 'allow' });
  });

  it('says nothing about access in a manual take', () => {
    expect(resolveReadiness(ready({ voiceTake: false, micPermission: 'denied' })).show).toBe(false);
  });

  /*
   * The platform is named, never inferred from the host: this suite runs as a
   * Mac everywhere (tests/setup/node-platform.ts), so the Windows and Linux
   * sentences are only tested at all because these pass the platform in.
   */
  it('sends Windows to the switches it actually has, and never to a relaunch', () => {
    const denied = microphoneAccessFinding('denied', 'windows')!;
    expect(denied.action).toEqual({ label: 'Open Windows Settings', microphone: 'privacy' });
    expect(denied.detail).toContain('Windows Settings → Privacy & security → Microphone');
    expect(denied.detail).toContain('“Let desktop apps access your microphone”');
    // Windows caches nothing: reopening Speaking Glass changes nothing there.
    expect(denied.detail).not.toMatch(/reopen|quit/i);

    const restricted = microphoneAccessFinding('restricted', 'windows')!;
    expect(restricted.id).toBe('mic_permission_restricted');
    expect(restricted.detail).toMatch(/whole PC/);
    expect(restricted.action?.label).toBe('Open Windows Settings');

    for (const finding of [denied, restricted]) {
      expect(finding.detail).not.toMatch(/macOS|\bMac\b|System Settings|Screen Time/);
    }
  });

  it('promises no pane, path or prompt where the platform is unknown', () => {
    const denied = microphoneAccessFinding('denied', 'linux')!;
    expect(denied.detail).toContain('your system settings');
    expect(denied.detail).not.toMatch(/macOS|Windows|\bMac\b|→/);
    expect(microphoneAccessFinding('prompt', 'linux')!.detail).not.toMatch(/asks here/);
  });

  it('does not call a pinned microphone missing while access is the problem', () => {
    // Without access the webview lists inputs with no labels or stable ids, so
    // the pin cannot be matched — "not connected" would blame the hardware.
    const verdict = resolveReadiness(
      ready({ micPermission: 'denied', pinnedMicLabel: 'Shure MV7', pinnedMicAvailable: false }),
    );
    expect(verdict.findings.map((f) => f.id)).toEqual(['mic_permission_denied']);
    // And with access granted, a missing pin is still reported.
    const granted = resolveReadiness(
      ready({ micPermission: 'granted', pinnedMicLabel: 'Shure MV7', pinnedMicAvailable: false }),
    );
    expect(granted.findings.map((f) => f.id)).toEqual(['mic_missing']);
  });
});
