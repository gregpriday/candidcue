/**
 * ============================================================================
 * MOCK BACKEND — awaiting Rust integration.
 *
 * A typed in-memory stand-in for the spec §46 command surface. It exists so
 * every control-window screen is fully drivable before the Rust commands
 * land. `invokeOrMock` in `ipc.ts` only routes here when the real command is
 * unregistered or the app runs outside Tauri; once a Rust command ships, the
 * matching mock path silently stops being used.
 *
 * Nothing outside `src/control/services/` may import this module.
 * ============================================================================
 */
import type { ScriptDocument, ScriptSummary, StageStatus } from '../../shared/contracts';
import { BUNDLED_MODEL_NAME } from '../../shared/contracts';
import { DEFAULT_WORDS_PER_MINUTE } from '../../shared/speaking-rate';
import {
  countWords,
  estimateDurationSeconds,
  hashSource,
  plainExcerpt,
} from '../lib/format';
import type { AppSettings, ClearResult } from './settings-types';
import { defaultAppSettings } from './settings-types';
import type {
  DisplayDescriptor,
  IdentificationSession,
  StageOpenResult,
  StageWindowState,
} from './stage-types';
import type { SaveResult, ScriptListFilter, ScriptPage, ScriptSort } from './scripts-types';
// Type-only, so this does not close a runtime cycle: `speech-models` reaches
// this module through a dynamic import, and types are erased.
import type { SpeechLanguageOptions, SpeechModelStatus } from './speech-models';

const STORAGE_KEY = 'candidcue.mock.scripts.v1';

interface MockScriptRecord {
  doc: ScriptDocument;
  trashedAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `mock-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function defaultScriptSettings(): ScriptDocument['settings'] {
  return {
    schemaVersion: 1,
    readHeadings: false,
    readImageAltText: false,
    readInlineCode: false,
    cueVisibility: 'subtle',
    silentBlockVisibility: 'dim',
    // Rust's default, so `pnpm dev:vite` shows the lengths a real install does.
    wordsPerMinuteEstimate: DEFAULT_WORDS_PER_MINUTE,
  };
}

class MockState {
  scripts = new Map<string, MockScriptRecord>();
  settings: AppSettings = defaultAppSettings();
  /** Only redacted metadata is retained — never the key itself. */
  loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as MockScriptRecord[];
      for (const record of parsed) this.scripts.set(record.doc.id, record);
    } catch {
      // Corrupt dev storage is discarded; the mock starts empty.
    }
  }

  persist(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.scripts.values()]));
    } catch {
      // Quota/serialization problems are non-fatal in the mock.
    }
  }
}

const state = new MockState();

function refreshDerived(doc: ScriptDocument): void {
  const words = countWords(doc.source);
  doc.spokenWordCount = words;
  doc.estimatedDurationSeconds = estimateDurationSeconds(words, doc.settings.wordsPerMinuteEstimate);
  doc.previewText = plainExcerpt(doc.source);
  doc.sourceHash = hashSource(doc.source);
}

function toSummary(doc: ScriptDocument): ScriptSummary {
  const {
    id, title, status, language, spokenWordCount, estimatedDurationSeconds,
    updatedAt, lastOpenedAt, previewText, hasWarnings, scriptRevision,
  } = doc;
  return {
    id, title, status, language, spokenWordCount, estimatedDurationSeconds,
    updatedAt, previewText, hasWarnings, scriptRevision,
    ...(lastOpenedAt ? { lastOpenedAt } : {}),
  };
}

/**
 * Refuse a transition sent against a revision the script has moved past, the
 * way Rust's `AppError::stale_revision` does: by rejecting, because trash and
 * restore have no `SaveResult` to carry a conflict by value. This mock used to
 * ignore the revision, which is why no browser run ever saw #255.
 */
function expectRevision(doc: ScriptDocument, expectedRevision: number): void {
  if (doc.scriptRevision === expectedRevision) return;
  throw {
    code: 'SCRIPT_CONFLICT',
    userMessage: 'This document changed elsewhere. Reload before saving.',
  };
}

/* ---------------------------------------------------------------- scripts */

export const mockScripts = {
  list(filter?: ScriptListFilter, sort?: ScriptSort): ScriptPage {
    state.load();
    const view = filter?.view ?? 'all';
    let items = [...state.scripts.values()];
    items = items.filter((r) => (view === 'trash' ? r.doc.status === 'trash' : r.doc.status !== 'trash'));
    if (view === 'recent') {
      items = items.filter((r) => r.doc.lastOpenedAt !== undefined);
      items.sort((a, b) => (b.doc.lastOpenedAt ?? '').localeCompare(a.doc.lastOpenedAt ?? ''));
    }
    const query = filter?.query?.trim().toLowerCase();
    if (query) {
      items = items.filter(
        (r) =>
          r.doc.title.toLowerCase().includes(query) ||
          r.doc.source.toLowerCase().includes(query),
      );
    }
    const key = sort ?? 'recently_edited';
    if (view !== 'recent') {
      items.sort((a, b) => {
        switch (key) {
          case 'name':
            return a.doc.title.localeCompare(b.doc.title);
          case 'created':
            return a.doc.id.localeCompare(b.doc.id);
          case 'estimated_length':
            return b.doc.estimatedDurationSeconds - a.doc.estimatedDurationSeconds;
          default:
            return b.doc.updatedAt.localeCompare(a.doc.updatedAt);
        }
      });
    }
    return { items: items.map((r) => toSummary(r.doc)), total: items.length };
  },

  create(input: { title: string; source: string }): ScriptDocument {
    state.load();
    const id = makeId();
    const doc: ScriptDocument = {
      id,
      title: input.title,
      status: 'draft',
      language: 'en',
      spokenWordCount: 0,
      estimatedDurationSeconds: 0,
      updatedAt: nowIso(),
      previewText: '',
      hasWarnings: false,
      source: input.source,
      sourceHash: '',
      scriptRevision: 1,
      settings: defaultScriptSettings(),
    };
    refreshDerived(doc);
    state.scripts.set(id, { doc });
    state.persist();
    return structuredClone(doc);
  },

  get(scriptId: string): ScriptDocument {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    record.doc.lastOpenedAt = nowIso();
    state.persist();
    return structuredClone(record.doc);
  },

  save(scriptId: string, expectedRevision: number, source: string, metadataPatch?: { title?: string }): SaveResult {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    if (record.doc.scriptRevision !== expectedRevision) {
      return { status: 'conflict', scriptRevision: record.doc.scriptRevision, savedAt: record.doc.updatedAt };
    }
    record.doc.source = source;
    if (metadataPatch?.title !== undefined) record.doc.title = metadataPatch.title;
    record.doc.scriptRevision += 1;
    record.doc.updatedAt = nowIso();
    refreshDerived(record.doc);
    state.persist();
    return { status: 'saved', scriptRevision: record.doc.scriptRevision, savedAt: record.doc.updatedAt };
  },

  rename(scriptId: string, title: string): ScriptSummary {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    record.doc.title = title;
    record.doc.updatedAt = nowIso();
    state.persist();
    return toSummary(record.doc);
  },

  duplicate(scriptId: string): ScriptSummary {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    const copy = this.create({ title: `${record.doc.title} copy`, source: record.doc.source });
    return toSummary(copy);
  },

  trash(scriptId: string, expectedRevision: number): ScriptSummary {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    expectRevision(record.doc, expectedRevision);
    record.doc.status = 'trash';
    record.doc.scriptRevision += 1;
    record.trashedAt = nowIso();
    state.persist();
    return toSummary(record.doc);
  },

  restore(scriptId: string, expectedRevision: number): ScriptSummary {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    expectRevision(record.doc, expectedRevision);
    record.doc.status = 'draft';
    record.doc.scriptRevision += 1;
    delete record.trashedAt;
    state.persist();
    return toSummary(record.doc);
  },

  deletePermanently(scriptId: string): void {
    state.load();
    state.scripts.delete(scriptId);
    state.persist();
  },
};

/* --------------------------------------------------------------- settings */

export const mockSettings = {
  get(): AppSettings {
    return structuredClone(state.settings);
  },
  update(expectedRevision: number, patch: Partial<AppSettings>): AppSettings {
    if (state.settings.revision !== expectedRevision) return structuredClone(state.settings);
    state.settings = {
      ...state.settings,
      ...patch,
      revision: state.settings.revision + 1,
    };
    return structuredClone(state.settings);
  },
  clearCache(kind: 'logs'): ClearResult {
    return { kind, clearedFiles: 0, clearedBytes: 0 };
  },
  // No `checkForUpdate`: CandidCue 1.0 has no updater to mock.
};

/* ------------------------------------------------------------ speech */

export const mockSpeech = {
  /**
   * Browser dev has no ONNX runtime, so it reports the shape of a healthy
   * installation rather than pretending to transcribe. The packaged build is
   * the only place this can be true or false for a real reason.
   *
   * `available` is DERIVED from the model mock below rather than hard-coded
   * true. The two are answers to the same question, and while they were
   * independent, deleting the model in browser dev left the Settings header
   * saying "Installed" over a body offering Download.
   */
  status(): { available: boolean; loaded: boolean; model: string } {
    return {
      available: mockModelInstalled,
      loaded: false,
      model: `${BUNDLED_MODEL_NAME} (mock)`,
    };
  },
};

/* ----------------------------------------------------- speech model install */

/**
 * The model lifecycle (#152), for a window with no Rust behind it.
 *
 * Stateful rather than a constant, because the screen it backs is a state
 * machine and a mock that always answers "installed" cannot exercise it. It
 * does NOT simulate progress on a timer: browser dev has no event bus to
 * publish `speech://model-progress` on, so a fake in-flight state would be one
 * the UI could never leave. Start and delete flip the flag; the screen re-reads
 * and sees the result, which is the honest half of the behaviour.
 *
 * Defaults to installed so existing browser-dev flows keep working; the tests
 * that care about the empty state call `reset(false)` first.
 */
const MOCK_MODEL_DOWNLOAD_BYTES = 133_895_136;
const MOCK_MODEL_INSTALLED_BYTES = 169_347_218;

let mockModelInstalled = true;

function mockModelStatus(): SpeechModelStatus {
  return {
    modelId: 'x-asr-480ms',
    modelName: `${BUNDLED_MODEL_NAME} (mock)`,
    languages: ['en', 'zh'],
    phase: mockModelInstalled ? 'installed' : 'notInstalled',
    source: mockModelInstalled ? 'downloaded' : null,
    installed: mockModelInstalled,
    supported: true,
    downloadBytes: MOCK_MODEL_DOWNLOAD_BYTES,
    installedBytes: MOCK_MODEL_INSTALLED_BYTES,
    progressBytes: 0,
    progressTotal: 0,
    operationId: null,
    error: null,
  };
}

/**
 * The language picker (#153), for a window with no Rust behind it.
 *
 * One language, because that is what the real build offers: the three-way join
 * Rust does (catalogue × recogniser × alignment engine) selects English alone
 * today, and a mock that offered French would let a browser-dev screen render a
 * row the app can never produce.
 *
 * `changeBlocked` is always false — browser dev has no coordinator and no take.
 */
function mockLanguageOptions(): SpeechLanguageOptions {
  return {
    active: {
      languageTag: 'en-US',
      primarySubtag: 'en',
      modelId: 'x-asr-480ms',
      recognizerId: BUNDLED_MODEL_NAME,
    },
    changeBlocked: false,
    languages: [
      {
        languageTag: 'en-US',
        primarySubtag: 'en',
        modelId: 'x-asr-480ms',
        recognizerId: BUNDLED_MODEL_NAME,
        active: true,
        status: mockModelStatus(),
        origins: [{ kind: 'upstream', host: 'github.com' }],
        attribution: {
          title: 'X-ASR streaming Zipformer transducer (mock)',
          author: 'Jun Guo, with the X-LANCE Lab, Shanghai Jiao Tong University',
          sourceUrl: 'https://github.com/Gilgamesh-J/X-ASR',
          distributedVia: 'https://github.com/k2-fsa/sherpa-onnx',
          license: {
            id: 'Apache-2.0',
            name: 'Apache License 2.0',
            url: 'https://www.apache.org/licenses/LICENSE-2.0',
          },
          licenseNote: null,
          modified: false,
        },
      },
    ],
    removable: [],
  };
}

export const mockSpeechModels = {
  status: mockModelStatus,
  /** No network in browser dev, so this completes immediately. */
  start(): SpeechModelStatus {
    mockModelInstalled = true;
    return mockModelStatus();
  },
  cancel: mockModelStatus,
  remove(): SpeechModelStatus {
    mockModelInstalled = false;
    return mockModelStatus();
  },
  languageOptions: mockLanguageOptions,
  /** Test seam: put the mock back into a known state. */
  reset(installed = true): void {
    mockModelInstalled = installed;
  },
};

/* ------------------------------------------------------------------ stage */

let mockStageGeneration = 0;

export const mockStage = {
  listDisplays(): DisplayDescriptor[] {
    return [
      {
        id: 'display-0',
        name: 'Built-in Display',
        physicalPosition: { x: 0, y: 0 },
        physicalSize: { width: 3024, height: 1964 },
        scaleFactor: 2,
        logicalSize: { width: 1512, height: 982 },
        primary: true,
        fingerprint: 'dsp-mock-builtin',
        topologyHash: 'top-mock-builtin',
        // A 14-inch MacBook Pro panel, as its EDID reports it.
        physicalSizeMm: { width: 302, height: 196 },
      },
      {
        id: 'display-1',
        name: 'Teleprompter Display',
        physicalPosition: { x: 3024, y: 0 },
        physicalSize: { width: 1920, height: 1080 },
        scaleFactor: 1,
        logicalSize: { width: 1920, height: 1080 },
        primary: false,
        fingerprint: 'dsp-mock-prompter',
        topologyHash: 'top-mock-prompter',
        // A 15.6-inch 1080p panel. The name says "prompter" but the grid is
        // not the 9-inch's, so identification falls through to these
        // millimetres — the path an ordinary monitor takes.
        physicalSizeMm: { width: 344, height: 194 },
      },
    ];
  },
  /**
   * Browser dev has no window manager to ask, so the mock answers with the
   * panel a control window would ordinarily be on: the primary one.
   */
  currentWindowDisplay(): DisplayDescriptor | null {
    return this.listDisplays().find((d) => d.primary) ?? null;
  },
  identifyDisplays(): IdentificationSession {
    return {
      sessionId: makeId(),
      durationMs: 2500,
      displays: this.listDisplays().map((d, index) => ({
        number: index + 1,
        fingerprint: d.fingerprint,
        name: d.name,
        logicalSize: d.logicalSize,
        primary: d.primary,
      })),
    };
  },
  async openStage(displayFingerprint?: string): Promise<StageOpenResult> {
    await delay(400);
    mockStageGeneration += 1;
    return {
      stageGeneration: mockStageGeneration,
      displayFingerprint: displayFingerprint ?? 'dsp-mock-prompter',
    };
  },
  setFullscreen(enabled: boolean): StageWindowState {
    return {
      exists: true,
      visible: true,
      fullscreen: enabled,
      nativeFullscreen: false,
      displayFingerprint: 'dsp-mock-prompter',
      stageGeneration: mockStageGeneration,
    };
  },
  /**
   * C12: browser dev used to answer `null` here, which is why the service
   * declared `StageStatus | null`. Rust always returns a status — "no stage"
   * is `exists: false` — so the mock says the same thing.
   */
  stageStatus(): StageStatus {
    return {
      exists: mockStageGeneration > 0,
      visible: mockStageGeneration > 0,
      fullscreen: false,
      displayFingerprint: 'dsp-mock-prompter',
      stageGeneration: mockStageGeneration,
      listening: mockStageGeneration > 0,
      hydrated: mockStageGeneration > 0,
      layoutReady: mockStageGeneration > 0,
      mediaHealthy: true,
    };
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
