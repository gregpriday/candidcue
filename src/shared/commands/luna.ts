/**
 * Luna fallback INTERFACE (spec §33.7–§33.8, §33.12). Types, the strict
 * function schema, the bounded request builder, and the raw-response
 * validator live here. The actual network call is implemented elsewhere
 * (control frontend + Rust proxy) against the `LunaCommandInterpreter`
 * interface — this module performs no I/O.
 */
import type { CommandAction, CommandCandidate } from '../contracts/commands';
import type { NavigationTarget } from '../contracts/compiler';
import { resolveNamedTarget, type CommandParseContext } from './grammar';
import { validateCommandAction } from './schema';
import type { CommandBounds } from './settings';

/** Strict structured-output schema sent to Luna (spec §33.8, verbatim). */
export const CONTROL_CANDIDCUE_FUNCTION = {
  name: 'control_candidcue',
  description: 'Interpret a bounded teleprompter command.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'confidence', 'requires_confirmation'],
    properties: {
      action: {
        type: 'string',
        enum: [
          'start', 'pause', 'resume', 'hard_pause', 'stop',
          'go_to_target', 'next_section', 'previous_section',
          'move_relative', 'restart_unit', 'set_font_size',
          'adjust_font_size', 'set_margins', 'toggle_mirror',
          'blank_stage', 'unblank_stage', 'set_listener',
          'adjust_reading_band', 'set_scroll_mode', 'unknown',
        ],
      },
      target_type: {
        type: ['string', 'null'],
        enum: ['heading', 'take', 'sentence', 'paragraph', 'beginning', 'end', 'phrase', null],
      },
      target_value: { type: ['string', 'null'] },
      direction: { type: ['string', 'null'], enum: ['forward', 'backward', 'up', 'down', null] },
      amount: { type: ['number', 'null'] },
      unit: {
        type: ['string', 'null'],
        enum: ['sentence', 'paragraph', 'section', 'percent', 'point', null],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      requires_confirmation: { type: 'boolean' },
    },
  },
} as const;

/** Bounded context sent with a Luna request (spec §33.7, §33.12). */
export interface LunaCommandRequest {
  candidateId: string;
  contextRevision: number;
  /** Command text only — never unrelated transcript (§33.12). */
  commandText: string;
  scrollMode: 'voice' | 'manual' | 'fixed';
  position: { blockId: string; sentenceId: string; tokenIndex: number };
  /** Nearby heading/take names (§33.7). */
  nearbyTargets: Array<{ id: string; type: NavigationTarget['type']; label: string }>;
  /** Compact document outline (§33.7). */
  outline: Array<{ level: number; title: string }>;
  /** Relevant settings bounds (§33.7). */
  bounds: CommandBounds;
  /** The strict schema Luna must answer with (§33.8). */
  schema: typeof CONTROL_CANDIDCUE_FUNCTION;
  /** Explicit instruction: return `unknown` rather than inventing (§33.7). */
  instruction: string;
}

/** Raw structured output returned by Luna against the strict schema. */
export interface LunaRawResult {
  action: string;
  target_type?: string | null;
  target_value?: string | null;
  direction?: string | null;
  amount?: number | null;
  unit?: string | null;
  confidence: number;
  requires_confirmation: boolean;
}

/**
 * Transport interface implemented by the network layer. Implementations
 * must respect the soft/hard timeouts in CommandSettings (§33.11) and use
 * `parallel_tool_calls: false` or equivalent (§33.8).
 */
export interface LunaCommandInterpreter {
  interpret(request: LunaCommandRequest, signal?: AbortSignal): Promise<LunaRawResult>;
}

export interface LunaRequestInput {
  candidate: CommandCandidate;
  scrollMode: 'voice' | 'manual' | 'fixed';
  position: { blockId: string; sentenceId: string; tokenIndex: number };
  navigationTargets: readonly NavigationTarget[];
  outline: ReadonlyArray<{ level: number; title: string }>;
  bounds: CommandBounds;
  /** Max nearby targets to include (keeps context bounded, §33.7). */
  maxNearbyTargets?: number;
}

/** Build a bounded Luna request (spec §33.7) — pure, no I/O. */
export function buildLunaRequest(input: LunaRequestInput): LunaCommandRequest {
  const limit = input.maxNearbyTargets ?? 12;
  const nearby = [...input.navigationTargets]
    .filter((t) => t.type === 'heading' || t.type === 'take')
    .sort(
      (a, b) =>
        Math.abs(a.tokenIndex - input.position.tokenIndex) -
        Math.abs(b.tokenIndex - input.position.tokenIndex),
    )
    .slice(0, limit)
    .map((t) => ({ id: t.id, type: t.type, label: t.label }));
  return {
    candidateId: input.candidate.id,
    contextRevision: input.candidate.contextRevision,
    commandText: input.candidate.normalizedTranscript,
    scrollMode: input.scrollMode,
    position: input.position,
    nearbyTargets: nearby,
    outline: input.outline.slice(0, 64).map((o) => ({ level: o.level, title: o.title })),
    bounds: input.bounds,
    schema: CONTROL_CANDIDCUE_FUNCTION,
    instruction:
      'Interpret the command against the provided context only. If the request is not one of the allowed actions or references content that does not exist, return action "unknown" rather than inventing a result.',
  };
}

export type LunaValidation =
  | { ok: true; action: CommandAction; confidence: number; requiresConfirmation: boolean }
  | { ok: false; reason: string };

const LUNA_ACTIONS = new Set(
  CONTROL_CANDIDCUE_FUNCTION.parameters.properties.action.enum as readonly string[],
);

/**
 * Validate a raw Luna result against the strict schema and map it onto a
 * `CommandAction` (spec §33.8: reject out-of-schema, out-of-range, and
 * nonexistent-target responses).
 */
export function validateLunaResult(
  raw: unknown,
  context: CommandParseContext & { bounds?: CommandBounds },
): LunaValidation {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'not_an_object' };
  const result = raw as Partial<LunaRawResult>;
  if (typeof result.action !== 'string' || !LUNA_ACTIONS.has(result.action)) {
    return { ok: false, reason: 'action_out_of_schema' };
  }
  if (
    typeof result.confidence !== 'number' ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1
  ) {
    return { ok: false, reason: 'confidence_out_of_range' };
  }
  if (typeof result.requires_confirmation !== 'boolean') {
    return { ok: false, reason: 'missing_requires_confirmation' };
  }

  const mapped = mapLunaAction(result, context);
  if (!mapped.ok) return mapped;
  const validated = validateCommandAction(mapped.action, {
    navigationTargets: context.navigationTargets,
    bounds: context.bounds,
  });
  if (!validated.ok) return { ok: false, reason: validated.reason };
  return {
    ok: true,
    action: validated.action,
    confidence: result.confidence,
    requiresConfirmation: result.requires_confirmation,
  };
}

function mapLunaAction(
  result: Partial<LunaRawResult>,
  context: CommandParseContext,
): { ok: true; action: CommandAction } | { ok: false; reason: string } {
  switch (result.action) {
    case 'start': case 'pause': case 'resume': case 'hard_pause': case 'stop':
    case 'next_section': case 'previous_section':
    case 'blank_stage': case 'unblank_stage':
      return { ok: true, action: { action: result.action } };
    case 'unknown':
      return { ok: true, action: { action: 'unknown', reason: 'luna_unknown' } };
    case 'go_to_target': {
      const value = typeof result.target_value === 'string' ? result.target_value : '';
      if (value.length === 0) return { ok: false, reason: 'missing_target_value' };
      // Luna may return a target id directly, or a label to resolve.
      const byId = context.navigationTargets.find((t) => t.id === value);
      if (byId !== undefined) return { ok: true, action: { action: 'go_to_target', targetId: byId.id } };
      const type = result.target_type === 'take' ? 'take' : 'any_heading';
      const resolution = resolveNamedTarget(type, value.toLowerCase().split(/\s+/), context);
      if (resolution.target === undefined || resolution.score < 0.5) {
        return { ok: false, reason: 'nonexistent_target' };
      }
      return { ok: true, action: { action: 'go_to_target', targetId: resolution.target.id } };
    }
    case 'move_relative': {
      const direction =
        result.direction === 'forward' || result.direction === 'backward'
          ? result.direction
          : undefined;
      const unit =
        result.unit === 'sentence' || result.unit === 'paragraph' || result.unit === 'section'
          ? result.unit
          : undefined;
      const amount = typeof result.amount === 'number' ? result.amount : 1;
      if (direction === undefined || unit === undefined) {
        return { ok: false, reason: 'invalid_move_relative' };
      }
      return { ok: true, action: { action: 'move_relative', direction, amount, unit } };
    }
    case 'restart_unit': {
      const unit =
        result.unit === 'sentence' || result.unit === 'paragraph' || result.unit === 'section'
          ? result.unit
          : result.target_type === 'take'
            ? 'take'
            : undefined;
      if (unit === undefined) return { ok: false, reason: 'invalid_restart_unit' };
      return { ok: true, action: { action: 'restart_unit', unit } };
    }
    case 'set_font_size':
      if (typeof result.amount !== 'number') return { ok: false, reason: 'missing_amount' };
      return { ok: true, action: { action: 'set_font_size', valuePx: result.amount } };
    case 'adjust_font_size': {
      if (typeof result.amount !== 'number') return { ok: false, reason: 'missing_amount' };
      const sign = result.direction === 'down' || result.direction === 'backward' ? -1 : 1;
      return { ok: true, action: { action: 'adjust_font_size', deltaSteps: sign * result.amount } };
    }
    case 'set_margins':
      if (typeof result.amount !== 'number') return { ok: false, reason: 'missing_amount' };
      return { ok: true, action: { action: 'set_margins', valuePercent: result.amount } };
    case 'toggle_mirror':
      return { ok: true, action: { action: 'toggle_mirror', axis: 'x' } };
    case 'set_listener':
      return {
        ok: true,
        action: { action: 'set_listener', enabled: result.direction !== 'down' },
      };
    case 'adjust_reading_band': {
      const amount = typeof result.amount === 'number' ? result.amount : 5;
      const sign = result.direction === 'up' ? -1 : 1;
      return { ok: true, action: { action: 'adjust_reading_band', deltaPercent: sign * amount } };
    }
    case 'set_scroll_mode': {
      const value = typeof result.target_value === 'string' ? result.target_value : '';
      if (value !== 'voice' && value !== 'manual' && value !== 'fixed') {
        return { ok: false, reason: 'invalid_scroll_mode' };
      }
      return { ok: true, action: { action: 'set_scroll_mode', mode: value } };
    }
    default:
      return { ok: false, reason: 'action_out_of_schema' };
  }
}
