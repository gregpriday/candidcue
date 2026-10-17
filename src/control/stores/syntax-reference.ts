/**
 * Whether the script syntax reference is open (#305).
 *
 * A store rather than a flag in App.svelte, because two places open it and only
 * one of them is the shell: Help › Script Syntax Reference runs through the
 * command registry, and the editor's own button sits in a route that has no
 * handle on the shell's actions. One SyntaxReferenceDialog in App.svelte reads
 * this, the same arrangement as the confirmation sheet.
 */
import { writable, type Readable } from 'svelte/store';

const store = writable(false);
export const syntaxReferenceOpen: Readable<boolean> = { subscribe: store.subscribe };

export function openSyntaxReference(): void {
  store.set(true);
}

export function closeSyntaxReference(): void {
  store.set(false);
}
