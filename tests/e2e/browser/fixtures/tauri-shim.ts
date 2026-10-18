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
  /** ISO timestamp. Defaults to the moment the shim boots. */
  updatedAt?: string;
  /** ISO timestamp; seeds the Recent view without opening the script first. */
  lastOpenedAt?: string;
  hasWarnings?: boolean;
}

export interface ShimConfig {
  /** Mark the welcome screen as already seen so boot lands on the Library. */
  welcomed?: boolean;
  seedScripts?: ShimScriptSeed[];
  /** Speech-engine status returned by get_speech_engine_status. */
  engineStatus?: Record<string, unknown>;
  /**
   * Speech-model status returned by the four model-lifecycle commands (#152).
   * Seed it to drive the not-installed, downloading or failed states.
   *
   * Applies to the DEFAULT model (`x-asr-480ms`). Use `modelStatuses` to seed
   * more than one at a time.
   */
  modelStatus?: Record<string, unknown>;
  /**
   * Per-model status, keyed by catalogue id (#153).
   *
   * The picker addresses each model by id, so a shim that answered the same
   * object however it was asked would let a spec pass while the UI requested
   * the wrong model entirely. Falls back to `modelStatus`, then to a default.
   */
  modelStatuses?: Record<string, Record<string, unknown>>;
  /**
   * The language options the picker paints (#153).
   *
   * Defaults to English-only installed, which is what a healthy real build
   * returns: Rust joins the catalogue against the recogniser and alignment
   * tables and only English survives today.
   */
  languageOptions?: Record<string, unknown>;
  /** When set, select_speech_language rejects with this AppError. */
  failSelectLanguage?: Record<string, unknown>;
  /** When true, list_displays rejects (degraded enumeration path). */
  failListDisplays?: boolean;
  /**
   * When true, list_displays SUCCEEDS and returns nothing.
   *
   * A different state from `failListDisplays`, and one Rust can genuinely
   * produce: `available_monitors()` answering `Ok([])` is a successful call
   * about a machine with no enumerable panel. A screen that only handles the
   * rejection treats an empty list as a normal answer and confidently reports
   * where the take will land, having been told nothing.
   */
  emptyDisplays?: boolean;
  /**
   * The fingerprint of the panel `current_window_display` reports the control
   * window on — where a prompter take opens when nothing pinned is connected
   * (#302). Unset, it answers null ("could not be named"), which is what it
   * always answered: a default panel here would also feed the session's
   * mid-take "this window moved" probe, which compares it with the panel a
   * take landed on, and every take spec would see the window move.
   */
  windowDisplay?: string;
  /**
   * Hold a SUCCESSFUL list_displays open for this long, from BEFORE the app
   * boots.
   *
   * `__E2E__.setDelay` cannot reach this: it is only callable after navigation,
   * by which time the welcome screen has already asked. This is what makes the
   * in-flight state observable rather than a frame nobody can catch.
   *
   * Combining it with `failListDisplays` does NOT produce a delayed rejection —
   * the failure is thrown before the timer is armed, so it rejects at once.
   */
  listDisplaysDelayMs?: number;
  /**
   * The presentation mode the Rust document reports (§ reader-mode spec).
   *
   * Set on `stageBehavior` — the field that actually owns the mode now — so a
   * spec exercises the persisted path rather than the localStorage fallback
   * that only exists to migrate documents written before it moved.
   */
  presentationMode?: 'prompter' | 'reader';
  /**
   * Session mode a take opens in. Rust stores it as
   * `stageBehavior.promptMode`; the settings service maps it to
   * `general.defaultSessionMode` (§14.2 G).
   */
  promptMode?: 'voice' | 'manual' | 'fixed';
  /**
   * A `following` section for the settings document, camelCase as Rust sends
   * it. Absent by default, so the app takes its own defaults.
   */
  following?: Record<string, unknown>;
  /**
   * Start in Diagnostic Take (#300), for a spec that reads the stage's
   * `.diagnostics` readout or transcript bar. Absent leaves the app's own
   * default, which is Clean.
   *
   * Seeded into the localStorage overlay, where the preference lives, and only
   * when the overlay does not already state one — so a reload does not undo a
   * choice the spec has made since.
   */
  diagnosticTake?: boolean;
  /**
   * The images `resolve_asset_urls` can find, by authored href (#250), each
   * answered with the url given here. Rust leaves out any id it cannot find,
   * so an href not listed is answered the same way: missing.
   */
  assetUrls?: Record<string, string>;
  /**
   * What `get_boot_status` answers. Unset, the database came up. A report with
   * `databaseReady: false` (and a `code` such as `DATABASE_CORRUPT`) puts the
   * shell on the recovery screen instead of the app, exactly as a failed
   * `database::init` does.
   */
  bootStatus?: Record<string, unknown>;
  /** What `list_database_backups` answers — newest first, as Rust sorts them. */
  databaseBackups?: Array<Record<string, unknown>>;
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
  if (config.diagnosticTake !== undefined) {
    const OVERLAY_KEY = 'candidcue.settings-overlay.v1';
    try {
      const overlay = JSON.parse(localStorage.getItem(OVERLAY_KEY) ?? '{}') as Record<
        string,
        Record<string, unknown> | undefined
      >;
      const teleprompter = overlay.teleprompter ?? {};
      if (!('diagnosticTake' in teleprompter)) {
        overlay.teleprompter = { ...teleprompter, diagnosticTake: config.diagnosticTake };
        localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
      }
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
  /*
   * What Rust's `preview_text` answers: the spoken text (headings are not
   * spoken by default, so they are not in it), cut on a word boundary at 200
   * characters with an ellipsis.
   */
  const excerpt = (s: string) => {
    const plain = s
      .replace(/^#{1,6}\s+.*$/gm, ' ')
      .replace(/[>*_`\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length <= 200) return plain;
    const head = plain.slice(0, 200);
    const boundary = head.lastIndexOf(' ');
    return `${(boundary > 0 ? head.slice(0, boundary) : head).trimEnd()}…`;
  };

  const defaultScriptSettings = () => ({
    schemaVersion: 1,
    readHeadings: false,
    readImageAltText: false,
    readInlineCode: false,
    cueVisibility: 'subtle',
    silentBlockVisibility: 'dim',
    wordsPerMinuteEstimate: 130,
  });

  function makeDoc(id: string, title: string, source: string, status = 'draft', rev = 1): Doc {
    const w = words(source);
    return {
      id,
      title,
      status,
      language: 'en',
      spokenWordCount: w,
      estimatedDurationSeconds: Math.round((w / 130) * 60),
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
    const doc = makeDoc(seed.id, seed.title, seed.source, seed.status ?? 'draft', seed.scriptRevision ?? 1);
    if (seed.updatedAt) doc.updatedAt = seed.updatedAt;
    if (seed.lastOpenedAt) doc.lastOpenedAt = seed.lastOpenedAt;
    if (seed.hasWarnings) doc.hasWarnings = true;
    store.set(seed.id, doc);
  }

  const settingsDoc = {
    revision: 3,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
      },
      ...(config.following ? { following: config.following } : {}),
      stageBehavior: {
        // Written only when a spec asks for one: an absent field is what sends
        // the settings adapter to the overlay-migration path, and some specs
        // are about that path.
        ...(config.presentationMode ? { presentationMode: config.presentationMode } : {}),
        promptMode: config.promptMode ?? 'voice',
        fixedSpeedWpm: 140,
        horizontalMirror: false,
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        // A full BCP-47 tag, as the app's own default is and as Rust validates:
        // a bare 'en' here made a take that faithfully carried the setting look
        // like one that had dropped the region.
        language: 'en-US',
        delayProfile: 'balanced',
      },
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

  /** Rust's `AppError::stale_revision`, as the rejection it arrives as. */
  function staleRevision() {
    return {
      code: 'SCRIPT_CONFLICT',
      userMessage: 'This document changed elsewhere. Reload before saving.',
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
    /**
     * Whether THIS window is presenting (single-window takes). Separate from
     * `stage` above, which describes the second window that single-window
     * presentation deliberately never opens.
     */
    presenting: false,
    /** Every StageDirective relayed through publish_stage_command, in order. */
    directives: [] as Array<{ kind: string; payload: Record<string, unknown> }>,
    /** The panel `current_window_display` names; see `ShimConfig.windowDisplay`. */
    windowDisplay: config.windowDisplay ?? null,
    /**
     * Test seam: move the control window to another panel (or to an unnamed
     * one with null). Pair it with `emit('app://device-or-display-change')`,
     * which is what Rust sends when the window is dragged.
     */
    setWindowDisplay(fingerprint: string | null) {
      this.windowDisplay = fingerprint;
    },
    /**
     * Test seam: the next alignment sequence number, off the same counter the
     * shim's own manual-anchor snapshots use. A spec that injects snapshots
     * with numbers of its own either has them dropped as stale or leaves every
     * later shim response behind them — and then never sees a move land.
     */
    nextAlignmentSeq(): number {
      alignment.seq += 1;
      return alignment.seq;
    },
    /** Test seam: force a command to reject with the given AppError (or clear). */
    setFail(command: string, error: unknown) {
      if (error === null || error === undefined) delete this.fail[command];
      else this.fail[command] = error;
    },
    /**
     * Test seam: hold a command open for `ms` before it answers.
     *
     * `setFail` can prove what happens when a command is refused, but not what
     * the app LOOKS LIKE while one is still in flight — and for the presentation
     * commands that interval is the whole point of the cover. Without this a
     * spec can only assert the settled states either side of it.
     */
    setDelay(command: string, ms: number | null) {
      if (ms === null) delete this.delay[command];
      else this.delay[command] = ms;
    },
    delay: {} as Record<string, number>,
    /**
     * Test seam: hold a command's replies until the spec lets them go.
     *
     * `setDelay` holds for a time, and a time is a race against the runner: a
     * spec asserting what the screen shows BEFORE the reply loses whenever a
     * slow machine spends the delay getting there. Held replies answer only
     * when `setHeld(command, false)` releases them, in the order they were
     * asked, so the in-flight state lasts exactly as long as the spec needs it.
     */
    setHeld(command: string, held: boolean) {
      if (held) {
        this.held[command] = true;
        return;
      }
      delete this.held[command];
      const due = this.heldReplies.filter((reply) => reply.command === command);
      this.heldReplies = this.heldReplies.filter((reply) => reply.command !== command);
      for (const reply of due) reply.release();
    },
    held: {} as Record<string, true>,
    heldReplies: [] as Array<{ command: string; release: () => void }>,
    /**
     * Commands that have ANSWERED, in order — `calls` only records that one was
     * asked. A spec waiting on a held command has no other way to know the
     * reply landed, and the alternative is sleeping for longer than the delay
     * and hoping, which fails on a slow machine in the direction that looks
     * like a real bug.
     */
    settled: [] as string[],
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
      this.settled = [];
      this.fail = {};
      this.directives = [];
    },
  };
  if (config.failListDisplays) {
    control.fail['list_displays'] = { code: 'HARDWARE_ERROR', userMessage: 'Could not enumerate displays.' };
  }
  if (config.listDisplaysDelayMs !== undefined) {
    control.delay['list_displays'] = config.listDisplaysDelayMs;
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
   *
   * `lenTokens` is the script handed to `start_alignment`, which is what Rust
   * reports as `scriptLenTokens`. It used to be a literal 0, and the display
   * position is clamped to it, so every manual move put the glass at token 0
   * whatever the snapshot said — no spec could see a step land.
   */
  const alignment = { generation: 0, seq: 0, token: 0, lenTokens: 0 };

  /** Off the session counter's numbers, so the two cannot agree by accident. */
  let transcriptionGeneration = 40;

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
      leadMarginTokens: 2.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: alignment.token,
      confidence: 1,
      suggestionToken: null,
      scriptLenTokens: alignment.lenTokens,
      observedAtom: alignment.token,
      confirmedAtom: alignment.token,
    });
  }

  /*
   * The speech model surface (#152, #153).
   *
   * `DEFAULT_MODEL_ID` is the catalogue's short id — the one every install
   * command is addressed with, and NOT the long recogniser id that settings
   * persists. The two are different strings on purpose and a shim that
   * conflated them would hide exactly the bug the real code is careful about.
   */
  const DEFAULT_MODEL_ID = 'x-asr-480ms';
  const DEFAULT_RECOGNIZER_ID = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';

  function baseModelStatus(modelId: string): Record<string, unknown> {
    return {
      modelId,
      modelName: DEFAULT_RECOGNIZER_ID,
      languages: ['en', 'zh'],
      phase: 'installed',
      source: 'downloaded',
      installed: true,
      supported: true,
      downloadBytes: 133_895_136,
      installedBytes: 169_347_218,
      progressBytes: 0,
      progressTotal: 0,
      operationId: null,
      error: null,
    };
  }

  /** Per-model seed first, then the single-model seed, then a healthy default. */
  function modelStatusFor(modelId: string): Record<string, unknown> {
    const keyed = config.modelStatuses?.[modelId];
    if (keyed) return keyed;
    // The single-model seed answers only for the default model. Letting it
    // answer for every id is what made a multi-model spec vacuous.
    if (config.modelStatus && modelId === DEFAULT_MODEL_ID) return config.modelStatus;
    return baseModelStatus(modelId);
  }

  /**
   * English alone, because that is what a real build returns.
   *
   * Rust joins the catalogue against the recogniser table and the alignment
   * engine's language table; French, German and Spanish have neither an
   * alignment profile nor a recogniser, so they are absent rather than
   * disabled. A shim that offered them would let a spec assert against a
   * screen no backend can produce.
   */
  function defaultLanguageOptions(): Record<string, unknown> {
    const status = modelStatusFor(DEFAULT_MODEL_ID);
    return {
      active: {
        languageTag: 'en-US',
        primarySubtag: 'en',
        modelId: DEFAULT_MODEL_ID,
        recognizerId: DEFAULT_RECOGNIZER_ID,
      },
      changeBlocked: false,
      languages: [
        {
          languageTag: 'en-US',
          primarySubtag: 'en',
          modelId: DEFAULT_MODEL_ID,
          recognizerId: DEFAULT_RECOGNIZER_ID,
          active: true,
          status,
          origins: [{ kind: 'upstream', host: 'github.com' }],
          attribution: {
            title: 'X-ASR streaming Zipformer transducer (480 ms chunk, INT8, punctuated)',
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

  /**
   * The language a `select_speech_language` call has committed, if any.
   *
   * Held so the picker's SUBSEQUENT reads reflect the choice. A shim that only
   * bumped a revision left the screen showing the old active row for ever,
   * which would let a spec assert "activation worked" against a UI that had not
   * changed at all.
   */
  let selectedLanguageTag: string | null = null;

  /** The options reply, with any committed selection applied. */
  function currentLanguageOptions(): Record<string, unknown> {
    const base = (config.languageOptions ?? defaultLanguageOptions()) as {
      active: Record<string, unknown>;
      languages: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    if (selectedLanguageTag === null) return base;
    const chosen = base.languages.find((row) => row['languageTag'] === selectedLanguageTag);
    if (!chosen) return base;
    return {
      ...base,
      active: {
        languageTag: chosen['languageTag'],
        primarySubtag: chosen['primarySubtag'],
        modelId: chosen['modelId'],
        recognizerId: chosen['recognizerId'],
      },
      languages: base.languages.map((row) => ({
        ...row,
        active: row['languageTag'] === selectedLanguageTag,
      })),
    };
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

      /*
       * The shell asks this BEFORE it routes anywhere, so the shim has to
       * answer it or every journey lands on the recovery screen instead of the
       * app. It is modelled rather than left to the `default: null` below for
       * the same reason the app validates the reply: `null` is not a boot
       * status, and a test that ran against one would be testing the failure
       * path by accident.
       */
      case 'get_boot_status':
        return config.bootStatus ?? { databaseReady: true, dataDirectory: '/tmp/candidcue-e2e' };

      /*
       * The recovery screen's commands, shaped like `recovery_cmds.rs`. Both
       * repairs move the live database into `quarantine/` and say where; a
       * rescue copies the scripts into a timestamped folder beside a file that
       * names them. Each succeeds; `setFail` drives a refusal and `setHeld`
       * the moment one is still running.
       */
      case 'list_database_backups':
        return config.databaseBackups ?? [];

      case 'restore_database_backup':
      case 'rebuild_database_index': {
        const root = String(config.bootStatus?.['dataDirectory'] ?? '/tmp/candidcue-e2e');
        return { previousStateAt: `${root}/quarantine/pre-rebuild-20261018T081500Z`, restartRequired: true };
      }

      case 'rescue_scripts':
        return {
          path: '/Users/sam/Desktop/CandidCue-scripts-20261018-081512',
          scriptsCopied: store.size,
          namesFile: 'CandidCue script names.txt',
        };

      // Nothing was repaired at startup. `null` is the ordinary answer here,
      // and the shell treats it as "nothing to report".
      case 'get_startup_findings':
        return null;

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

      // Both transitions are compare-and-swaps in Rust (`repo.rs`), refused with
      // `stale_revision` when the revision sent is not the row's. Answering any
      // revision at all is what kept the editor's stale one invisible (#255).
      case 'trash_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        if (args?.['expectedRevision'] !== doc.scriptRevision) throw staleRevision();
        doc.status = 'trash';
        doc.scriptRevision += 1;
        return toSummary(doc);
      }

      case 'restore_script': {
        const id = args?.['scriptId'] as string;
        const doc = store.get(id);
        if (!doc) throw { code: 'NOT_FOUND', userMessage: 'Script not found.' };
        if (args?.['expectedRevision'] !== doc.scriptRevision) throw staleRevision();
        doc.status = 'draft';
        doc.scriptRevision += 1;
        return toSummary(doc);
      }

      case 'permanently_delete_script':
        store.delete(args?.['scriptId'] as string);
        return null;

      case 'get_speech_engine_status':
        // Rust's real shape: `{ available, loaded, model, detail? }`. The
        // recogniser is bundled, so a healthy install always answers available.
        return (
          config.engineStatus ?? {
            available: true,
            loaded: true,
            model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
          }
        );

      case 'preload_speech_engine':
        return null;

      /*
       * Speech-model install (#152). The recogniser is downloaded after
       * installation rather than bundled, so Settings and Welcome both ask
       * about it on mount.
       *
       * Modelled here rather than left to the shim's `default: null`, which
       * would hand the routes a null status and blank the Speech panel — a
       * spec would then be asserting against a screen no real backend can
       * produce. `config.modelStatus` lets a spec seed the not-installed and
       * mid-download states.
       */
      case 'get_speech_model_status':
      case 'start_speech_model_download':
      case 'cancel_speech_model_download':
      case 'delete_speech_model':
        /*
         * Routed by the requested id (#153).
         *
         * This used to return one object however it was asked, which was fine
         * while one model existed and became a trap the moment the picker
         * started addressing several: a spec could drive Download on model B,
         * be handed model A's status, and pass while the UI did the wrong
         * thing entirely.
         */
        return modelStatusFor(
          (args?.['modelId'] as string | undefined) ?? DEFAULT_MODEL_ID,
        );

      /*
       * The language picker (#153). One call carries every followable
       * language with its sizes, origin, attribution and install state.
       */
      case 'get_speech_language_options':
        return currentLanguageOptions();

      case 'select_speech_language': {
        if (config.failSelectLanguage) throw config.failSelectLanguage;
        const input = (args?.['input'] ?? {}) as {
          expectedRevision?: number;
          languageTag?: string;
        };
        // The conflict check is half of what this command is for: a stale
        // revision means another window has written since this screen loaded.
        // A shim that skipped it would hide a UI holding a superseded revision.
        if (input.expectedRevision !== settingsDoc.revision) {
          throw {
            code: 'SCRIPT_CONFLICT',
            userMessage: 'Settings changed somewhere else. Reopen this screen and try again.',
          };
        }
        const chosen = (currentLanguageOptions()['languages'] as Array<Record<string, unknown>>).find(
          (row) => row['languageTag'] === input.languageTag,
        );
        if (!chosen) {
          throw {
            code: 'STT_LANGUAGE_UNAVAILABLE',
            userMessage: 'CandidCue cannot follow that language yet.',
          };
        }
        // Both halves of the pair, together — the whole point of the command.
        const audio = (settingsDoc.value as unknown as Record<string, Record<string, unknown>>)[
          'audio'
        ];
        if (audio) {
          audio['language'] = chosen['languageTag'];
          audio['transcriptionModel'] = chosen['recognizerId'];
        }
        selectedLanguageTag = String(chosen['languageTag']);
        settingsDoc.revision += 1;
        return settingsDoc;
      }

      case 'list_displays':
        if (control.fail['list_displays']) throw control.fail['list_displays'];
        return config.emptyDisplays ? [] : displays();

      case 'current_window_display':
        return control.windowDisplay === null
          ? null
          : (displays().find((d) => d.fingerprint === control.windowDisplay) ?? null);

      case 'identify_displays':
        return {
          sessionId: 'identify-e2e',
          durationMs: 2500,
          displays: displays().map((d, i) => ({ number: i + 1, fingerprint: d.fingerprint, name: d.name, logicalSize: d.logicalSize, primary: d.primary })),
        };

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

      /*
       * Single-window presentation: the control window becomes the
       * teleprompter (borderless, monitor-sized) and comes back afterwards.
       *
       * The browser has one viewport and no window management, so the honest
       * answer is the viewport it already has — which is also what makes
       * `awaitViewportSettled` resolve on its first check here instead of
       * burning its ceiling on every Present in the suite.
       *
       * What this shim CANNOT do is resize anything, which is worth being
       * explicit about: the artifact this command exists to remove — a window
       * mid-shape-change with a half-painted webview in it — has no
       * representation in Playwright at all. The ordering is asserted in
       * `tests/unit/control/start-take.test.ts`; the appearance is not asserted
       * anywhere, and cannot be on this machine.
       */
      case 'set_control_presenting': {
        const enabled = args?.['enabled'] === true;
        control.presenting = enabled;
        // Echoed back the way Rust does, so a caller that adopts the answer —
        // `togglePresentationMode` does — sees the mode it asked for rather than
        // falling back to its own guess and hiding a mismatch the real command
        // would have surfaced.
        const mode = enabled ? (args?.['mode'] ?? 'prompter') : undefined;
        return {
          presenting: enabled,
          ...(mode === undefined ? {} : { mode }),
          width: window.innerWidth,
          height: window.innerHeight,
        };
      }

      case 'publish_stage_command': {
        const action = (args?.['action'] ?? {}) as { directive?: Record<string, unknown> };
        const directive = action.directive ?? {};
        control.directives.push({ kind: String(directive['kind'] ?? 'unknown'), payload: directive });
        return null;
      }

      case 'publish_stage_snapshot':
        return null;

      /*
       * File › Close Window (#266). Answered and NOT acted on: in Rust this
       * raises `CloseRequested`, and the shutdown handshake hanging off that
       * event — then the exit — has no representation in a browser. A spec can
       * prove the close was asked for, once and only after any question it
       * owed; that the app then quits cleanly is a packaged-app check.
       */
      case 'close_control_window':
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

      case 'list_revisions':
        return [];

      case 'list_sessions':
        return [];

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
        {
          const tokens = args?.['tokens'];
          alignment.lenTokens = Array.isArray(tokens) ? tokens.length : 0;
        }
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

      /*
       * A real generation, as Rust mints one. This used to fall through to
       * `null`, and the voice pipeline closes only a session it holds a
       * generation for — so a hard pause sent no `stop_transcription` here
       * however correctly it was wired, and no spec could tell a hard pause
       * from a soft one. Nothing is transcribed: no frame ever arrives.
       */
      case 'start_transcription':
        transcriptionGeneration += 1;
        return transcriptionGeneration;

      /*
       * Answered under the id the caller sent, as Rust answers it. Left to the
       * `default: null` below, every image would read as a lookup that failed.
       */
      case 'resolve_asset_urls': {
        const requested = (args?.['assetsToResolve'] ?? []) as Array<{ id: string; href: string }>;
        const found: Record<string, { url: string; mime: string }> = {};
        for (const request of requested) {
          const url = config.assetUrls?.[request.href];
          if (url) found[request.id] = { url, mime: 'image/png' };
        }
        return found;
      }

      default:
        return null;
    }
  }

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'control' },
      currentWebview: { label: 'control', windowLabel: 'control' },
    },
    invoke(command: string, args: Record<string, unknown> | undefined) {
      control.calls.push({ command, args: args ?? null });
      if (control.fail[command] && command !== 'list_displays') {
        control.settled.push(command);
        return Promise.reject(control.fail[command]);
      }
      const held = control.delay[command];
      try {
        const answer = handle(command, args);
        if (control.held[command]) {
          return new Promise((resolve) => {
            control.heldReplies.push({
              command,
              release: () => {
                control.settled.push(command);
                resolve(answer);
              },
            });
          });
        }
        if (held === undefined) {
          control.settled.push(command);
          return Promise.resolve(answer);
        }
        return new Promise((resolve) =>
          setTimeout(() => {
            control.settled.push(command);
            resolve(answer);
          }, held),
        );
      } catch (err) {
        control.settled.push(command);
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
