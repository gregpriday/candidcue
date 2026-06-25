import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SpeechPlaybackPlan,
  StageBootstrap,
  StageStateProjection,
  ListeningClipRef,
} from '@shared/contracts';
import { mediaUrl } from './mediaUrl';
import styles from './VideoDeck.module.css';

interface VideoDeckProps {
  bootstrap: StageBootstrap;
  state: StageStateProjection;
  /** The most recent speaking plan, or null when none is pending. */
  plan: SpeechPlaybackPlan | null;
  /** Speech audio (authoritative) has finished for this turn. */
  speechEndedTurnId: string | null;
  /** Notifies the host that the speaking media is preloaded for `turnId`. */
  onSpeakingReady: (turnId: string) => void;
}

type Layer = 'a' | 'b';

const LISTENING_VISUAL_STATES: ReadonlySet<StageStateProjection['visualState']> =
  new Set(['standby', 'listening', 'thinking']);

/**
 * A randomised, non-repeating draw order over the listening clips. Reshuffles
 * once exhausted and never lets the same clip play twice in a row.
 */
class ShuffleBag {
  private order: number[] = [];
  private cursor = 0;
  private last = -1;

  constructor(private readonly size: number) {
    this.reshuffle();
  }

  next(): number {
    if (this.size <= 1) {
      return 0;
    }
    if (this.cursor >= this.order.length) {
      this.reshuffle();
    }
    let index = this.order[this.cursor] ?? 0;
    // Avoid an immediate repeat across a reshuffle boundary.
    if (index === this.last && this.cursor + 1 < this.order.length) {
      this.cursor += 1;
      index = this.order[this.cursor] ?? index;
    }
    this.cursor += 1;
    this.last = index;
    return index;
  }

  private reshuffle(): void {
    const next = Array.from({ length: this.size }, (_unused, i) => i);
    for (let i = next.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = next[i] ?? 0;
      const b = next[j] ?? 0;
      next[i] = b;
      next[j] = a;
    }
    this.order = next;
    this.cursor = 0;
  }
}

/**
 * Two stacked, cross-faded <video> elements. One layer shows the looping
 * listening footage; the other preloads/plays the interviewer's speaking clips.
 * On any media error we reveal the poster image underneath both layers.
 */
export function VideoDeck({
  bootstrap,
  state,
  plan,
  speechEndedTurnId,
  onSpeakingReady,
}: VideoDeckProps): JSX.Element {
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);

  // Which layer is currently visible on top.
  const [frontLayer, setFrontLayer] = useState<Layer>('a');
  // Which layer is dedicated to listening loops vs. speaking playback.
  const speakingLayerRef = useRef<Layer>('b');
  // Index of the speaking segment currently loaded on the speaking layer.
  const segIndexRef = useRef(0);
  const [posterVisible, setPosterVisible] = useState(false);

  const clips = bootstrap.listeningClips;
  const bag = useMemo(() => new ShuffleBag(Math.max(clips.length, 1)), [clips.length]);

  const refFor = useCallback(
    (layer: Layer): HTMLVideoElement | null =>
      (layer === 'a' ? videoARef.current : videoBRef.current),
    [],
  );

  const isListeningVisual = LISTENING_VISUAL_STATES.has(state.visualState);

  // --- Listening loop -----------------------------------------------------
  const playNextListeningClip = useCallback(() => {
    const listeningLayer: Layer = speakingLayerRef.current === 'a' ? 'b' : 'a';
    const el = refFor(listeningLayer);
    if (el === null || clips.length === 0) {
      return;
    }
    const clip: ListeningClipRef | undefined = clips[bag.next()];
    if (clip === undefined) {
      return;
    }
    el.src = clip.url;
    el.loop = false;
    el.muted = true;
    void el.play().catch(() => setPosterVisible(true));
  }, [bag, clips, refFor]);

  // --- Speaking segment loading -------------------------------------------
  /**
   * Load segment `index` of the current plan onto the speaking layer. Only the
   * FINAL segment loops (so the speaking visual holds until audio — which is
   * authoritative — ends); earlier segments fire 'ended' to advance.
   */
  const loadSpeakingSegment = useCallback(
    (index: number): boolean => {
      if (plan === null) {
        return false;
      }
      const segments = plan.media.segments;
      const seg = segments[index];
      const el = refFor(speakingLayerRef.current);
      if (el === null || seg === undefined) {
        return false;
      }
      segIndexRef.current = index;
      el.src = mediaUrl(seg.relativePath);
      el.playbackRate = seg.playbackRate > 0 ? seg.playbackRate : 1;
      el.loop = index === segments.length - 1;
      el.muted = true;
      return true;
    },
    [plan, refFor],
  );

  const advanceSpeakingSegment = useCallback(() => {
    if (plan === null) {
      return;
    }
    const next = segIndexRef.current + 1;
    if (next >= plan.media.segments.length) {
      return; // the final segment loops/holds until speech audio ends
    }
    if (loadSpeakingSegment(next)) {
      const el = refFor(speakingLayerRef.current);
      void el?.play().catch(() => setPosterVisible(true));
    }
  }, [plan, loadSpeakingSegment, refFor]);

  const handleLayerEnded = useCallback(
    (layer: Layer) => {
      if (state.visualState === 'speaking' && layer === speakingLayerRef.current) {
        advanceSpeakingSegment();
      } else if (isListeningVisual && layer !== speakingLayerRef.current) {
        playNextListeningClip();
      }
    },
    [state.visualState, isListeningVisual, advanceSpeakingSegment, playNextListeningClip],
  );

  // Kick off / sustain the listening loop while in a listening-ish state.
  useEffect(() => {
    if (!isListeningVisual) {
      return;
    }
    const listeningLayer: Layer = speakingLayerRef.current === 'a' ? 'b' : 'a';
    setFrontLayer(listeningLayer);
    const el = refFor(listeningLayer);
    if (el !== null && (el.src === '' || el.ended || el.paused)) {
      playNextListeningClip();
    }
  }, [isListeningVisual, playNextListeningClip, refFor]);

  // --- Speaking preload (segment 0) + readiness ---------------------------
  useEffect(() => {
    if (plan === null) {
      return;
    }
    const segments = plan.media.segments;
    const el = refFor(speakingLayerRef.current);
    if (el === null || segments.length === 0) {
      // No media to play (poster fallback plan); still report ready so the turn
      // isn't blocked waiting on the deck.
      onSpeakingReady(plan.turnId);
      return;
    }

    loadSpeakingSegment(0);

    const handleReady = (): void => onSpeakingReady(plan.turnId);
    if (el.readyState >= 3 /* HAVE_FUTURE_DATA */) {
      handleReady();
    } else {
      el.addEventListener('canplay', handleReady, { once: true });
    }
    el.load();

    return () => {
      el.removeEventListener('canplay', handleReady);
    };
  }, [plan, refFor, onSpeakingReady, loadSpeakingSegment]);

  // Start speaking playback + crossfade when the visual state says so.
  useEffect(() => {
    if (state.visualState !== 'speaking' || plan === null) {
      return;
    }
    const speakingLayer = speakingLayerRef.current;
    const el = refFor(speakingLayer);
    if (el === null) {
      return;
    }
    setFrontLayer(speakingLayer);
    void el.play().catch(() => setPosterVisible(true));
  }, [state.visualState, plan, refFor]);

  // Pause the speaking <video> layer and hand its role back to listening duty,
  // returning the front to the listening loop. Shared by the natural-end path
  // and the leave-speaking (pause/complete/error) path so audio + video stop
  // together rather than the footage looping on after a mid-speech stop.
  const stopSpeakingAndReturnToListening = useCallback(() => {
    const previousSpeaking = speakingLayerRef.current;
    const el = refFor(previousSpeaking);
    if (el !== null) {
      el.pause();
    }
    // Swap roles so the next speaking plan preloads on the now-idle layer.
    speakingLayerRef.current = previousSpeaking === 'a' ? 'b' : 'a';
    segIndexRef.current = 0;
    const listeningLayer = previousSpeaking;
    setFrontLayer(listeningLayer);
    playNextListeningClip();
  }, [refFor, playNextListeningClip]);

  // When speech audio ends naturally, return to listening.
  useEffect(() => {
    if (speechEndedTurnId === null) {
      return;
    }
    stopSpeakingAndReturnToListening();
  }, [speechEndedTurnId, stopSpeakingAndReturnToListening]);

  // Pause the speaking layer when the visual state transitions AWAY from
  // 'speaking' to a control state (paused/complete/error) WITHOUT a natural
  // audio end — e.g. Pause or End Now mid-speech. Without this the speaking
  // footage keeps looping (the final segment has el.loop = true) even though the
  // audio was stopped. The natural-end path above already handled the end-of-
  // speech case via speechEndedTurnId, so skip when that has fired for clarity.
  const speakingActive = state.visualState === 'speaking';
  const prevSpeakingActiveRef = useRef(false);
  useEffect(() => {
    const wasSpeaking = prevSpeakingActiveRef.current;
    prevSpeakingActiveRef.current = speakingActive;
    // Only react to a speaking -> non-speaking transition that was NOT a natural
    // audio end (speechEndedTurnId drives that path and resets per new plan).
    if (wasSpeaking && !speakingActive && speechEndedTurnId === null) {
      stopSpeakingAndReturnToListening();
    }
  }, [speakingActive, speechEndedTurnId, stopSpeakingAndReturnToListening]);

  // --- Transform / fit ----------------------------------------------------
  const fit = bootstrap.video.fit;
  const transitionMs = bootstrap.video.transitionMs;

  const transform = useMemo(() => {
    const mirror = state.mirror ? -1 : 1;
    const offsetY = state.verticalOffsetPercent;
    return `translateY(${offsetY}%) scale(${state.zoom}) scaleX(${mirror})`;
  }, [state.mirror, state.zoom, state.verticalOffsetPercent]);

  const handleError = useCallback(() => setPosterVisible(true), []);

  const layerClass = (layer: Layer): string =>
    `${styles.video} ${frontLayer === layer ? styles.front : styles.back}`;

  return (
    <div className={styles.deck}>
      <img
        className={`${styles.poster} ${posterVisible ? styles.posterVisible : ''}`}
        src={bootstrap.posterUrl}
        alt=""
        aria-hidden="true"
        style={{ objectFit: fit, transform }}
      />
      <video
        ref={videoARef}
        className={layerClass('a')}
        style={{ objectFit: fit, transform, transitionDuration: `${transitionMs}ms` }}
        muted
        playsInline
        onError={handleError}
        onStalled={handleError}
        onEnded={() => handleLayerEnded('a')}
      />
      <video
        ref={videoBRef}
        className={layerClass('b')}
        style={{ objectFit: fit, transform, transitionDuration: `${transitionMs}ms` }}
        muted
        playsInline
        onError={handleError}
        onStalled={handleError}
        onEnded={() => handleLayerEnded('b')}
      />
    </div>
  );
}
