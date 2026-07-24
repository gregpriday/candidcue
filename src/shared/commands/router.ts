/**
 * Command router (spec §33.4, §33.10–§33.11, G.7): wake gate → phrase
 * collection → collision suppression → deterministic parse → Luna handoff →
 * validated execution decision, plus acknowledgement log and timeout /
 * cancellation bookkeeping. Pure and deterministic — all time is injected.
 */
import type { CommandCandidate, ValidatedCommand } from '../contracts/commands';
import type { TranscriptLedger } from '../tracking/ledger';
import type { LedgerToken, SpokenToken, TokenRange } from '../tracking/types';
import { matchLiteralCommandRange, scoreScriptCollision } from './collision';
import { parseCommand, type CommandParseContext } from './grammar';
import { buildLunaRequest, validateLunaResult, type LunaCommandRequest } from './luna';
import { validateCommandAction } from './schema';
import { resolveCommandSettings, type CommandSettings, type CommandBounds } from './settings';
import { collectCommandPhrase, findWake } from './wake';

export type CommandObservation =
  /**
   * Nothing to do. `releaseItemIds` is non-empty when this observation
   * *undoes* an earlier `pending`: the phrase turned out to be authored script
   * (§33.4 tail), so the items previously masked out of alignment must be
   * handed back rather than excluded for the rest of the session.
   */
  | { kind: 'none'; releaseItemIds?: string[] }
  | { kind: 'pending'; itemIds: string[] }
  | { kind: 'command'; command: ValidatedCommand; candidate: CommandCandidate; itemIds: string[] }
  | { kind: 'needs_luna'; candidate: CommandCandidate; request: LunaCommandRequest; itemIds: string[] }
  | { kind: 'unknown'; candidate: CommandCandidate; itemIds: string[]; message: string };

export interface CommandLogEntry {
  label: string;
  status: 'executed' | 'confirm_required' | 'rejected' | 'unknown' | 'timeout' | 'cancelled';
  atMs: number;
}

export interface StageAcknowledgement {
  label: string;
  untilMs: number;
}

export interface CommandRouterDeps {
  ledger: TranscriptLedger;
  parseContext: CommandParseContext;
  scriptTokens: readonly SpokenToken[];
  literalCommandRanges?: readonly TokenRange[];
  getCursorTokenIndex: () => number;
  getContextRevision: () => number;
  getScrollMode: () => 'voice' | 'manual' | 'fixed';
  getPosition: () => { blockId: string; sentenceId: string; tokenIndex: number };
  outline: ReadonlyArray<{ level: number; title: string }>;
  bounds: CommandBounds;
}

const UNSUPPORTED_MESSAGE = 'That command is not available during prompting.'; // §34.8

interface PendingLuna {
  candidate: CommandCandidate;
  sentAtMs: number;
  itemIds: string[];
}

export class CommandRouter {
  readonly settings: CommandSettings;
  private readonly deps: CommandRouterDeps;
  private consumed = new Set<string>();
  /** Items masked out of alignment by a `pending` observation (§33.4.4). */
  private maskedByPending = new Set<string>();
  private pendingLuna: PendingLuna | undefined;
  private log: CommandLogEntry[] = [];
  private stageAck: StageAcknowledgement | undefined;
  private candidateSequence = 0;
  private sessionGeneration = 0;
  /** Push-to-command window (spec §33.3.3). */
  private commandWindowUntilMs = -Infinity;
  private commandWindowOpenedAtMs = Infinity;

  constructor(deps: CommandRouterDeps, settings?: Partial<CommandSettings>) {
    this.deps = deps;
    this.settings = resolveCommandSettings(settings);
  }

  consumedItemIds(): ReadonlySet<string> {
    return this.consumed;
  }

  commandLog(): readonly CommandLogEntry[] {
    return this.log;
  }

  /** Stage chip currently visible, if any (spec §33.10). */
  stageAcknowledgement(nowMs: number): StageAcknowledgement | undefined {
    if (this.stageAck !== undefined && nowMs < this.stageAck.untilMs) return this.stageAck;
    return undefined;
  }

  /** Open a push-to-command window (wake phrase not required, §33.3.3). */
  openCommandWindow(nowMs: number, windowMs = 4000): void {
    this.commandWindowOpenedAtMs = nowMs;
    this.commandWindowUntilMs = nowMs + windowMs;
  }

  /** Cancel pending interpretation (§33.11: stop, supersede, generation). */
  cancelPending(reason: 'session_stopped' | 'superseded' | 'generation_changed', nowMs: number): void {
    if (this.pendingLuna !== undefined) {
      this.record({ label: this.pendingLuna.candidate.normalizedTranscript, status: 'cancelled', atMs: nowMs });
      this.pendingLuna = undefined;
    }
    if (reason === 'generation_changed') {
      this.consumed.clear();
      this.maskedByPending.clear();
      this.commandWindowUntilMs = -Infinity;
    }
  }

  /**
   * Drive time-based expiry (§33.11). Must be called on a timer, not only when
   * transcript arrives: the failure this exists for — a Luna handoff that never
   * returns — is precisely the case where no further transcript is processed,
   * because the aligner is frozen in COMMAND_PENDING waiting for it.
   */
  tick(nowMs: number): CommandObservation {
    return this.expireLuna(nowMs);
  }

  /* -------------------------------------------------------------------------
   * G.7 observe.
   * ----------------------------------------------------------------------- */

  observe(sessionGeneration: number, nowMs: number): CommandObservation {
    if (sessionGeneration !== this.sessionGeneration) {
      this.cancelPending('generation_changed', nowMs);
      this.sessionGeneration = sessionGeneration;
    }
    // A Luna handoff past its hard timeout must not keep the aligner frozen
    // while new speech is arriving (§33.11).
    const expired = this.expireLuna(nowMs);
    if (expired.kind !== 'none') return expired;

    const tail = this.deps.ledger
      .recentTokens(48)
      .filter(
        (token) =>
          !this.consumed.has(token.itemId) &&
          this.deps.ledger.getItem(token.itemId)?.sessionGeneration === sessionGeneration,
      );

    const pushToCommand =
      this.settings.wakeMode === 'push_to_command' && nowMs < this.commandWindowUntilMs;

    let phraseTokens: LedgerToken[];
    let itemIds: string[];
    let wakeAlias = '';
    let wakeConfidence = 1;
    let phraseFinal: boolean;
    let phraseClosed: boolean;
    let collisionTokens: LedgerToken[];

    if (pushToCommand) {
      // Push-to-command: everything spoken inside the window is command
      // text; speech from before the shortcut was pressed is not (§33.3.3).
      const inWindow = tail.filter((token) => {
        const item = this.deps.ledger.getItem(token.itemId);
        return item !== undefined && item.updatedAtMs >= this.commandWindowOpenedAtMs;
      });
      phraseTokens = inWindow;
      itemIds = [...new Set(inWindow.map((t) => t.itemId))];
      phraseFinal = itemIds.every((id) => this.isItemFinal(id));
      phraseClosed = phraseFinal;
      collisionTokens = inWindow;
      if (phraseTokens.length === 0) return { kind: 'none' };
    } else {
      const wake = findWake(tail, this.settings);
      if (wake === undefined) return { kind: 'none' };

      // §33.5: low wake confidence with no clear pause boundary → reject.
      if (wake.confidence < this.settings.minimumWakeConfidence) return { kind: 'none' };
      if (!wake.atBoundary && wake.confidence < 0.9) return { kind: 'none' };

      const phrase = collectCommandPhrase(tail, wake, this.settings, (id) => this.isItemFinal(id));
      phraseTokens = phrase.tokens;
      itemIds = phrase.itemIds;
      wakeAlias = wake.alias;
      wakeConfidence = wake.confidence;
      phraseFinal = phrase.final;
      phraseClosed = phrase.closed;
      collisionTokens = tail.slice(wake.startIndex);
    }

    // §33.5/G.7 literal-command blocks, tested two ways, both before the
    // pending branch so reading one aloud never freezes the aligner at all.
    //
    // (a) The cursor is standing inside an authored block: everything said
    //     here is demonstration, whatever the words are.
    const cursor = this.deps.getCursorTokenIndex();
    for (const range of this.deps.literalCommandRanges ?? []) {
      if (cursor >= range.startTokenIndex - 4 && cursor <= range.endTokenIndex + 4) {
        return this.releaseObservation(itemIds);
      }
    }
    // (b) The phrase itself reads as a block, wherever it lives in the
    //     document. (a) alone is not enough and never was: it keys off where
    //     the tracker *thinks* the presenter is, and after a twenty-second
    //     ad-lib the cursor can be a hundred tokens behind their mouth — at
    //     which point reading "to blank the stage you say CandidCue blank the
    //     screen" out of the script blanks the stage mid-take.
    const literal = matchLiteralCommandRange(
      collisionTokens,
      this.deps.scriptTokens,
      this.deps.literalCommandRanges,
      undefined,
      this.settings.literalCommandThreshold,
    );
    if (literal.matched) return this.releaseObservation(itemIds);

    // Not yet final and not a recognizable complete grammar → pending
    // (aligner enters COMMAND_PENDING and masks these items, §33.4.4).
    const provisionalParse = parseCommand(
      phraseTokens.map((t) => t.normalized),
      this.deps.parseContext,
    );
    if (
      (!phraseFinal && !phraseClosed && provisionalParse.kind !== 'command') ||
      (!phraseFinal && provisionalParse.kind !== 'command')
    ) {
      for (const id of itemIds) this.maskedByPending.add(id);
      return { kind: 'pending', itemIds };
    }

    // §33.5: does the whole phrase read as authored script near the cursor?
    const collision = scoreScriptCollision({
      phraseTokens: collisionTokens,
      scriptTokens: this.deps.scriptTokens,
      cursorTokenIndex: this.deps.getCursorTokenIndex(),
      literalCommandRanges: this.deps.literalCommandRanges,
    });
    if (collision.inLiteralRegion) return this.releaseObservation(itemIds);
    if (collision.score >= this.settings.scriptCollisionThreshold) {
      // Release the text back to ordinary alignment (§33.4).
      return this.releaseObservation(itemIds);
    }

    const candidate = this.makeCandidate(
      phraseTokens,
      itemIds,
      wakeAlias,
      wakeConfidence,
      collision.score,
      nowMs,
    );
    this.consume(itemIds);

    if (provisionalParse.kind === 'command') {
      const validated = validateCommandAction(provisionalParse.action, {
        navigationTargets: this.deps.parseContext.navigationTargets,
        bounds: this.deps.bounds,
      });
      if (validated.ok) {
        const value: ValidatedCommand = {
          candidateId: candidate.id,
          source: 'local',
          action: validated.action,
          confidence: provisionalParse.confidence * wakeConfidence,
          requiresConfirmation: provisionalParse.requiresConfirmation,
          contextRevision: candidate.contextRevision,
          humanLabel: provisionalParse.humanLabel,
        };
        return { kind: 'command', command: value, candidate, itemIds };
      }
      return this.unknownObservation(candidate, itemIds, validated.reason, nowMs);
    }

    if (provisionalParse.kind === 'incomplete') {
      return this.unknownObservation(candidate, itemIds, 'incomplete_command', nowMs);
    }

    // Deterministic parser failed. Route to Luna only when enabled and the
    // text looks command-like (§33.7).
    if (this.settings.lunaFallback && looksCommandLike(phraseTokens)) {
      if (this.pendingLuna !== undefined) {
        this.cancelPending('superseded', nowMs); // newer command supersedes (§33.11)
      }
      const request = buildLunaRequest({
        candidate,
        scrollMode: this.deps.getScrollMode(),
        position: this.deps.getPosition(),
        navigationTargets: this.deps.parseContext.navigationTargets,
        outline: this.deps.outline,
        bounds: this.deps.bounds,
      });
      this.pendingLuna = { candidate, sentAtMs: nowMs, itemIds };
      return { kind: 'needs_luna', candidate, request, itemIds };
    }

    return this.unknownObservation(candidate, itemIds, UNSUPPORTED_MESSAGE, nowMs);
  }

  /* -------------------------------------------------------------------------
   * Luna result handling (§33.8, §33.11).
   * ----------------------------------------------------------------------- */

  resolveLuna(candidateId: string, raw: unknown, nowMs: number): CommandObservation {
    const pending = this.pendingLuna;
    if (pending === undefined || pending.candidate.id !== candidateId) {
      return { kind: 'none' }; // superseded or cancelled (§33.11)
    }
    this.pendingLuna = undefined;

    if (nowMs - pending.sentAtMs > this.settings.lunaHardTimeoutMs) {
      this.record({ label: pending.candidate.normalizedTranscript, status: 'timeout', atMs: nowMs });
      return this.unknownObservation(pending.candidate, pending.itemIds, UNSUPPORTED_MESSAGE, nowMs);
    }
    // §33.11: every result must match the current context revision.
    if (pending.candidate.contextRevision !== this.deps.getContextRevision()) {
      this.record({ label: pending.candidate.normalizedTranscript, status: 'cancelled', atMs: nowMs });
      return { kind: 'none' };
    }

    const validation = validateLunaResult(raw, {
      navigationTargets: this.deps.parseContext.navigationTargets,
      findPhrase: this.deps.parseContext.findPhrase,
      bounds: this.deps.bounds,
    });
    if (!validation.ok || validation.action.action === 'unknown') {
      return this.unknownObservation(pending.candidate, pending.itemIds, UNSUPPORTED_MESSAGE, nowMs);
    }
    const command: ValidatedCommand = {
      candidateId: pending.candidate.id,
      source: 'luna',
      action: validation.action,
      confidence: validation.confidence,
      requiresConfirmation: validation.requiresConfirmation,
      contextRevision: pending.candidate.contextRevision,
      humanLabel: humanLabelFor(validation.action.action),
    };
    return { kind: 'command', command, candidate: pending.candidate, itemIds: pending.itemIds };
  }

  /** Expire a pending Luna interpretation past the hard timeout (§33.11). */
  expireLuna(nowMs: number): CommandObservation {
    const pending = this.pendingLuna;
    if (pending === undefined) return { kind: 'none' };
    if (nowMs - pending.sentAtMs <= this.settings.lunaHardTimeoutMs) return { kind: 'none' };
    this.pendingLuna = undefined;
    this.record({ label: pending.candidate.normalizedTranscript, status: 'timeout', atMs: nowMs });
    return this.unknownObservation(pending.candidate, pending.itemIds, UNSUPPORTED_MESSAGE, nowMs);
  }

  /* -------------------------------------------------------------------------
   * Acknowledgements (§33.10).
   * ----------------------------------------------------------------------- */

  acknowledgeExecuted(command: ValidatedCommand, nowMs: number, stageAckEnabled: boolean): void {
    this.record({ label: command.humanLabel, status: 'executed', atMs: nowMs });
    if (stageAckEnabled && this.settings.stageAcknowledgementMs > 0) {
      this.stageAck = {
        label: command.humanLabel,
        untilMs: nowMs + this.settings.stageAcknowledgementMs,
      };
    }
  }

  acknowledgeConfirmRequired(command: ValidatedCommand, nowMs: number): void {
    this.record({ label: command.humanLabel, status: 'confirm_required', atMs: nowMs });
  }

  acknowledgeRejected(label: string, nowMs: number): void {
    this.record({ label, status: 'rejected', atMs: nowMs });
  }

  /** Error chip only in control (§33.10): target not found. */
  targetNotFoundMessage(targetLabel: string): string {
    return `I couldn't find '${targetLabel}.'`;
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Spec §33.4 tail: the phrase was authored script after all, so anything a
   * previous `pending` masked has to go back to the aligner. Without this the
   * sentence the presenter was reading when a spurious wake fired stays
   * excluded from alignment for the rest of the session, and the engine's
   * masked-item set only ever grows.
   */
  private releaseObservation(itemIds: readonly string[]): CommandObservation {
    const release = new Set<string>(itemIds);
    for (const id of this.maskedByPending) release.add(id);
    this.maskedByPending.clear();
    const releaseItemIds = [...release].filter((id) => !this.consumed.has(id));
    return releaseItemIds.length > 0 ? { kind: 'none', releaseItemIds } : { kind: 'none' };
  }

  private unknownObservation(
    candidate: CommandCandidate,
    itemIds: string[],
    message: string,
    nowMs: number,
  ): CommandObservation {
    this.consume(itemIds);
    this.record({ label: candidate.normalizedTranscript, status: 'unknown', atMs: nowMs });
    return { kind: 'unknown', candidate, itemIds, message };
  }

  private makeCandidate(
    tokens: readonly LedgerToken[],
    itemIds: string[],
    wakeAlias: string,
    wakeConfidence: number,
    collisionScore: number,
    nowMs: number,
  ): CommandCandidate {
    this.candidateSequence++;
    return {
      id: `cmd-${this.sessionGeneration}-${this.candidateSequence}`,
      sessionGeneration: this.sessionGeneration,
      contextRevision: this.deps.getContextRevision(),
      itemIds,
      rawTranscript: tokens.map((t) => t.surface).join(' '),
      normalizedTranscript: tokens.map((t) => t.normalized).join(' '),
      wakeAlias,
      wakeConfidence,
      scriptCollisionScore: collisionScore,
      createdAtMs: nowMs,
    };
  }

  private consume(itemIds: readonly string[]): void {
    for (const id of itemIds) {
      this.consumed.add(id);
      this.maskedByPending.delete(id);
    }
    this.deps.ledger.setCommandDisposition(itemIds, 'command');
  }

  private isItemFinal(itemId: string): boolean {
    return this.deps.ledger.getItem(itemId)?.status === 'complete';
  }

  private record(entry: CommandLogEntry): void {
    this.log.push(entry);
    if (this.log.length > this.settings.commandHistorySize) {
      this.log.splice(0, this.log.length - this.settings.commandHistorySize);
    }
  }
}

/** Heuristic: does the phrase look like a command at all (§33.7)? */
const COMMAND_LIKE_WORDS = new Set([
  'go', 'goto', 'move', 'set', 'make', 'start', 'stop', 'pause', 'resume',
  'restart', 'back', 'forward', 'next', 'previous', 'find', 'show', 'hide',
  'turn', 'blank', 'mirror', 'unmirror', 'speed', 'slow', 'use', 'switch',
  'take', 'retake', 'mark', 'bigger', 'smaller', 'larger', 'text', 'font',
  'size', 'margin', 'margins', 'listener', 'chapter', 'chapters', 'section',
  'sections', 'sentence', 'sentences', 'paragraph', 'paragraphs', 'dim',
  'up', 'down', 'higher', 'lower', 'faster', 'slower', 'scroll', 'screen',
  'view', 'cues', 'beginning', 'end', 'top', 'bottom', 'heading', 'phrase',
]);

export function looksCommandLike(tokens: readonly LedgerToken[]): boolean {
  if (tokens.length === 0 || tokens.length > 16) return false;
  let hits = 0;
  for (const token of tokens) {
    if (COMMAND_LIKE_WORDS.has(token.normalized)) hits++;
  }
  return hits > 0;
}

function humanLabelFor(action: string): string {
  return action
    .split('_')
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}
