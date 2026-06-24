import type { ReactNode } from 'react';
import styles from './StatusPill.module.css';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'live';

interface StatusPillProps {
  tone?: StatusTone;
  children: ReactNode;
  /** Show a leading status dot (default true). */
  dot?: boolean;
  className?: string;
}

/** Compact readiness state — a calm chip with an optional status dot. */
export function StatusPill({ tone = 'neutral', children, dot = true, className }: StatusPillProps): JSX.Element {
  const classes = [styles.pill, styles[tone], className].filter(Boolean).join(' ');
  return (
    <span className={classes}>
      {dot && <span className={styles.dot} aria-hidden />}
      <span className={styles.label}>{children}</span>
    </span>
  );
}
