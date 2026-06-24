import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Panel } from '../components/Panel';
import { PageHeader } from '../components/PageHeader';
import { useSnapshot } from '../state/useSnapshot';
import { formatElapsed } from '../lib/format';
import { describeError } from '../lib/errors';
import route from './route.module.css';
import styles from './OperatorConsole.module.css';

interface OperatorConsoleProps {
  nav: Navigator;
  sessionId: string;
}

interface StateDescriptor {
  tone: StatusTone;
  label: string;
}

const STATE_DESCRIPTORS: Record<SessionRuntimeState, StateDescriptor> = {
  IDLE: { tone: 'neutral', label: 'Idle' },
  PREPARING: { tone: 'pending', label: 'Preparing' },
  READY: { tone: 'success', label: 'Ready' },
  INTERVIEWER_THINKING: { tone: 'active', label: 'Mira is thinking' },
  INTERVIEWER_BUFFERING: { tone: 'active', label: 'Buffering question' },
  INTERVIEWER_SPEAKING: { tone: 'active', label: 'Mira is speaking' },
  USER_ARMED: { tone: 'pending', label: 'Ready for your answer' },
  USER_SPEAKING: { tone: 'active', label: 'Listening' },
  ENDPOINT_CANDIDATE: { tone: 'pending', label: 'Detecting end of answer' },
  TURN_FINALIZING: { tone: 'active', label: 'Finalizing answer' },
  PAUSED: { tone: 'warning', label: 'Paused' },
  RECOVERING: { tone: 'warning', label: 'Recovering' },
  FINISHING: { tone: 'pending', label: 'Finishing up' },
  COMPLETED: { tone: 'success', label: 'Completed' },
  ERROR: { tone: 'danger', label: 'Error' },
};

const PROVIDER_TONE: Record<'ok' | 'degraded' | 'down', StatusTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
};

const COVERAGE_TONE: Record<PublicCoverageItem['status'], StatusTone> = {
  not_started: 'neutral',
  partial: 'pending',
  covered: 'success',
  skipped: 'warning',
};

const COVERAGE_WORD: Record<PublicCoverageItem['status'], string> = {
  not_started: 'Not started',
  partial: 'Partial',
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
 * shortcut wrong-firing a commit at it.
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

  // Navigate to review once the session completes.
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
  // Global keyboard shortcuts while a session is active and no field is focused.
  useEffect(() => {
    if (!snapshot) {
      return undefined;
    }
    const handler = (event: KeyboardEvent): void => {
      if (
        event.repeat ||
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
      <>
        <PageHeader
          title="Operator console"
          actions={
            <Button variant="ghost" onClick={() => nav.go({ name: 'home' })}>
              Exit
            </Button>
          }
        />
        <div className={route.page}>
          <p className={route.empty}>Waiting for the session to report in…</p>
        </div>
      </>
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
  const announcement = useMemo(() => {
    const parts = [descriptor.label];
    if (snapshot.endpointPending) {
      parts.push('detecting end of answer');
    }
    if (snapshot.recoverableWarning) {
      parts.push(snapshot.recoverableWarning);
    }
    return parts.join('. ');
  }, [descriptor.label, snapshot.endpointPending, snapshot.recoverableWarning]);

  return (
    <>
      <PageHeader
        title={snapshot.projectTitle}
        actions={
          <Button variant="ghost" onClick={onExit}>
            Exit
          </Button>
        }
      />

      <div className={styles.cockpit}>
        {/* ARIA live region announcing state changes to assistive tech. */}
        <div className={styles.visuallyHidden} role="status" aria-live="assertive">
          {announcement}
        </div>

        {snapshot.recoverableWarning && (
          <div className={route.notice} role="alert">
            <StatusIcon tone="warning" label="Warning" />
            <span>{snapshot.recoverableWarning}</span>
          </div>
        )}
        {commandError !== null && (
          <p className={route.error} role="alert">
            {commandError}
          </p>
        )}

        <div className={styles.grid}>
          <div className={styles.mainColumn}>
            <Panel title="Current question" flush flushBody bodyClassName={styles.questionBody}>
              <p className={styles.question}>
                {snapshot.currentQuestion ?? <span className={styles.muted}>No question yet.</span>}
              </p>
            </Panel>

            <Panel
              title="Live transcript"
              flush
              flushBody
              bodyClassName={styles.transcriptBody}
              actions={
                snapshot.endpointPending ? (
                  <span className={styles.endpointPending}>
                    <StatusIcon tone="pending" label="Detecting end of answer" /> Detecting end
                  </span>
                ) : undefined
              }
            >
              <p className={styles.transcript}>
                <span>{snapshot.finalTranscriptSoFar}</span>
                {snapshot.partialTranscript && (
                  <span className={styles.partial}> {snapshot.partialTranscript}</span>
                )}
                {!snapshot.finalTranscriptSoFar && !snapshot.partialTranscript && (
                  <span className={styles.muted}>Waiting for the answer…</span>
                )}
              </p>
            </Panel>
          </div>

          <aside className={styles.sideColumn}>
            <Panel title="Microphone" flush flushBody bodyClassName={styles.sideBody}>
              <MicStatus mic={snapshot.mic} />
            </Panel>
            <Panel title="Coverage" flush flushBody bodyClassName={styles.sideBody}>
              <CoverageList items={snapshot.coverage} />
            </Panel>
            <Panel title="Providers" flush flushBody bodyClassName={styles.sideBody}>
              <ProviderStatusList status={snapshot.providerStatus} />
            </Panel>
          </aside>
        </div>

        <div className={styles.transport}>
          <div className={styles.transportReadout}>
            <span className={styles.stateBadge}>
              <StatusIcon tone={descriptor.tone} label={`State: ${descriptor.label}`} />
              {descriptor.label}
            </span>
            <span className={styles.timer} aria-label="Elapsed time">
              {formatElapsed(snapshot.elapsedMs)}
            </span>
            <span className={styles.ordinal}>Question {snapshot.questionOrdinal}</span>
          </div>

          <div className={styles.transportControls}>
            {controls.canResume ? (
              <Button onClick={() => onCommand({ type: 'RESUME_SESSION' })}>
                <Icon name="play" size={14} /> Resume (P)
              </Button>
            ) : (
              <Button onClick={() => onCommand({ type: 'PAUSE_SESSION' })} disabled={!controls.canPause}>
                <Icon name="pause" size={14} /> Pause (P)
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => onCommand({ type: 'COMMIT_USER_TURN', reason: 'manual' })}
              disabled={!controls.canCommit}
            >
              <Icon name="check" size={14} /> Commit (Space)
            </Button>
            <Button onClick={() => onCommand({ type: 'REPEAT_QUESTION' })} disabled={!controls.canRepeat}>
              <Icon name="repeat" size={14} /> Repeat (R)
            </Button>
            <Button onClick={() => onCommand({ type: 'SKIP_QUESTION' })} disabled={!controls.canSkip}>
              <Icon name="skip" size={14} /> Skip (S)
            </Button>
            <Button
              variant="danger"
              onClick={() => onCommand({ type: 'END_AFTER_TURN' })}
              disabled={!controls.canEnd}
            >
              <Icon name="stop" size={14} /> End after turn
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function MicStatus({ mic }: { mic: OperatorSessionSnapshot['mic'] }): JSX.Element {
  const gateTone: StatusTone = mic.gate === 'active' ? 'active' : mic.gate === 'armed' ? 'pending' : 'neutral';
  const gateWord = mic.gate === 'active' ? 'Active' : mic.gate === 'armed' ? 'Armed' : 'Closed';
  const percent = Math.round(Math.min(1, Math.max(0, mic.level)) * 100);
  return (
    <div className={styles.micStatus}>
      <span className={styles.micGate}>
        <StatusIcon tone={gateTone} label={`Microphone ${gateWord}`} />
        {gateWord}
        {mic.deviceLabel && <span className={styles.micDevice}> · {mic.deviceLabel}</span>}
      </span>
      <div
        className={styles.micTrack}
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={`${styles.micFill} ${mic.clipping ? styles.micClip : ''}`} style={{ width: `${percent}%` }} />
      </div>
      {mic.clipping && <span className={styles.micClipNote}>Clipping</span>}
    </div>
  );
}

function CoverageList({ items }: { items: PublicCoverageItem[] }): JSX.Element {
  if (items.length === 0) {
    return <p className={styles.muted}>No coverage items.</p>;
  }
  return (
    <ul className={styles.coverageList}>
      {items.map((item) => (
        <li key={item.id} className={styles.coverageItem}>
          <StatusIcon tone={COVERAGE_TONE[item.status]} label={`${item.label}: ${COVERAGE_WORD[item.status]}`} />
          <div className={styles.coverageBody}>
            <span className={styles.coverageLabel}>{item.label}</span>
            <span className={styles.coverageMeta}>
              {item.priority} · {COVERAGE_WORD[item.status]}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ProviderStatusList({ status }: { status: PublicProviderStatus }): JSX.Element {
  const rows: Array<{ label: string; value: 'ok' | 'degraded' | 'down' }> = [
    { label: 'OpenAI', value: status.openai },
    { label: 'Inworld STT', value: status.inworldStt },
    { label: 'Inworld TTS', value: status.inworldTts },
  ];
  return (
    <ul className={styles.providerList}>
      {rows.map((row) => (
        <li key={row.label} className={styles.providerItem}>
          <StatusIcon tone={PROVIDER_TONE[row.value]} label={`${row.label}: ${row.value}`} />
          <span className={styles.providerLabel}>{row.label}</span>
          <span className={styles.providerValue}>{row.value}</span>
        </li>
      ))}
      {status.lastQuestionLatencyMs !== null && (
        <li className={styles.providerLatency}>Last question: {status.lastQuestionLatencyMs} ms</li>
      )}
    </ul>
  );
}
