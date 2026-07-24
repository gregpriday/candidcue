/**
 * S6 — the stage half of the §62 report.
 *
 * `onlayouterror` reached the stage's own operator overlay and stopped there:
 * there was no layout-error member in STAGE_EVENT at all, so an operator at the
 * CONTROL window — the only one with a keyboard and the rebuild action — could
 * not see that the stage was holding its motion.
 *
 * The control end of this wire is exercised behaviourally in
 * tests/unit/control/session-stage-bridge.test.ts, and the name discipline by
 * tests/unit/control/stage-event-relay.test.ts. What is left, and what this
 * file covers, is that the stage window actually reports — including the
 * recovery, without which the operator's most serious notice could never clear.
 *
 * These are source assertions, deliberately: the emit happens inside a Svelte
 * event handler in a window that cannot be mounted without a Tauri event bus,
 * and asserting the handler exists is worth more than asserting nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STAGE_EVENT } from '../../../src/shared/contracts';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

const stageApp = source('../../../src/stage/StageApp.svelte');
const scriptLayer = source('../../../src/stage/renderer/ScriptLayer.svelte');

describe('the stage reports a §62 layout failure to control', () => {
  it('routes the renderer callback through a handler that emits', () => {
    expect(stageApp).toContain('onlayouterror={handleLayoutError}');
    const handler = stageApp.slice(stageApp.indexOf('function handleLayoutError'));
    const body = handler.slice(0, handler.indexOf('\n  }'));
    expect(body).toContain('emitStageEvent<StageLayoutErrorPayload>(STAGE_EVENT.layoutError');
    // Everything control needs to gate and act on it.
    for (const field of ['stageGeneration', 'issues', 'layoutGeneration']) {
      expect(body).toContain(field);
    }
  });

  it('emits under the stage-side name, never the relayed one', () => {
    // S1: a webview emit is a broadcast, so emitting the name control listens
    // for would deliver it twice, the first time with no generation check.
    expect(stageApp).not.toContain('STAGE_EVENT.layoutFailed');
    expect(STAGE_EVENT.layoutError).toBe('stage://layout-error');
    expect(STAGE_EVENT.layoutFailed).toBe('stage://layout-failed');
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
