// Deterministic provider fakes for orchestrator and integration tests. Each
// fake implements its real adapter contract precisely and exposes small knobs
// so tests can script behaviour without network access.

export { AbortError } from './abort';

export { FakeInterviewModel } from './fake-interview-model';
export type { FakeInterviewModelConfig } from './fake-interview-model';

export { FakeModeration } from './fake-moderation';
export type { FakeModerationConfig } from './fake-moderation';

export { FakeStt } from './fake-stt';
export type { FakeSttConfig } from './fake-stt';

export { FakeTts } from './fake-tts';
export type { FakeTtsConfig } from './fake-tts';
