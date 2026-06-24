import { useCallback, useEffect, useState } from 'react';
import type { PublicSettings } from '@shared/contracts';
import type { ProviderTestResult } from '@shared/contracts';
import { Button } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { PageHeader } from '../components/PageHeader';
import { describeError } from '../lib/errors';
import route from './route.module.css';
import styles from './SettingsScreen.module.css';

// Provider brand marks — official logo icons only (no wordmark). OpenAI's logomark
// is monochrome (rendered white on this dark UI); Inworld's brushstroke mark uses
// its warm off-white from the brand favicon.
function OpenAILogo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="#ffffff"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
      />
    </svg>
  );
}

function InworldLogo(): JSX.Element {
  return (
    <svg viewBox="0 0 14 18" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="#efe3db"
        d="M4.321 2.988c-.029.006-.03-.021-.013-.03.57-.326 1.381-.404 1.442-.448.054-.075-.371-.07-.52-.07a4.2 4.2 0 0 0-2.777 1.138C1.268 4.564.88 6.187 1.043 7.645a5.597 5.597 0 0 0 2.301 3.817c2.627 1.724 6.335.9 8.3-1.446 2.42-2.864 1.697-6.942-.832-8.806A6.956 6.956 0 0 0 8.664.213C8.303.108 7.8.007 7.569 0c-.354-.011-.236.273-.299.343-.062.07-.71.098.023.35.434.148.17.157-.161.45-.293.258-.037.548-.139.65-.434.437.231.629.574.82 1.664.867 2.58 2.427 2.277 4.264-.426 2.428-4.128 3.476-5.766 1.557-1.26-1.456-.784-3.878 1.01-4.668.249-.118.81-.289.569-.269-.929.076-1.654.558-1.888.733-.02.015-.047-.008-.035-.03.17-.291 1.155-.972 3.091-1.211.346-.073-.956-.34-2.504-.001ZM5.116 17.583c.105 0 .21.014.308.024.253.008.537-.02.815.015.604.033 1.212.165 1.817.18.418.03.816.011 1.242.027.322.04.704.016.992.058.18.02.345.011.525.037.478.067.954.077 1.438.07.184.006.372.01.556-.002.196-.011.41-.003.567-.126.093-.053.089-.163.108-.238.024-.04.075-.063.098-.104a.713.713 0 0 0 .042-.22V17.3c.005-.25-.117-.496-.21-.727a8.62 8.62 0 0 0-.537-.965c-.22-.304-.332-.72-.707-.884-.676-.29-1.372-.26-2.12-.348a59.988 59.988 0 0 0-4.217-.228c-1.222.017-3.381.095-4.493.191-1.974.172-1.055.478-1.117 1.019-.023.2-.246.183-.221.378.041.283.585.638.859.71 1.204.314-.394.36-.215.675.148.262.811.187 1.082.29l3.387.172Z"
      />
    </svg>
  );
}

type ProviderName = 'openai' | 'inworld';

interface KeyFieldState {
  value: string;
  reveal: boolean;
}

export function SettingsScreen(): JSX.Element {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [openai, setOpenai] = useState<KeyFieldState>({ value: '', reveal: false });
  const [inworld, setInworld] = useState<KeyFieldState>({ value: '', reveal: false });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ProviderName | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<ProviderName, ProviderTestResult>>>({});
  const [testing, setTesting] = useState<ProviderName | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.candidcue.settings.getPublic();
      setSettings(next);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSaveProvider = useCallback(async (provider: ProviderName) => {
    const field = provider === 'openai' ? openai : inworld;
    const value = field.value.trim();
    if (!value) {
      setError('Enter an API key before saving this connection.');
      return;
    }
    setSaving(true);
    setError(null);
    setSavedNote(null);
    const input =
      provider === 'openai'
        ? { openaiApiKey: value }
        : { inworldApiKey: value };
    try {
      await window.candidcue.settings.saveProviders(input);
      if (provider === 'openai') {
        setOpenai({ value: '', reveal: false });
      } else {
        setInworld({ value: '', reveal: false });
      }
      setSavedNote(`${provider === 'openai' ? 'OpenAI' : 'Inworld'} connection updated.`);
      setEditing(null);
      await refresh();
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [inworld, openai, refresh]);

  const handleTest = useCallback(async (provider: ProviderName) => {
    setTesting(provider);
    setError(null);
    try {
      const result = await window.candidcue.settings.testProvider(provider);
      setTestResults((prev) => ({ ...prev, [provider]: result }));
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setTesting(null);
    }
  }, []);

  const handleClear = useCallback(
    async (provider: ProviderName) => {
      setError(null);
      try {
        await window.candidcue.settings.clearProvider(provider);
        setTestResults((prev) => ({ ...prev, [provider]: undefined }));
        await refresh();
      } catch (err: unknown) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  return (
    <>
      <PageHeader
        title="Settings"
        meta="AI provider connections."
      />
      <div className={`${route.page} ${route.pageNarrow}`}>
        {error !== null && (
          <p className={route.error} role="alert">
            {error}
          </p>
        )}
        {savedNote !== null && (
          <div className={route.notice} role="status">
            <StatusIcon tone="success" label="Saved" />
            <span>{savedNote}</span>
          </div>
        )}

        <div className={styles.providerList}>
          <ProviderCard
            provider="openai"
            logo={<OpenAILogo />}
            title="OpenAI"
            description="Plans interviews and processes transcripts."
            hasKey={settings?.hasOpenAiKey ?? false}
            field={openai}
            onChange={setOpenai}
            inputId="openai-key"
            open={editing === 'openai'}
            onToggle={() => setEditing(editing === 'openai' ? null : 'openai')}
            onSave={() => void handleSaveProvider('openai')}
            onTest={() => void handleTest('openai')}
            onClear={() => void handleClear('openai')}
            saving={saving}
            testing={testing === 'openai'}
            result={testResults.openai}
          />

          <ProviderCard
            provider="inworld"
            logo={<InworldLogo />}
            title="Inworld"
            description="Speech recognition and interviewer voice."
            hasKey={settings?.hasInworldKey ?? false}
            field={inworld}
            onChange={setInworld}
            inputId="inworld-key"
            open={editing === 'inworld'}
            onToggle={() => setEditing(editing === 'inworld' ? null : 'inworld')}
            onSave={() => void handleSaveProvider('inworld')}
            onTest={() => void handleTest('inworld')}
            onClear={() => void handleClear('inworld')}
            saving={saving}
            testing={testing === 'inworld'}
            result={testResults.inworld}
          />
        </div>
      </div>
    </>
  );
}

interface ProviderCardProps {
  provider: ProviderName;
  icon?: IconName;
  logo?: JSX.Element;
  title: string;
  description: string;
  hasKey: boolean;
  field: KeyFieldState;
  onChange: (next: KeyFieldState) => void;
  inputId: string;
  onTest: () => void;
  onClear: () => void;
  testing: boolean;
  result: ProviderTestResult | undefined;
  open: boolean;
  onToggle: () => void;
  onSave: () => void;
  saving: boolean;
}

function ProviderCard({
  icon,
  logo,
  title,
  description,
  hasKey,
  field,
  onChange,
  inputId,
  onTest,
  onClear,
  testing,
  result,
  open,
  onToggle,
  onSave,
  saving,
}: ProviderCardProps): JSX.Element {
  const resultTone: StatusTone = result ? (result.ok ? 'success' : 'danger') : 'neutral';
  return (
    <section className={styles.providerCard}>
      <div className={styles.providerSummary}>
        <span className={styles.providerIcon} aria-hidden>
          {logo ? logo : <Icon name={icon!} size={22} />}
        </span>
        <div className={styles.providerCopy}>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className={styles.keyStatus}>
          <StatusIcon tone={hasKey ? 'success' : 'pending'} label={hasKey ? 'Connected' : 'Not connected'} />
          {hasKey ? 'Connected' : 'Not connected'}
        </span>
        <Button variant="secondary" onClick={onToggle}>
          {hasKey ? 'Manage' : 'Connect'}
        </Button>
      </div>

      {open && (
        <div className={styles.managePanel}>
          <p className={route.sectionHint}>
            Keys are stored by the desktop app and are never displayed again after saving.
          </p>
          <div className={route.field}>
            <label className={route.label} htmlFor={inputId}>
              API key
            </label>
            <div className={styles.keyInputWrap}>
              <input
                id={inputId}
                className={route.input}
                type={field.reveal ? 'text' : 'password'}
                value={field.value}
                autoComplete="off"
                spellCheck={false}
                placeholder={hasKey ? 'Enter a new key to replace the stored key' : 'Paste your API key'}
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
          </div>

          <div className={styles.actions}>
            <Button variant="primary" onClick={onSave} disabled={saving || field.value.trim().length === 0}>
              {saving ? 'Saving…' : hasKey ? 'Update key' : 'Save key'}
            </Button>
            {hasKey && (
              <Button variant="secondary" onClick={onTest} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            )}
            {result && (
              <span className={styles.testResult}>
                <StatusIcon tone={resultTone} label={result.ok ? 'Passed' : 'Failed'} />
                {result.message}
                {result.latencyMs !== null && <span className={styles.latency}> ({result.latencyMs} ms)</span>}
              </span>
            )}
          </div>

          {hasKey && (
            <div className={styles.dangerZone}>
              <Button variant="danger" onClick={onClear}>
                Remove key
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
