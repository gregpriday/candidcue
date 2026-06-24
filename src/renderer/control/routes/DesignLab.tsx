import { useState } from 'react';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Section } from '../components/Section';
import { StatusPill, type StatusTone } from '../components/StatusPill';
import { SegmentedControl } from '../components/SegmentedControl';
import { RadioCard } from '../components/RadioCard';
import { Sheet } from '../components/Sheet';
import { ToastRegion, useToasts } from '../components/Toast';
import { ListRow } from '../components/ListRow';
import { ProgressSteps } from '../components/ProgressSteps';
import { Disclosure } from '../components/Disclosure';
import { OverflowMenu } from '../components/OverflowMenu';
import { PageHeader } from '../components/PageHeader';
import route from './route.module.css';
import styles from './DesignLab.module.css';

const PILL_TONES: StatusTone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'live'];

type LengthMode = 'questions' | 'duration';
type Pacing = 'manual' | 'natural' | 'patient';

/**
 * Dev-only gallery of the design system. Every primitive in every state, so the
 * look can be tuned without walking a real session. Reachable in dev only.
 */
export function DesignLab({ nav }: { nav: Navigator }): JSX.Element {
  const [lengthMode, setLengthMode] = useState<LengthMode>('questions');
  const [pacing, setPacing] = useState<Pacing>('natural');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dangerSheetOpen, setDangerSheetOpen] = useState(false);
  const { toasts, push, dismiss } = useToasts();

  return (
    <>
      <PageHeader
        title="Design Lab"
        meta="Workspace + studio primitives"
        onBack={() => nav.go({ name: 'home' })}
        backLabel="Interviews"
      />
      <div className={route.page}>
        <Section title="Buttons" description="Primary is the one obvious action; everything else recedes.">
          <div className={styles.row}>
            <Button variant="primary">Prepare interview</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">
              <Icon name="arrowLeft" size={16} /> Ghost
            </Button>
            <Button variant="danger">
              <Icon name="trash" size={16} /> Remove
            </Button>
            <Button variant="primary" disabled>
              Disabled
            </Button>
          </div>
        </Section>

        <Section title="Status pills" description="Compact readiness state.">
          <div className={styles.row}>
            {PILL_TONES.map((tone) => (
              <StatusPill key={tone} tone={tone}>
                {tone}
              </StatusPill>
            ))}
            <StatusPill tone="neutral" dot={false}>
              No dot
            </StatusPill>
          </div>
        </Section>

        <Section title="Fields" description="Clean, explicit inputs — not machined recesses.">
          <div className={styles.fieldGrid}>
            <label className={route.field}>
              <span className={route.label}>Interview title</span>
              <input className={route.input} placeholder="The founding story of Acme Robotics" />
            </label>
            <label className={route.field}>
              <span className={route.label}>Move on after</span>
              <select className={route.select} defaultValue="natural">
                <option value="manual">I&rsquo;ll finish each answer myself</option>
                <option value="natural">A natural pause</option>
                <option value="patient">A longer pause</option>
              </select>
            </label>
          </div>
          <label className={route.field}>
            <span className={route.label}>Style and boundaries</span>
            <textarea
              className={route.textarea}
              placeholder="Keep the tone warm but probing. Avoid leading questions about funding."
            />
          </label>
        </Section>

        <Section title="Segmented control">
          <SegmentedControl<LengthMode>
            ariaLabel="Interview length mode"
            value={lengthMode}
            onChange={setLengthMode}
            segments={[
              { value: 'questions', label: 'Questions' },
              { value: 'duration', label: 'Duration' },
            ]}
          />
        </Section>

        <Section title="Radio cards" description="Descriptive mode choices — when to move on.">
          <div className={styles.radioStack}>
            <RadioCard<Pacing>
              name="lab-pacing"
              value="manual"
              checked={pacing === 'manual'}
              onChange={setPacing}
              title="I&rsquo;ll finish each answer myself"
              description="You decide when each answer is complete."
            />
            <RadioCard<Pacing>
              name="lab-pacing"
              value="natural"
              checked={pacing === 'natural'}
              onChange={setPacing}
              title="Move on after a natural pause"
              description="Mira continues once you pause naturally."
            />
            <RadioCard<Pacing>
              name="lab-pacing"
              value="patient"
              checked={pacing === 'patient'}
              onChange={setPacing}
              title="Wait for a longer pause"
              description="Mira waits a little longer before moving on."
            />
          </div>
        </Section>

        <Section title="Sheets &amp; toasts" description="Confirmation sheets and transient confirmations.">
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => setSheetOpen(true)}>
              Open sheet
            </Button>
            <Button variant="danger" onClick={() => setDangerSheetOpen(true)}>
              Destructive sheet
            </Button>
            <Button variant="secondary" onClick={() => push('success', 'Your answer has been saved.')}>
              Success toast
            </Button>
            <Button variant="secondary" onClick={() => push('info', 'Interview needs an update.')}>
              Info toast
            </Button>
            <Button variant="secondary" onClick={() => push('danger', 'Connection lost. Reconnecting…')}>
              Danger toast
            </Button>
          </div>
        </Section>

        <Section title="Lists, steps &amp; menus">
          <ProgressSteps
            steps={[
              { key: 'brief', label: 'Brief' },
              { key: 'reference', label: 'Reference material' },
              { key: 'style', label: 'Interview style' },
              { key: 'ready', label: 'Ready' },
            ]}
            current="reference"
          />
          <ListRow
            title="Acme founding story"
            meta="Updated 2h ago · 3 sessions"
            status={<StatusPill tone="success">Ready</StatusPill>}
            action={<Button variant="secondary">Start</Button>}
            onOpen={() => undefined}
          />
          <div className={styles.row}>
            <Disclosure summary="Advanced settings">
              <p>Tucked-away technical options live here.</p>
            </Disclosure>
            <OverflowMenu
              items={[
                { label: 'Show original transcript', onSelect: () => undefined },
                { label: 'Export as Markdown', onSelect: () => undefined, icon: 'download' },
              ]}
            />
          </div>
        </Section>

        <Section
          title="Studio theme"
          description="The same primitives in the dark studio used during a live session."
        >
          <div className={styles.studioIsland} data-theme="studio">
            <div className={styles.row}>
              <Button variant="primary">Finish answer</Button>
              <Button variant="secondary">Pause</Button>
              <StatusPill tone="live">Live</StatusPill>
              <StatusPill tone="success">Mic ready</StatusPill>
            </div>
            <p className={styles.studioQuestion}>What changed your mind about the original business model?</p>
          </div>
        </Section>
      </div>

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Leave without saving?"
        description="You have unsaved changes to this interview."
        actions={
          <>
            <Button variant="ghost" onClick={() => setSheetOpen(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={() => setSheetOpen(false)}>
              Discard changes
            </Button>
          </>
        }
      />
      <Sheet
        open={dangerSheetOpen}
        onClose={() => setDangerSheetOpen(false)}
        tone="danger"
        title="End the interview after this answer?"
        description="Mira will wrap up once the current answer is saved."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDangerSheetOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setDangerSheetOpen(false)}>
              End after turn
            </Button>
          </>
        }
      />
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
