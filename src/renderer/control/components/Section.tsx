import type { ReactNode } from 'react';
import styles from './Section.module.css';

interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Borderless content grouping — the default way to structure a workspace
 * screen. A quiet sentence-case heading and generous spacing instead of a
 * framed, boxed Panel. Reserve Panel for genuinely technical/diagnostic
 * material; everything editorial uses Section.
 */
export function Section({ title, description, actions, children, className }: SectionProps): JSX.Element {
  const classes = [styles.section, className].filter(Boolean).join(' ');
  const hasHeader = title != null || description != null || actions != null;
  return (
    <section className={classes}>
      {hasHeader && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title != null && <h2 className={styles.title}>{title}</h2>}
            {description != null && <p className={styles.description}>{description}</p>}
          </div>
          {actions != null && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </section>
  );
}
