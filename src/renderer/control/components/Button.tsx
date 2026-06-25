import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'small';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'default',
  className,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    styles.button,
    styles[variant],
    size === 'small' ? styles.small : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}
