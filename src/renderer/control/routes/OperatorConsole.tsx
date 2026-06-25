import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionRuntimeState, SessionCommand } from '@shared/domain';
import type {
  OperatorSessionSnapshot,
  PublicCoverageItem,
  PublicProviderStatus,
} from '@shared/contracts';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { useSnapshot } from '../state/useSnapshot';
import { formatElapsed } from '../lib/format';
import { describeError } from '../lib/errors';
import styles from './OperatorConsole.module.css';

interface OperatorConsoleProps {
  nav: Navigator;
  sessionId: string;
}

interface StateDescriptor {
  tone: StatusTone;
  label: string;
}

/** Reassuring, human state copy — what's happening, in the interviewee's terms. */
const STATE_DESCRIPTORS: Record<SessionRuntimeState, StateDescriptor> = {
  IDLE: { tone: 'neutral', label: 'Idle' },
  PREPARING: { tone: 'pending', label: 'Preparing the interview' },
  READY: { tone: 'success', label: 'Ready' },
  INTERVIEWER_THINKING: { tone: 'active', label: 'Mira is preparing the next question' },
  INTERVIEWER_BUFFERING: { tone: 'active', label: 'Preparing the next question' },
  INTERVIEWER_SPEAKING: { tone: 'active', label: 'Mira is speaking' },
  USER_ARMED: { tone: 'pending', label: 'Your turn — take your time' },
  USER_SPEAKING: { tone: 'active', label: 'Mira is listening' },
  ENDPOINT_CANDIDATE: { tone: 'pending', label: 'Waiting for a natural pause' },
  TURN_FINALIZING: { tone: 'active', label: 'Saving your answer' },
  PAUSED: { tone: 'warning', label: 'Paused' },
  RECOVERING: { tone: 'warning', label: 'Reconnecting' },
  FINISHING: { tone: 'pending', label: 'Wrapping up' },
  COMPLETED: { tone: 'success', label: 'Interview complete' },
  ERROR: { tone: 'danger', label: 'Something went wrong' },
};

const COVERAGE_TONE: Record<PublicCoverageItem['status'], StatusTone> = {
  not_started: 'neutral',
  partial: 'pending',
  covered: 'success',
  skipped: 'warning',
};

const COVERAGE_WORD: Record<PublicCoverageItem['status'], string> = {
  not_started: 'Not discussed',
  partial: 'In progress',
  covered: 'Covered',
  skipped: 'Skipped',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.closest('.cm-editor') !== null
  );
}

/**
 * Focus is on an interactive control (e.g. a transport button). Let it handle its
 * own keys so Space/Enter activates the focused button instead of the global
 * shortcut wrong-firing at it.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button, a[href], [role="button"]') !== null;
}

export function OperatorConsole({ nav, sessionId }: OperatorConsoleProps): JSX.Element {
  const snapshot = useSnapshot();
  const [commandError, setCommandError] = useState<string | null>(null);

  const sendCommand = useCallback(async (command: SessionCommand) => {
    setCommandError(null);
    try {
      const result = await window.candidcue.sessions.command(command);
      if (!result.ok && result.error) {
        setCommandError(result.error.publicMessage);
      }
    } catch (err: unknown) {
      setCommandError(describeError(err));
    }
  }, []);

  const completed = snapshot?.state === 'COMPLETED';
  useEffect(() => {
    if (completed) {
      const id = snapshot?.sessionId ?? sessionId;
      const timer = window.setTimeout(() => nav.go({ name: 'review', sessionId: id }), 600);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [completed, snapshot, sessionId, nav]);

  const controls = snapshot?.controls;
  useEffect(() => {
    if (!snapshot) {
      return undefined;
    }
    const handler = (event: KeyboardEvent): void => {
      if (
        event.repeat ||
        // A confirmation sheet is open — don't drive the session behind it.
        document.querySelector('[aria-modal="true"]') !== null ||
        isEditableTarget(event.target) ||
        isInteractiveTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (event.code === 'Space' || key === ' ') {
        if (controls?.canCommit) {
          event.preventDefault();
          void sendCommand({ type: 'COMMIT_USER_TURN', reason: 'manual' });
        }
        return;
      }
      if (key === 'p') {
        if (controls?.canResume) {
          event.preventDefault();
          void sendCommand({ type: 'RESUME_SESSION' });
        } else if (controls?.canPause) {
          event.preventDefault();
          void sendCommand({ type: 'PAUSE_SESSION' });
        }
        return;
      }
      if (key === 'r') {
        if (controls?.canRepeat) {
          event.preventDefault();
          void sendCommand({ type: 'REPEAT_QUESTION' });
        }
        return;
      }
      if (key === 's') {
        if (controls?.canSkip) {
          event.preventDefault();
          void sendCommand({ type: 'SKIP_QUESTION' });
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [snapshot, controls, sendCommand]);

  if (!snapshot) {
    return (
      <div className={styles.waiting}>
        <p>Connecting to the session…</p>
        <Button variant="ghost" onClick={() => nav.go({ name: 'home' })}>
          Exit
        </Button>
      </div>
    );
  }

  return (
    <OperatorView
      snapshot={snapshot}
      commandError={commandError}
      onCommand={(command) => void sendCommand(command)}
      onExit={() => nav.go({ name: 'home' })}
    />
  );
}

interface OperatorViewProps {
  snapshot: OperatorSessionSnapshot;
  commandError: string | null;
  onCommand: (command: SessionCommand) => void;
  onExit: () => void;
}

function OperatorView({ snapshot, commandError, onCommand, onExit }: OperatorViewProps): JSX.Element {
  const descriptor = STATE_DESCRIPTORS[snapshot.state];
  const controls = snapshot.controls;
  const [endConfirm, setEndConfirm] = useState(false);

  const announcement = useMemo(() => {
    const parts = [descriptor.label];
    if (snapshot.recoverableWarning) {
      parts.push(snapshot.recoverableWarning);
    }
    return parts.join('. ');
  }, [descriptor.label, snapshot.recoverableWarning]);

  const hasAnswer = snapshot.finalTranscriptSoFar !== '' || snapshot.partialTranscript !== '';
  const awaitingAnswer = snapshot.state === 'USER_ARMED' || snapshot.state === 'USER_SPEAKING';

  return (
    <div className={styles.console}>
      <div className={styles.visuallyHidden} role="status" aria-live="assertive">
        {announcement}
      </div>

      <header className={styles.bar}>
        <div className={styles.barLeft}>
          <LiveIndicator paused={snapshot.state === 'PAUSED'} />
          <span className={styles.timer} aria-label="Elapsed time">
            {formatElapsed(snapshot.elapsedMs)}
          </span>
        </div>
        <div className={styles.barTitle}>{snapshot.projectTitle}</div>
        <div className={styles.barRight}>
          <MicChip mic={snapshot.mic} />
          <ConnectionChip status={snapshot.providerStatus} />
          <button type="button" className={styles.exit} onClick={onExit} title="Exit the live console">
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>

      {snapshot.recoverableWarning && (
        <div className={styles.warning} role="alert">
          <StatusIcon tone="warning" label="Warning" />
          <span>{snapshot.recoverableWarning}</span>
        </div>
      )}
      {commandError !== null && (
        <p className={styles.commandError} role="alert">
          {commandError}
        </p>
      )}

      <main className={styles.conversation}>
        <p className={styles.stateLine} data-tone={descriptor.tone}>
          {descriptor.label}
        </p>
        <p className={styles.question}>
          {snapshot.currentQuestion ?? <span className={styles.muted}>Preparing the first question…</span>}
        </p>

        <div className={styles.answer}>
          <span className={styles.speaker}>You</span>
          {hasAnswer ? (
            <p className={styles.answerText}>
              {snapshot.finalTranscriptSoFar}
              {snapshot.partialTranscript && <span className={styles.partial}> {snapshot.partialTranscript}</span>}
            </p>
          ) : (
            <p className={styles.answerPlaceholder}>
              {awaitingAnswer ? 'Your turn — take your time.' : 'Mira is listening.'}
            </p>
          )}
        </div>

        <Topics items={snapshot.coverage} />
      </main>

      <footer className={styles.transport}>
        <div className={styles.transportSecondary}>
          {controls.canResume ? (
            <Button
              className={styles.transportButton}
              onClick={() => onCommand({ type: 'RESUME_SESSION' })}
              title="Resume (P)"
            >
              <Icon name="play" size={16} /> Resume
            </Button>
          ) : (
            <Button
              className={styles.transportButton}
              onClick={() => onCommand({ type: 'PAUSE_SESSION' })}
              disabled={!controls.canPause}
              title="Pause (P)"
            >
              <Icon name="pause" size={16} /> Pause
            </Button>
          )}
        </div>

        <Button
          variant="primary"
          className={styles.finish}
          onClick={() => onCommand({ type: 'COMMIT_USER_TURN', reason: 'manual' })}
          disabled={!controls.canCommit}
          title="Finish answer (Space)"
        >
          <Icon name="check" size={16} /> Finish answer
        </Button>

        <div className={styles.transportSecondary}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onCommand({ type: 'REPEAT_QUESTION' })}
            disabled={!controls.canRepeat}
            title="Repeat question (R)"
            aria-label="Repeat question"
          >
            <Icon name="repeat" size={18} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onCommand({ type: 'SKIP_QUESTION' })}
            disabled={!controls.canSkip}
            title="Skip question (S)"
            aria-label="Skip question"
          >
            <Icon name="skip" size={18} />
          </button>
          <button
            type="button"
            className={styles.iconButtonDanger}
            onClick={() => setEndConfirm(true)}
            disabled={!controls.canEnd}
            title="End after this answer"
            aria-label="End after this answer"
          >
            <Icon name="stop" size={18} />
          </button>
        </div>
      </footer>

      <Sheet
        open={endConfirm}
        onClose={() => setEndConfirm(false)}
        tone="danger"
        title="End the interview after this answer?"
        description="Mira will wrap up once the current answer is saved."
        actions={
          <>
            <Button variant="ghost" onClick={() => setEndConfirm(false)}>
              Keep going
            </Button>
            <Button
              variant="danger"
              disabled={!controls.canEnd}
              onClick={() => {
                setEndConfirm(false);
                if (controls.canEnd) {
                  onCommand({ type: 'END_AFTER_TURN' });
                }
              }}
            >
              End after turn
            </Button>
          </>
        }
      />
    </div>
  );
}

function LiveIndicator({ paused }: { paused: boolean }): JSX.Element {
  return (
    <span className={paused ? styles.liveIndicatorPaused : styles.liveIndicator}>
      <span className={styles.liveDot} aria-hidden />
      {paused ? 'PAUSED' : 'LIVE'}
    </span>
  );
}

function MicChip({ mic }: { mic: OperatorSessionSnapshot['mic'] }): JSX.Element {
  const tone: StatusTone = mic.gate === 'active' ? 'success' : mic.gate === 'armed' ? 'pending' : 'neutral';
  const label = mic.gate === 'active' ? 'Mic on' : mic.gate === 'armed' ? 'Mic ready' : 'Mic off';
  // Restrained live level — only while the mic is open. level is normalised 0..1;
  // a light curve keeps quiet speech visible without the bar pinning to the top.
  const open = mic.gate === 'active';
  const fill = open ? Math.min(1, Math.max(0, mic.level)) ** 0.7 : 0;
  return (
    <span className={styles.chip} title={mic.deviceLabel ? `${label} · ${mic.deviceLabel}` : label}>
      <StatusIcon tone={tone} label={label} size={13} />
      <span className={styles.chipLabel}>Mic</span>
      <span className={styles.micLevel} data-open={open || undefined} aria-hidden>
        <span className={styles.micLevelFill} style={{ transform: `scaleY(${0.12 + fill * 0.88})` }} />
      </span>
    </span>
  );
}

function ConnectionChip({ status }: { status: PublicProviderStatus }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const values = [status.openai, status.inworldStt, status.inworldTts];
  const overall: 'ok' | 'degraded' | 'down' = values.includes('down')
    ? 'down'
    : values.includes('degraded')
      ? 'degraded'
      : 'ok';
  const tone: StatusTone = overall === 'ok' ? 'success' : overall === 'degraded' ? 'warning' : 'danger';
  const label = overall === 'ok' ? 'Connected' : overall === 'degraded' ? 'Degraded' : 'Connection lost';

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows: Array<{ label: string; value: 'ok' | 'degraded' | 'down' }> = [
    { label: 'OpenAI', value: status.openai },
    { label: 'Speech-to-text', value: status.inworldStt },
    { label: 'Voice', value: status.inworldTts },
  ];

  return (
    <div className={styles.connection} ref={ref}>
      <button
        type="button"
        className={
          overall === 'ok'
            ? styles.chipButton
            : overall === 'down'
              ? styles.chipButtonDanger
              : styles.chipButtonAlert
        }
        onClick={() => setOpen((prev) => !prev)}
        title={`Connection: ${label}`}
        aria-expanded={open}
      >
        <StatusIcon tone={tone} label={label} size={13} />
        <span className={styles.chipLabel}>{overall === 'ok' ? 'Connection' : label}</span>
      </button>
      {open && (
        <div className={styles.connectionPopover} role="group" aria-label="Connection details">
          <ul className={styles.connectionList}>
            {rows.map((row) => {
              const rowTone: StatusTone = row.value === 'ok' ? 'success' : row.value === 'degraded' ? 'warning' : 'danger';
              const rowWord = row.value === 'ok' ? 'Connected' : row.value === 'degraded' ? 'Degraded' : 'Offline';
              return (
                <li key={row.label}>
                  <StatusIcon tone={rowTone} label={rowWord} size={13} />
                  <span className={styles.connectionName}>{row.label}</span>
                  <span className={styles.connectionValue}>{rowWord}</span>
                </li>
              );
            })}
          </ul>
          {status.lastQuestionLatencyMs !== null && (
            <p className={styles.connectionLatency}>Last question took {status.lastQuestionLatencyMs} ms</p>
          )}
        </div>
      )}
    </div>
  );
}

function Topics({ items }: { items: PublicCoverageItem[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return null;
  }
  const covered = items.filter((item) => item.status === 'covered').length;
  const remaining = items.filter((item) => item.status !== 'covered');
  const shown = expanded ? items : remaining.slice(0, 3);

  return (
    <section className={styles.topics}>
      <div className={styles.topicsHead}>
        <span className={styles.topicsTitle}>Topics</span>
        <span className={styles.topicsCount}>
          {covered} of {items.length}
        </span>
      </div>
      <div className={styles.topicsBar} aria-hidden>
        <div className={styles.topicsBarFill} style={{ width: `${(covered / items.length) * 100}%` }} />
      </div>
      <ul className={styles.topicsList}>
        {shown.map((item) => {
          const inProgress = item.status === 'partial';
          return (
            <li key={item.id} className={styles.topicItem} data-current={inProgress || undefined}>
              <span className={styles.topicMark} data-current={inProgress || undefined}>
                <StatusIcon tone={COVERAGE_TONE[item.status]} label={COVERAGE_WORD[item.status]} size={13} />
              </span>
              <span className={styles.topicLabel}>{item.label}</span>
              <span className={styles.topicStatus}>{COVERAGE_WORD[item.status]}</span>
            </li>
          );
        })}
      </ul>
      {items.length > shown.length || expanded ? (
        <button type="button" className={styles.topicsToggle} onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? 'Show less' : `Show all ${items.length}`}
        </button>
      ) : null}
    </section>
  );
}
