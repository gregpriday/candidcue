import { useCallback, useEffect, useState } from 'react';
import type { PublicSettings } from '@shared/contracts';
import type { ProviderTestResult } from '@shared/contracts';
import { Button } from '../components/Button';
import { Panel } from '../components/Panel';
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

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    // Never overwrite a stored key with an empty string.
    const input: { openaiApiKey?: string; inworldApiKey?: string } = {};
    if (openai.value.trim()) {
      input.openaiApiKey = openai.value.trim();
    }
    if (inworld.value.trim()) {
      input.inworldApiKey = inworld.value.trim();
    }
    try {
      await window.candidcue.settings.saveProviders(input);
      setOpenai({ value: '', reveal: false });
      setInworld({ value: '', reveal: false });
      setSavedNote('Saved. Entered keys are stored; blank fields were left unchanged.');
      await refresh();
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [openai.value, inworld.value, refresh]);

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
        actions={
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save keys'}
          </Button>
        }
      />
      <div className={route.page}>
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

        <ProviderCard
          title="OpenAI"
          description="Receives your compiled source material and transcripts to plan the interview, generate questions, clean transcripts, and moderate content."
          hasKey={settings?.hasOpenAiKey ?? false}
          field={openai}
          onChange={setOpenai}
          inputId="openai-key"
          onTest={() => void handleTest('openai')}
          onClear={() => void handleClear('openai')}
          testing={testing === 'openai'}
          result={testResults.openai}
        />

        <ProviderCard
          title="Inworld"
          description="Receives microphone audio to transcribe your answers and the interviewer's question text to synthesise speech."
          hasKey={settings?.hasInworldKey ?? false}
          field={inworld}
          onChange={setInworld}
          inputId="inworld-key"
          onTest={() => void handleTest('inworld')}
          onClear={() => void handleClear('inworld')}
          testing={testing === 'inworld'}
          result={testResults.inworld}
        />
      </div>
    </>
  );
}

interface ProviderCardProps {
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
}

function ProviderCard({
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
}: ProviderCardProps): JSX.Element {
  const resultTone: StatusTone = result ? (result.ok ? 'success' : 'danger') : 'neutral';
  return (
    <Panel
      title={title}
      actions={
        <span className={styles.keyStatus}>
          <StatusIcon tone={hasKey ? 'success' : 'pending'} label={hasKey ? 'Key set' : 'No key set'} size={12} />
          {hasKey ? 'Key set' : 'Not set'}
        </span>
      }
    >
      <p className={route.sectionHint}>{description}</p>

      <div className={route.field}>
        <label className={route.label} htmlFor={inputId}>
          API key
        </label>
        <div className={styles.keyRow}>
          <input
            id={inputId}
            className={route.input}
            type={field.reveal ? 'text' : 'password'}
            value={field.value}
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey ? 'A key is stored — enter a new one to replace it' : 'Paste your API key'}
            onChange={(e) => onChange({ ...field, value: e.target.value })}
          />
          <Button variant="secondary" onClick={() => onChange({ ...field, reveal: !field.reveal })}>
            {field.reveal ? 'Hide' : 'Show'}
          </Button>
        </div>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onTest} disabled={testing || !hasKey}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Button variant="danger" onClick={onClear} disabled={!hasKey}>
          Clear key
        </Button>
        {result && (
          <span className={styles.testResult}>
            <StatusIcon tone={resultTone} label={result.ok ? 'Passed' : 'Failed'} />
            {result.message}
            {result.latencyMs !== null && <span className={styles.latency}> ({result.latencyMs} ms)</span>}
          </span>
        )}
      </div>
    </Panel>
  );
}
