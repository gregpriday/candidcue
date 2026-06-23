import { useEffect, useRef, useState } from 'react';
import styles from './MicMeter.module.css';

interface MicMeterProps {
  /** The selected microphone device id, or null to disable the meter. */
  deviceId: string | null;
}

/**
 * A live microphone level meter. Opens a getUserMedia stream on the selected
 * device, feeds it through an AnalyserNode, and renders the RMS level. Cleans
 * up the stream and audio graph on unmount or when the device changes.
 */
export function MicMeter({ deviceId }: MicMeterProps): JSX.Element {
  const [level, setLevel] = useState(0);
  const [meterError, setMeterError] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (deviceId === null) {
      setLevel(0);
      return;
    }

    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let cancelled = false;
    setMeterError(null);

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = (): void => {
          analyser.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i += 1) {
            const sample = (data[i] ?? 128) - 128;
            sumSquares += sample * sample;
          }
          const rms = Math.sqrt(sumSquares / data.length) / 128;
          setLevel(Math.min(1, rms * 1.8));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (err: unknown) {
        if (!cancelled) {
          setMeterError(err instanceof Error ? err.message : 'Could not open the microphone.');
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (audioContext) {
        void audioContext.close();
      }
      setLevel(0);
    };
  }, [deviceId]);

  const percent = Math.round(level * 100);
  const clipping = level > 0.92;

  return (
    <div className={styles.meter}>
      <div className={styles.labelRow}>
        <span className={styles.label}>Microphone level</span>
        <span className={styles.value} aria-hidden="true">
          {percent}%
        </span>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`${styles.fill} ${clipping ? styles.clip : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {clipping && <span className={styles.clipNote}>Input is clipping — move back or lower the gain.</span>}
      {meterError !== null && <span className={styles.error}>{meterError}</span>}
    </div>
  );
}
