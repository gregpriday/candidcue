import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Sheet.module.css';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer actions (buttons). The caller owns confirm/cancel wiring. */
  actions: ReactNode;
  tone?: 'default' | 'danger';
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A focused confirmation sheet for discard / remove / end-session decisions.
 * Centered modal with a dimmed backdrop; Escape and backdrop-click close it,
 * focus is moved in on open and restored on close, and Tab is trapped inside.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  tone = 'default',
}: SheetProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descId = useId();

  // Escape on the bubble phase (no stopPropagation) so a nested control that
  // handles Escape itself — e.g. an open <select> — gets first refusal.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Move focus into the sheet on open; restore it to the prior element on close.
  useEffect(() => {
    if (!open) {
      return;
    }
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      restoreRef.current?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || panelRef.current === null) {
      return;
    }
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const sheetClass = [styles.sheet, tone === 'danger' ? styles.danger : null].filter(Boolean).join(' ');

  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={sheetClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description != null ? descId : undefined}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {description != null && (
            <p id={descId} className={styles.description}>
              {description}
            </p>
          )}
        </div>
        {children != null && <div className={styles.body}>{children}</div>}
        <div className={styles.actions}>{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
