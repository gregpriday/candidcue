/**
 * Stage envelope construction (spec §29.2 step 3, §43.3): projects an
 * immutable CompiledScript into the StageSessionEnvelope the stage window
 * hydrates from, resolving asset and Listener media URLs through Rust.
 */
import type {
  CompiledScript,
  ListenerStageSelection,
  StageRenderDocument,
  StageSessionEnvelope,
  StageSettings,
} from '../../shared/contracts';
import { resolveFollowProfile, type FollowingSettings } from '../lib/follow-profiles';
import { invokeOrMock } from './ipc';

/* ---------------------------------------------------------------------------
 * Stage settings
 * ------------------------------------------------------------------------- */

export interface StageSettingsOverrides {
  fontFamilyId?: string;
  fontSizePx?: number;
  lineHeight?: number;
  columnWidthPercent?: number;
  readingBandCenterPercent?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  background?: string;
  pastDimming?: boolean;
  phraseHighlight?: boolean;
  showCues?: boolean;
}

/** Defaults per spec Appendix A.3 (mirrors the stage preview settings). */
export function buildStageSettings(overrides: StageSettingsOverrides = {}): StageSettings {
  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: overrides.background ?? '#000000',
    foreground: '#f5f3ef',
    fontFamilyId: overrides.fontFamilyId ?? 'system-sans',
    fontSizePx: overrides.fontSizePx ?? 64,
    lineHeight: overrides.lineHeight ?? 1.28,
    letterSpacingEm: 0,
    columnWidthPercent: overrides.columnWidthPercent ?? 68,
    readingBandCenterPercent: overrides.readingBandCenterPercent ?? 38,
    readingBandHalfHeightPercent: 4,
    pastOpacity: overrides.pastDimming === false ? 0.92 : 0.42,
    futureOpacity: 0.92,
    currentUnderlayOpacity: overrides.phraseHighlight === false ? 0 : 0.1,
    mirrorX: overrides.mirrorX ?? false,
    mirrorY: overrides.mirrorY ?? false,
    showCues: overrides.showCues ?? true,
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: 0.7,
  };
}

/* ---------------------------------------------------------------------------
 * Render document
 * ------------------------------------------------------------------------- */

/**
 * Project a compiled script into the stage's render document. Sentences and
 * take layout hints are populated so the current-phrase underlay and take
 * headers render without re-parsing (spec §16.2).
 */
export function buildStageRenderDocument(
  script: CompiledScript,
  assets: StageRenderDocument['assets'] = {},
): StageRenderDocument {
  // Take markers → layout hints on their carrying block (§21.4).
  const takeByBlock = new Map<string, string>();
  for (const cue of script.cues) {
    if (cue.cueType === 'take') takeByBlock.set(cue.blockId, cue.label);
  }

  const blocks = script.blocks.map((block) => {
    const takeLabel = takeByBlock.get(block.id);
    if (takeLabel === undefined) return block;
    return {
      ...block,
      layoutHints: { ...block.layoutHints, take: true, takeLabel },
    };
  });

  return {
    schemaVersion: 1,
    title: script.title,
    blocks,
    tokenToNode: script.spokenTokens.map((token) => ({
      tokenIndex: token.index,
      blockId: token.blockId,
      nodeKey: '',
    })),
    assets,
    sentences: script.sentences.map((sentence) => ({
      id: sentence.id,
      blockId: sentence.blockId,
      startTokenIndex: sentence.startTokenIndex,
      endTokenIndex: sentence.endTokenIndex,
    })),
  };
}

/** Resolve local asset URLs through Rust (asset-protocol scope, §47.8). */
export async function resolveDocumentAssets(
  script: CompiledScript,
): Promise<StageRenderDocument['assets']> {
  // The compiler's `img-<hash>` ids are node keys derived from the authored
  // URL, never database ids, so the href must travel with them: Rust resolves
  // by canonical path and answers under the id we sent (§24.1).
  const local = script.assets
    .filter((a) => !a.remote && a.kind === 'image')
    .map((a) => ({ id: a.id, href: a.href }));
  if (local.length === 0) return {};
  try {
    const entries = await invokeOrMock<Record<string, { url: string; mime: string }>>(
      'resolve_asset_urls',
      { scriptId: script.scriptId, assetsToResolve: local },
      () => ({}),
    );
    const resolved: StageRenderDocument['assets'] = {};
    for (const [id, entry] of Object.entries(entries)) {
      resolved[id] = { url: entry.url, mime: entry.mime };
    }
    return resolved;
  } catch {
    // Unresolvable assets degrade to alt text on the stage (§24.2).
    return {};
  }
}

/* ---------------------------------------------------------------------------
 * Envelope
 * ------------------------------------------------------------------------- */

export interface EnvelopeInput {
  script: CompiledScript;
  sessionId: string;
  sessionGeneration: number;
  stageGeneration: number;
  stageSettings: StageSettings;
  listener?: ListenerStageSelection;
  initialTokenIndex?: number;
  assets?: StageRenderDocument['assets'];
  /**
   * §47 follow settings. Resolved here into the §55 motion profile the stage's
   * engine runs on, so the Follow feel the user chose is in force from the
   * first frame. Omitted settings mean the stage keeps its own default profile.
   */
  following?: FollowingSettings;
}

export function buildStageEnvelope(input: EnvelopeInput): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    sessionGeneration: input.sessionGeneration,
    stageGeneration: input.stageGeneration,
    scriptId: input.script.scriptId,
    sourceHash: input.script.sourceHash,
    compileRevision: 1,
    stageSettings: input.stageSettings,
    renderDocument: buildStageRenderDocument(input.script, input.assets ?? {}),
    ...(input.listener ? { listener: input.listener } : {}),
    initialTokenIndex: input.initialTokenIndex ?? 0,
    ...(input.following ? { followProfile: resolveFollowProfile(input.following) } : {}),
  };
}
