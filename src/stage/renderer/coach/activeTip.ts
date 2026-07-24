/**
 * §9 active coaching tip.
 *
 * The load-bearing property here is self-expiry. The stage owns the tip's
 * *display* window even though control owns its selection: a control side that
 * stalls, deadlocks, or dies mid-take must not be able to leave text sitting on
 * the presenter's glass for the rest of the session. `CoachStrip` got this
 * right with a single timer and the behaviour survives here in a form that can
 * actually be tested — the whole lifecycle is a pure function of the tip and
 * the current audio time, so "control never sends another snapshot" is just
 * "call update again with a later time".
 *
 * Copy never comes from the payload's own strings: the tip carries a `code` and
 * a `textKey`, and the authored catalog resolves them. A snapshot that somehow
 * arrived carrying model prose therefore cannot render it (§25).
 */
import type { CoachRailTip, CoachTipSeverity } from '../../../shared/contracts/coaching';
import { COACH_TIP_CATALOG, renderTipText } from '../../../shared/coaching/coach/tip-catalog';

export interface ActiveTipView {
  tipId: string;
  code: string;
  text: string;
  severity: CoachTipSeverity;
}

/**
 * Authored copy for a tip, or `null` when the code is not in the catalog.
 *
 * The `Record<CoachTipCode, …>` type makes an unknown code impossible in
 * well-typed code; this guard exists for the payload that arrives over IPC,
 * where the type is a claim rather than a fact.
 */
export function tipText(tip: CoachRailTip): string | null {
  const definition = COACH_TIP_CATALOG[tip.code] as (typeof COACH_TIP_CATALOG)[typeof tip.code] | undefined;
  if (!definition) return null;
  const known =
    definition.primary.textKey === tip.textKey || definition.alternate?.textKey === tip.textKey;
  // An unrecognised key falls back to the code's primary copy rather than
  // rendering nothing: the tip was legitimately selected, only its variant is
  // unknown to this build.
  const resolved = {
    code: tip.code,
    textKey: known ? tip.textKey : definition.primary.textKey,
    interpolations: tip.interpolations,
  };
  const text = renderTipText(resolved);
  return text.length > 0 ? text : null;
}

/**
 * Stateful only in what it has already shown. `update` is idempotent for a
 * fixed `nowAudioMs`.
 */
export class ActiveTipPresenter {
  private tipId: string | null = null;
  private shownAtMs: number | null = null;
  private retired = false;

  /**
   * @param tip           the snapshot's `activeTip`
   * @param nowAudioMs    the rail's audio-clock estimate
   * @param criticalOnly  §6.2 / §6.5: modes that withhold ordinary coaching
   */
  update(tip: CoachRailTip | null, nowAudioMs: number, criticalOnly = false): ActiveTipView | null {
    if (tip === null) return null;
    if (tip.tipId !== this.tipId) {
      // §9.1: a new tip replaces the old outright. Nothing stacks, and the
      // outgoing tip's minimum display does not delay the incoming one — a
      // queue of stale advice is worse than a hard cut.
      this.tipId = tip.tipId;
      this.shownAtMs = null;
      this.retired = false;
    }
    if (this.retired) return null;
    if (criticalOnly && tip.severity !== 'critical') return null;
    // Not yet at a safe display opportunity (§9.4). Control chose the moment;
    // the stage only refuses to pre-empt it.
    if (nowAudioMs < tip.earliestDisplayMs) return null;

    if (this.shownAtMs === null) {
      // §9.3: a tip that went stale before it was ever displayed is dropped
      // unshown. Late advice about a sentence the presenter has left behind is
      // worse than silence (§2.6).
      if (nowAudioMs >= tip.expiresAudioTimeMs) {
        this.retired = true;
        return null;
      }
      this.shownAtMs = nowAudioMs;
    }

    const elapsed = nowAudioMs - this.shownAtMs;
    if (elapsed >= tip.maximumDisplayMs) {
      this.retired = true;
      return null;
    }
    // Expiry retires the tip, but never before it has had its minimum display:
    // a tip that flashes for 200 ms is unreadable and costs more than it gives.
    if (nowAudioMs >= tip.expiresAudioTimeMs && elapsed >= tip.minimumDisplayMs) {
      this.retired = true;
      return null;
    }

    const text = tipText(tip);
    if (text === null) return null;
    return { tipId: tip.tipId, code: tip.code, text, severity: tip.severity };
  }
}
