/**
 * Each syntax reference example compiled and projected as a take draws it.
 *
 * The page shows what the glass shows by asking the compiler, not by
 * describing it: the same `compile()` the editor's worker runs, then the same
 * take projection the stage applies, so an image is its one-line cue and a
 * table inside `:::stage` is still a table. A look the compiler stops
 * producing disappears from the page with it.
 *
 * Loaded on first use. The compiler is the editor worker's whole Markdown
 * stack, and nothing else in this window needs it on the main thread.
 */
import type { CompiledBlock } from '../../shared/contracts';
import { syntaxEntries } from '../../shared/markdown/syntax-reference';
import { projectForPerformance } from '../../shared/performance-view';
import { exampleForms } from './syntax-reference-view';

/** Projected blocks by entry id, one list per form in `exampleForms` order. */
export type Specimens = ReadonlyMap<string, CompiledBlock[][]>;

let loading: Promise<Specimens> | null = null;

export function loadSpecimens(): Promise<Specimens> {
  if (!loading) {
    loading = import('../../shared/markdown/compile').then(({ compile }) => {
      const specimens = new Map<string, CompiledBlock[][]>();
      for (const entry of syntaxEntries()) {
        specimens.set(
          entry.id,
          exampleForms(entry).map((form) => {
            const script = compile(form.source, { scriptId: 'syntax-reference', ...form.options });
            return projectForPerformance(script.blocks, 'take');
          }),
        );
      }
      return specimens;
    });
    // A failed load is tried again on the next open rather than remembered.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
