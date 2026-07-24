/**
 * GPT-5.6 Luna semantic sidecar and live coaching engine
 * (companion spec Parts VII and VIII).
 */
export * from './types';
export * from './hash';
export * from './validate';
export * from './landmark-index';
export * from './context';
export * from './fusion';
export * from './scheduler';
/*
 * `coach-engine.ts` was removed here. It exported a second, superseded tip
 * catalog (12 codes, different copy, different priorities, different display
 * times) alongside `FIDELITY_POLICY` and its own `renderTipText`, and its only
 * reference anywhere was this line. Its fidelity codes duplicated the shipping
 * ones — `number_changed` / `name_changed` / `critical_word_changed` against
 * `CRITICAL_NUMBER` / `CRITICAL_NAME` / `CRITICAL_NEGATION` — which
 * `coaching/fidelity/comparator.ts` produces and `coaching/coach/tip-catalog.ts`
 * words. The coaching-rail specification's §0 gives that catalog precedence,
 * and two catalogs with different copy and different cooldowns is not a state
 * to wire a live rail into.
 *
 * The v1 *wire* codes in `types.ts` and `validate.ts` are untouched and still
 * live: they are the Luna structured-output schema shared with
 * `src-tauri/src/openai/semantic.rs`.
 */
export * from './invoker';
