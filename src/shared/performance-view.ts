/**
 * The performance projection: what the presenter READS, as opposed to what the
 * author WROTE (spec §16.2, §24).
 *
 * ---------------------------------------------------------------------------
 * WHY A PROJECTION EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * A script is a document; a performance is not. The editor is right to draw a
 * code fence as a code card, a table as a table and a diagram as a diagram —
 * that is the material the author is working on, at a distance where working on
 * it is what you are doing. On a nine-inch panel two metres away through a
 * beamsplitter none of those is readable: a code card sized at three quarters of
 * a body size that was itself chosen for prompting distance is a texture, not
 * text.
 *
 * A large visual costs more than the space it wastes. It is a span the motion
 * engine has to detect and hold across (`hasVisualBlockBetween` in
 * `motion/lineMap.ts`), and every one of those holds is a re-anchor the
 * presenter feels — bought in exchange for something they could not have read
 * anyway.
 *
 * So in a take each non-spoken visual block becomes the one thing that IS
 * useful from where the presenter is standing: a cue saying the thing exists and
 * is not on this glass. In rehearsal — reading a script through at a desk — the
 * rich view is exactly right, and this is the identity function.
 *
 * ---------------------------------------------------------------------------
 * SPOKEN TOKENS DO NOT MOVE. EVER.
 * ---------------------------------------------------------------------------
 * The compiler is the single source of spoken tokens, and the alignment engine's
 * indices ARE the compiler's indices. A projection that dropped a spoken token
 * or renumbered one would not present as a rendering bug: tracking would follow
 * a script the presenter is not reading, and the display would be confidently
 * somewhere else. So the projection is allowed exactly two moves:
 *
 *   - REPLACE a block, only when that block carries no spoken tokens at all —
 *     checked in both places a token can hide, the block's own index range and
 *     `tokenIndexes` anywhere in its render tree. The replacement carries a
 *     single `cue` node, which by construction has no token indexes. (The range
 *     check is not redundant: with `readImageAltText` on, an image block's alt
 *     text becomes spoken tokens whose render nodes were discarded, so the tree
 *     alone would call that block token-free.)
 *   - UNWRAP a `link` node into the label nodes it already contained. This is
 *     the one edit made to blocks that ARE spoken, and it is safe because the
 *     text nodes come through by reference — same objects, same `tokenIndexes`,
 *     same order. Only the inert underline goes.
 *
 * `performance-view.test.ts` asserts the whole spoken-token sequence of a real
 * compiled document is identical either side of the projection.
 *
 * ---------------------------------------------------------------------------
 * A PROJECTION, NOT A COMPILE STEP
 * ---------------------------------------------------------------------------
 * Pure: same input, same output, no state, nothing mutated. A block the
 * projection does not change is returned BY REFERENCE, which is not only an
 * allocation saving — the stage caches measured block heights and DOM nodes per
 * block, and handing it a fresh object for an identical block would throw that
 * away on every recompute.
 */
import type { CompiledBlock, SafeRenderNode } from './contracts';

/**
 * Which view of the script is on the glass.
 *
 * Two values rather than a boolean because both are real states a presenter
 * chooses between, and `performanceMode: false` would have to be read as "not
 * performing", which is not what rehearsal is.
 */
export type PerformanceMode = 'take' | 'rehearsal';

/** The block kinds a take replaces with a cue. */
export type PerformanceCueKind = 'image' | 'table' | 'code' | 'diagram';

/**
 * What each replaced block says instead.
 *
 * Deliberately fixed strings rather than anything derived from the block — the
 * alt text, the fence language, the first table heading. Those are authored for
 * a reader at desk distance and are routinely a filename or a paragraph; putting
 * them on the glass would rebuild the problem the replacement exists to remove.
 * What the presenter needs is the fact, in as few words as carry it.
 */
export const PERFORMANCE_CUE_LABELS: Readonly<Record<PerformanceCueKind, string>> = {
  image: 'IMAGE ON SCREEN',
  table: 'REFER TO TABLE',
  code: 'DEMO CODE',
  diagram: 'DIAGRAM ON SCREEN',
};

/**
 * The `cueType` a projected cue carries.
 *
 * One value for all four, because from the presenter's side they are one kind
 * of instruction — something exists that is not here — and the stage's cue
 * vocabulary is small on purpose. The block kind it stands in for survives in
 * the layout hint, for anything that needs to tell them apart.
 */
export const PERFORMANCE_CUE_TYPE = 'reference';

/** Layout hint marking a block this projection replaced. Read it back through
 *  {@link performanceCueKind} so the key stays in one file. */
const PERFORMANCE_CUE_HINT = 'performanceCue';

/**
 * Project compiled blocks into the view the presenter reads.
 *
 * `rehearsal` is the identity: same blocks, same order, same objects.
 */
export function projectForPerformance(
  blocks: readonly CompiledBlock[],
  mode: PerformanceMode,
): CompiledBlock[] {
  if (mode === 'rehearsal') return blocks.slice();
  return blocks.map(projectBlock);
}

/**
 * The block kind a projected cue stands in for, or `null` for every real block.
 *
 * The renderer needs this for two decisions it cannot make from `kind` alone: a
 * projected cue must survive "hide cues" (hiding it would delete the presenter's
 * only evidence that a table exists), and it wants its own compact treatment
 * rather than the inline-aside one.
 */
export function performanceCueKind(block: CompiledBlock): PerformanceCueKind | null {
  const hint = block.layoutHints?.[PERFORMANCE_CUE_HINT];
  return isPerformanceCueKind(hint) ? hint : null;
}

function projectBlock(block: CompiledBlock): CompiledBlock {
  const cue = replaceableKind(block);
  if (cue !== null) return cueBlock(block, cue);
  // Links are already inert on stage; in a take they lose the underline too,
  // which is decoration describing an affordance that does not exist.
  if (!someNode(block.renderNodes, (node) => node.type === 'link')) return block;
  return { ...block, renderNodes: withoutLinks(block.renderNodes) };
}

/**
 * The cue kind this block may be replaced by, or `null` to leave it alone.
 *
 * An image the author explicitly marked as presenter reference stays, and it
 * needs no new syntax to say so: `:::stage` already means "this is for my glass,
 * not for the audience" (§23.6), and the compiler renders that as a
 * `stage_only` block carrying its own kind in `innerKind`. A kind this function
 * does not name is a kind it never touches, so those survive by construction —
 * as does a `:::stage` table or diagram, on the same argument.
 */
function replaceableKind(block: CompiledBlock): PerformanceCueKind | null {
  const kind = block.kind;
  if (!isPerformanceCueKind(kind)) return null;
  if (block.spoken || carriesSpokenTokens(block)) return null;
  return kind;
}

/**
 * The cue that replaces `block`.
 *
 * Built field by field rather than spread, because two of the fields must NOT
 * come through:
 *
 *   - `assetIds`, because the projected block draws nothing. It buys no bytes:
 *     the stage resolves images from `CompiledScript.assets`, not from this
 *     field, so nothing is loaded on its account today. What it costs is a
 *     block claiming to show a picture it has replaced with a sentence, and
 *     the next thing to read the field would be acting on that claim.
 *   - `startTokenIndex` / `endTokenIndex`, which `replaceableKind` has already
 *     guaranteed are absent — listing them nowhere is how that guarantee stays
 *     visible.
 *
 * The id is kept: this IS that block, projected. The stage keys its measured
 * heights, its `{#each}` blocks and its `[data-block-id]` lookups by it, so a
 * new id would not be a new name for the same thing — it would be a block the
 * stage has never measured, standing where the one it had measured was.
 */
function cueBlock(block: CompiledBlock, kind: PerformanceCueKind): CompiledBlock {
  return {
    id: block.id,
    kind: 'cue',
    renderNodes: [
      { type: 'cue', cueType: PERFORMANCE_CUE_TYPE, label: PERFORMANCE_CUE_LABELS[kind] },
    ],
    source: block.source,
    spoken: false,
    layoutHints: { ...block.layoutHints, [PERFORMANCE_CUE_HINT]: kind },
  };
}

/** Every `link` wrapper replaced by the label nodes it held, recursively. */
function withoutLinks(nodes: readonly SafeRenderNode[]): SafeRenderNode[] {
  const out: SafeRenderNode[] = [];
  for (const node of nodes) {
    if (node.type === 'link') {
      for (const inner of withoutLinks(node.label)) out.push(inner);
    } else if (node.type === 'table') {
      out.push({ ...node, rows: node.rows.map((row) => row.map((cell) => withoutLinks(cell))) });
    } else {
      out.push(node);
    }
  }
  return out;
}

function carriesSpokenTokens(block: CompiledBlock): boolean {
  if (block.startTokenIndex !== undefined || block.endTokenIndex !== undefined) return true;
  return someNode(
    block.renderNodes,
    (node) => node.type === 'text' && (node.tokenIndexes?.length ?? 0) > 0,
  );
}

/** Depth-first over the render tree, through link labels and table cells. */
function someNode(
  nodes: readonly SafeRenderNode[],
  match: (node: SafeRenderNode) => boolean,
): boolean {
  for (const node of nodes) {
    if (match(node)) return true;
    if (node.type === 'link') {
      if (someNode(node.label, match)) return true;
    } else if (node.type === 'table') {
      for (const row of node.rows) {
        for (const cell of row) {
          if (someNode(cell, match)) return true;
        }
      }
    }
  }
  return false;
}

function isPerformanceCueKind(value: unknown): value is PerformanceCueKind {
  return value === 'image' || value === 'table' || value === 'code' || value === 'diagram';
}
