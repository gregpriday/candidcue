import styles from './StatusIcon.module.css';

export type StatusTone = 'neutral' | 'pending' | 'active' | 'success' | 'warning' | 'danger';

interface StatusIconProps {
  tone: StatusTone;
  /** Accessible label describing the state (required — never colour alone). */
  label: string;
}

/**
 * A small glyph that conveys state with both a shape and a colour, plus an
 * accessible label. Shapes differ per tone so the meaning never depends on
 * colour perception.
 */
const GLYPH: Record<StatusTone, string> = {
  neutral: '•',
  pending: '◷',
  active: '◐',
  success: '✓',
  warning: '!',
  danger: '✕',
};

export function StatusIcon({ tone, label }: StatusIconProps): JSX.Element {
  return (
    <span className={`${styles.icon} ${styles[tone]}`} role="img" aria-label={label}>
      {GLYPH[tone]}
    </span>
  );
}
