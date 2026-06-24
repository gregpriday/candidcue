import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import styles from './SegmentedControl.module.css';

interface Segment<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  segments: ReadonlyArray<Segment<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

/** Small mutually-exclusive choice — a quiet pill track with full radiogroup
 *  keyboard semantics (roving tabindex, Arrow/Home/End). */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>): JSX.Element {
  const classes = [styles.track, className].filter(Boolean).join(' ');

  const handleKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % segments.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + segments.length) % segments.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = segments.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const next = segments[nextIndex];
    if (next === undefined) {
      return;
    }
    onChange(next.value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div className={classes} role="radiogroup" aria-label={ariaLabel}>
      {segments.map((seg, index) => {
        const selected = seg.value === value;
        return (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={[styles.segment, selected ? styles.selected : null].filter(Boolean).join(' ')}
            onClick={() => onChange(seg.value)}
            onKeyDown={(event) => handleKey(event, index)}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
