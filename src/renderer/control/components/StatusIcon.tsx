import styles from './StatusIcon.module.css';

export type StatusTone = 'neutral' | 'pending' | 'active' | 'success' | 'warning' | 'danger';

interface StatusIconProps {
  tone: StatusTone;
  /** Accessible label describing the state (required — never colour alone). */
  label: string;
  /** Pixel size of the mark. Defaults to 13 (inline, app-dense). */
  size?: number;
}

/**
 * A small status mark drawn as crisp SVG line-art. The SHAPE differs per tone
 * (dash / ring / filled dot / check / triangle / cross) so meaning never depends
 * on colour perception, and the colour reinforces it. Replaces the earlier text
 * glyphs so status reads like an application indicator, not an emoji.
 */
function Mark({ tone }: { tone: StatusTone }): JSX.Element {
  switch (tone) {
    case 'success':
      return <polyline points="3.5 8.5 6.8 11.8 12.5 4.6" />;
    case 'danger':
      return (
        <>
          <line x1="4.2" y1="4.2" x2="11.8" y2="11.8" />
          <line x1="11.8" y1="4.2" x2="4.2" y2="11.8" />
        </>
      );
    case 'warning':
      return (
        <>
          <path d="M8 2.6 14 13H2L8 2.6z" />
          <line x1="8" y1="6.6" x2="8" y2="9.4" />
          <line x1="8" y1="11.3" x2="8.01" y2="11.3" />
        </>
      );
    case 'active':
      return <circle cx="8" cy="8" r="3.3" fill="currentColor" stroke="none" />;
    case 'pending':
      return <circle cx="8" cy="8" r="3.5" />;
    case 'neutral':
    default:
      return <line x1="4.5" y1="8" x2="11.5" y2="8" />;
  }
}

export function StatusIcon({ tone, label, size = 13 }: StatusIconProps): JSX.Element {
  return (
    <span className={`${styles.icon} ${styles[tone]}`} role="img" aria-label={label}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.85}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable={false}
      >
        <Mark tone={tone} />
      </svg>
    </span>
  );
}
