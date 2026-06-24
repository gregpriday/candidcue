import type { ReactNode } from 'react';
import styles from './StagePreview.module.css';

interface StagePreviewProps {
  posterUrl: string | null;
  captionsEnabled: boolean;
  caption?: string;
  mirror?: boolean;
  zoom?: number;
  verticalOffsetPercent?: number;
  status?: ReactNode;
}

/** A faithful dark-studio preview of the stage display — the same framing,
 *  vignette, and caption treatment the interviewee will see. */
export function StagePreview({
  posterUrl,
  captionsEnabled,
  caption,
  mirror = false,
  zoom = 1,
  verticalOffsetPercent = 0,
  status,
}: StagePreviewProps): JSX.Element {
  const transform = `translateY(${verticalOffsetPercent}%) scale(${mirror ? -zoom : zoom}, ${zoom})`;
  return (
    <div className={styles.preview} data-theme="studio">
      <div className={styles.stage}>
        {posterUrl !== null && (
          <img className={styles.poster} src={posterUrl} alt="" aria-hidden style={{ transform }} />
        )}
        {captionsEnabled && caption !== undefined && caption !== '' && (
          <div className={styles.caption}>{caption}</div>
        )}
        {status != null && <div className={styles.status}>{status}</div>}
      </div>
    </div>
  );
}
