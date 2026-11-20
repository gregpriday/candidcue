/**
 * S6 — the stage half of the §62 layout failure.
 *
 * The stage measures its rendered layout into a line map and, if a bounded
 * rebuild is still unusable, HOLDS motion rather than move on guessed line
 * positions. It says so on its own diagnostics overlay (`layout: HELD`).
 *
 * The separate stage window used to report the failure to Rust as well, for a
 * relay to control that no control code ever listened for; a take renders the
 * stage embedded in the control window, where there is no event hop to make.
 * That emit is gone (#235). What this file still pins is that the renderer
 * reports both the failure and its recovery, and that the stage keeps the issue
 * codes for its overlay.
 *
 * Source assertions, deliberately: the callback runs inside the script layer's
 * measurement pass, which needs real layout that jsdom does not have.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const stageApp = source('../../../src/stage/StageApp.svelte');
const scriptLayer = source('../../../src/stage/renderer/ScriptLayer.svelte');

describe('the stage holds on a §62 layout failure and says so', () => {
  it('routes the renderer callback to the overlay, and reports nothing control does not read', () => {
    expect(stageApp).toContain('onlayouterror={handleLayoutError}');
    const handler = stageApp.slice(stageApp.indexOf('function handleLayoutError'));
    const body = handler.slice(0, handler.indexOf('\n  }'));
    expect(body).toContain('layoutIssues = issues');
    expect(body).not.toContain('emitStageEvent');
    expect(stageApp).not.toContain('STAGE_EVENT.layoutError');
    expect(stageApp).not.toContain('STAGE_EVENT.layoutFailed');
    // And the overlay draws them.
    expect(stageApp).toContain("layout: HELD ({layoutIssues.join(', ')})");
  });

  it('reports the recovery as well as the failure', () => {
    // A §62 error is recoverable. The renderer already resets its own retry
    // bookkeeping on a good rebuild; it must also say so, or control keeps
    // showing "motion is held" for a stage that is fine.
    const recovery = scriptLayer.slice(scriptLayer.indexOf('      mapRetries = 0;'));
    expect(recovery.slice(0, recovery.indexOf('\n  }'))).toContain('onlayouterror?.([])');
  });

  it('still reports the fatal issue codes on the way in', () => {
    // The operator's notice quotes these; an empty list means recovery, so the
    // failing branch must never send one.
    expect(scriptLayer).toContain(
      "onlayouterror?.(next.issues.filter((i) => i.fatal).map((i) => i.code));",
    );
  });
});
