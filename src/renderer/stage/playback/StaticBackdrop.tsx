import { useEffect, useMemo } from 'react';
import type { SpeechPlaybackPlan, StageBootstrap, StageStateProjection } from '@shared/contracts';
import styles from './StaticBackdrop.module.css';

interface StaticBackdropProps {
  bootstrap: StageBootstrap;
  state: StageStateProjection;
  /** The most recent speaking plan, or null when none is pending. */
  plan: SpeechPlaybackPlan | null;
  /** Notifies the host that the (non-existent) speaking media is "ready". */
  onSpeakingReady: (turnId: string) => void;
}

/**
 * The stage backdrop while the avatar video deck is disabled
 * (STATIC_STAGE_BACKGROUND). It shows a single still image — the interviewer's
 * poster — for the whole session, and applies the same fit/mirror/zoom/offset
 * transform the VideoDeck would so framing is unchanged.
 *
 * There is no video to decode, so it acknowledges each new plan immediately:
 * the orchestrator's dual readiness gate (audio decode AND speaking-media ready)
 * then falls through to the decoded audio alone, and the turn is never blocked
 * waiting on a clip that will never load.
 *
 * The effect keys off the `plan` instance, NOT its `turnId`: repeat / retake /
 * resume re-send a fresh plan for the SAME turn (the host resets its readiness
 * refs for each plan), so keying on turnId alone would skip the re-acknowledge
 * and deadlock the readiness gate. Every plan is a new object, so this re-fires
 * exactly when the host expects a fresh "ready".
 */
export function StaticBackdrop({
  bootstrap,
  state,
  plan,
  onSpeakingReady,
}: StaticBackdropProps): JSX.Element {
  useEffect(() => {
    if (plan !== null) {
      onSpeakingReady(plan.turnId);
    }
  }, [plan, onSpeakingReady]);

  const transform = useMemo(() => {
    const mirror = state.mirror ? -1 : 1;
    return `translateY(${state.verticalOffsetPercent}%) scale(${state.zoom}) scaleX(${mirror})`;
  }, [state.mirror, state.zoom, state.verticalOffsetPercent]);

  return (
    <div className={styles.backdrop}>
      {bootstrap.posterUrl !== '' ? (
        <img
          className={styles.image}
          src={bootstrap.posterUrl}
          alt=""
          aria-hidden="true"
          style={{ objectFit: bootstrap.video.fit, transform }}
        />
      ) : null}
    </div>
  );
}
