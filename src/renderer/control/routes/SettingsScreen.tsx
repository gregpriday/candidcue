import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderTestResult, PublicSettings } from '@shared/contracts';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { StatusIcon } from '../components/StatusIcon';
import { StatusPill, type StatusTone } from '../components/StatusPill';
import { PageHeader } from '../components/PageHeader';
import { Sheet } from '../components/Sheet';
import { ToastRegion, useToasts } from '../components/Toast';
import { describeError } from '../lib/errors';
import route from './route.module.css';
import styles from './SettingsScreen.module.css';

// Provider brand marks — official logomarks only (no wordmark). Both are
// monochrome and inherit `currentColor` from the provider tile, so they render
// as dark marks on the light theme (and would adapt to a dark surface too).
function OpenAILogo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

function InworldLogo(): JSX.Element {
  return (
    <svg viewBox="0 0 14 18" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="currentColor"
        d="M4.321 2.988c-.029.006-.03-.021-.013-.03.57-.326 1.381-.404 1.442-.448.054-.075-.371-.07-.52-.07a4.2 4.2 0 0 0-2.777 1.138C1.268 4.564.88 6.187 1.043 7.645a5.597 5.597 0 0 0 2.301 3.817c2.627 1.724 6.335.9 8.3-1.446 2.42-2.864 1.697-6.942-.832-8.806A6.956 6.956 0 0 0 8.664.213C8.303.108 7.8.007 7.569 0c-.354-.011-.236.273-.299.343-.062.07-.71.098.023.35.434.148.17.157-.161.45-.293.258-.037.548-.139.65-.434.437.231.629.574.82 1.664.867 2.58 2.427 2.277 4.264-.426 2.428-4.128 3.476-5.766 1.557-1.26-1.456-.784-3.878 1.01-4.668.249-.118.81-.289.569-.269-.929.076-1.654.558-1.888.733-.02.015-.047-.008-.035-.03.17-.291 1.155-.972 3.091-1.211.346-.073-.956-.34-2.504-.001ZM5.116 17.583c.105 0 .21.014.308.024.253.008.537-.02.815.015.604.033 1.212.165 1.817.18.418.03.816.011 1.242.027.322.04.704.016.992.058.18.02.345.011.525.037.478.067.954.077 1.438.07.184.006.372.01.556-.002.196-.011.41-.003.567-.126.093-.053.089-.163.108-.238.024-.04.075-.063.098-.104a.713.713 0 0 0 .042-.22V17.3c.005-.25-.117-.496-.21-.727a8.62 8.62 0 0 0-.537-.965c-.22-.304-.332-.72-.707-.884-.676-.29-1.372-.26-2.12-.348a59.988 59.988 0 0 0-4.217-.228c-1.222.017-3.381.095-4.493.191-1.974.172-1.055.478-1.117 1.019-.023.2-.246.183-.221.378.041.283.585.638.859.71 1.204.314-.394.36-.215.675.148.262.811.187 1.082.29l3.387.172Z"
      />
    </svg>
  );
}

type ProviderName = 'openai' | 'inworld';

const PROVIDER_TITLE: Record<ProviderName, string> = { openai: 'OpenAI', inworld: 'Inworld' };

// Where a new key is issued. Both hosts are on the renderer's external-link
// allowlist, so the click is routed to the system browser.
const PROVIDER_KEY_URL: Record<ProviderName, string> = {
  openai: 'https://platform.openai.com/api-keys',
  inworld: 'https://docs.inworld.ai',
};

interface KeyFieldState {
  value: string;
  reveal: boolean;
}

export function SettingsScreen(): JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [openai, setOpenai] = useState<KeyFieldState>({ value: '', reveal: false });
  const [inworld, setInworld] = useState<KeyFieldState>({ value: '', reveal: false });
  const [savingProvider, setSavingProvider] = useState<ProviderName | null>(null);
  const [editing, setEditing] = useState<ProviderName | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Validation / save / test errors live inside the relevant provider panel.
  const [panelError, setPanelError] = useState<Partial<Record<ProviderName, string>>>({});
  const [testResults, setTestResults] = useState<Partial<Record<ProviderName, ProviderTestResult>>>({});
  const [testing, setTesting] = useState<ProviderName | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderName | null>(null);
  const { toasts, push, dismiss } = useToasts();
  // Bumped whenever a save/remove lands so a slow in-flight test that returns
  // afterwards can be discarded instead of re-marking a replaced/removed key.
  const opSeq = useRef<Record<ProviderName, number>>({ openai: 0, inworld: 0 });

  const refresh = useCallback(async () => {
    try {
      const next = await window.candidcue.settings.getPublic();
      setSettings(next);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveProvider = useCallback(
    async (provider: ProviderName) => {
      const field = provider === 'openai' ? openai : inworld;
      const value = field.value.trim();
      if (!value) {
        setPanelError((prev) => ({ ...prev, [provider]: 'Enter an API key before saving.' }));
        return;
      }
      setSavingProvider(provider);
      setPanelError((prev) => ({ ...prev, [provider]: undefined }));
      const input = provider === 'openai' ? { openaiApiKey: value } : { inworldApiKey: value };
      try {
        await window.candidcue.settings.saveProviders(input);
        // A freshly saved key invalidates any earlier verification result and
        // any test still in flight for this provider.
        opSeq.current[provider] += 1;
        if (provider === 'openai') {
          setOpenai({ value: '', reveal: false });
        } else {
          setInworld({ value: '', reveal: false });
        }
        setTestResults((prev) => ({ ...prev, [provider]: undefined }));
        setEditing(null);
        push('success', `${PROVIDER_TITLE[provider]} key saved.`);
        await refresh();
      } catch (err: unknown) {
        setPanelError((prev) => ({ ...prev, [provider]: describeError(err) }));
      } finally {
        setSavingProvider(null);
      }
    },
    [inworld, openai, push, refresh],
  );

  const handleTest = useCallback(async (provider: ProviderName) => {
    const seq = opSeq.current[provider];
    setTesting(provider);
    setPanelError((prev) => ({ ...prev, [provider]: undefined }));
    try {
      const result = await window.candidcue.settings.testProvider(provider);
      // Drop a result the user has since superseded with a save/remove.
      if (opSeq.current[provider] !== seq) {
        return;
      }
      setTestResults((prev) => ({ ...prev, [provider]: result }));
    } catch (err: unknown) {
      if (opSeq.current[provider] !== seq) {
        return;
      }
      setPanelError((prev) => ({ ...prev, [provider]: describeError(err) }));
    } finally {
      setTesting((curr) => (curr === provider ? null : curr));
    }
  }, []);

  const handleConfirmRemove = useCallback(async () => {
    const provider = removeTarget;
    if (provider === null) {
      return;
    }
    setRemoveTarget(null);
    setPanelError((prev) => ({ ...prev, [provider]: undefined }));
    // Collapse the editor so no save/test can be triggered while the credential
    // is being cleared, and invalidate any in-flight test for this provider.
    setEditing((curr) => (curr === provider ? null : curr));
    opSeq.current[provider] += 1;
    try {
      await window.candidcue.settings.clearProvider(provider);
      setTestResults((prev) => ({ ...prev, [provider]: undefined }));
      push('info', `${PROVIDER_TITLE[provider]} connection removed.`);
      await refresh();
    } catch (err: unknown) {
      setPanelError((prev) => ({ ...prev, [provider]: describeError(err) }));
    }
  }, [removeTarget, push, refresh]);

  return (
    <>
      <PageHeader title="Settings" meta="Connect the AI services CandidCue uses during interviews" />
      <div className={`${route.page} ${styles.settingsPage}`}>
        {loadError !== null && (
          <p className={route.error} role="alert">
            {loadError}
          </p>
        )}

        <div className={styles.providerList}>
          {settings === null ? (
            <>
              <ProviderSkeleton />
              <ProviderSkeleton />
            </>
          ) : (
            <>
              <ProviderCard
                provider="openai"
                logo={<OpenAILogo />}
                title="OpenAI"
                description="Interview planning and transcript processing."
                hasKey={settings.hasOpenAiKey}
                field={openai}
                onChange={setOpenai}
                inputId="openai-key"
                open={editing === 'openai'}
                onToggle={() => setEditing(editing === 'openai' ? null : 'openai')}
                onSave={() => void handleSaveProvider('openai')}
                onTest={() => void handleTest('openai')}
                onRemove={() => setRemoveTarget('openai')}
                saving={savingProvider === 'openai'}
                testing={testing === 'openai'}
                result={testResults.openai}
                error={panelError.openai}
              />

              <ProviderCard
                provider="inworld"
                logo={<InworldLogo />}
                title="Inworld"
                description="Speech recognition and interviewer voice."
                hasKey={settings.hasInworldKey}
                field={inworld}
                onChange={setInworld}
                inputId="inworld-key"
                open={editing === 'inworld'}
                onToggle={() => setEditing(editing === 'inworld' ? null : 'inworld')}
                onSave={() => void handleSaveProvider('inworld')}
                onTest={() => void handleTest('inworld')}
                onRemove={() => setRemoveTarget('inworld')}
                saving={savingProvider === 'inworld'}
                testing={testing === 'inworld'}
                result={testResults.inworld}
                error={panelError.inworld}
              />
            </>
          )}
        </div>

        <p className={styles.securityLine}>
          <Icon name="info" size={14} />
          Keys are kept in your operating system&rsquo;s secure credential store and never shown again after saving.
        </p>
      </div>

      <Sheet
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        tone="danger"
        title={`Remove the ${removeTarget !== null ? PROVIDER_TITLE[removeTarget] : ''} connection?`}
        description={`CandidCue will not be able to start an interview until a new ${
          removeTarget !== null ? PROVIDER_TITLE[removeTarget] : ''
        } key is configured.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void handleConfirmRemove()}>
              Remove connection
            </Button>
          </>
        }
      />
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

function ProviderSkeleton(): JSX.Element {
  return (
    <div className={styles.providerCard} aria-hidden>
      <div className={styles.providerSummary}>
        <span className={`${route.skeleton} ${styles.skeletonIcon}`} />
        <div className={styles.skeletonCopy}>
          <span className={`${route.skeleton} ${styles.skeletonLine}`} />
          <span className={`${route.skeleton} ${styles.skeletonLineSm}`} />
        </div>
      </div>
    </div>
  );
}

interface ProviderCardProps {
  provider: ProviderName;
  logo: JSX.Element;
  title: string;
  description: string;
  hasKey: boolean;
  field: KeyFieldState;
  onChange: (next: KeyFieldState) => void;
  inputId: string;
  open: boolean;
  onToggle: () => void;
  onSave: () => void;
  onTest: () => void;
  onRemove: () => void;
  saving: boolean;
  testing: boolean;
  result: ProviderTestResult | undefined;
  error: string | undefined;
}

function ProviderCard({
  provider,
  logo,
  title,
  description,
  hasKey,
  field,
  onChange,
  inputId,
  open,
  onToggle,
  onSave,
  onTest,
  onRemove,
  saving,
  testing,
  result,
  error,
}: ProviderCardProps): JSX.Element {
  const panelId = `${provider}-connection-panel`;
  const helpId = `${inputId}-help`;
  // Credential presence is not a connection. Reserve "Verified" for a successful
  // explicit test; a stored-but-untested key is only ever "Configured". Gating on
  // hasKey first guarantees a keyless provider can never show a result-based tone.
  const status: { tone: StatusTone; label: string } = !hasKey
    ? { tone: 'neutral', label: 'Not configured' }
    : testing
      ? { tone: 'accent', label: 'Verifying' }
      : result?.ok
        ? { tone: 'success', label: 'Verified' }
        : result && !result.ok
          ? { tone: 'danger', label: 'Needs attention' }
          : { tone: 'accent', label: 'Configured' };
  // The resting connected state reads as a quiet dot + label so the name line
  // stays calm; louder/transient states keep the filled StatusPill.
  const isConnected = status.tone === 'success';

  return (
    <section className={styles.providerCard}>
      <div className={styles.providerSummary}>
        <span className={styles.providerIcon} data-provider={provider} aria-hidden>
          {logo}
        </span>
        <div className={styles.providerCopy}>
          <div className={styles.providerNameRow}>
            <h2>{title}</h2>
            {isConnected ? (
              <span className={styles.connectedTag}>
                <span className={styles.connectedDot} aria-hidden />
                Connected
              </span>
            ) : (
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            )}
          </div>
          <p>{description}</p>
        </div>
        <Button variant="secondary" onClick={onToggle} aria-expanded={open} aria-controls={panelId}>
          {hasKey ? 'Manage' : 'Configure'}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} />
        </Button>
      </div>

      {open && (
        <div id={panelId} className={styles.managePanel}>
          <div className={route.field}>
            <label className={route.label} htmlFor={inputId}>
              {hasKey ? 'Replacement API key' : 'API key'}
            </label>
            <div className={styles.keyInputWrap}>
              <input
                id={inputId}
                className={route.input}
                type={field.reveal ? 'text' : 'password'}
                value={field.value}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={helpId}
                placeholder={hasKey ? 'Paste a replacement key' : 'Paste your API key'}
                onChange={(e) => onChange({ ...field, value: e.target.value })}
              />
              <button
                type="button"
                className={styles.revealButton}
                onClick={() => onChange({ ...field, reveal: !field.reveal })}
                aria-label={field.reveal ? 'Hide API key' : 'Show API key'}
              >
                <Icon name={field.reveal ? 'eyeOff' : 'eye'} size={16} />
              </button>
            </div>
            <div className={styles.fieldFootnote}>
              <p id={helpId} className={styles.fieldHelp}>
                {hasKey
                  ? 'The current key stays in place until you save a replacement.'
                  : 'After saving, the key cannot be shown or copied from CandidCue again.'}
              </p>
              <a className={styles.getKeyLink} href={PROVIDER_KEY_URL[provider]} target="_blank" rel="noreferrer">
                Get your {title} key
                <Icon name="externalLink" size={12} />
              </a>
            </div>
          </div>

          <div className={styles.formFooter}>
            <div className={styles.resultArea} role="status" aria-live="polite">
              {error ? (
                <>
                  <StatusIcon tone="danger" label="Error" />
                  <span>{error}</span>
                </>
              ) : result ? (
                <>
                  <StatusIcon
                    tone={result.ok ? 'success' : 'danger'}
                    label={result.ok ? 'Verified' : 'Verification failed'}
                  />
                  <span>
                    {result.ok
                      ? `Verified${result.latencyMs !== null ? ` in ${result.latencyMs} ms` : ''}`
                      : result.message}
                  </span>
                </>
              ) : null}
            </div>
            <div className={styles.formActions}>
              <Button variant="ghost" onClick={onToggle}>
                Cancel
              </Button>
              {hasKey && (
                <Button variant="secondary" onClick={onTest} disabled={testing || saving}>
                  {testing ? 'Verifying…' : 'Test connection'}
                </Button>
              )}
              <Button
                className={styles.compactAction}
                variant="primary"
                onClick={onSave}
                disabled={saving || testing || field.value.trim().length === 0}
              >
                {saving ? 'Saving…' : hasKey ? 'Save replacement' : 'Save key'}
              </Button>
            </div>
          </div>

          {hasKey && (
            <div className={styles.removeRow}>
              <Button variant="danger" onClick={onRemove} disabled={saving || testing}>
                <Icon name="trash" size={15} /> Remove connection
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
