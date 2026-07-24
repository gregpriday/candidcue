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
  CoachRailState,
  CompiledBlock,
  DeliveryScoreState,
  ListenerStageSelection,
  SemanticMotionFrame,
  StageDirective,
  StageRenderDocument,
  StageSessionEnvelope,
  StageSettings,
  StageStatePayload,
  TrackingSnapshot,
} from '../shared/contracts';
import { STAGE_EVENT } from '../shared/contracts';
import {
  initialFillerState,
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
  resolveRailModules,
} from '../shared/coaching/coach/coach-state';
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
  /**
   * §11.1. Put the Coaching Rail's delivery score into a given state — `null`
   * for "not scored at all", a partial for anything else. The next rail
   * snapshot carries it.
   *
   * This exists because the score's states are exactly what the rail must
   * survive without reflowing (`Listening…` → `84` → `100`), and that is a
   * property only a real layout engine can be asked about. The browser suite
   * drives it through {@link PREVIEW_DRIVER_KEY}.
   */
  setDeliveryScore(score: Partial<DeliveryScoreState> | null): void;
}

/** Where {@link startPreviewDriver} parks the driver for the browser suite. */
export const PREVIEW_DRIVER_KEY = '__stagePreview';

/**
 * A believable mid-take rail (§27). The numbers are settled rather than
 * learning, so the preview shows the layout a presenter actually reads — and so
 * a test can change one thing (the score) with everything else held still.
 */
function previewDeliveryScore(overrides: Partial<DeliveryScoreState>): DeliveryScoreState {
  return {
    displayScore: 84,
    rawScore: 84,
    confidence: 0.72,
    tier: 'usable',
    dimensions: [],
    weakestDimension: null,
    trend: 'steady',
    ...overrides,
  };
}

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
    if (tokenIndex >= built.tokenCount - 1) tokenIndex = 0;
    else tokenIndex += 1;
    emitTracking('advance', false);
  };

  function emitTracking(movement: TrackingSnapshot['movement'], provisional: boolean) {
    revision += 1;
    const snapshot: TrackingSnapshot = {
      schemaVersion: 1,
      revision,
      sessionId: envelope.sessionId,
      sessionGeneration: 1,
      stageGeneration: STAGE_GEN,
      scriptId: envelope.scriptId,
      tokenIndex,
      committedTokenIndex: Math.max(0, tokenIndex - 2),
      blockId: built.tokenBlock[tokenIndex] ?? 'b0',
      sentenceId: built.tokenSentence[tokenIndex] ?? 's0',
      confidence: 0.92,
      state: 'following',
      provisional,
      movement,
      sourceItemIds: [],
      generatedAtMs: Date.now(),
    };
    dispatchLocalStageEvent(STAGE_EVENT.trackingSnapshot, snapshot);
  }

  /**
   * Semantic motion frames (companion §26.1) at ~20 Hz, so the preview
   * exercises the real v2 motion path rather than the degraded snapshot one.
   * The preview "speaks" at a steady pace and the stage interpolates between
   * frames — which is exactly the behavior worth eyeballing.
   */
  const SEMANTIC_HZ = 20;
  const PREVIEW_UNITS_PER_SECOND = 2.6;
  const sessionStartMs = performance.now();
  let semanticRevision = 0;
  let semanticUnit = 0;

  function semanticTick() {
    if (frozen || blanked) return;
    semanticRevision += 1;
    semanticUnit = (semanticUnit + PREVIEW_UNITS_PER_SECOND / SEMANTIC_HZ) % built.tokenCount;
    const token = Math.min(built.tokenCount - 1, Math.floor(semanticUnit));
    const frame: SemanticMotionFrame = {
      sessionId: envelope.sessionId,
      sessionGeneration: 1,
      scriptCompileHash: envelope.sourceHash,
      // The stage builds its first map as generation 1.
      layoutGeneration: 1,
      revision: semanticRevision,
      epoch: 1,
      sessionTimeMs: performance.now() - sessionStartMs,
      estimatedUnit: semanticUnit,
      committedUnit: Math.max(0, semanticUnit - 2),
      velocityUnitsPerSecond: PREVIEW_UNITS_PER_SECOND,
      accelerationUnitsPerSecond2: 0,
      positionVariance: 0.2,
      confidence: 0.92,
      sectionId: 'section:0',
      tokenIndex: token,
      sentenceId: built.tokenSentence[token] ?? 's0',
      blockId: built.tokenBlock[token] ?? 'b0',
      state: 'following',
      behavior: 'normal',
      finalEvidence: true,
      motionProfileId: 'default-v1',
    };
    dispatchLocalStageEvent(STAGE_EVENT.semanticFrame, frame);
  }

  /**
   * The Coaching Rail (§27), published at the producer's own §12.2 rate so the
   * preview exercises the real snapshot path: an advancing `audioTimeMs`, a
   * bounded ribbon, and one delivery score the rail rate-limits for itself.
   */
  const RAIL_PUBLISH_MS = 200;
  const RAIL_MODE = 'coach' as const;
  let railRevision = 0;
  let railScore: DeliveryScoreState | null = previewDeliveryScore({});

  function railTick() {
    railRevision += 1;
    const audioTimeMs = performance.now() - sessionStartMs;
    const snapshot: CoachRailState = {
      schemaVersion: 1,
      stageRevision: railRevision,
      sessionId: envelope.sessionId,
      takePassId: 'preview-pass-1',
      mode: RAIL_MODE,
      modules: resolveRailModules(RAIL_MODE),
      audioTimeMs,
      visible: true,
      mirrored: settings.mirrorX,
      reducedMotion: settings.reducedMotion,
      pace: {
        ...initialPaceState(115, 160),
        wpm: 142,
        confidence: 0.9,
        state: 'on_target',
      },
      variety: {
        ...initialVarietyState(40, 75),
        level: 61,
        confidence: 0.8,
        state: 'balanced',
      },
      fillers: { ...initialFillerState(), confirmedCount: 2, confirmedLast60s: 2 },
      microphone: initialMicrophoneState(),
      score: railScore,
      // A tip that outlives the preview, so the centre zone is occupied and the
      // rail looks like a rail. A real producer bounds these tightly (§9.3);
      // this one is a demo of the layout, not of the tip policy.
      activeTip: {
        tipId: 'preview-tip-1',
        code: 'USE_SILENT_PAUSE',
        textKey: 'coach.tip.USE_SILENT_PAUSE',
        interpolations: {},
        severity: 'gentle',
        priority: 60,
        createdAudioTimeMs: 0,
        evidenceStartMs: 0,
        evidenceEndMs: 0,
        earliestDisplayMs: 0,
        expiresAudioTimeMs: Number.MAX_SAFE_INTEGER,
        minimumDisplayMs: 2_500,
        maximumDisplayMs: Number.MAX_SAFE_INTEGER,
        cooldownKey: 'filler',
        trackingEpoch: 1,
        takePassId: 'preview-pass-1',
        scriptAnchorTokenId: null,
        evidenceIds: [],
        source: 'local',
      },
      // A speech trace across the whole window plus one confirmed filler a few
      // seconds back, so the ribbon has something to slide.
      ribbonEvents: [
        {
          eventId: 'preview-speech',
          type: 'speech',
          startMs: Math.max(0, audioTimeMs - 18_000),
          endMs: audioTimeMs,
          confidence: 1,
          takePassId: 'preview-pass-1',
        },
        {
          eventId: 'preview-filler',
          type: 'confirmed_filler',
          startMs: Math.max(0, audioTimeMs - 6_000),
          endMs: Math.max(0, audioTimeMs - 5_800),
          confidence: 1,
          takePassId: 'preview-pass-1',
        },
      ],
      gutterMarks: [],
    };
    dispatchLocalStageEvent(STAGE_EVENT.coachRail, snapshot);
  }

  railTick();
  const railTimer = window.setInterval(railTick, RAIL_PUBLISH_MS);

  const semanticTimer = window.setInterval(semanticTick, 1000 / SEMANTIC_HZ);
  const trackingTimer = window.setInterval(trackingTick, 340);
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
      clearInterval(semanticTimer);
      clearInterval(trackingTimer);
      clearInterval(heartbeatTimer);
      clearInterval(railTimer);
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
      // A large forward skip: the semantic position moves and the stage is
      // told to re-anchor rather than race through the skipped paragraphs.
      tokenIndex = Math.min(built.tokenCount - 1, tokenIndex + 40);
      semanticUnit = tokenIndex;
      semanticRevision += 1;
      const nowMs = performance.now() - sessionStartMs;
      dispatchLocalStageEvent<SemanticMotionFrame>(STAGE_EVENT.semanticFrame, {
        sessionId: envelope.sessionId,
        sessionGeneration: 1,
        scriptCompileHash: envelope.sourceHash,
        layoutGeneration: 1,
        revision: semanticRevision,
        epoch: 1,
        sessionTimeMs: nowMs,
        estimatedUnit: semanticUnit,
        committedUnit: semanticUnit,
        velocityUnitsPerSecond: PREVIEW_UNITS_PER_SECOND,
        accelerationUnitsPerSecond2: 0,
        positionVariance: 0.5,
        confidence: 0.85,
        sectionId: 'section:0',
        tokenIndex,
        sentenceId: built.tokenSentence[tokenIndex] ?? 's0',
        blockId: built.tokenBlock[tokenIndex] ?? 'b0',
        state: 'reanchoring',
        behavior: 'large_skip',
        finalEvidence: true,
        motionProfileId: 'default-v1',
        transition: {
          id: `preview-jump-${semanticRevision}`,
          type: 'reanchor',
          authority: 'ordinary',
          fromUnit: Math.max(0, semanticUnit - 40),
          toUnit: semanticUnit,
          destinationTokenIndex: tokenIndex,
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + 3000,
          semanticEpoch: 1,
          reason: 'large_forward_skip',
        },
      });
      emitTracking('skip', false);
    },
    setDeliveryScore(score: Partial<DeliveryScoreState> | null) {
      railScore = score === null ? null : previewDeliveryScore(score);
      // Publish immediately rather than waiting out the interval: a caller that
      // just set a state wants to see it.
      railTick();
    },
  };

  // Dev-only, and only inside `?preview=1`: the browser suite drives the same
  // object the keyboard shortcuts drive, so there is no second protocol to keep
  // in step with this one.
  (window as unknown as Record<string, unknown>)[PREVIEW_DRIVER_KEY] = driver;
  return driver;
}
