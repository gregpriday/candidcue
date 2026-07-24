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
import {
  countWords,
  estimateDurationSeconds,
  hashSource,
  plainExcerpt,
} from '../lib/format';
import type {
  AppSettings,
  ClearResult,
  UpdateCheckResult,
} from './settings-types';
import { defaultAppSettings } from './settings-types';
import type {
  KeyValidationResult,
  OpenAiKeyStatus,
} from './secrets-types';
import type {
  DisplayDescriptor,
  IdentificationSession,
  StageOpenResult,
  StageWindowState,
} from './stage-types';
import type { SaveResult, ScriptListFilter, ScriptPage, ScriptSort } from './scripts-types';

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
    wordsPerMinuteEstimate: 150,
  };
}

class MockState {
  scripts = new Map<string, MockScriptRecord>();
  settings: AppSettings = defaultAppSettings();
  /** Only redacted metadata is retained — never the key itself. */
  keyStatus: OpenAiKeyStatus = { present: false, state: 'unknown' };
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

  trash(scriptId: string): ScriptSummary {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
    record.doc.status = 'trash';
    record.doc.scriptRevision += 1;
    record.trashedAt = nowIso();
    state.persist();
    return toSummary(record.doc);
  },

  restore(scriptId: string): ScriptSummary {
    state.load();
    const record = state.scripts.get(scriptId);
    if (!record) throw new Error(`SCRIPT_FILE_MISSING: ${scriptId}`);
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
  clearCache(kind: string): ClearResult {
    return { kind, clearedFiles: 0, clearedBytes: 0 };
  },
  checkForUpdate(): UpdateCheckResult {
    // Browser dev has no updater either; say so rather than claim currency.
    return { status: 'unsupported', currentVersion: '0.1.0-dev' };
  },
};

/* ---------------------------------------------------------------- secrets */

export const mockSecrets = {
  async validate(candidateKey: string): Promise<KeyValidationResult> {
    await delay(500);
    if (!/^sk-/.test(candidateKey.trim())) {
      return { status: 'invalid' };
    }
    return { status: 'valid', models: { realtime: true, command: true } };
  },
  save(candidateKey: string): OpenAiKeyStatus {
    // Only the redacted tail is retained, mirroring the Rust contract.
    state.keyStatus = {
      present: true,
      lastFour: candidateKey.trim().slice(-4),
      state: 'connected',
      lastValidatedAt: nowIso(),
    };
    return { ...state.keyStatus };
  },
  status(): OpenAiKeyStatus {
    return { ...state.keyStatus };
  },
  remove(): void {
    state.keyStatus = { present: false, state: 'unknown' };
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
      },
    ];
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
      hydrated: mockStageGeneration > 0,
      layoutReady: mockStageGeneration > 0,
      mediaHealthy: true,
    };
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
