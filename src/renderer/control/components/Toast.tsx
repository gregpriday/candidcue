import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import styles from './Toast.module.css';

export type ToastTone = 'success' | 'info' | 'danger';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

/** Transient save / export confirmations, anchored bottom-center. */
export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}): JSX.Element | null {
  if (toasts.length === 0) {
    return null;
  }
  return createPortal(
    <div className={styles.region} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={[styles.toast, styles[toast.tone]].filter(Boolean).join(' ')}>
          <span className={styles.dot} aria-hidden />
          <span className={styles.message}>{toast.message}</span>
          <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

let nextToastId = 0;

/** Lightweight toast queue with auto-dismiss. */
export function useToasts(autoDismissMs = 3200): {
  toasts: ToastItem[];
  push: (tone: ToastTone, message: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextToastId++;
      setToasts((prev) => [...prev, { id, tone, message }]);
      const timer = setTimeout(() => dismiss(id), autoDismissMs);
      timers.current.set(id, timer);
    },
    [autoDismissMs, dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}
