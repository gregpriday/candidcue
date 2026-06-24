import type { ReactNode } from 'react';
import styles from './ListRow.module.css';

interface ListRowProps {
  title: ReactNode;
  meta?: ReactNode;
  /** Leading visual (portrait, icon, mark). */
  leading?: ReactNode;
  /** A compact status indicator shown before the action. */
  status?: ReactNode;
  /** A trailing control (already a Button). Kept a separate target from the row. */
  action?: ReactNode;
  /** Makes the row body itself clickable (e.g. open the interview). */
  onOpen?: () => void;
  ariaLabel?: string;
  className?: string;
}

/** A single row in a list of interviews, sessions, or settings. The body and
 *  the trailing action are independent targets — never nested buttons. */
export function ListRow({
  title,
  meta,
  leading,
  status,
  action,
  onOpen,
  ariaLabel,
  className,
}: ListRowProps): JSX.Element {
  const classes = [styles.row, onOpen ? styles.interactive : null, className].filter(Boolean).join(' ');
  const body = (
    <>
      {leading != null && <span className={styles.leading}>{leading}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {meta != null && <span className={styles.meta}>{meta}</span>}
      </span>
    </>
  );
  return (
    <div className={classes}>
      {onOpen ? (
        <button type="button" className={styles.main} onClick={onOpen} aria-label={ariaLabel}>
          {body}
        </button>
      ) : (
        <div className={styles.main}>{body}</div>
      )}
      {(status != null || action != null) && (
        <div className={styles.trailing}>
          {status}
          {action}
        </div>
      )}
    </div>
  );
}
