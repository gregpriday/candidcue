import type { ReactNode } from 'react';
import styles from './RadioCard.module.css';

interface RadioCardProps<T extends string> {
  name: string;
  value: T;
  checked: boolean;
  onChange: (value: T) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** A descriptive mode choice — a selectable card with a real radio input. */
export function RadioCard<T extends string>({
  name,
  value,
  checked,
  onChange,
  title,
  description,
  icon,
  disabled = false,
}: RadioCardProps<T>): JSX.Element {
  const classes = [styles.card, checked ? styles.checked : null, disabled ? styles.disabled : null]
    .filter(Boolean)
    .join(' ');
  return (
    <label className={classes}>
      <input
        type="radio"
        className={styles.input}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span className={styles.indicator} aria-hidden />
      <span className={styles.content}>
        <span className={styles.title}>
          {icon != null && <span className={styles.icon}>{icon}</span>}
          {title}
        </span>
        {description != null && <span className={styles.description}>{description}</span>}
      </span>
    </label>
  );
}
