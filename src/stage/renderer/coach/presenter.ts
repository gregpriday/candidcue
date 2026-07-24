/**
 * The Coaching Rail's view model: one `CoachRailState` in, one frame of rail in.
 *
 * Everything the rail draws is computed here, so the Svelte component stays a
 * projection with no decisions of its own and the behaviour that matters —
 * reserved geometry, the `—` that is never `0`, tip self-expiry, historical
 * placement of a late event — is testable without a DOM.
 *
 * Rule 1 (§2.1) restated where it is enforced: this module takes a
 * `CoachRailState` and returns pixels-and-strings. It has no callback, no
 * emitter, no store handle, and no import from the motion engine, the line map,
 * or the reading cursor. There is no path from here back into motion, which is
 * what makes "the stage keeps scrolling even if every coaching process dies"
 * (§5.2) a structural fact rather than a promise.
 */
import type { CoachRailState } from '../../../shared/contracts/coaching';
import { ActiveTipPresenter, type ActiveTipView } from './activeTip';
import { DeliveryScorePresenter, type DeliveryScoreView } from './deliveryScore';
import { PaceTilePresenter, sparklinePoints, type PaceTileView } from './paceTile';
import { RailClock } from './railClock';
import {
  RAIL_RIBBON_HEIGHT_PX,
  RAIL_SCRIPT_GAP_PX,
  clampRailTextScale,
  coachRailReservedHeightPx,
  modePermissions,
  resolveRailLayout,
  type RailLayout,
} from './railGeometry';
import { layoutRibbon, ribbonTypesFor, ribbonWindowMs, type RibbonMark } from './ribbon';
import {
  fillerSummaryText,
  microphoneAlertText,
  varietyTileView,
  type VarietyTileView,
} from './statusText';

/** What occupies the single centre slot. There is only ever one (§9.1). */
export type RailCentreKind = 'tip' | 'alert' | 'none';

export interface RailCentre {
  kind: RailCentreKind;
  text: string;
  /** §7.4 contrast band. `critical` is reserved for system-critical alerts. */
  tone: 'gentle' | 'important' | 'critical';
  /** Present for a tip, so the component can key its fade to the tip identity. */
  tipId: string | null;
}

export interface RailView {
  /** False only for mode `off`: the rail is not part of the layout at all. */
  present: boolean;
  /**
   * §7.1: the reserved band height. Identical whether or not `visible` is true
   * — hiding the rail fades its contents and never returns the space.
   */
  reservedHeightPx: number;
  ribbonHeightPx: number;
  scriptGapPx: number;
  /** §27: contents are faded out, geometry is not. */
  visible: boolean;
  mirrored: boolean;
  reducedMotion: boolean;
  textScale: number;
  layout: RailLayout;
  /**
   * Speaking Score report §11.1. `null` when the mode or the width does not
   * admit the score at all — which is a different thing from a score that
   * exists and is still warming up, and the view keeps them apart: a warming-up
   * score is a {@link DeliveryScoreView} whose value is `—`.
   */
  score: DeliveryScoreView | null;
  pace: PaceTileView | null;
  sparkline: Array<{ x: number; y: number }> | null;
  variety: VarietyTileView | null;
  fillers: string | null;
  centre: RailCentre;
  ribbon: {
    show: boolean;
    windowMs: number;
    /** Audio time at the right edge for the marks below. */
    nowMs: number;
    marks: RibbonMark[];
  };
}

export interface RailPresenterInput {
  state: CoachRailState;
  /** Monotonic wall clock, e.g. `performance.now()`. */
  monotonicMs: number;
  /** Measured rail width; `0` before the first measurement (§7.3). */
  widthPx: number;
  /** Safe viewport height, for §7.1. */
  viewportHeightPx: number;
  /** §7.6 rail text scale, 0.8–1.5. Clamped here. */
  textScale: number;
}

export class CoachRailPresenter {
  private clock = new RailClock();
  private paceTile = new PaceTilePresenter();
  private tip = new ActiveTipPresenter();
  private score = new DeliveryScorePresenter();
  private applied: CoachRailState | null = null;

  /**
   * §27 arrival validation. Out-of-order delivery is normal, so a snapshot
   * whose revision is not greater than the applied one is *stale, not a
   * correction*, and the rail keeps rendering what it already had — at the
   * current time, so the ribbon keeps moving and the tip keeps ageing.
   *
   * A different session is not a stale snapshot; it is a different rail. The
   * presenter resets rather than freezing, because a rail stuck on the previous
   * session's numbers is the worst of the three outcomes.
   */
  private adopt(incoming: CoachRailState): CoachRailState {
    const current = this.applied;
    if (current === null) {
      this.applied = incoming;
      return incoming;
    }
    if (incoming.sessionId !== current.sessionId) {
      this.clock = new RailClock();
      this.paceTile = new PaceTilePresenter();
      this.tip = new ActiveTipPresenter();
      this.score = new DeliveryScorePresenter();
      this.applied = incoming;
      return incoming;
    }
    if (incoming.stageRevision > current.stageRevision) {
      this.applied = incoming;
      return incoming;
    }
    return current;
  }

  /**
   * Idempotent for a fixed input: re-running it with the same snapshot and the
   * same `monotonicMs` produces the same view and advances nothing. The Svelte
   * component evaluates this inside a `$derived`, which may re-run for reasons
   * that have nothing to do with time passing.
   */
  update(input: RailPresenterInput): RailView {
    const state = this.adopt(input.state);
    const nowAudioMs = this.clock.sync(state, input.monotonicMs);

    const permissions = modePermissions(state.mode);
    const layout = resolveRailLayout(state.mode, input.widthPx, state.modules);
    const reservedHeightPx = coachRailReservedHeightPx(input.viewportHeightPx);

    // The presenters still run when the rail is hidden. Their state is a
    // continuous record of what the presenter was shown; letting it freeze
    // under `visible: false` would make an un-hide replay a stale tip or a
    // pause ladder from minutes ago.
    const paceView = this.paceTile.update(state.pace, nowAudioMs);
    const tipView = this.tip.update(state.activeTip, nowAudioMs, permissions.criticalTipsOnly);
    // Runs even when the zone is not drawn, for the same reason the pace tile
    // does: the 2–5 Hz limiter is a record of what the presenter was shown, and
    // freezing it would let a re-widened rail flash a stale number.
    const scoreView = this.score.update(state.score, nowAudioMs);

    const windowMs = ribbonWindowMs(state.mode);
    return {
      present: state.mode !== 'off',
      reservedHeightPx,
      ribbonHeightPx: RAIL_RIBBON_HEIGHT_PX,
      scriptGapPx: RAIL_SCRIPT_GAP_PX,
      visible: state.visible,
      mirrored: state.mirrored,
      reducedMotion: state.reducedMotion,
      textScale: clampRailTextScale(input.textScale),
      layout,
      score: layout.showScore ? scoreView : null,
      pace: layout.showPace ? paceView : null,
      sparkline: layout.showSparkline
        ? sparklinePoints(state.pace.recentSeries, state.pace.targetLowWpm, state.pace.targetHighWpm)
        : null,
      variety: layout.showVariety ? varietyTileView(state.variety) : null,
      fillers: layout.showFillerCount ? fillerSummaryText(state.fillers) : null,
      centre: resolveCentre(tipView, microphoneAlertText(state.microphone)),
      ribbon: {
        show: layout.showRibbon,
        windowMs,
        nowMs: nowAudioMs,
        marks: layout.showRibbon
          ? layoutRibbon(state.ribbonEvents, nowAudioMs, windowMs, ribbonTypesFor(state.mode))
          : [],
      },
    };
  }
}

/**
 * §7.4 / §9.1. One slot, one message, in priority order: a system-critical tip,
 * then a sustained microphone fault, then any other tip. The microphone line
 * sits above ordinary tips because a take being recorded badly outranks advice
 * about how it is being delivered — and below critical tips because those are
 * the mic alerts themselves when the policy is alive.
 */
export function resolveCentre(tip: ActiveTipView | null, alert: string | null): RailCentre {
  if (tip !== null && tip.severity === 'critical') {
    return { kind: 'tip', text: tip.text, tone: 'critical', tipId: tip.tipId };
  }
  if (alert !== null) {
    return { kind: 'alert', text: alert, tone: 'critical', tipId: null };
  }
  if (tip !== null) {
    return {
      kind: 'tip',
      text: tip.text,
      tone: tip.severity === 'important' ? 'important' : 'gentle',
      tipId: tip.tipId,
    };
  }
  // §2.6: silence is a valid coaching decision, and the tiles already carry the
  // quiet positive state of §8.5. An empty centre is the ordinary case.
  return { kind: 'none', text: '', tone: 'gentle', tipId: null };
}
