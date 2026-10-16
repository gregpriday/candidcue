/**
 * S1 regression — the stage must never broadcast a name control listens for.
 *
 * A webview `emit()` is a BROADCAST. Tauri's manager hands it to every
 * webview's JS listeners *and* to the Rust `listen_any` handlers
 * (`manager::emit` → `listeners.emit_js(all webviews)` + `listeners.emit`),
 * and a JS listener registered with the default target `Any` matches
 * unconditionally regardless of what the emitter targeted
 * (`match_any_or_filter`, tauri/src/event/listener.rs). So `emitTo` cannot
 * exclude control, and the ONLY defence is name separation.
 *
 * Before the fix the stage emitted `stage://escape-requested` and
 * `stage://motion-ack`, and src-tauri/src/app.rs re-emitted those same names to
 * control after a generation check. Control's handler therefore ran twice: once
 * straight from the stage with no check at all (a double Escape called
 * `stopSession()` twice; every motion ack was ingested twice into the §61
 * degradation logic), and once from the relay.
 *
 * This test fails if either emit site goes back to the relayed name.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STAGE_EVENT } from '../../../src/shared/contracts';

const ROOT = resolve(__dirname, '../../..');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const stageSources = sourcesUnder(join(ROOT, 'src/stage')).map((p) => readFileSync(p, 'utf8'));
const controlSources = sourcesUnder(join(ROOT, 'src/control')).map((p) => readFileSync(p, 'utf8'));

type StageEventKey = keyof typeof STAGE_EVENT;
const keys = Object.keys(STAGE_EVENT) as StageEventKey[];

/** Keys the stage window emits. */
function keysEmittedByStage(): StageEventKey[] {
  const found = new Set<StageEventKey>();
  for (const source of stageSources) {
    for (const match of source.matchAll(/emitStageEvent(?:<[^>]*>)?\(\s*STAGE_EVENT\.(\w+)/g)) {
      const key = match[1];
      if (key) found.add(key as StageEventKey);
    }
  }
  return keys.filter((k) => found.has(k));
}

/**
 * Keys the control window subscribes to, following one level of aliasing
 * (`const ALIAS = STAGE_EVENT.key`).
 */
function keysListenedByControl(): StageEventKey[] {
  const aliases = new Map<string, StageEventKey>();
  for (const source of controlSources) {
    for (const match of source.matchAll(/const\s+(\w+)\s*=\s*STAGE_EVENT\.(\w+)/g)) {
      const [, alias, key] = match;
      if (alias && key) aliases.set(alias, key as StageEventKey);
    }
  }
  const found = new Set<StageEventKey>();
  for (const source of controlSources) {
    for (const match of source.matchAll(/listen(?:<[^>]*>)?\(\s*(?:STAGE_EVENT\.)?(\w+)/g)) {
      const token = match[1];
      if (!token) continue;
      const aliased = aliases.get(token);
      if (keys.includes(token as StageEventKey) && source.includes(`STAGE_EVENT.${token}`)) {
        found.add(token as StageEventKey);
      } else if (aliased) {
        found.add(aliased);
      }
    }
  }
  return keys.filter((k) => found.has(k));
}

/** Event NAMES src-tauri/src/app.rs re-emits to the control window. */
function namesRelayedToControl(): string[] {
  const consts = new Map<string, string>();
  const windowsRs = readFileSync(join(ROOT, 'src-tauri/src/windows/mod.rs'), 'utf8');
  for (const match of windowsRs.matchAll(/pub const (\w+): &str = "([^"]+)"/g)) {
    const [, constName, value] = match;
    if (constName && value) consts.set(constName, value);
  }
  const appRs = readFileSync(join(ROOT, 'src-tauri/src/app.rs'), 'utf8');
  const relayed = new Set<string>();
  for (const match of appRs.matchAll(/emit_to\(\s*CONTROL_LABEL\s*,\s*events::(\w+)/g)) {
    const constName = match[1];
    const name = constName ? consts.get(constName) : undefined;
    if (name) relayed.add(name);
  }
  return [...relayed];
}

describe('stage → control event relay (S1)', () => {
  it('the scan finds the emit, listen and relay sites it is meant to guard', () => {
    // A guard on the guard: if these go empty the assertions below are vacuous.
    expect(keysEmittedByStage()).toContain('escapePressed');
    expect(keysEmittedByStage()).toContain('motionReport');
    // S6: the §62 stage-layout error is the third pair to follow this rule.
    expect(keysEmittedByStage()).toContain('layoutError');
    // Settings and Calibrate still listen for the relayed Escape from the
    // separate stage window they open.
    expect(keysListenedByControl()).toContain('escapeRequested');
    expect(namesRelayedToControl()).toContain(STAGE_EVENT.escapeRequested);
    expect(namesRelayedToControl()).toContain(STAGE_EVENT.motionAck);
    expect(namesRelayedToControl()).toContain(STAGE_EVENT.layoutFailed);
  });

  it('nothing Rust relays to control is also broadcast by the stage', () => {
    /*
     * `stage://intent` is deliberately absent from the relay: Rust never
     * re-emits it. The defect is the OVERLAP — a name that arrives both ways.
     */
    const relayed = new Set(namesRelayedToControl());
    const collisions = keysEmittedByStage()
      .map((key) => STAGE_EVENT[key] as string)
      .filter((name) => relayed.has(name));
    expect(
      collisions,
      `the stage broadcasts ${collisions.join(', ')}, which src-tauri/src/app.rs also relays ` +
        "to control — control's handler would run twice, the first time bypassing " +
        'the generation check in the relay',
    ).toEqual([]);
  });

  it('control does not listen for the raw names the stage broadcasts', () => {
    const listened = new Set<string>(keysListenedByControl().map((k) => STAGE_EVENT[k] as string));
    expect(listened.has(STAGE_EVENT.escapePressed)).toBe(false);
    expect(listened.has(STAGE_EVENT.motionReport)).toBe(false);
    expect(listened.has(STAGE_EVENT.layoutError)).toBe(false);
  });

  it('the relayed names are distinct from the names the stage emits', () => {
    expect(STAGE_EVENT.escapePressed).not.toBe(STAGE_EVENT.escapeRequested);
    expect(STAGE_EVENT.motionReport).not.toBe(STAGE_EVENT.motionAck);
    expect(STAGE_EVENT.layoutError).not.toBe(STAGE_EVENT.layoutFailed);
    // Only src-tauri/src/app.rs may produce the control-facing names.
    const appRs = readFileSync(join(ROOT, 'src-tauri/src/app.rs'), 'utf8');
    expect(appRs).toContain('events::STAGE_ESCAPE_REQUESTED');
    expect(appRs).toContain('events::STAGE_MOTION_ACK');
    expect(appRs).toContain('events::STAGE_LAYOUT_FAILED');
  });
});
