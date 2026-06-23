import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectId, EndpointMode } from '@shared/domain';
import type { DisplayInfo, PreflightState, PreflightCheck, PrepareSessionInput } from '@shared/contracts';
import type { Navigator } from '../app';
import { Button } from '../components/Button';
import { StatusIcon, type StatusTone } from '../components/StatusIcon';
import { Panel } from '../components/Panel';
import { WorkspaceToolbar } from '../components/WorkspaceToolbar';
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

  const [permissionState, setPermissionState] = useState<'idle' | 'granted' | 'denied'>('idle');
  const [preflight, setPreflight] = useState<PreflightState | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [beginning, setBeginning] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <WorkspaceToolbar
        title="Session setup"
        onBack={() => nav.go({ name: 'project', projectId })}
      />
      <div className={`${route.page} ${route.pageWide}`}>
        {error !== null && (
          <p className={route.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.columns}>
          <div className={styles.column}>
            <Panel title="Endpoint mode">
              <p className={route.sectionHint}>How CandidCue decides an answer is finished.</p>
              <div className={route.field}>
                <label className={route.label} htmlFor="endpoint-mode">
                  Mode
                </label>
                <select
                  id="endpoint-mode"
                  className={route.select}
                  value={endpointMode}
                  onChange={(e) => setEndpointMode(e.target.value as EndpointMode)}
                >
                  <option value="manual">Manual — you commit each answer</option>
                  <option value="conservative">Conservative — wait longer before committing</option>
                  <option value="balanced">Balanced — commit a little sooner</option>
                </select>
              </div>
            </Panel>

            <Panel title="Audio devices">
              {permissionState !== 'granted' ? (
                <div className={route.notice}>
                  <StatusIcon tone={permissionState === 'denied' ? 'danger' : 'pending'} label="Microphone access" />
                  <div>
                    <p style={{ margin: 0 }}>
                      {permissionState === 'denied'
                        ? 'Microphone access was denied. Grant access in system settings, then retry.'
                        : 'Grant microphone access to list devices and preview your level.'}
                    </p>
                    <Button variant="secondary" onClick={() => void requestPermission()}>
                      {permissionState === 'denied' ? 'Retry microphone access' : 'Allow microphone'}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={route.field}>
                    <label className={route.label} htmlFor="input-device">
                      Microphone
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
                      Audio output
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
            </Panel>

            <Panel
              title="Teleprompter display"
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
            </Panel>
          </div>

          <div className={styles.column}>
            <Panel title="Stage">
              <label className={route.checkboxRow}>
                <input
                  type="checkbox"
                  checked={captionsEnabled}
                  onChange={(e) => setCaptionsEnabled(e.target.checked)}
                />
                Show captions on the stage
              </label>
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
            </Panel>

            <Panel
              title="Readiness"
              actions={
                <Button variant="secondary" onClick={() => void handlePrepare()} disabled={preparing}>
                  {preparing ? 'Checking…' : preflight ? 'Re-check' : 'Run checks'}
                </Button>
              }
            >
              {checks.length === 0 ? (
                <p className={route.sectionHint}>Run the checks to confirm everything is ready.</p>
              ) : (
                <ul className={styles.checklist}>
                  {checks.map((check) => (
                    <li key={check.id} className={styles.checkItem}>
                      <StatusIcon
                        tone={CHECK_TONE[check.status]}
                        label={`${check.label}: ${CHECK_WORD[check.status]}`}
                      />
                      <span className={styles.checkLabel}>
                        {check.label}
                        {check.required && <span className={styles.required}> (required)</span>}
                      </span>
                      <span className={styles.checkStatus}>
                        {CHECK_WORD[check.status]}
                        {check.detail ? ` — ${check.detail}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.beginRow} aria-live="polite">
                <Button variant="primary" onClick={() => void handleBegin()} disabled={!canBegin || beginning}>
                  {beginning ? 'Starting…' : 'Begin'}
                </Button>
                {!canBegin && checks.length > 0 && (
                  <span className={route.sectionHint}>Resolve required checks before beginning.</span>
                )}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
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
