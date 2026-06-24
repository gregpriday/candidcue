import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './OverflowMenu.module.css';

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  icon?: IconName;
  /** Shows a check — for toggle-style items. */
  active?: boolean;
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
  ariaLabel?: string;
}

/** A quiet "•••" overflow menu for secondary actions. */
export function OverflowMenu({ items, ariaLabel = 'More actions' }: OverflowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.menu} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className={styles.list}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className={styles.itemIcon} aria-hidden>
                {item.active ? <Icon name="check" size={16} /> : item.icon ? <Icon name={item.icon} size={16} /> : null}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
