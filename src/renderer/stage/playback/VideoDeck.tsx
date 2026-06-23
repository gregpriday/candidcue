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

  // --- Speaking preload + crossfade --------------------------------------
  useEffect(() => {
    if (plan === null) {
      return;
    }
    const segments = plan.media.segments;
    const first = segments[0];
    const speakingLayer = speakingLayerRef.current;
    const el = refFor(speakingLayer);
    if (el === null || first === undefined) {
      // No media to play (poster fallback plan); still report ready so the
      // turn isn't blocked waiting on the deck.
      onSpeakingReady(plan.turnId);
      return;
    }

    el.src = mediaUrl(first.relativePath);
    el.playbackRate = first.playbackRate > 0 ? first.playbackRate : 1;
    el.loop = segments.length === 1;
    el.muted = true;

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
  }, [plan, refFor, onSpeakingReady]);

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

  // When speech audio ends, hand the speaking layer back to listening duty and
  // return the front to the listening loop.
  useEffect(() => {
    if (speechEndedTurnId === null) {
      return;
    }
    const previousSpeaking = speakingLayerRef.current;
    const el = refFor(previousSpeaking);
    if (el !== null) {
      el.pause();
    }
    // Swap roles so the next speaking plan preloads on the now-idle layer.
    speakingLayerRef.current = previousSpeaking === 'a' ? 'b' : 'a';
    const listeningLayer = previousSpeaking;
    setFrontLayer(listeningLayer);
    playNextListeningClip();
  }, [speechEndedTurnId, refFor, playNextListeningClip]);

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
        onEnded={isListeningVisual ? playNextListeningClip : undefined}
      />
      <video
        ref={videoBRef}
        className={layerClass('b')}
        style={{ objectFit: fit, transform, transitionDuration: `${transitionMs}ms` }}
        muted
        playsInline
        onError={handleError}
        onStalled={handleError}
        onEnded={isListeningVisual ? playNextListeningClip : undefined}
      />
    </div>
  );
}
