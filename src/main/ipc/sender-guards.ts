import type { WebContents } from 'electron';
import { AppError } from '@shared/errors/app-error';

export type WindowRole = 'control' | 'stage';

export interface KnownWindows {
  control: WebContents | null;
  stage: WebContents | null;
}

/**
 * Build a guard that rejects IPC from any sender that is not one of our own
 * known windows in an allowed role (spec §20.7). Defends against a compromised
 * or injected frame invoking privileged channels.
 */
export function makeSenderGuard(known: () => KnownWindows) {
  return function assertSenderIsCandidCueWindow(sender: WebContents, allow: WindowRole[]): void {
    const k = known();
    const ok = allow.some(
      (role) => (role === 'control' && k.control === sender) || (role === 'stage' && k.stage === sender),
    );
    if (!ok) {
      throw new AppError('VALIDATION_FAILED', { publicMessage: 'Unauthorized IPC sender.' });
    }
  };
}
