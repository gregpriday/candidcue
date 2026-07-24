/**
 * Stage-target computation (spec §32, G.6): converts tracking snapshots into
 * visual targets with lead compensation, movement classes, reading-band
 * geometry with a dead band, and fixed-speed/manual mode support.
 *
 * Layout is injected via `StageLayout` so this module stays pure — the stage
 * window supplies real measured geometry; tests supply synthetic layouts.
 */
import type { TrackingSnapshot } from '../contracts/tracking';
import type { TrackingProfile } from './profile';
import type { MovementKind } from './types';

/** Measured stage geometry (spec §32.4 "precompute block top offsets"). */
export interface StageLayout {
  /** Y offset (px from document top) of a spoken token's line. */
  tokenY(tokenIndex: number): number;
  lastTokenIndex: number;
  /** Total scrollable content height in px. */
  contentHeight: number;
  /** Visible viewport height in px. */
  viewportHeight: number;
  /** Rendered line height in px (micro-movement classification). */
  lineHeight: number;
}

export type MovementClass = 'none' | 'micro' | 'follow' | 'skip' | 'retake' | 'command';

export interface VisualTarget {
  /** Target scroll offset (px), clamped to the scrollable range. */
  y: number;
  movement: MovementKind;
  movementClass: MovementClass;
  /** Suggested animation duration; 0 = instant (§32.3, reduced motion). */
  durationMs: number;
  confidence: number;
}

export interface StageTargetOptions {
  /** Current scroll position, used for dead-band and movement class. */
  currentY: number;
  /** Reading-band center as a percent of the viewport (20–70, §32.5). */
  readingBandPercent?: number;
  /** Forward lead in tokens (0 when confidence is low, §32.2/G.6). */
  leadTokens?: number;
  reducedMotion?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function maxScrollY(layout: StageLayout): number {
  return Math.max(0, layout.contentHeight - layout.viewportHeight);
}

/** Reading-band center offset in px from the viewport top (spec §32.5). */
export function readingBandCenterY(
  layout: StageLayout,
  profile: TrackingProfile,
  percent?: number,
): number {
  const raw = percent ?? profile.readingBandPercent;
  const clamped = clamp(raw, profile.readingBandMinPercent, profile.readingBandMaxPercent);
  return (clamped / 100) * layout.viewportHeight;
}

/**
 * G.6 `deriveVisualTarget` with §32.3 movement classes and §32.5 dead band.
 * Always returns a finite y within [0, maxScroll] (§55.3 property).
 */
export function deriveVisualTarget(
  snapshot: TrackingSnapshot,
  layout: StageLayout,
  profile: TrackingProfile,
  options: StageTargetOptions,
): VisualTarget {
  const bandY = readingBandCenterY(layout, profile, options.readingBandPercent);
  const committedY = safeTokenY(layout, snapshot.committedTokenIndex);
  const provisionalY = safeTokenY(layout, snapshot.tokenIndex);

  // Provisional movement is clamped around the committed position (G.6).
  const semanticY = snapshot.provisional
    ? clamp(
        provisionalY,
        committedY - profile.provisionalBackwardPx,
        committedY + profile.provisionalForwardPx,
      )
    : provisionalY;

  // Lead compensation (§32.2) — only when confidently locked; the caller
  // computes leadTokens from pace and latency (G.6).
  const lead =
    snapshot.confidence >= profile.leadConfidence && snapshot.state === 'following'
      ? Math.min(profile.maxLeadTokens, Math.max(0, Math.floor(options.leadTokens ?? 0)))
      : 0;
  // Lead is applied relative to the (already clamped) semantic anchor so it
  // can never bypass the provisional clamp (§31.8).
  const leadPx =
    lead > 0
      ? Math.max(
          0,
          safeTokenY(layout, Math.min(snapshot.tokenIndex + lead, layout.lastTokenIndex)) -
            safeTokenY(layout, snapshot.tokenIndex),
        )
      : 0;

  const anchorY = semanticY + leadPx;
  let targetY = clamp(anchorY - bandY, 0, maxScrollY(layout));
  if (!Number.isFinite(targetY)) targetY = 0;

  const delta = targetY - options.currentY;
  const absDelta = Math.abs(delta);

  // Dead band (§32.5): while the phrase stays inside it, do not scroll.
  const holdMovement = snapshot.movement === 'hold' || snapshot.state !== 'following';
  const withinDeadBand = absDelta <= profile.deadBandPx;
  if ((holdMovement || snapshot.movement === 'advance') && withinDeadBand) {
    return {
      y: clamp(options.currentY, 0, maxScrollY(layout)),
      movement: snapshot.movement,
      movementClass: 'none',
      durationMs: 0,
      confidence: snapshot.confidence,
    };
  }

  const { movementClass, durationMs } = classifyMovement(
    snapshot.movement,
    absDelta,
    layout,
    profile,
  );

  return {
    y: targetY,
    movement: snapshot.movement,
    movementClass,
    durationMs: options.reducedMotion ? 0 : durationMs, // §32.4 reduced motion
    confidence: snapshot.confidence,
  };
}

function safeTokenY(layout: StageLayout, tokenIndex: number): number {
  const index = clamp(Math.floor(tokenIndex), 0, Math.max(0, layout.lastTokenIndex));
  const y = layout.tokenY(index);
  if (!Number.isFinite(y)) return 0;
  return clamp(y, 0, layout.contentHeight);
}

/** Movement classes and transition durations (spec §32.3). */
function classifyMovement(
  movement: MovementKind,
  absDeltaPx: number,
  layout: StageLayout,
  profile: TrackingProfile,
): { movementClass: MovementClass; durationMs: number } {
  if (movement === 'manual' || movement === 'command') {
    return { movementClass: 'command', durationMs: profile.commandTransitionMs };
  }
  if (movement === 'retake') {
    return {
      movementClass: 'retake',
      durationMs: interpolate(
        absDeltaPx,
        layout,
        profile.retakeTransitionMsMin,
        profile.retakeTransitionMsMax,
      ),
    };
  }
  if (movement === 'skip') {
    return {
      movementClass: 'skip',
      durationMs: interpolate(
        absDeltaPx,
        layout,
        profile.skipTransitionMsMin,
        profile.skipTransitionMsMax,
      ),
    };
  }
  if (absDeltaPx <= Math.max(profile.microMovementPx, layout.lineHeight * 1.5)) {
    return { movementClass: 'micro', durationMs: profile.normalFollowMsMin };
  }
  return {
    movementClass: 'follow',
    durationMs: interpolate(
      absDeltaPx,
      layout,
      profile.normalFollowMsMin,
      profile.normalFollowMsMax,
    ),
  };
}

function interpolate(
  absDeltaPx: number,
  layout: StageLayout,
  minMs: number,
  maxMs: number,
): number {
  const span = Math.max(1, layout.viewportHeight);
  const t = clamp(absDeltaPx / span, 0, 1);
  return Math.round(minMs + (maxMs - minMs) * t);
}

/* ---------------------------------------------------------------------------
 * Fixed-speed and manual modes (spec §32.6).
 * ------------------------------------------------------------------------- */

export type ScrollMode = 'voice' | 'fixed' | 'manual';

/**
 * Continuous fixed-speed scroller. Pure stepper: callers feed elapsed time.
 * Speed can be set in px/s directly or derived from words per minute using
 * layout calibration (average px per token).
 */
export class FixedSpeedScroller {
  private y: number;
  private pxPerSecond: number;
  private running = false;

  constructor(initialY = 0, pxPerSecond = 40) {
    this.y = Math.max(0, initialY);
    this.pxPerSecond = Math.max(0, pxPerSecond);
  }

  get positionY(): number {
    return this.y;
  }

  get speedPxPerSecond(): number {
    return this.pxPerSecond;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  setPositionY(y: number, layout: StageLayout): void {
    this.y = clamp(y, 0, maxScrollY(layout));
  }

  setSpeedPxPerSecond(pxPerSecond: number): void {
    this.pxPerSecond = clamp(pxPerSecond, 0, 5000);
  }

  /** Calibrate px/s from words-per-minute using measured layout (§32.6). */
  setSpeedWordsPerMinute(wpm: number, layout: StageLayout): void {
    const tokens = Math.max(1, layout.lastTokenIndex + 1);
    const pxPerToken = layout.contentHeight / tokens;
    this.setSpeedPxPerSecond((clamp(wpm, 1, 1000) / 60) * pxPerToken);
  }

  /** Adjust speed by a percentage ("speed up"/"slow down", §34.6). */
  adjustSpeedPercent(deltaPercent: number): void {
    this.setSpeedPxPerSecond(this.pxPerSecond * (1 + deltaPercent / 100));
  }

  /** Advance by elapsed time; returns the new clamped position. */
  advance(elapsedMs: number, layout: StageLayout): number {
    if (this.running && Number.isFinite(elapsedMs) && elapsedMs > 0) {
      this.y = clamp(this.y + (this.pxPerSecond * elapsedMs) / 1000, 0, maxScrollY(layout));
    }
    return this.y;
  }
}

/**
 * Nearest spoken token for a scroll offset — used so switching modes
 * preserves the nearest semantic position (spec §32.6). Binary search over
 * the monotonic tokenY mapping.
 */
export function nearestTokenIndex(layout: StageLayout, scrollY: number, bandOffsetY = 0): number {
  const targetY = clamp(scrollY + bandOffsetY, 0, layout.contentHeight);
  let lo = 0;
  let hi = Math.max(0, layout.lastTokenIndex);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (safeTokenY(layout, mid) < targetY) lo = mid + 1;
    else hi = mid;
  }
  // Pick the closer of lo and lo-1.
  const above = safeTokenY(layout, lo);
  const belowIndex = Math.max(0, lo - 1);
  const below = safeTokenY(layout, belowIndex);
  return Math.abs(above - targetY) <= Math.abs(targetY - below) ? lo : belowIndex;
}
