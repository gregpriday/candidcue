import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './WorkspaceToolbar.module.css';

interface WorkspaceToolbarProps {
  title: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function WorkspaceToolbar({
  title,
  onBack,
  backLabel = 'Projects',
  meta,
  actions,
}: WorkspaceToolbarProps): JSX.Element {
  return (
    <div className={styles.toolbar}>
      <div className={styles.left}>
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack} aria-label={backLabel} title={backLabel}>
            <Icon name="arrowLeft" size={16} />
            <span>{backLabel}</span>
          </button>
        )}
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
