import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './WorkspaceToolbar.module.css';

interface WorkspaceToolbarProps {
  /** Screen title — a compact control-strip heading, not a hero header. */
  title: ReactNode;
  /** Optional back affordance (renders a chevron button on the left). */
  onBack?: () => void;
  backLabel?: string;
  /** Small muted breadcrumb/meta shown after the title. */
  meta?: ReactNode;
  /** Right-aligned primary/secondary actions. */
  actions?: ReactNode;
}

/**
 * The slim, sticky per-screen header strip. A screen reads as a control strip
 * (title + actions) with guidance demoted to inline hints, the way a desktop
 * application's toolbars do — not a tall marketing-style page header.
 */
export function WorkspaceToolbar({
  title,
  onBack,
  backLabel = 'Back',
  meta,
  actions,
}: WorkspaceToolbarProps): JSX.Element {
  return (
    <div className={styles.toolbar}>
      <div className={styles.left}>
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack} aria-label={backLabel} title={backLabel}>
            <Icon name="arrowLeft" size={16} />
          </button>
        )}
        <h1 className={styles.title}>{title}</h1>
        {meta && <span className={styles.meta}>{meta}</span>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
