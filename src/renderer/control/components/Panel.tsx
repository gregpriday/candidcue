import type { ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  /** Uppercase label shown in the header strip. Omit for a header-less pane. */
  title?: ReactNode;
  /** Right-aligned controls in the header strip. */
  actions?: ReactNode;
  /** Square corners for tiled/docked cockpit regions (no floating-card radius). */
  flush?: boolean;
  /** Drop the default body padding (for inset wells / lists that pad themselves). */
  flushBody?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * A flat framed pane — the application's basic content container. A 30px header
 * strip carries an uppercase label (and optional controls); the body holds the
 * content. Depth reads from the gray stack and 1px borders, never shadows, so
 * panels look docked into the workspace rather than floating like web cards.
 */
export function Panel({
  title,
  actions,
  flush,
  flushBody,
  className,
  bodyClassName,
  children,
}: PanelProps): JSX.Element {
  const classes = [styles.panel, flush ? styles.flush : '', className].filter(Boolean).join(' ');
  const bodyClasses = [styles.body, flushBody ? styles.bodyFlush : '', bodyClassName].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      {(title || actions) && (
        <header className={styles.header}>
          {title ? <h2 className={styles.title}>{title}</h2> : <span />}
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={bodyClasses}>{children}</div>
    </section>
  );
}
