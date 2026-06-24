import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './Disclosure.module.css';

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}

/** Advanced / technical settings tucked behind a native <details> toggle. */
export function Disclosure({ summary, children, defaultOpen = false }: DisclosureProps): JSX.Element {
  return (
    <details className={styles.disclosure} open={defaultOpen}>
      <summary className={styles.summary}>
        <Icon name="chevronRight" size={16} className={styles.chevron} />
        <span>{summary}</span>
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
