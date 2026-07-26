/**
 * Windowed preview mode (?preview=1): feeds the real stage event protocol
 * through the local bus so the whole stage can be exercised in a plain
 * browser during development — no Tauri, no control window.
 *
 * Dev-only by construction: asset URLs are repo-relative (`/assets/...`),
 * which the Vite dev server serves from the project root. Production always
 * receives resolved URLs inside the event payloads instead.
 */
import type {
  CompiledBlock,
  ListenerStageSelection,
  AlignmentSnapshot,
  StageDirective,
  StageRenderDocument,
  StageSessionEnvelope,
  StageSettings,
  StageStatePayload,
} from '../shared/contracts';
import { STAGE_EVENT } from '../shared/contracts';
import { dispatchLocalStageEvent } from './events';
import { isCompactViewport } from './renderer/geometry';

const MIRA_BASE = '/assets/listeners/mira';

export function previewListenerSelection(): ListenerStageSelection {
  return {
    packId: 'mira',
    version: '1.0.0',
    variant: '1080p',
    placement: 'background',
    geometry: {
      anchorX: 0.5,
      anchorY: 0.45,
      scale: 1,
      cropX: 0,
      cropY: 0,
      cropZoom: 1.15, // manifest defaultZoom — clips are framed loosely
      opacity: 0.4,
      blurPx: 0,
      saturation: 0.85,
      mirrorVideo: false,
    },
    clipUrls: [
      {
        id: 'listening-7s',
        url: `${MIRA_BASE}/listening/mira-listening-7s.mp4`,
        mime: 'video/mp4',
        durationMs: 7042,
        posterUrl: `${MIRA_BASE}/poster.webp`,
      },
      {
        id: 'listening-10s',
        url: `${MIRA_BASE}/listening/mira-listening-10s.mp4`,
        mime: 'video/mp4',
        durationMs: 10042,
        posterUrl: `${MIRA_BASE}/poster.webp`,
      },
    ],
  };
}

function previewSettings(compact: boolean): StageSettings {
  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: '#000000',
    foreground: '#f5f3ef',
    fontFamilyId: 'system-sans',
    fontSizePx: compact ? 40 : 64,
    lineHeight: compact ? 1.22 : 1.28,
    letterSpacingEm: 0,
    columnWidthPercent: compact ? 82 : 68,
    readingBandCenterPercent: compact ? 36 : 38,
    readingBandHalfHeightPercent: compact ? 5 : 4,
    pastOpacity: compact ? 0.48 : 0.42,
    futureOpacity: compact ? 0.96 : 0.92,
    currentUnderlayOpacity: compact ? 0.12 : 0.1,
    mirrorX: false,
    mirrorY: false,
    showCues: true,
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: 0.7,
  };
}

interface BuiltDoc {
  doc: StageRenderDocument;
  tokenCount: number;
  tokenBlock: string[];
  tokenSentence: string[];
}

function buildDocument(): BuiltDoc {
  const paragraphs: Array<{ kind: CompiledBlock['kind']; text: string; hints?: Record<string, string | number | boolean> }> = [
    { kind: 'heading', text: 'A calm start', hints: { level: 1 } },
    {
      kind: 'paragraph',
      text: 'Welcome back to the channel. Today we are walking through the new release, and I want to keep this simple, honest, and useful for anyone recording alone.',
    },
    {
      kind: 'paragraph',
      text: 'Reading from a prompter should feel like speaking to a person. The text drifts gently through a reading band instead of crawling at a fixed speed.',
    },
    { kind: 'cue', text: 'Smile — hold two beats' },
    {
      kind: 'paragraph',
      text: 'When you wander off script, nothing snaps or races. The stage waits, listens, and settles the moment it finds you again.',
    },
    { kind: 'heading', text: 'Take two', hints: { level: 2, take: true, takeLabel: 'Take 2' } },
    {
      kind: 'paragraph',
      text: 'This is the part where most tools get pushy. Ours does not. Manual moves win instantly, and voice tracking politely re-acquires around wherever you went.',
    },
    {
      kind: 'silent',
      text: 'Producer note: b-roll of the studio desk goes over this section.',
    },
    {
      kind: 'paragraph',
      text: 'If you enable the Listener, Mira sits quietly behind the script. She never talks and never reacts to your words; she simply gives your eyes a person to find.',
    },
    {
      kind: 'paragraph',
      text: 'That is the whole philosophy. Fewer moving parts on screen, more attention on your delivery, and a stage that stays out of the recording.',
    },
    {
      kind: 'paragraph',
      text: 'Thanks for watching. If this helped, you know what to do — and I will see you in the next one.',
    },
  ];

  const blocks: CompiledBlock[] = [];
  const tokenToNode: StageRenderDocument['tokenToNode'] = [];
  const sentences: NonNullable<StageRenderDocument['sentences']> = [];
  const tokenBlock: string[] = [];
  const tokenSentence: string[] = [];
  let token = 0;

  paragraphs.forEach((p, i) => {
    const id = `b${i}`;
    const spoken = p.kind === 'paragraph' || p.kind === 'heading';
    if (!spoken) {
      blocks.push({
        id,
        kind: p.kind,
        renderNodes:
          p.kind === 'cue'
            ? [{ type: 'cue', cueType: 'delivery', label: p.text }]
            : [{ type: 'text', text: p.text }],
        source: { utf16Start: 0, utf16End: 0 },
        spoken: false,
        layoutHints: p.hints,
      });
      return;
    }
    const words = p.text.split(/\s+/);
    const tokenIndexes = words.map(() => token++);
    const start = tokenIndexes[0] ?? 0;
    const end = tokenIndexes[tokenIndexes.length - 1] ?? start;
    const sentenceId = `s${i}`;
    for (const t of tokenIndexes) {
      tokenToNode.push({ tokenIndex: t, blockId: id, nodeKey: 'n0' });
      tokenBlock[t] = id;
      tokenSentence[t] = sentenceId;
    }
    sentences.push({ id: sentenceId, blockId: id, startTokenIndex: start, endTokenIndex: end });
    blocks.push({
      id,
      kind: p.kind,
      renderNodes: [{ type: 'text', text: p.text, tokenIndexes }],
      startTokenIndex: start,
      endTokenIndex: end,
      source: { utf16Start: 0, utf16End: 0 },
      spoken: true,
      layoutHints: p.hints,
    });
  });

  return {
    doc: {
      schemaVersion: 1,
      title: 'Stage preview',
      blocks,
      tokenToNode,
      assets: {},
      sentences,
    },
    tokenCount: token,
    tokenBlock,
    tokenSentence,
  };
}

export interface PreviewDriver {
  stop(): void;
  toggleListener(): void;
  toggleBlank(): void;
  toggleFreeze(): void;
  toggleMirror(): void;
  toggleCalibration(): void;
  ack(label: string): void;
  jump(): void;
}

/** Where {@link startPreviewDriver} parks the driver for the browser suite. */
export const PREVIEW_DRIVER_KEY = '__stagePreview';


const STAGE_GEN = 1;

export function startPreviewDriver(): PreviewDriver {
  const compact = isCompactViewport(window.innerWidth, window.innerHeight);
  const built = buildDocument();
  let settings = previewSettings(compact);
  let listenerOn = false;
  let blanked = false;
  let frozen = false;
  let calibration = false;
  let revision = 0;
  let heartbeatRevision = 0;
  let tokenIndex = 0;

  const envelope: StageSessionEnvelope = {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    sessionGeneration: 1,
    stageGeneration: STAGE_GEN,
    scriptId: '00000000-0000-0000-0000-000000000001',
    sourceHash: 'preview',
    compileRevision: 1,
    stageSettings: settings,
    renderDocument: built.doc,
    initialTokenIndex: 0,
  };

  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope);

  const trackingTick = () => {
    if (frozen || blanked) return;
    audioMs += 1000;
    // One second of speech at the preview's pace, so the position the snapshot
    // reports and the rate it claims describe the same motion.
    const advance = Math.max(1, Math.round(PREVIEW_TOKENS_PER_SECOND));
    tokenIndex =
      tokenIndex + advance >= built.tokenCount - 1 ? 0 : tokenIndex + advance;
    emitTracking(false);
  };

  function emitTracking(provisional: boolean) {
    revision += 1;
    const snapshot: AlignmentSnapshot = {
      sessionGeneration: 1,
      seq: revision,
      state: 'following',
      decision: provisional ? 'localObserved' : 'localConfirmed',
      confirmedToken: Math.max(0, tokenIndex - 2),
      observedToken: tokenIndex,
      rateTokensPerSecond: PREVIEW_TOKENS_PER_SECOND,
      evidenceAudioMs: audioMs,
      atAudioMs: audioMs,
      maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
      confidence: 0.92,
      suggestionToken: null,
      scriptLenTokens: built.tokenCount,
      observedAtom: tokenIndex,
      confirmedAtom: Math.max(0, tokenIndex - 2),
    };
    dispatchLocalStageEvent(STAGE_EVENT.alignmentSnapshot, snapshot);
  }

  /**
   * The preview "speaks" at a steady pace and emits one snapshot a second, the
   * same cadence the real engine produces. Everything between those snapshots
   * is the stage extrapolating through `alignmentDisplayAt` — which is exactly
   * the behaviour worth eyeballing, and what the preview exists for.
   */
  const PREVIEW_TOKENS_PER_SECOND = 2.6;
  let audioMs = 0;

  const trackingTimer = window.setInterval(trackingTick, 1000);
  const heartbeatTimer = window.setInterval(() => {
    heartbeatRevision += 1;
    dispatchLocalStageEvent(STAGE_EVENT.heartbeat, {
      stageGeneration: STAGE_GEN,
      revision: heartbeatRevision,
      sentAtMs: Date.now(),
    });
  }, 1000);

  const directive = (d: StageDirective) =>
    dispatchLocalStageEvent<StageStatePayload>(STAGE_EVENT.applyCommand, {
      stageGeneration: STAGE_GEN,
      directive: d,
    });

  const driver: PreviewDriver = {
    stop() {
      clearInterval(trackingTimer);
      clearInterval(heartbeatTimer);
      delete (window as unknown as Record<string, unknown>)[PREVIEW_DRIVER_KEY];
    },
    toggleListener() {
      listenerOn = !listenerOn;
      directive({ kind: 'listener', listener: listenerOn ? previewListenerSelection() : null });
    },
    toggleBlank() {
      blanked = !blanked;
      directive({ kind: 'blank', blanked, keepListener: false });
    },
    toggleFreeze() {
      frozen = !frozen;
      directive({ kind: 'freeze', frozen });
    },
    toggleMirror() {
      settings = { ...settings, mirrorX: !settings.mirrorX };
      directive({ kind: 'settings', settings });
    },
    toggleCalibration() {
      calibration = !calibration;
      directive({ kind: 'calibration', active: calibration, crosshairX: 0.5, crosshairY: 0.4 });
    },
    ack(label: string) {
      directive({ kind: 'ack', label, durationMs: 900 });
    },
    jump() {
      // A large forward skip: the position moves a long way at once and the
      // stage classifies it as an accepted discontinuity to fly, rather than
      // racing through the skipped paragraphs.
      tokenIndex = Math.min(built.tokenCount - 1, tokenIndex + 40);
      revision += 1;
      audioMs += 1000;
      dispatchLocalStageEvent<AlignmentSnapshot>(STAGE_EVENT.alignmentSnapshot, {
        sessionGeneration: 1,
        seq: revision,
        state: 'following',
        decision: 'jumpForwardAccepted',
        confirmedToken: tokenIndex,
        observedToken: tokenIndex,
        rateTokensPerSecond: PREVIEW_TOKENS_PER_SECOND,
        evidenceAudioMs: audioMs,
        atAudioMs: audioMs,
        maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
        confidence: 0.85,
        suggestionToken: null,
        scriptLenTokens: built.tokenCount,
        observedAtom: tokenIndex,
        confirmedAtom: tokenIndex,
      });
    },
  };

  // Dev-only, and only inside `?preview=1`: the browser suite drives the same
  // object the keyboard shortcuts drive, so there is no second protocol to keep
  // in step with this one.
  (window as unknown as Record<string, unknown>)[PREVIEW_DRIVER_KEY] = driver;
  return driver;
}
