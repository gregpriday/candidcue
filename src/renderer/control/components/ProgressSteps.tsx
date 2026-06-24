import { Icon } from './Icon';
import styles from './ProgressSteps.module.css';

export interface ProgressStep<K extends string> {
  key: K;
  label: string;
}

interface ProgressStepsProps<K extends string> {
  steps: ReadonlyArray<ProgressStep<K>>;
  current: K;
  /** Whether a step is complete (shows a check instead of its number). */
  isComplete?: (key: K) => boolean;
  /** Allow jumping to a step. */
  onSelect?: (key: K) => void;
}

/** The preparation workflow as a sequence of numbered steps. */
export function ProgressSteps<K extends string>({
  steps,
  current,
  isComplete,
  onSelect,
}: ProgressStepsProps<K>): JSX.Element {
  const currentIndex = steps.findIndex((step) => step.key === current);
  return (
    <ol className={styles.steps}>
      {steps.map((step, index) => {
        const active = step.key === current;
        const complete = isComplete ? isComplete(step.key) : index < currentIndex;
        const state = active ? 'active' : complete ? 'complete' : 'todo';
        return (
          <li key={step.key} className={styles.step} data-state={state}>
            <button
              type="button"
              className={styles.button}
              onClick={onSelect ? () => onSelect(step.key) : undefined}
              disabled={onSelect === undefined}
              aria-current={active ? 'step' : undefined}
            >
              <span className={styles.marker} aria-hidden>
                {complete && !active ? <Icon name="check" size={14} /> : index + 1}
              </span>
              <span className={styles.label}>{step.label}</span>
            </button>
            {index < steps.length - 1 && <span className={styles.connector} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
