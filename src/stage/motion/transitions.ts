/**
 * StageTransitionController (companion §53).
 *
 * A transition directive is an authorized, bounded change to how the stage
 * moves. Only one may be active, each runs exactly once (idempotent by `id`, so
 * a re-sent frame carrying the same directive is a no-op), and only a
 * `reanchor`/`reset` grants the frame loop permission to overwrite plant state
 * (§26.3). Everything else just reshapes the controller limits.
 *
 * Pure: the caller supplies session time.
 */
import type { StageTransitionDirective } from '../../shared/contracts';

export type TransitionIgnoreReason =
  | 'duplicate'
  | 'expired'
  | 'authority'
  | 'stale_epoch'
  | 'type_none';

export type TransitionOutcome =
  | { accepted: true; transition: ActiveTransition }
  | { accepted: false; reason: TransitionIgnoreReason };

export interface ActiveTransition {
  directive: StageTransitionDirective;
  startedAtMs: number;
  expiresAtMs: number;
}

export interface StageTransitionController {
  readonly active: ActiveTransition | null;
  /** Directives seen (accepted or duplicate) — diagnostics only. */
  readonly seenIds: number;
  submit(directive: StageTransitionDirective, nowMs: number): TransitionOutcome;
  /** Expire the active transition when its deadline passes. */
  update(nowMs: number): void;
  /**
   * Returns the directive exactly once per accepted reanchor/reset. Holding
   * this token is the only licence the frame loop has to write plant state.
   */
  consumePlantOverwrite(): StageTransitionDirective | null;
  /**
   * Hand an UNSPENT licence back (§62). The frame loop consumes the licence
   * before it knows whether it can resolve a destination — with no line map
   * there is nowhere to re-anchor to — and completing the directive anyway
   * destroys it: directives are idempotent by `id`, so every re-sent copy is
   * `duplicate`-ignored and the authorized discontinuity is lost for good.
   * Parking it here keeps it valid until the map resolves or it expires.
   */
  deferPlantOverwrite(directive: StageTransitionDirective): void;
  /**
   * Push the active transition's deadline later — never earlier, and never for
   * a transition that is not the active one.
   *
   * §30.5. A `rewind`'s TTL has to outlive its travel, and the travel cannot be
   * measured when the directive is minted: the destination is a scroll position,
   * and during a line-map rebuild there is no geometry to resolve one from. The
   * directive is therefore issued against a floor, and the frame loop re-arms it
   * on the first frame that can actually see the journey.
   *
   * Extension only, so this can never become a way to retire a licence early —
   * that is `complete`'s job, and it is the one that revokes the overwrite token
   * with it.
   */
  extend(id: string, expiresAtMs: number): void;
  /** Mark the active transition finished (arrived at destination). */
  complete(id: string): void;
  reset(): void;
}

const AUTHORITY_RANK: Record<StageTransitionDirective['authority'], number> = {
  ordinary: 0,
  command: 1,
  manual: 2,
};

export interface TransitionControllerOptions {
  /** How many directive ids to remember for idempotency. */
  historySize?: number;
}

export function createStageTransitionController(
  options: TransitionControllerOptions = {},
): StageTransitionController {
  const historySize = options.historySize ?? 64;
  const seen = new Set<string>();
  const order: string[] = [];
  let active: ActiveTransition | null = null;
  /**
   * The plant-overwrite licence, bound to the directive that granted it. It is
   * only ever consumed while that exact directive is still the ACTIVE
   * transition, so a supersession, an expiry, or a completion revokes it
   * implicitly — a token that outlives its transition is a stale re-anchor
   * waiting to teleport the plant on the next frame the loop happens to run
   * (which, after a freeze or a hidden window, can be seconds later).
   */
  let pendingOverwrite: StageTransitionDirective | null = null;
  let highestEpoch = Number.NEGATIVE_INFINITY;

  function revokeOverwrite(id: string | undefined) {
    if (pendingOverwrite && (id === undefined || pendingOverwrite.id === id)) {
      pendingOverwrite = null;
    }
  }

  function remember(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    while (order.length > historySize) {
      const oldest = order.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  return {
    get active() {
      return active;
    },
    get seenIds() {
      return seen.size;
    },

    submit(directive, nowMs): TransitionOutcome {
      if (!directive || directive.type === 'none') {
        return { accepted: false, reason: 'type_none' };
      }
      if (seen.has(directive.id)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (Number.isFinite(directive.expiresAtMs) && directive.expiresAtMs <= nowMs) {
        remember(directive.id);
        return { accepted: false, reason: 'expired' };
      }
      // A directive from a superseded semantic epoch is a late arrival.
      if (directive.semanticEpoch < highestEpoch) {
        remember(directive.id);
        return { accepted: false, reason: 'stale_epoch' };
      }
      // Only one active transition; a lower authority may not interrupt a
      // command or manual transition already in flight (§56).
      if (
        active &&
        AUTHORITY_RANK[directive.authority] < AUTHORITY_RANK[active.directive.authority]
      ) {
        remember(directive.id);
        return { accepted: false, reason: 'authority' };
      }

      remember(directive.id);
      highestEpoch = Math.max(highestEpoch, directive.semanticEpoch);
      // This directive supersedes whatever was active; its licence goes with it.
      revokeOverwrite(active?.directive.id);
      active = {
        directive,
        startedAtMs: nowMs,
        expiresAtMs: Number.isFinite(directive.expiresAtMs)
          ? directive.expiresAtMs
          : nowMs + 4000,
      };
      if (directive.type === 'reanchor' || directive.type === 'reset') {
        pendingOverwrite = directive;
      }
      return { accepted: true, transition: active };
    },

    update(nowMs) {
      if (active && nowMs >= active.expiresAtMs) {
        revokeOverwrite(active.directive.id);
        active = null;
      }
    },

    consumePlantOverwrite() {
      const directive = pendingOverwrite;
      pendingOverwrite = null;
      // Re-check at consumption: the licence is only valid while its own
      // directive is still the active transition.
      if (!directive) return null;
      if (!active || active.directive.id !== directive.id) return null;
      return directive;
    },

    deferPlantOverwrite(directive) {
      // Only while it is still the active transition — the same rule
      // `consumePlantOverwrite` applies. A licence that outlived its directive
      // is a stale re-anchor waiting to teleport the plant.
      if (!active || active.directive.id !== directive.id) return;
      pendingOverwrite = directive;
    },

    extend(id, expiresAtMs) {
      if (!active || active.directive.id !== id) return;
      if (!Number.isFinite(expiresAtMs)) return;
      if (expiresAtMs <= active.expiresAtMs) return;
      active = { ...active, expiresAtMs };
    },

    complete(id) {
      revokeOverwrite(id);
      if (active && active.directive.id === id) active = null;
    },

    reset() {
      active = null;
      pendingOverwrite = null;
      seen.clear();
      order.length = 0;
      highestEpoch = Number.NEGATIVE_INFINITY;
    },
  };
}
