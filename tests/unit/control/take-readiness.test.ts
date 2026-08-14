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
  resolveReadiness,
  summariseReadiness,
  type ReadinessInput,
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

  it('blocks a model this build cannot load at all', () => {
    // Different from "not downloaded": no action by the user fixes it in place,
    // so it is not a warning with a download button behind it.
    expect(resolveReadiness(ready({ modelSupported: false })).blocked).toBe(true);
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
      for (const pinnedMicAvailable of [true, false]) {
        for (const destinationMismatch of [null, { title: 'x', suggestion: 'y' }]) {
          const verdict = resolveReadiness(
            ready({ modelInstalled, pinnedMicLabel: 'Mic', pinnedMicAvailable, destinationMismatch }),
          );
          expect(verdict.blocked, JSON.stringify({ modelInstalled, pinnedMicAvailable })).toBe(false);
        }
      }
    }
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
});
