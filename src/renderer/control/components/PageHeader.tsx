import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './PageHeader.module.css';

interface PageHeaderProps {
  title: ReactNode;
  /** Optional back affordance, shown as a quiet breadcrumb above the title. */
  onBack?: () => void;
  backLabel?: string;
  /** Optional leading visual (e.g. an interviewer avatar) shown left of the title. */
  leading?: ReactNode;
  /** Secondary line under the title (save state, counts, dates). */
  meta?: ReactNode;
  /** A compact readiness indicator placed just left of the actions. */
  status?: ReactNode;
  /** The screen's one primary action (and an optional overflow). */
  actions?: ReactNode;
}

/**
 * Per-screen header: breadcrumb, page title, a small status, and one primary
 * action. Replaces the old framed WorkspaceToolbar. The bar is a window-drag
 * region; interactive controls opt out.
 */
export function PageHeader({ title, onBack, backLabel = 'Back', leading, meta, status, actions }: PageHeaderProps): JSX.Element {
  return (
    <header className={styles.header}>
      {onBack && (
        <button type="button" className={styles.back} onClick={onBack} title={backLabel}>
          <Icon name="chevronLeft" size={16} />
          <span>{backLabel}</span>
        </button>
      )}
      <div className={styles.bar}>
        <div className={styles.lead}>
          {leading != null && <div className={styles.leading}>{leading}</div>}
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{title}</h1>
            {meta != null && <div className={styles.meta}>{meta}</div>}
          </div>
        </div>
        {(status != null || actions != null) && (
          <div className={styles.right}>
            {status != null && <div className={styles.status}>{status}</div>}
            {actions != null && <div className={styles.actions}>{actions}</div>}
          </div>
        )}
      </div>
    </header>
  );
}
