import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [styles.button, styles[variant], className].filter(Boolean).join(' ');
  // eslint-disable-next-line react/button-has-type
  return <button type={type} className={classes} {...rest} />;
}
