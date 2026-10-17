/**
 * TakeReadinessSheet.svelte — what its start button says (#283).
 *
 * Present › Review take setup… on a healthy setup opened this sheet with
 * "Everything needed for this take is ready." over a primary button reading
 * "Start anyway". Somebody who just asked for a check was told, by the one
 * word that mattered, that it had failed. The label now turns on the same
 * question the summary line does — is the sheet warning about anything — so
 * the two cannot disagree.
 *
 * The verdicts are built by hand rather than resolved: what is under test is
 * how the sheet words a verdict, and `info` rows are a severity nothing emits
 * yet. Whether a setup PRODUCES each verdict is `take-readiness.test.ts`.
 */
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import TakeReadinessSheet from '../../src/control/components/TakeReadinessSheet.svelte';
import type {
  ReadinessFinding,
  ReadinessVerdict,
} from '../../src/control/lib/take-readiness';

// A row's Settings button opens another window; nothing here clicks one.
vi.mock('../../src/control/lib/open-settings', () => ({
  openSettingsWindow: vi.fn(async () => {}),
}));

const MODEL_MISSING: ReadinessFinding = {
  id: 'model_missing',
  severity: 'warning',
  label: 'Voice following',
  detail: 'No speech model is installed, so this take cannot follow your voice.',
  action: { label: 'Install a language', settingsSection: 'speech' },
};

const SILENT_SCRIPT: ReadinessFinding = {
  id: 'script_silent',
  severity: 'blocking',
  label: 'Script',
  detail: 'There are no spoken words in this script, so there is nothing to follow.',
};

const CONTEXT_ROW: ReadinessFinding = {
  id: 'context',
  severity: 'info',
  label: 'Context',
  detail: 'Something worth knowing.',
};

function verdict(findings: ReadinessFinding[] = []): ReadinessVerdict {
  return { show: true, blocked: findings.some((f) => f.severity === 'blocking'), findings };
}

interface SheetOpts {
  verdict: ReadinessVerdict | null;
  onstart?: () => void;
  onclose?: () => void;
}

function renderSheet(opts: SheetOpts) {
  const props: {
    verdict: ReadinessVerdict | null;
    onstart?: () => void;
    onclose: () => void;
  } = { verdict: opts.verdict, onclose: opts.onclose ?? (() => {}) };
  if (opts.onstart) props.onstart = opts.onstart;
  const result = render(TakeReadinessSheet, { props });
  flushSync();
  return result;
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

/** Footer button labels, in order. */
function footerLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.footer button')].map((b) =>
    (b.textContent ?? '').trim(),
  );
}

function footerButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.footer button')].find(
    (b) => (b.textContent ?? '').trim() === name,
  );
  if (!button) throw new Error(`no footer button "${name}" in [${footerLabels().join(', ')}]`);
  return button;
}

describe('TakeReadinessSheet start button', () => {
  it('reads as an ordinary start when a reviewed setup is healthy', () => {
    const onstart = vi.fn();
    renderSheet({ verdict: verdict(), onstart });

    expect(dialog()?.textContent).toContain('Everything needed for this take is ready.');
    expect(document.querySelectorAll('.finding')).toHaveLength(0);
    expect(footerLabels()).toEqual(['Back to the script', 'Present']);

    footerButton('Present').click();
    expect(onstart).toHaveBeenCalledTimes(1);
  });

  it('says "Start anyway" only when the sheet is warning about something', () => {
    const onstart = vi.fn();
    renderSheet({ verdict: verdict([MODEL_MISSING]), onstart });

    expect(dialog()?.textContent).toContain('This take can start, but not everything is set up.');
    expect(document.querySelectorAll('.finding.warning')).toHaveLength(1);
    expect(footerLabels()).toEqual(['Back to the script', 'Start anyway']);

    footerButton('Start anyway').click();
    expect(onstart).toHaveBeenCalledTimes(1);
  });

  it('does not let a context row turn the start into "Start anyway"', () => {
    renderSheet({ verdict: verdict([CONTEXT_ROW]), onstart: () => {} });

    expect(document.querySelectorAll('.finding.info')).toHaveLength(1);
    expect(footerLabels()).toEqual(['Back to the script', 'Present']);
  });

  it('offers no start at all for a blocked take, warnings or not', () => {
    for (const findings of [[SILENT_SCRIPT], [SILENT_SCRIPT, MODEL_MISSING]]) {
      const { unmount } = renderSheet({ verdict: verdict(findings), onstart: () => {} });

      expect(dialog()?.textContent).toContain('This take cannot start as it is.');
      expect(footerLabels()).toEqual(['Back to the script']);
      unmount();
    }
  });

  it('offers no start when there is nothing to start with', () => {
    renderSheet({ verdict: verdict() });
    expect(footerLabels()).toEqual(['Back to the script']);
  });

  it('goes back to the script without starting', () => {
    const onstart = vi.fn();
    const onclose = vi.fn();
    renderSheet({ verdict: verdict(), onstart, onclose });

    footerButton('Back to the script').click();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onstart).not.toHaveBeenCalled();
  });

  it('is not open without a verdict to show', () => {
    renderSheet({ verdict: null, onstart: () => {} });
    expect(dialog()).toBeNull();

    renderSheet({ verdict: { ...verdict(), show: false }, onstart: () => {} });
    expect(dialog()).toBeNull();
  });
});
