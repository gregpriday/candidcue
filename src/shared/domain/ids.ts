// Nominal-ish string aliases for the core entity identifiers. Kept as plain
// strings so they cross the IPC and persistence boundaries without ceremony.
export type ProjectId = string;
export type DocumentId = string;
export type PlanId = string;
export type SessionId = string;
export type TurnId = string;
export type CoverageItemId = string;

/** Generate a fresh UUID. Works in both the Node main process and renderers. */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}
