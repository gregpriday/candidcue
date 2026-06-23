import { useCallback, useEffect, useState } from 'react';
import type { PublicSettings } from '@shared/contracts';
import type { ProviderTestResult } from '@shared/contracts';
import { Button } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { WorkspaceToolbar } from '../components/WorkspaceToolbar';
import { describeError } from '../lib/errors';
import route from './route.module.css';
import styles from './SettingsScreen.module.css';

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
      <WorkspaceToolbar
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
            icon="sparkles"
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
            icon="speaker"
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
  icon: IconName;
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
          <Icon name={icon} size={22} />
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
