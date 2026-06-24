import { useEffect, useState } from 'react';
import type { StageStateProjection } from '@shared/contracts';
import styles from './StatusOverlay.module.css';

interface StatusOverlayProps {
  state: StageStateProjection;
  captionsEnabled: boolean;
  characterName?: string | null;
}

/** Visual states whose status text we surface (sparingly) on stage. The
 *  'standby' and 'complete' states render their own dedicated screens. */
const VISIBLE_STATUS: ReadonlySet<StageStateProjection['visualState']> = new Set([
  'listening',
  'thinking',
  'paused',
  'recovering',
]);

function fallbackStatusText(
  visualState: StageStateProjection['visualState'],
): string | null {
  switch (visualState) {
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Thinking';
    case 'paused':
      return 'Paused';
    case 'recovering':
      return 'Reconnecting';
    default:
      return null;
  }
}

/** Distinct glyph per mic gate — shape carries the meaning, not colour. */
function MicGlyph({ gate }: { gate: StageStateProjection['micState'] }): JSX.Element {
  const label =
    gate === 'active'
      ? 'Microphone live'
      : gate === 'armed'
        ? 'Microphone armed'
        : 'Microphone off';
  return (
    <span
      className={styles.mic}
      role="img"
      aria-label={label}
      data-gate={gate}
      title={label}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        {/* Mic body */}
        <rect x="9" y="3" width="6" height="11" rx="3" className={styles.micBody} />
        <path
          d="M6 11a6 6 0 0 0 12 0"
          fill="none"
          className={styles.micArc}
        />
        <line x1="12" y1="17" x2="12" y2="21" className={styles.micStem} />
        {gate === 'closed' ? (
          // Slash to read clearly as "off" without relying on colour.
          <line x1="4" y1="4" x2="20" y2="20" className={styles.micSlash} />
        ) : null}
        {gate === 'active' ? (
          // Filled dot indicates live capture.
          <circle cx="19" cy="5" r="3" className={styles.micLive} />
        ) : null}
      </svg>
    </span>
  );
}

/**
 * Minimal stage chrome: a mic-state glyph top-right and low-opacity status text
 * bottom-centre for a small set of states. Optional two-line captions sit just
 * above the status line and never cover the centre of the frame.
 */
export function StatusOverlay({
  state,
  captionsEnabled,
  characterName,
}: StatusOverlayProps): JSX.Element {
  const isStandby = state.visualState === 'standby';
  const isComplete = state.visualState === 'complete';

  const statusText =
    !isStandby && !isComplete && VISIBLE_STATUS.has(state.visualState)
      ? state.statusText ?? fallbackStatusText(state.visualState)
      : null;

  // Transient status fades after a couple of seconds so it never lingers as
  // permanent chrome; 'paused' stays put because it's a held state.
  const [statusVisible, setStatusVisible] = useState(true);
  useEffect(() => {
    if (statusText === null) {
      return undefined;
    }
    setStatusVisible(true);
    if (state.visualState === 'paused') {
      return undefined;
    }
    const timer = window.setTimeout(() => setStatusVisible(false), 2400);
    return () => window.clearTimeout(timer);
  }, [statusText, state.visualState]);

  const captions =
    captionsEnabled && state.captions !== null && state.captions !== ''
      ? state.captions
      : null;

  return (
    <div className={styles.overlay}>
      <div className={styles.topRight}>
        <MicGlyph gate={state.micState} />
      </div>

      {isStandby && (
        <div className={styles.screen} role="status" aria-live="polite">
          {characterName != null && characterName !== '' && (
            <p className={styles.screenName}>{characterName}</p>
          )}
          <p className={styles.screenTitle}>Your interview is ready.</p>
          <p className={styles.screenHint}>Press Start in CandidCue when you’re ready.</p>
        </div>
      )}

      {isComplete && (
        <div className={styles.screen} role="status" aria-live="polite">
          <p className={styles.screenTitle}>Interview complete</p>
          <p className={styles.screenHint}>Thank you for your time.</p>
        </div>
      )}

      {/* ARIA live region announces transient status changes for assistive tech. */}
      <div className={styles.status} aria-live="polite" aria-atomic="true">
        {statusText !== null ? (
          <span className={styles.statusText} data-visible={statusVisible ? 'true' : 'false'}>
            {statusText}
          </span>
        ) : null}
      </div>

      {captions !== null ? (
        <div className={styles.captions}>
          <div className={styles.captionPlate}>
            <p className={styles.captionLine}>{captions}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
