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
  /** Inworld key status returned by get_inworld_key_status. */
  keyStatus?: Record<string, unknown>;
  /** When true, list_displays rejects (degraded enumeration path). */
  failListDisplays?: boolean;
  /**
   * Session mode a take opens in. Rust stores it as
   * `stageBehavior.promptMode`; the settings service maps it to
   * `general.defaultSessionMode` (§14.2 G).
   */
  promptMode?: 'voice' | 'manual' | 'fixed';
  /**
   * §37 Listener defaults, as the Rust document stores them
   * (`settings.listener`). Configurable so a spec can prove the settings really
   * reach the controls: these fields had no reader at all before, and a default
   * that coincidentally matched a hard-coded literal is exactly what hid it.
   */
  listenerSettings?: Record<string, unknown>;
  /** Installed Listener packs returned by `list_installed_listeners`. */
  installedListeners?: Array<Record<string, unknown>>;
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
        promptMode: config.promptMode ?? 'voice',
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
        transcriptionModel: 'inworld/inworld-stt-1',
        // A full BCP-47 tag, as the app's own default is and as Rust validates:
        // a bare 'en' here made a take that faithfully carried the setting look
        // like one that had dropped the region.
        language: 'en-US',
        delayProfile: 'balanced',
        softPauseAutoDisconnectMinutes: 5,
      },
      listener: config.listenerSettings ?? {},
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

  /**
   * Session rows, exactly as `sessions::start_session` mints them: RUST
   * ASSIGNS the id and the session generation, control adopts. Getting this
   * wrong is not academic — a control window that proposes its own generation
   * has every stage payload rejected by `validate_stage_payload_header`.
   */
  interface SessionRow {
    id: string;
    sessionGeneration: number;
    scriptId: string;
    scriptSourceHash: string;
    startedAt: string;
    endedAt?: string;
    mode: string;
    startTokenIndex: number;
    softPauseMs: number;
    commandCount: number;
    retakeCount: number;
    reconnectCount: number;
    manualCorrectionCount: number;
    transcriptRetained: boolean;
  }
  const sessions = new Map<string, SessionRow>();

  /**
   * Event-plugin listener registry, keyed by event name. Tauri's `listen()`
   * calls `plugin:event|listen` with a `handler` callback id minted by
   * `transformCallback`, and Rust later evaluates `window['_<id>'](event)`.
   * Reproducing that here is what makes Rust→control events (`stage://closed`,
   * `stage://error`, …) drivable from a spec.
   */
  const listeners = new Map<string, Set<number>>();

  const control = {
    calls: [] as Array<{ command: string; args: unknown }>,
    fail: {} as Record<string, unknown>,
    stageGeneration: 0,
    /**
     * Deliberately NOT starting at 0, so the first session of a test gets
     * generation 7 rather than 1. A control window that hard-codes 1 (as it
     * once did) then fails visibly instead of coincidentally agreeing — which
     * is the whole point of asserting on it.
     */
    sessionGeneration: 6,
    /**
     * The last row `start_session` minted. Specs compare the stage envelope
     * against this to prove control ADOPTED Rust's id and generation instead
     * of proposing its own (the C1 defect that made every stage payload fail
     * `validate_stage_payload_header` in a packaged build).
     */
    lastSession: null as null | { id: string; sessionGeneration: number },
    /** Stage window state, mutated by open/close/fullscreen like Rust's. */
    stage: { exists: false, visible: false, fullscreen: false, nativeFullscreen: false },
    /** Every StageDirective relayed through publish_stage_command, in order. */
    directives: [] as Array<{ kind: string; payload: Record<string, unknown> }>,
    /** Test seam: force a command to reject with the given AppError (or clear). */
    setFail(command: string, error: unknown) {
      if (error === null || error === undefined) delete this.fail[command];
      else this.fail[command] = error;
    },
    lastCall(command: string) {
      for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i]?.command === command) return this.calls[i];
      return null;
    },
    /** Directives of one kind, oldest first (e.g. every 'position' move). */
    directivesOfKind(kind: string) {
      return this.directives.filter((d) => d.kind === kind);
    },
    /**
     * Deliver a Rust → control event exactly the way Tauri does. Returns how
     * many listeners received it, so a spec can prove it was not shouting into
     * an empty room.
     */
    emit(event: string, payload: unknown): number {
      const ids = listeners.get(event);
      if (!ids || ids.size === 0) return 0;
      let delivered = 0;
      for (const id of [...ids]) {
        const cb = (window as unknown as Record<string, unknown>)[`_${id}`];
        if (typeof cb === 'function') {
          (cb as (e: unknown) => void)({ event, id, payload });
          delivered += 1;
        }
      }
      return delivered;
    },
    reset() {
      this.calls = [];
      this.fail = {};
      this.directives = [];
    },
  };
  if (config.failListDisplays) {
    control.fail['list_displays'] = { code: 'HARDWARE_ERROR', userMessage: 'Could not enumerate displays.' };
  }
  (window as unknown as { __E2E__: typeof control }).__E2E__ = control;

  /**
   * The manual-mode alignment state, and the snapshot that carries it.
   *
   * Every field the control-side validator insists on is present and finite:
   * `validateAlignmentSnapshot` drops a malformed payload silently, which would
   * look exactly like no alignment feed at all (src/shared/contracts/
   * alignment.ts explains why it is that strict — one NaN poisons the stage's
   * motion plant for the life of the session).
   */
  const alignment = { generation: 0, seq: 0, token: 0 };

  function publishAlignment(): void {
    if (alignment.generation === 0) return;
    alignment.seq += 1;
    control.emit('align://snapshot', {
      sessionGeneration: alignment.generation,
      seq: alignment.seq,
      // A manual move is not a guess: the operator said where they are, so the
      // engine is following, at the position it was given, with no lead.
      state: 'following',
      decision: 'manualAnchor',
      confirmedToken: alignment.token,
      observedToken: alignment.token,
      rateTokensPerSecond: 0,
      evidenceAudioMs: 0,
      atAudioMs: 0,
      maxPredictionMs: 0,
      pauseOnsetMs: 0,
      leadFloorMs: 0,
      maxLeadTokens: 0,
      displayLimitToken: alignment.token,
      confidence: 1,
      suggestionToken: null,
      scriptLenTokens: 0,
      observedAtom: alignment.token,
      confirmedAtom: alignment.token,
    });
  }

  function handle(command: string, args: Record<string, unknown> | undefined): unknown {
    /*
     * Tauri event plugin (used by @tauri-apps/api/event). `listen` returns the
     * event id that `unlisten` is later called with; here the handler callback
     * id doubles as that id, which is enough to unregister precisely.
     */
    if (command.startsWith('plugin:event|')) {
      if (command === 'plugin:event|listen') {
        const event = String(args?.['event'] ?? '');
        const handler = Number(args?.['handler'] ?? 0);
        let set = listeners.get(event);
        if (!set) {
          set = new Set<number>();
          listeners.set(event, set);
        }
        set.add(handler);
        return handler;
      }
      if (command === 'plugin:event|unlisten') {
        listeners.get(String(args?.['event'] ?? ''))?.delete(Number(args?.['eventId'] ?? 0));
        return null;
      }
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

      case 'get_inworld_key_status':
        // Rust's real shape: `{ present, hint?, source }` — `source` is what
        // tells Settings whether a debug build's INWORLD_API_KEY is in play.
        return config.keyStatus ?? { present: false, source: 'none' };

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

      case 'save_display_profile': {
        const profile = (args?.['profile'] ?? {}) as Record<string, unknown>;
        return { ...profile, id: (profile['id'] as string | undefined) ?? 'profile-e2e', updatedAt: nowIso() };
      }

      case 'open_stage':
        control.stageGeneration += 1;
        control.stage = { exists: true, visible: false, fullscreen: false, nativeFullscreen: false };
        return { stageGeneration: control.stageGeneration, displayFingerprint: (args?.['request'] as { displayFingerprint?: string } | undefined)?.displayFingerprint ?? 'dsp-e2e-prompter' };

      case 'close_stage':
        control.stage = { exists: false, visible: false, fullscreen: false, nativeFullscreen: false };
        return null;

      /**
       * §29.2 step 3. Rust answers with a StageAck; `accepted: false` is how a
       * stale generation is refused, so the shape has to be real — the whole
       * start sequence hangs on control noticing the difference.
       */
      case 'publish_stage_document': {
        const envelope = (args?.['documentEnvelope'] ?? {}) as { stageGeneration?: number };
        const generation = envelope.stageGeneration ?? control.stageGeneration;
        return {
          accepted: generation === control.stageGeneration,
          stageGeneration: control.stageGeneration,
          sessionId: (args?.['sessionId'] as string | undefined) ?? null,
        };
      }

      case 'set_stage_fullscreen': {
        const enabled = args?.['enabled'] === true;
        control.stage = {
          exists: true,
          visible: true,
          fullscreen: enabled,
          nativeFullscreen: enabled && args?.['native'] === true,
        };
        return {
          exists: true,
          visible: true,
          fullscreen: enabled,
          nativeFullscreen: control.stage.nativeFullscreen,
          displayFingerprint: 'dsp-e2e-prompter',
          stageGeneration: control.stageGeneration,
        };
      }

      case 'publish_stage_command': {
        const action = (args?.['action'] ?? {}) as { directive?: Record<string, unknown> };
        const directive = action.directive ?? {};
        control.directives.push({ kind: String(directive['kind'] ?? 'unknown'), payload: directive });
        return null;
      }

      case 'publish_listener_state':
      case 'publish_stage_snapshot':
        return null;

      case 'get_stage_status':
        return {
          exists: control.stage.exists,
          visible: control.stage.visible,
          fullscreen: control.stage.fullscreen,
          displayFingerprint: 'dsp-e2e-prompter',
          stageGeneration: control.stageGeneration,
          // The stage window really does hydrate and lay out in Tauri; here it
          // is the poll backstop in `waitForStageReady` that resolves the
          // handshake, since no second webview exists to emit `stage://ready`.
          listening: control.stage.exists,
          hydrated: control.stage.exists,
          layoutReady: control.stage.exists,
          mediaHealthy: true,
        };

      /**
       * `AppCoordinator::begin_session` is the ONLY writer of the session
       * generation, and the row id is Rust's uuid — control adopts both.
       */
      case 'start_session': {
        const input = (args?.['input'] ?? {}) as {
          scriptId: string;
          scriptSourceHash: string;
          mode: string;
          startTokenIndex?: number;
        };
        if (!store.has(input.scriptId)) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        if (!['voice', 'manual', 'fixed'].includes(input.mode)) {
          throw { code: 'INVALID_INPUT', userMessage: 'Session mode must be voice, manual, or fixed.' };
        }
        control.sessionGeneration += 1;
        const id = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `sess-${Date.now()}`;
        const row: SessionRow = {
          id,
          sessionGeneration: control.sessionGeneration,
          scriptId: input.scriptId,
          scriptSourceHash: input.scriptSourceHash,
          startedAt: nowIso(),
          mode: input.mode,
          startTokenIndex: input.startTokenIndex ?? 0,
          softPauseMs: 0,
          commandCount: 0,
          retakeCount: 0,
          reconnectCount: 0,
          manualCorrectionCount: 0,
          // `general.saveTranscript` is 'off' in this settings document, and
          // Rust fixes retention at session start — so this stays false.
          transcriptRetained: false,
        };
        sessions.set(id, row);
        control.lastSession = { id, sessionGeneration: row.sessionGeneration };
        return row;
      }

      case 'end_session': {
        const row = sessions.get(args?.['sessionId'] as string);
        if (!row) throw { code: 'NOT_FOUND', userMessage: 'Session not found.' };
        row.endedAt = nowIso();
        return row;
      }

      case 'append_session_transcript':
        // Rust REFUSES retention that was not enabled at session start.
        throw { code: 'INVALID_INPUT', userMessage: 'This session does not retain transcripts.' };

      case 'list_revisions':
        return [];

      case 'list_sessions':
        return [];

      case 'list_installed_listeners':
        return config.installedListeners ?? [];

      /*
       * §29 alignment. Rust owns the engine and publishes its snapshots on
       * `align://snapshot`; this shim owns just enough of it that a MANUAL take
       * behaves the way a manual take does.
       *
       * Without this the Live screen had no reading position at all: the
       * sentence preview, the progress meter and the outline's current-section
       * highlight are all derived from a snapshot, so a stepped or jumped
       * position moved nothing on screen and three specs asserted against an
       * element that could never render. Manual moves are the one part of
       * alignment that needs no audio, no provider and no engine — the operator
       * says where they are and the answer is exactly that — so it is the one
       * part worth shimming. Voice following is not faked here and must not be.
       */
      case 'start_alignment':
        /*
         * Armed, but silent. Rust publishes nothing here either: with no audio
         * yet there is no evidence and therefore no position to report, and a
         * snapshot invented at arming time would put the Live screen into
         * "Following" over a take that has not heard a word — the confident
         * state-you-do-not-have that half these specs exist to catch.
         */
        alignment.generation = control.sessionGeneration;
        alignment.seq = 0;
        alignment.token = 0;
        return null;

      case 'stop_alignment':
        alignment.generation = 0;
        return null;

      case 'set_alignment_position': {
        const token = Number(args?.['token'] ?? 0);
        if (!Number.isFinite(token) || token < 0) return null;
        alignment.token = token;
        publishAlignment();
        return null;
      }

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

  /*
   * The event plugin injects its OWN global, separate from
   * `__TAURI_INTERNALS__`, and `@tauri-apps/api/event`'s `_unlisten` reaches
   * for it unconditionally. Without it every unlisten threw
   * `Cannot read properties of undefined (reading 'unregisterListener')` —
   * from a `.then()` nobody catches, so it surfaced as an uncaught page error.
   */
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      listeners.get(event)?.delete(eventId);
    },
  };
}

/** Install the shim on a page so the app boots into the production IPC path. */
export async function installTauriShim(page: Page, config: ShimConfig = {}): Promise<void> {
  await page.addInitScript(shimBody, config);
}
