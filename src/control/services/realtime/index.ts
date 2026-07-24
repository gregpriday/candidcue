/**
 * Public API of the realtime transcription package (spec §27, §29, §30.1,
 * §35). Consumers (the session facade / UI layer) import from this barrel
 * only; raw OpenAI event shapes never escape this package.
 */
export {
  WebRtcTranscriptionTransport,
  OPENAI_REALTIME_CALLS_URL,
  DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS,
  type WebRtcTransportDeps,
  type ConnectPhase,
  type RtcPeerConnectionLike,
  type RtcDataChannelLike,
  type RtcSenderLike,
  type FetchLike,
  type FetchResponseLike,
  type TransportTimers,
} from './webrtcTransport';
export { RustWebSocketTranscriptionTransport } from './wsTransport';
export {
  mintTranscriptionCredential,
  CREATE_REALTIME_TRANSCRIPTION_CREDENTIAL_COMMAND,
  CREDENTIAL_EXPIRY_MARGIN_MS,
  type TauriInvoke,
} from './credentials';
export {
  buildSessionUpdateEvent,
  DEFAULT_TRANSCRIPTION_CONFIG,
  type TranscriptionSessionOptions,
} from './sessionConfig';
export {
  TranscriptEventAdapter,
  normalizeLogprobs,
  type AdapterDeps,
} from './eventAdapter';
export { CommitLedger, type PendingCommitInput } from './commitLedger';
export { ManualCommitDriver, type CommitDriverDeps } from './commitDriver';
export {
  RealtimeStateMachine,
  InvalidTransitionError,
  resolveTransition,
  type RealtimeStateEvent,
  type StateChangeListener,
} from './stateMachine';
export {
  ReconnectScheduler,
  computeReconnectDelayMs,
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicyConfig,
} from './reconnect';
export {
  SessionHealthMonitor,
  DEFAULT_HEALTH_MONITOR_CONFIG,
  type HealthIssue,
  type HealthMonitorConfig,
} from './healthMonitor';
export {
  estimateTranscriptionCostUsd,
  formatUsdEstimate,
  SessionUsageTracker,
  REALTIME_TRANSCRIPTION_RATES_USD_PER_MINUTE,
  type CostEstimate,
} from './costEstimator';
export {
  RealtimeSessionController,
  type SessionControllerDeps,
  type SessionControllerHooks,
} from './sessionController';
export {
  RealtimeTransportError,
  NotImplementedError,
  mapRealtimeHttpStatus,
  mapProviderErrorEvent,
  type MappedFailure,
} from './errors';
