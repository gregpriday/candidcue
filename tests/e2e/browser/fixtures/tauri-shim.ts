/**
 * Injected Tauri shim for the browser E2E layer.
 *
 * Installing `window.__TAURI_INTERNALS__` before the app boots makes
 * `isTauriRuntime()` (src/control/services/ipc.ts) return TRUE, so the frontend
 * takes the SAME `ipcInvoke` -> `@tauri-apps/api/core` path it takes in
 * production — NOT the `mock-backend.ts` fallback. Every command response is
 * therefore owned here, per test, which lets these specs:
 *   - assert the exact IPC payloads the frontend emits (recorded in
 *     `window.__E2E__.calls`, shapes cross-checked against
 *     tests/fixtures/ipc/captured-invocations.json);
 *   - drive failure paths the mock backend structurally cannot produce — a
 *     rejecting `save_script` with a real `SCRIPT_CONFLICT` AppError, a
 *     rejecting `list_displays`, etc.
 *
 * The command responses below are deliberately realistic (matching the Rust
 * DTO shapes), NOT the stronger mock-backend behaviour. In particular
 * `save_script` resolves to `{ scriptRevision, savedAt }` with NO `status`
 * field (Rust has no such concept) and signals a conflict by REJECTING with an
 * AppError — which is exactly the production contract the editor store depends
 * on (see the F.8 note in src/control/stores/editor.ts).
 */
import type { Page } from '@playwright/test';

export interface ShimScriptSeed {
  id: string;
  title: string;
  source: string;
  status?: 'draft' | 'ready' | 'trash';
  scriptRevision?: number;
}

export interface ShimConfig {
  /** Mark the welcome screen as already seen so boot lands on the Library. */
  welcomed?: boolean;
  seedScripts?: ShimScriptSeed[];
  /** OpenAI key status returned by get_openai_key_status. */
  keyStatus?: Record<string, unknown>;
  /** When true, list_displays rejects (degraded enumeration path). */
  failListDisplays?: boolean;
}

/** The AppError the frontend maps to the F.8 external-change conflict sheet. */
export const SCRIPT_CONFLICT_ERROR = {
  code: 'SCRIPT_CONFLICT',
  userMessage: 'This script changed on disk outside CandidCue.',
};

/**
 * The shim body. Serialised and run via addInitScript BEFORE any app module, so
 * it may reference only its `config` argument and browser globals.
 */
function shimBody(config: ShimConfig): void {
  const WELCOMED_KEY = 'candidcue.welcomed.v1';
  if (config.welcomed) {
    try {
      localStorage.setItem(WELCOMED_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  interface Doc {
    id: string;
    title: string;
    status: string;
    language: string;
    spokenWordCount: number;
    estimatedDurationSeconds: number;
    updatedAt: string;
    lastOpenedAt?: string;
    previewText: string;
    hasWarnings: boolean;
    source: string;
    sourceHash: string;
    scriptRevision: number;
    settings: Record<string, unknown>;
  }

  const nowIso = () => new Date().toISOString();
  const words = (s: string) => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length);
  const excerpt = (s: string) =>
    s
      .replace(/[#>*_`\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

  const defaultScriptSettings = () => ({
    schemaVersion: 1,
    readHeadings: false,
    readImageAltText: false,
    readInlineCode: false,
    cueVisibility: 'subtle',
    silentBlockVisibility: 'dim',
    wordsPerMinuteEstimate: 150,
  });

  function makeDoc(id: string, title: string, source: string, status = 'draft', rev = 1): Doc {
    const w = words(source);
    return {
      id,
      title,
      status,
      language: 'en',
      spokenWordCount: w,
      estimatedDurationSeconds: Math.round((w / 150) * 60),
      updatedAt: nowIso(),
      previewText: excerpt(source),
      hasWarnings: false,
      source,
      sourceHash: `hash-${w}-${source.length}`,
      scriptRevision: rev,
      settings: defaultScriptSettings(),
    };
  }

  const store = new Map<string, Doc>();
  for (const seed of config.seedScripts ?? []) {
    store.set(seed.id, makeDoc(seed.id, seed.title, seed.source, seed.status ?? 'draft', seed.scriptRevision ?? 1));
  }

  const settingsDoc = {
    revision: 3,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 800,
        revisionIntervalMinutes: 10,
        wordsPerMinuteEstimate: 150,
        updateCheck: 'startup',
        analyticsEnabled: false,
        saveTranscript: 'off',
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 140,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 3,
        stageAcknowledgement: 'required',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'gpt-4o-mini-transcribe',
        language: 'en',
        delayProfile: 'balanced',
        softPauseAutoDisconnectMinutes: 5,
      },
      commands: { wakePhrase: 'hey cue', wakeMode: 'double_gate', lunaFallback: true, commandModel: 'gpt-4o-mini' },
      listener: {},
    },
  };

  const displays = () => [
    {
      id: 'display-0',
      name: 'Built-in Display',
      physicalPosition: { x: 0, y: 0 },
      physicalSize: { width: 3024, height: 1964 },
      scaleFactor: 2,
      logicalSize: { width: 1512, height: 982 },
      primary: true,
      fingerprint: 'dsp-e2e-builtin',
      topologyHash: 'top-e2e',
    },
    {
      id: 'display-1',
      name: 'Teleprompter Display',
      physicalPosition: { x: 3024, y: 0 },
      physicalSize: { width: 1920, height: 1080 },
      scaleFactor: 1,
      logicalSize: { width: 1920, height: 1080 },
      primary: false,
      fingerprint: 'dsp-e2e-prompter',
      topologyHash: 'top-e2e',
    },
  ];

  function toSummary(d: Doc) {
    return {
      id: d.id,
      title: d.title,
      status: d.status,
      language: d.language,
      spokenWordCount: d.spokenWordCount,
      estimatedDurationSeconds: d.estimatedDurationSeconds,
      updatedAt: d.updatedAt,
      previewText: d.previewText,
      hasWarnings: d.hasWarnings,
      scriptRevision: d.scriptRevision,
      ...(d.lastOpenedAt ? { lastOpenedAt: d.lastOpenedAt } : {}),
    };
  }

  const control = {
    calls: [] as Array<{ command: string; args: unknown }>,
    fail: {} as Record<string, unknown>,
    stageGeneration: 0,
    /** Test seam: force a command to reject with the given AppError (or clear). */
    setFail(command: string, error: unknown) {
      if (error === null || error === undefined) delete this.fail[command];
      else this.fail[command] = error;
    },
    lastCall(command: string) {
      for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i]?.command === command) return this.calls[i];
      return null;
    },
    reset() {
      this.calls = [];
      this.fail = {};
    },
  };
  if (config.failListDisplays) {
    control.fail['list_displays'] = { code: 'HARDWARE_ERROR', userMessage: 'Could not enumerate displays.' };
  }
  (window as unknown as { __E2E__: typeof control }).__E2E__ = control;

  function handle(command: string, args: Record<string, unknown> | undefined): unknown {
    // Tauri event plugin (used by @tauri-apps/api/event) — no-op softly.
    if (command.startsWith('plugin:event|')) {
      if (command === 'plugin:event|listen') return Math.floor(Math.random() * 1e9);
      return null;
    }

    switch (command) {
      case 'app_version':
        return '0.1.0-e2e';

      case 'get_settings':
        return settingsDoc;

      case 'update_settings': {
        const patch = (args?.['patch'] ?? {}) as Record<string, Record<string, unknown>>;
        const value = settingsDoc.value as unknown as Record<string, Record<string, unknown>>;
        for (const section of Object.keys(patch)) {
          value[section] = { ...(value[section] ?? {}), ...patch[section] };
        }
        settingsDoc.revision += 1;
        return settingsDoc;
      }

      case 'list_scripts': {
        const filter = (args?.['filter'] ?? {}) as Record<string, unknown>;
        const wantStatus = filter['status'] as string | undefined;
        const openedOnly = filter['openedOnly'] === true;
        const query = ((filter['query'] as string | undefined) ?? '').toLowerCase();
        let items = [...store.values()];
        items = items.filter((d) => (wantStatus === 'trash' ? d.status === 'trash' : d.status !== 'trash'));
        if (openedOnly) items = items.filter((d) => d.lastOpenedAt !== undefined);
        if (query) items = items.filter((d) => d.title.toLowerCase().includes(query) || d.source.toLowerCase().includes(query));
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { items: items.map(toSummary), total: items.length };
      }

      case 'create_script': {
        const input = (args?.['input'] ?? {}) as { title: string; source: string };
        const id = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `e2e-${Date.now()}`;
        const doc = makeDoc(id, input.title, input.source);
        store.set(id, doc);
        return doc;
      }

      case 'get_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        doc.lastOpenedAt = nowIso();
        return { ...doc };
      }

      case 'save_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        const patch = args?.['metadataPatch'] as { title?: string } | undefined;
        doc.source = args?.['source'] as string;
        if (patch?.title !== undefined) doc.title = patch.title;
        doc.scriptRevision += 1;
        doc.updatedAt = nowIso();
        doc.spokenWordCount = words(doc.source);
        doc.previewText = excerpt(doc.source);
        // Rust SaveResult: NO `status` field. Conflicts are rejections, not this.
        return { scriptRevision: doc.scriptRevision, savedAt: doc.updatedAt };
      }

      case 'rename_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        doc.title = args?.['title'] as string;
        doc.scriptRevision += 1;
        doc.updatedAt = nowIso();
        return toSummary(doc);
      }

      case 'duplicate_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        const newId = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `e2e-${Date.now()}`;
        const copy = makeDoc(newId, `${doc.title} copy`, doc.source);
        store.set(newId, copy);
        return toSummary(copy);
      }

      case 'trash_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        doc.status = 'trash';
        doc.scriptRevision += 1;
        return toSummary(doc);
      }

      case 'restore_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        doc.status = 'draft';
        doc.scriptRevision += 1;
        return toSummary(doc);
      }

      case 'permanently_delete_script':
        store.delete(args?.['scriptId'] as string);
        return null;

      case 'get_openai_key_status':
        return config.keyStatus ?? { present: false, state: 'unknown' };

      case 'list_displays':
        if (control.fail['list_displays']) throw control.fail['list_displays'];
        return displays();

      case 'identify_displays':
        return {
          sessionId: 'identify-e2e',
          durationMs: 2500,
          displays: displays().map((d, i) => ({ number: i + 1, fingerprint: d.fingerprint, name: d.name, logicalSize: d.logicalSize, primary: d.primary })),
        };

      case 'list_display_profiles':
        return [];

      case 'open_stage':
        control.stageGeneration += 1;
        return { stageGeneration: control.stageGeneration, displayFingerprint: (args?.['request'] as { displayFingerprint?: string } | undefined)?.displayFingerprint ?? 'dsp-e2e-prompter' };

      case 'close_stage':
        return null;

      case 'get_stage_status':
        return {
          exists: control.stageGeneration > 0,
          visible: control.stageGeneration > 0,
          fullscreen: false,
          displayFingerprint: 'dsp-e2e-prompter',
          stageGeneration: control.stageGeneration,
          hydrated: control.stageGeneration > 0,
          layoutReady: control.stageGeneration > 0,
          mediaHealthy: true,
        };

      case 'list_revisions':
        return [];

      case 'list_sessions':
        return [];

      case 'list_installed_listeners':
        return [];

      default:
        return null;
    }
  }

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke(command: string, args: Record<string, unknown> | undefined) {
      control.calls.push({ command, args: args ?? null });
      if (control.fail[command] && command !== 'list_displays') {
        return Promise.reject(control.fail[command]);
      }
      try {
        return Promise.resolve(handle(command, args));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    transformCallback(callback: (payload: unknown) => void) {
      const id = Math.floor(Math.random() * 1e9);
      (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
      return id;
    },
    unregisterCallback() {
      /* no-op */
    },
    convertFileSrc(path: string) {
      return path;
    },
  };
}

/** Install the shim on a page so the app boots into the production IPC path. */
export async function installTauriShim(page: Page, config: ShimConfig = {}): Promise<void> {
  await page.addInitScript(shimBody, config);
}
