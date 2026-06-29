import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import styles from './EndConfirmOverlay.module.css';

interface EndConfirmOverlayProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Stage-side confirmation for ending the interview. The Shift+E chord on stage
 * opens this; only the explicit "End interview" press dispatches END_AFTER_TURN,
 * so the destructive action can never fire from a single keypress.
 *
 * Mirrors the control renderer's Sheet pattern (focus-trapping modal: portal to
 * body, role=dialog/aria-modal, focus moved in on open and restored on close,
 * Tab trapped, Escape closes). It is duplicated rather than imported because the
 * stage and control renderers are separate Vite bundles. The cancel button is
 * auto-focused so Enter/Space defaults to keeping the interview running.
 */
export function EndConfirmOverlay({
  open,
  onClose,
  onConfirm,
}: EndConfirmOverlayProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descId = useId();

  // Escape on the bubble phase (no stopPropagation), matching Sheet.
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

  // Move focus to the cancel button on open; restore it to the prior element on
  // close. Focusing cancel (not confirm) keeps the safe action as the default.
  useEffect(() => {
    if (!open) {
      return;
    }
    restoreRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
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

  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className={styles.heading}>
          <h2 id={titleId} className={styles.title}>
            End the interview?
          </h2>
          <p id={descId} className={styles.description}>
            Mira will finish the current turn, then the interview will end and
            recording will stop.
          </p>
        </div>
        <div className={styles.actions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.ghost}
            onClick={onClose}
          >
            Keep going
          </button>
          <button type="button" className={styles.danger} onClick={onConfirm}>
            End interview
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
