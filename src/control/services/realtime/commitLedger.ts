/**
 * Commit ledger (spec §29.3).
 *
 * Maintains the local monotonically increasing `commitSequence` and the
 * association between local commits and OpenAI item IDs, which arrive later
 * via `input_audio_buffer.committed`. Completion events can arrive out of
 * order; chronological application must use local commit order — the ledger
 * is the authority for that ordering. Pure (injected clock only).
 */
import type { CommitMeta, CommitReason } from '../../../shared/contracts';

export interface PendingCommitInput {
  reason: CommitReason;
  speechStartMs: number;
  speechEndMs: number;
  alignmentAnchor?: number;
  likelyCommand?: boolean;
}

export class CommitLedger {
  private nextSequence = 1;
  private sessionGeneration = 0;
  private readonly commits: CommitMeta[] = [];
  /** Commits sent but not yet associated with an OpenAI item id (FIFO). */
  private readonly unassociated: CommitMeta[] = [];
  private readonly byItemId = new Map<string, CommitMeta>();

  getSessionGeneration(): number {
    return this.sessionGeneration;
  }

  /** Bump on every fresh connection; stale-generation events are ignorable. */
  beginSessionGeneration(): number {
    this.sessionGeneration += 1;
    this.unassociated.length = 0;
    return this.sessionGeneration;
  }

  /** Record a commit at send time (spec §29.3). Returns the assigned meta. */
  recordPending(input: PendingCommitInput): CommitMeta {
    const meta: CommitMeta = {
      commitSequence: this.nextSequence,
      sessionGeneration: this.sessionGeneration,
      reason: input.reason,
      speechStartMs: input.speechStartMs,
      speechEndMs: input.speechEndMs,
      alignmentAnchor: input.alignmentAnchor,
      likelyCommand: input.likelyCommand,
    };
    this.nextSequence += 1;
    this.commits.push(meta);
    this.unassociated.push(meta);
    return meta;
  }

  /**
   * Associate the next unassociated commit (FIFO — server acknowledges
   * commits in audio order) with the item id from
   * `input_audio_buffer.committed`. Returns the meta, or null when the item
   * cannot be matched to a local commit.
   */
  associateItem(itemId: string): CommitMeta | null {
    const existing = this.byItemId.get(itemId);
    if (existing) return existing;
    const meta = this.unassociated.shift();
    if (!meta) return null;
    meta.itemId = itemId;
    this.byItemId.set(itemId, meta);
    return meta;
  }

  /**
   * M1: undo the most recent `recordPending` when the commit could not be
   * sent (data channel closed/closing).
   *
   * The FIFO is an ordered promise that the server WILL acknowledge these
   * commits in this order. A commit that never left the client breaks that
   * promise permanently: every later item is then matched to the wrong
   * commit metadata — wrong alignment anchor, wrong command heuristic, wrong
   * audio timestamps — for the rest of the session, silently.
   */
  rollbackPending(meta: CommitMeta): boolean {
    const tail = this.unassociated.at(-1);
    if (!tail || tail.commitSequence !== meta.commitSequence) return false;
    this.unassociated.pop();
    const index = this.commits.lastIndexOf(meta);
    if (index >= 0) this.commits.splice(index, 1);
    // Reuse the sequence number: it was never observable to the provider.
    if (this.nextSequence === meta.commitSequence + 1) this.nextSequence -= 1;
    return true;
  }

  /** Commits sent but not yet acknowledged by the provider (M1 diagnostics). */
  get pendingCount(): number {
    return this.unassociated.length;
  }

  getByItemId(itemId: string): CommitMeta | null {
    return this.byItemId.get(itemId) ?? null;
  }

  getCommitSequenceForItem(itemId: string): number | null {
    return this.byItemId.get(itemId)?.commitSequence ?? null;
  }

  /** All commits in local (chronological) order for the current session. */
  getCommits(): readonly CommitMeta[] {
    return this.commits;
  }

  /** Drop bookkeeping for a stopped session (spec §29.7 stop semantics). */
  clear(): void {
    this.commits.length = 0;
    this.unassociated.length = 0;
    this.byItemId.clear();
  }
}
