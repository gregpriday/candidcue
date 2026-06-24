import type { SVGProps } from 'react';

/**
 * The application icon set. A small, cohesive collection of stroke-based glyphs
 * (24px viewBox, 1.75 stroke, currentColor) so the operator console reads like a
 * desktop application — the activity rail, transport controls, status rows, and
 * buttons all draw from the same line-art language instead of emoji/text glyphs.
 *
 * Transport glyphs (play/pause/stop) are filled, which reads clearer at small
 * sizes and matches how every media application draws its transport.
 */
export type IconName =
  | 'library'
  | 'settings'
  | 'mic'
  | 'micOff'
  | 'play'
  | 'pause'
  | 'stop'
  | 'skip'
  | 'repeat'
  | 'check'
  | 'alert'
  | 'close'
  | 'plus'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'arrowLeft'
  | 'upload'
  | 'download'
  | 'eye'
  | 'eyeOff'
  | 'monitor'
  | 'sparkles'
  | 'clock'
  | 'waveform'
  | 'speaker'
  | 'info'
  | 'pencil'
  | 'star'
  | 'starFilled'
  | 'grip'
  | 'search'
  | 'trash'
  | 'copy'
  | 'inbox'
  | 'folder'
  | 'externalLink'
  | 'more';

/** Icons whose shapes are filled rather than stroked. */
const FILLED = new Set<IconName>(['play', 'pause', 'stop', 'starFilled', 'grip', 'more']);

const PATHS: Record<IconName, JSX.Element> = {
  more: (
    <>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </>
  ),
  library: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="14" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
    </>
  ),
  settings: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1.5" y1="14" x2="6.5" y2="14" />
      <line x1="9.5" y1="8" x2="14.5" y2="8" />
      <line x1="17.5" y1="16" x2="22.5" y2="16" />
    </>
  ),
  mic: (
    <>
      <path d="M12 1.75a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0v-7a3 3 0 0 0-3-3z" />
      <path d="M18.5 10.5v1a6.5 6.5 0 0 1-13 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </>
  ),
  micOff: (
    <>
      <line x1="3" y1="3" x2="21" y2="21" />
      <path d="M9 9.3v2.45a3 3 0 0 0 4.9 2.32" />
      <path d="M15 10.8V4.75a3 3 0 0 0-5.86-.9" />
      <path d="M18.5 10.5v1a6.5 6.5 0 0 1-10.2 5.32M5.5 11.5v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </>
  ),
  play: <path d="M7 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" />
    </>
  ),
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />,
  skip: (
    <>
      <path d="M5 4.5v15a1 1 0 0 0 1.55.83L17 13.1V19a1 1 0 0 0 2 0V5a1 1 0 0 0-2 0v5.9L6.55 3.67A1 1 0 0 0 5 4.5z" stroke="none" fill="currentColor" />
    </>
  ),
  repeat: (
    <>
      <polyline points="2.5 4 2.5 10 8.5 10" />
      <path d="M4.5 15a8 8 0 1 0 1.9-8.3L2.5 10" />
    </>
  ),
  check: <polyline points="20 6.5 9.5 17.5 4 12" />,
  alert: (
    <>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.7 3h16.96a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <line x1="12" y1="17.5" x2="12.01" y2="17.5" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  chevronLeft: <polyline points="15 6 9 12 15 18" />,
  chevronRight: <polyline points="9 6 15 12 9 18" />,
  chevronDown: <polyline points="6 9.5 12 15.5 18 9.5" />,
  arrowLeft: (
    <>
      <line x1="20" y1="12" x2="5" y2="12" />
      <polyline points="11 5 4.5 12 11 19" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5" />
      <polyline points="7.5 8 12 3.5 16.5 8" />
      <line x1="12" y1="3.5" x2="12" y2="15" />
    </>
  ),
  download: (
    <>
      <path d="M21 15.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5" />
      <polyline points="7.5 11 12 15.5 16.5 11" />
      <line x1="12" y1="15.5" x2="12" y2="3.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 12s3.8-7 10.5-7 10.5 7 10.5 7-3.8 7-10.5 7S1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M9.9 5.2A10.6 10.6 0 0 1 12 5c6.7 0 10.5 7 10.5 7a18.4 18.4 0 0 1-2.5 3.4M6.1 6.6A18.5 18.5 0 0 0 1.5 12s3.8 7 10.5 7a10.4 10.4 0 0 0 4.3-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="3.5" width="20" height="13.5" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.7 4.6L18 9.2l-4.3 1.6L12 15.4l-1.7-4.6L6 9.2l4.3-1.6L12 3z" />
      <path d="M19 14l.85 2.3L22 17.1l-2.15.8L19 20.2l-.85-2.3L16 17.1l2.15-.8L19 14z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </>
  ),
  waveform: <polyline points="2.5 12 6 12 8.5 5.5 12 18.5 15 9.5 17 12 21.5 12" />,
  speaker: (
    <>
      <path d="M4 9v6h3.5L13 20V4L7.5 9H4z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <line x1="12" y1="7.5" x2="12.01" y2="7.5" />
    </>
  ),
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </>
  ),
  star: (
    <path d="M12 2.6l2.82 5.72 6.31.92-4.57 4.45 1.08 6.29L12 17.5l-5.64 2.97 1.08-6.29-4.57-4.45 6.31-.92L12 2.6z" />
  ),
  starFilled: (
    <path d="M12 2.6l2.82 5.72 6.31.92-4.57 4.45 1.08 6.29L12 17.5l-5.64 2.97 1.08-6.29-4.57-4.45 6.31-.92L12 2.6z" />
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.5" y1="15.5" x2="21" y2="21" />
    </>
  ),
  trash: (
    <>
      <polyline points="3.5 6 5 6 20.5 6" />
      <path d="M8 6V4.5a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 4.5V6m2.5 0v14a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5V6" />
      <line x1="10" y1="10.5" x2="10" y2="17" />
      <line x1="14" y1="10.5" x2="14" y2="17" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="1.6" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V4.5A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </>
  ),
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.6 5.4 2.2 12v6a2 2 0 0 0 2 2h15.6a2 2 0 0 0 2-2v-6L18.4 5.4A2 2 0 0 0 16.6 4.3H7.4a2 2 0 0 0-1.8 1.1z" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h3.8l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  externalLink: (
    <>
      <path d="M14 4h6v6" />
      <line x1="20" y1="4" x2="11" y2="13" />
      <path d="M19 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Pixel size of the square icon. Defaults to 16 (compact, app-dense). */
  size?: number;
}

/**
 * Render a single icon. Decorative by default (aria-hidden); pass an
 * `aria-label` (and the caller sets role) when the icon is the only label.
 */
export function Icon({ name, size = 16, ...rest }: IconProps): JSX.Element {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest['aria-label'] ? undefined : true}
      focusable={false}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
