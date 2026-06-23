import { useEffect, useRef, useState } from 'react';
import type { OperatorSessionSnapshot } from '@shared/contracts';

/**
 * Subscribe to operator session snapshots and return the latest one. Snapshots
 * are versioned monotonically; out-of-order deliveries (lower or equal version)
 * are ignored so the UI never flickers backwards.
 */
export function useSnapshot(): OperatorSessionSnapshot | null {
  const [snapshot, setSnapshot] = useState<OperatorSessionSnapshot | null>(null);
  const versionRef = useRef<number>(-1);

  useEffect(() => {
    // Pull any snapshot that already exists (e.g. resuming into an active run).
    let cancelled = false;
    void window.candidcue.sessions.getSnapshot().then((initial) => {
      if (cancelled || initial === null) {
        return;
      }
      if (initial.version > versionRef.current) {
        versionRef.current = initial.version;
        setSnapshot(initial);
      }
    });

    const unsubscribe = window.candidcue.events.onSessionSnapshot((next) => {
      if (next.version <= versionRef.current) {
        return;
      }
      versionRef.current = next.version;
      setSnapshot(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return snapshot;
}
