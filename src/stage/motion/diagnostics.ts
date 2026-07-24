/**
 * StageMotionDiagnostics (companion §54, §61, §70).
 *
 * Two jobs:
 *
 * 1. Build the periodic `StageMotionAck`. This is a *report*, not a control
 *    loop — it runs at a fixed low cadence so control can explain motion and
 *    recover from a desync, and it never feeds back into the aligner (§54).
 * 2. Watch frame health and declare degradation (§61) when the stage keeps
 *    missing its budget: nonessential effects and styling cadence get cut,
 *    controller integration and text motion stay untouched, and the stage never
 *    silently falls back to event-driven jumps.
 *
 * The §70 motion metrics are accumulated here so the same numbers used in tests
 * are the numbers shown in diagnostics.
 */
import type { StageMotionAck } from '../../shared/contracts';

export interface MotionSample {
  nowMs: number;
  dtMs: number;
  hitch: boolean;
  targetPx: number;
  positionPx: number;
  velocityPxS: number;
  accelerationPxS2: number;
  jerkPxS3: number;
  lineId: string | null;
  controllerState: string;
  /** Wall time the frame's motion work took, ms (§63 budget). */
  frameCostMs?: number;
}

/** Companion §70. */
export interface MotionMetrics {
  frames: number;
  droppedFrames: number;
  droppedFrameCountWindow: number;
  maxAbsJerkPxS3: number;
  maxAbsAccelerationPxS2: number;
  maxTrackingErrorPx: number;
  /** Velocity sign changes — oscillation/overshoot detector (§70.5). */
  velocitySignChanges: number;
  /** Largest single-frame position change (§70.8 "visible single-frame jumps"). */
  maxFrameStepPx: number;
  p95FrameCostMs: number;
  meanFrameCostMs: number;
}

export interface AckContext {
  sessionId: string;
  revision: number;
  epoch: number;
  layoutGeneration: number;
  targetPx: number;
  positionPx: number;
  velocityPxS: number;
  activeLineId: string | null;
  controllerState: string;
  nowMs: number;
}

export interface StageMotionDiagnostics {
  sample(sample: MotionSample): void;
  readonly metrics: MotionMetrics;
  /** True when the stage is repeatedly missing its frame budget (§61). */
  readonly degraded: boolean;
  shouldEmitAck(nowMs: number): boolean;
  buildAck(context: AckContext): StageMotionAck;
  reset(): void;
}

export interface DiagnosticsOptions {
  ackIntervalMs?: number;
  /** Length of the frame-health window. */
  windowMs?: number;
  /** Dropped-frame ratio that trips degradation. */
  degradeRatio?: number;
  /** Dropped-frame ratio that clears it (hysteresis). */
  recoverRatio?: number;
  /** Consecutive bad windows before degrading. */
  degradeWindows?: number;
}

const DEFAULT_ACK_INTERVAL_MS = 500;
const DEFAULT_WINDOW_MS = 2000;
const FRAME_COST_SAMPLES = 120;

export function createStageMotionDiagnostics(
  options: DiagnosticsOptions = {},
): StageMotionDiagnostics {
  const ackIntervalMs = options.ackIntervalMs ?? DEFAULT_ACK_INTERVAL_MS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const degradeRatio = options.degradeRatio ?? 0.2;
  const recoverRatio = options.recoverRatio ?? 0.05;
  const degradeWindows = options.degradeWindows ?? 2;

  const metrics: MotionMetrics = {
    frames: 0,
    droppedFrames: 0,
    droppedFrameCountWindow: 0,
    maxAbsJerkPxS3: 0,
    maxAbsAccelerationPxS2: 0,
    maxTrackingErrorPx: 0,
    velocitySignChanges: 0,
    maxFrameStepPx: 0,
    p95FrameCostMs: 0,
    meanFrameCostMs: 0,
  };

  const frameCosts: number[] = [];
  let lastVelocitySign = 0;
  let lastPosition: number | null = null;
  let windowStartMs: number | null = null;
  let windowFrames = 0;
  let windowDropped = 0;
  let badWindows = 0;
  let goodWindows = 0;
  let degraded = false;
  let lastAckAtMs = Number.NEGATIVE_INFINITY;

  function closeWindow() {
    const ratio = windowFrames > 0 ? windowDropped / windowFrames : 0;
    metrics.droppedFrameCountWindow = windowDropped;
    if (ratio >= degradeRatio) {
      badWindows++;
      goodWindows = 0;
      if (badWindows >= degradeWindows) degraded = true;
    } else if (ratio <= recoverRatio) {
      goodWindows++;
      badWindows = 0;
      if (goodWindows >= degradeWindows + 1) degraded = false;
    } else {
      badWindows = 0;
      goodWindows = 0;
    }
    windowFrames = 0;
    windowDropped = 0;
  }

  return {
    get metrics() {
      return metrics;
    },
    get degraded() {
      return degraded;
    },

    sample(sample) {
      metrics.frames++;
      if (sample.hitch) metrics.droppedFrames++;

      metrics.maxAbsJerkPxS3 = Math.max(metrics.maxAbsJerkPxS3, Math.abs(sample.jerkPxS3));
      metrics.maxAbsAccelerationPxS2 = Math.max(
        metrics.maxAbsAccelerationPxS2,
        Math.abs(sample.accelerationPxS2),
      );
      metrics.maxTrackingErrorPx = Math.max(
        metrics.maxTrackingErrorPx,
        Math.abs(sample.targetPx - sample.positionPx),
      );

      const sign = Math.sign(sample.velocityPxS);
      if (sign !== 0 && lastVelocitySign !== 0 && sign !== lastVelocitySign) {
        metrics.velocitySignChanges++;
      }
      if (sign !== 0) lastVelocitySign = sign;

      if (lastPosition !== null) {
        metrics.maxFrameStepPx = Math.max(
          metrics.maxFrameStepPx,
          Math.abs(sample.positionPx - lastPosition),
        );
      }
      lastPosition = sample.positionPx;

      if (sample.frameCostMs !== undefined) {
        frameCosts.push(sample.frameCostMs);
        if (frameCosts.length > FRAME_COST_SAMPLES) frameCosts.shift();
        const sorted = [...frameCosts].sort((a, b) => a - b);
        metrics.p95FrameCostMs = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        metrics.meanFrameCostMs =
          frameCosts.reduce((sum, value) => sum + value, 0) / frameCosts.length;
      }

      if (windowStartMs === null) windowStartMs = sample.nowMs;
      windowFrames++;
      if (sample.hitch) windowDropped++;
      if (sample.nowMs - windowStartMs >= windowMs) {
        closeWindow();
        windowStartMs = sample.nowMs;
      }
    },

    shouldEmitAck(nowMs) {
      if (nowMs - lastAckAtMs < ackIntervalMs) return false;
      lastAckAtMs = nowMs;
      return true;
    },

    buildAck(context): StageMotionAck {
      return {
        sessionId: context.sessionId,
        revision: context.revision,
        epoch: context.epoch,
        layoutGeneration: context.layoutGeneration,
        actualScrollPx: context.positionPx,
        actualVelocityPxPerSecond: context.velocityPxS,
        targetScrollPx: context.targetPx,
        activeLineId: context.activeLineId,
        controllerState: context.controllerState,
        droppedFrameCountWindow: metrics.droppedFrameCountWindow,
        renderedAtMs: context.nowMs,
      };
    },

    reset() {
      metrics.frames = 0;
      metrics.droppedFrames = 0;
      metrics.droppedFrameCountWindow = 0;
      metrics.maxAbsJerkPxS3 = 0;
      metrics.maxAbsAccelerationPxS2 = 0;
      metrics.maxTrackingErrorPx = 0;
      metrics.velocitySignChanges = 0;
      metrics.maxFrameStepPx = 0;
      metrics.p95FrameCostMs = 0;
      metrics.meanFrameCostMs = 0;
      frameCosts.length = 0;
      lastVelocitySign = 0;
      lastPosition = null;
      windowStartMs = null;
      windowFrames = 0;
      windowDropped = 0;
      badWindows = 0;
      goodWindows = 0;
      degraded = false;
      lastAckAtMs = Number.NEGATIVE_INFINITY;
    },
  };
}
