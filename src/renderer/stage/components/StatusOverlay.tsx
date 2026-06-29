import { useEffect, useState } from 'react';
import type { StageStateProjection } from '@shared/contracts';
import styles from './StatusOverlay.module.css';

/** A brief confirm/reject cue for a keypress. `token` increments per press so a
 *  repeated identical key still restarts the cue (the element is keyed on it). */
export interface CommandFeedback {
  kind: 'ok' | 'rejected';
  token: number;
}

interface StatusOverlayProps {
  state: StageStateProjection;
  captionsEnabled: boolean;
  characterName?: string | null;
  /** Show the keyboard legend (also shown automatically on standby). */
  legendVisible?: boolean;
  /** Transient confirm/reject cue for the last keypress, or null. */
  commandFeedback?: CommandFeedback | null;
  /** Seconds left in the founder's start countdown, or null when not counting. */
  countdown?: number | null;
}

/** The keyboard controls surfaced in the on-screen legend, in press order. The
 *  labels mirror exactly what `commandForKey` / stage-app act on. */
const LEGEND_ROWS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'Space', label: 'Commit answer' },
  { keys: 'P', label: 'Pause / Resume' },
  { keys: 'R', label: 'Repeat question' },
  { keys: 'S', label: 'Skip question' },
  { keys: 'Shift + E', label: 'End interview' },
  { keys: 'Shift + Esc', label: 'Exit stage' },
  { keys: '?', label: 'Toggle controls' },
];

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
  legendVisible = false,
  commandFeedback = null,
  countdown = null,
}: StatusOverlayProps): JSX.Element {
  const isStandby = state.visualState === 'standby';
  const isCounting = isStandby && countdown !== null;
  const isComplete = state.visualState === 'complete';
  const isError = state.visualState === 'error';

  // 'listening' is the founder's turn: always show the actionable "Answer now"
  // cue (overriding any orchestrator statusText) so the prompt to speak is
  // unmistakable rather than a passive "Listening" that reads as the machine's
  // state and fades into chrome.
  const statusText =
    isStandby || isComplete || !VISIBLE_STATUS.has(state.visualState)
      ? null
      : state.visualState === 'listening'
        ? 'Answer now'
        : state.statusText ?? fallbackStatusText(state.visualState);

  // Transient status fades after a couple of seconds so it never lingers as
  // permanent chrome. Held states keep their cue on screen: 'paused' and
  // 'recovering' can last a while (a real reconnect looks frozen if it fades),
  // and 'listening' is the founder's turn — "Answer now" must persist until they
  // act, not vanish into a dim corner glyph.
  const [statusVisible, setStatusVisible] = useState(true);
  useEffect(() => {
    if (statusText === null) {
      return undefined;
    }
    setStatusVisible(true);
    if (
      state.visualState === 'paused' ||
      state.visualState === 'recovering' ||
      state.visualState === 'listening'
    ) {
      return undefined;
    }
    const timer = window.setTimeout(() => setStatusVisible(false), 2400);
    return () => window.clearTimeout(timer);
  }, [statusText, state.visualState]);

  // The legend's visibility is fully owned by the caller (StageApp): it defaults
  // open on standby to orient the founder, auto-hides once the interview starts
  // so it stays out of the frame, and toggles with '?'.
  const showLegend = legendVisible;

  // The model-authored teleprompter cue: the on-screen question (headline) the
  // founder reads, plus an optional coaching line. This is the primary prompt —
  // shown independently of the verbatim captions toggle — and the orchestrator
  // already gates it to the live turn (speaking → answer). The coaching prompt
  // shows only while Mira is the one talking ("how to answer" belongs to her
  // turn); once the founder answers, the headline stays for reference but the
  // steer recedes.
  const cue =
    !isError && state.cue !== null && state.cue.headline !== '' ? state.cue : null;
  const cuePrompt =
    cue !== null && state.visualState === 'speaking' && cue.prompt !== null && cue.prompt !== ''
      ? cue.prompt
      : null;

  // When a cue owns the lower third, the verbatim caption plate steps aside so
  // the two never stack into a double readout of the same question.
  const captions =
    !isError && cue === null && captionsEnabled && state.captions !== null && state.captions !== ''
      ? state.captions
      : null;

  return (
    <div className={styles.overlay}>
      <div className={styles.topRight}>
        <MicGlyph gate={state.micState} />
      </div>

      {isStandby && !isCounting && (
        <div className={styles.screen} role="status" aria-live="polite">
          {characterName != null && characterName !== '' && (
            <p className={styles.screenName}>{characterName}</p>
          )}
          <p className={styles.screenTitle}>Your interview is ready.</p>
          <p className={styles.screenHint}>
            {state.canBegin ? 'Press Space to begin.' : 'Getting everything ready…'}
          </p>
          <p className={styles.screenHint}>Press ? anytime to show the controls.</p>
        </div>
      )}

      {/* The countdown is its own assertive live region — kept a sibling of the
          standby screen above (never nested) so screen readers announce each
          tick without ambiguous nested-live-region behaviour. */}
      {isCounting && (
        <div className={styles.screen} role="timer" aria-live="assertive" aria-atomic="true">
          {characterName != null && characterName !== '' && (
            <p className={styles.screenName}>{characterName}</p>
          )}
          <p className={styles.screenTitle}>Starting in {countdown}…</p>
        </div>
      )}

      {isComplete && (
        <div className={styles.screen} role="status" aria-live="polite">
          <p className={styles.screenTitle}>Interview complete</p>
          <p className={styles.screenHint}>Thank you for your time.</p>
        </div>
      )}

      {isError && (
        <div className={styles.screen} role="status" aria-live="polite">
          <p className={styles.screenTitle}>Something went wrong.</p>
          <p className={styles.screenHint}>Check CandidCue to retry the session.</p>
        </div>
      )}

      {/* Brief confirm/reject cue so a wrong-moment keypress is never silent.
          Keyed on the token so a repeated identical press restarts the cue. */}
      {commandFeedback !== null ? (
        <span
          key={commandFeedback.token}
          className={styles.feedback}
          data-kind={commandFeedback.kind}
          role="status"
          aria-live="polite"
        >
          {commandFeedback.kind === 'ok' ? 'Got it' : 'Not now'}
        </span>
      ) : null}

      {/* ARIA live region announces transient status changes for assistive tech. */}
      <div className={styles.status} aria-live="polite" aria-atomic="true">
        {statusText !== null ? (
          <span className={styles.statusText} data-visible={statusVisible ? 'true' : 'false'}>
            {statusText}
          </span>
        ) : null}
      </div>

      {/* Keyboard legend: quiet, non-interactive help. Kept in the DOM so it can
          fade, but hidden from assistive tech while not shown. */}
      <div className={styles.legend} data-visible={showLegend ? 'true' : 'false'} aria-hidden={!showLegend}>
        {LEGEND_ROWS.map((row) => (
          <div key={row.keys} className={styles.legendRow}>
            <span className={styles.legendKey}>{row.keys}</span>
            <span className={styles.legendLabel}>{row.label}</span>
          </div>
        ))}
      </div>

      {/* Teleprompter cue: a soft lower-third scrim grounds the text so it reads
          over a bright (non-dark) video, then the serif headline + optional
          coaching line. No plate, no bordered box — the scrim and text-shadow
          carry legibility. The headline is keyed on its text so a new question
          replays the entrance reveal. */}
      {cue !== null ? (
        <>
          <div className={styles.lowerScrim} aria-hidden="true" />
          <div className={styles.cue}>
            <p key={cue.headline} className={styles.cueHeadline}>
              {cue.headline}
            </p>
            {cuePrompt !== null ? <p className={styles.cuePrompt}>{cuePrompt}</p> : null}
          </div>
        </>
      ) : null}

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
