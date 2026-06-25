import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectId, EndpointMode } from '@shared/domain';
import type { DisplayInfo, PreflightState, PreflightCheck, PrepareSessionInput } from '@shared/contracts';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { Section } from '../components/Section';
import { RadioCard } from '../components/RadioCard';
import { Disclosure } from '../components/Disclosure';
import { StagePreview } from '../components/StagePreview';
import { PageHeader } from '../components/PageHeader';
import { describeError } from '../lib/errors';
import { MicMeter } from '../components/MicMeter';
import route from './route.module.css';
import styles from './PreflightScreen.module.css';

interface PreflightScreenProps {
  nav: Navigator;
  projectId: ProjectId;
}

interface DeviceOption {
  deviceId: string;
  label: string;
}

const CHECK_TONE: Record<PreflightCheck['status'], StatusTone> = {
  pending: 'pending',
  checking: 'active',
  passed: 'success',
  failed: 'danger',
};

const CHECK_WORD: Record<PreflightCheck['status'], string> = {
  pending: 'Pending',
  checking: 'Checking',
  passed: 'Ready',
  failed: 'Not ready',
};

const PACING: ReadonlyArray<{ value: EndpointMode; title: string; description: string }> = [
  { value: 'manual', title: 'I’ll finish each answer myself', description: 'You decide when each answer is complete.' },
  { value: 'balanced', title: 'Move on after a natural pause', description: 'Mira continues once you pause naturally.' },
  { value: 'conservative', title: 'Wait for a longer pause', description: 'Mira waits a little longer before moving on.' },
];

export function PreflightScreen({ nav, projectId }: PreflightScreenProps): JSX.Element {
  const [endpointMode, setEndpointMode] = useState<EndpointMode>('conservative');
  const [inputDevices, setInputDevices] = useState<DeviceOption[]>([]);
  const [outputDevices, setOutputDevices] = useState<DeviceOption[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const [selectedOutput, setSelectedOutput] = useState<string | null>(null);
  const [selectedDisplay, setSelectedDisplay] = useState<string | null>(null);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [mirrorStage, setMirrorStage] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [verticalOffsetPercent, setVerticalOffsetPercent] = useState(0);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);

  const [permissionState, setPermissionState] = useState<'idle' | 'granted' | 'denied'>('idle');
  const [preflight, setPreflight] = useState<PreflightState | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [beginning, setBeginning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoPrepared = useRef(false);

  const enumerate = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs: DeviceOption[] = [];
      const outputs: DeviceOption[] = [];
      devices.forEach((device, index) => {
        if (device.kind === 'audioinput') {
          inputs.push({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` });
        } else if (device.kind === 'audiooutput') {
          outputs.push({ deviceId: device.deviceId, label: device.label || `Output ${index + 1}` });
        }
      });
      setInputDevices(inputs);
      setOutputDevices(outputs);
      setSelectedInput((prev) => prev ?? inputs[0]?.deviceId ?? null);
      setSelectedOutput((prev) => prev ?? outputs[0]?.deviceId ?? null);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  }, []);

  const requestPermission = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermissionState('granted');
      await enumerate();
    } catch (err: unknown) {
      setPermissionState('denied');
      setError(describeError(err));
    }
  }, [enumerate]);

  useEffect(() => {
    let cancelled = false;
    void window.candidcue.devices
      .listDisplays()
      .then((list) => {
        if (cancelled) {
          return;
        }
        setDisplays(list);
        const external = list.find((d) => !d.isInternal) ?? list[0];
        setSelectedDisplay((prev) => prev ?? external?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(describeError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The interviewer's portrait for the stage preview.
  useEffect(() => {
    let cancelled = false;
    Promise.all([window.candidcue.projects.get(projectId), window.candidcue.characters.list()])
      .then(([aggregate, chars]) => {
        if (cancelled || aggregate === null) {
          return;
        }
        const characterId = aggregate.project.interviewerCharacterId;
        const character = chars.find((c) => c.id === characterId) ?? chars.find((c) => c.id === 'mira') ?? chars[0];
        setPosterUrl(character?.profileImageUrl ?? null);
      })
      .catch(() => {
        /* the preview portrait is a nicety */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const unsubscribe = window.candidcue.events.onPreflight((state) => {
      if (state.projectId === projectId) {
        setPreflight(state);
      }
    });
    return unsubscribe;
  }, [projectId]);

  const buildInput = useCallback((): PrepareSessionInput => {
    return {
      projectId,
      config: {
        endpointMode,
        selectedInputDeviceId: selectedInput,
        selectedOutputDeviceId: selectedOutput,
        selectedDisplayId: selectedDisplay,
        captionsEnabled,
        mirrorStage,
        zoom,
        verticalOffsetPercent,
      },
    };
  }, [
    projectId,
    endpointMode,
    selectedInput,
    selectedOutput,
    selectedDisplay,
    captionsEnabled,
    mirrorStage,
    zoom,
    verticalOffsetPercent,
  ]);

  const handlePrepare = useCallback(async () => {
    setPreparing(true);
    setError(null);
    try {
      const state = await window.candidcue.sessions.prepare(buildInput());
      setPreflight(state);
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setPreparing(false);
    }
  }, [buildInput]);

  // A completed check is only valid for the config it was prepared with. When a
  // session-affecting input changes, drop the prepared state so the user can't
  // start a stale session and the check re-runs. (Display-only fine-tuning —
  // zoom/offset — is excluded so dragging a slider doesn't thrash prepare.)
  useEffect(() => {
    setPreflight(null);
    autoPrepared.current = false;
  }, [endpointMode, selectedInput, selectedOutput, selectedDisplay, captionsEnabled, mirrorStage]);

  // Run the readiness checks automatically once the microphone is enumerated and
  // a display is available — no separate "prepare" step the user has to discover.
  useEffect(() => {
    if (
      permissionState === 'granted' &&
      selectedInput !== null &&
      selectedDisplay !== null &&
      preflight === null &&
      !preparing &&
      !autoPrepared.current
    ) {
      autoPrepared.current = true;
      void handlePrepare();
    }
  }, [permissionState, selectedInput, selectedDisplay, preflight, preparing, handlePrepare]);

  const handleBegin = useCallback(async () => {
    setBeginning(true);
    setError(null);
    try {
      const result = await window.candidcue.sessions.command({ type: 'BEGIN_SESSION' });
      if (!result.ok) {
        setError(result.error?.publicMessage ?? 'The session could not be started.');
        return;
      }
      const sessionId = preflight?.sessionId;
      if (sessionId) {
        nav.go({ name: 'operator', sessionId });
      } else {
        setError('The session started but no session id was returned.');
      }
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setBeginning(false);
    }
  }, [preflight, nav]);

  const identifyDisplays = useCallback(() => {
    void window.candidcue.devices.identifyDisplays();
  }, []);

  const handleSelectDisplay = useCallback((displayId: string) => {
    setSelectedDisplay(displayId);
    void window.candidcue.devices.setSelectedDisplay(displayId);
  }, []);

  const canBegin = preflight?.canBegin ?? false;
  const checks = preflight?.checks ?? [];
  const meterDeviceId = permissionState === 'granted' ? selectedInput : null;

  // One evolving primary action instead of separate "prepare" then "begin".
  const primary: { label: string; onClick: () => void; disabled: boolean } =
    permissionState !== 'granted'
      ? {
          label: permissionState === 'denied' ? 'Fix microphone access' : 'Allow microphone',
          onClick: () => void requestPermission(),
          disabled: false,
        }
      : preparing
        ? { label: 'Checking setup…', onClick: () => undefined, disabled: true }
        : canBegin
          ? { label: beginning ? 'Starting…' : 'Start interview', onClick: () => void handleBegin(), disabled: beginning }
          : preflight !== null
            ? { label: 'Re-check setup', onClick: () => void handlePrepare(), disabled: false }
            : { label: 'Check setup', onClick: () => void handlePrepare(), disabled: false };

  return (
    <div className={route.screen}>
      <PageHeader title="Get ready" onBack={() => nav.go({ name: 'project', projectId })} backLabel="Interview" />
      <div className={`${route.screenBody} ${styles.preflight}`}>
        <div className={styles.setupCol}>
          {error !== null && (
            <p className={route.error} role="alert">
              {error}
            </p>
          )}

          <Section title="Microphone" description="Say a few words and watch the level move.">
            {permissionState !== 'granted' ? (
              <div className={route.notice}>
                <StatusIcon tone={permissionState === 'denied' ? 'danger' : 'pending'} label="Microphone access" />
                <span>
                  {permissionState === 'denied'
                    ? 'Microphone access was denied. Grant access in system settings, then try again.'
                    : 'Grant microphone access to pick a device and preview your level.'}
                </span>
              </div>
            ) : (
              <>
                <div className={route.field}>
                  <label className={route.label} htmlFor="input-device">
                    Device
                  </label>
                  <select
                    id="input-device"
                    className={route.select}
                    value={selectedInput ?? ''}
                    onChange={(e) => setSelectedInput(e.target.value || null)}
                  >
                    {inputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </div>
                <MicMeter deviceId={meterDeviceId} />
                <div className={route.field}>
                  <label className={route.label} htmlFor="output-device">
                    Interviewer voice plays through
                  </label>
                  <select
                    id="output-device"
                    className={route.select}
                    value={selectedOutput ?? ''}
                    onChange={(e) => setSelectedOutput(e.target.value || null)}
                  >
                    {outputDevices.length === 0 && <option value="">System default</option>}
                    {outputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </Section>

          <Section
            title="Stage display"
            description="The screen the interviewee sees."
            actions={
              <Button variant="ghost" onClick={identifyDisplays}>
                Identify displays
              </Button>
            }
          >
            <div className={route.field}>
              <label className={route.label} htmlFor="display-select">
                Display
              </label>
              <select
                id="display-select"
                className={route.select}
                value={selectedDisplay ?? ''}
                onChange={(e) => handleSelectDisplay(e.target.value)}
              >
                {displays.length === 0 && <option value="">No displays detected</option>}
                {displays.map((display) => (
                  <option key={display.id} value={display.id}>
                    {display.label}
                    {display.isPrimary ? ' (primary)' : ''}
                    {display.isInternal ? ' (internal)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <label className={route.checkboxRow}>
              <input type="checkbox" checked={captionsEnabled} onChange={(e) => setCaptionsEnabled(e.target.checked)} />
              Show captions on the stage
            </label>
          </Section>

          <Section title="When to move on" description="How Mira decides an answer is finished.">
            <div className={styles.pacing}>
              {PACING.map((option) => (
                <RadioCard<EndpointMode>
                  key={option.value}
                  name="endpoint-mode"
                  value={option.value}
                  checked={endpointMode === option.value}
                  onChange={setEndpointMode}
                  title={option.title}
                  description={option.description}
                />
              ))}
            </div>
          </Section>

          <Disclosure summary="Stage preferences">
            <label className={route.checkboxRow}>
              <input type="checkbox" checked={mirrorStage} onChange={(e) => setMirrorStage(e.target.checked)} />
              Mirror the stage horizontally
            </label>
            <RangeField
              id="zoom"
              label="Zoom"
              min={1}
              max={1.5}
              step={0.01}
              value={zoom}
              onChange={setZoom}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <RangeField
              id="offset"
              label="Vertical offset"
              min={-25}
              max={25}
              step={1}
              value={verticalOffsetPercent}
              onChange={setVerticalOffsetPercent}
              format={(v) => `${v}%`}
            />
          </Disclosure>

          {checks.length > 0 && (
            <div className={styles.readinessBlock}>
              <p className={styles.readinessLabel}>Readiness</p>
              <ul className={styles.checklist}>
                {checks.map((check) => (
                  <li key={check.id} className={styles.checkItem}>
                    <StatusIcon tone={CHECK_TONE[check.status]} label={`${check.label}: ${CHECK_WORD[check.status]}`} />
                    <span className={styles.checkLabel}>{check.label}</span>
                    <span className={styles.checkStatus}>
                      {CHECK_WORD[check.status]}
                      {check.detail ? ` — ${check.detail}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className={styles.previewCol}>
          <StagePreview
            posterUrl={posterUrl}
            captionsEnabled={captionsEnabled}
            caption="Your interview is ready."
            mirror={mirrorStage}
            zoom={zoom}
            verticalOffsetPercent={verticalOffsetPercent}
            status="Stage preview"
          />
          <p className={styles.privacy}>
            CandidCue does not record your camera. Raw microphone audio is not saved. Interview text is processed
            using your configured providers.
          </p>
        </div>
      </div>

      <div className={route.actionBar}>
        <div className={`${route.actionBarInner} ${route.actionBarSplit}`} aria-live="polite">
          <span className={route.sectionHint}>
            {permissionState === 'granted' && !canBegin && checks.length > 0 && !preparing
              ? 'Resolve the items above to begin.'
              : ''}
          </span>
          <Button variant="primary" onClick={primary.onClick} disabled={primary.disabled}>
            {primary.label}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface RangeFieldProps {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
}

function RangeField({ id, label, min, max, step, value, onChange, format }: RangeFieldProps): JSX.Element {
  const inputId = useRef(`range-${id}`).current;
  const displayValue = useMemo(() => format(value), [format, value]);
  return (
    <div className={route.field}>
      <label className={route.label} htmlFor={inputId}>
        {label}: <span className={styles.rangeValue}>{displayValue}</span>
      </label>
      <input
        id={inputId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
      />
    </div>
  );
}
