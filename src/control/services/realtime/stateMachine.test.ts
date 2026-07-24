import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, RealtimeStateMachine, resolveTransition } from './stateMachine';
import type { RealtimeState } from '../../../shared/contracts';

describe('RealtimeStateMachine (spec §29.1)', () => {
  it('walks the happy path start sequence to listening', () => {
    const machine = new RealtimeStateMachine();
    expect(machine.state).toBe('idle');
    machine.transition('start');
    expect(machine.state).toBe('requesting_permission');
    machine.transition('permission_granted');
    expect(machine.state).toBe('opening_microphone');
    machine.transition('microphone_open');
    expect(machine.state).toBe('minting_credential');
    machine.transition('credential_minted');
    expect(machine.state).toBe('negotiating');
    machine.transition('negotiated');
    expect(machine.state).toBe('ready');
    machine.transition('start_listening');
    expect(machine.state).toBe('listening');
  });

  it('supports listening ↔ soft_paused', () => {
    const machine = atState('listening');
    machine.transition('soft_pause');
    expect(machine.state).toBe('soft_paused');
    machine.transition('resume');
    expect(machine.state).toBe('listening');
  });

  it('routes connection loss through reconnecting and lands paused with position held', () => {
    const machine = atState('listening');
    machine.transition('connection_lost');
    expect(machine.state).toBe('reconnecting');
    machine.transition('reconnected');
    expect(machine.state).toBe('soft_paused'); // explicit resume required (§29.6)
  });

  it('stops through stopping back to idle', () => {
    const machine = atState('listening');
    machine.transition('stop');
    expect(machine.state).toBe('stopping');
    machine.transition('stopped');
    expect(machine.state).toBe('idle');
  });

  it('suspend forces a pause from active states (§29.8)', () => {
    expect(atState('listening').transition('suspend')).toBe('soft_paused');
    expect(atState('ready').transition('suspend')).toBe('soft_paused');
  });

  it('allows error escapes from every transitional or active state', () => {
    const activeStates: RealtimeState[] = [
      'requesting_permission',
      'opening_microphone',
      'minting_credential',
      'negotiating',
      'ready',
      'listening',
      'soft_paused',
      'reconnecting',
      'stopping',
    ];
    for (const state of activeStates) {
      expect(resolveTransition(state, 'recoverable_error')).toBe('recoverable_error');
      expect(resolveTransition(state, 'fatal_error')).toBe('fatal_error');
    }
    // idle cannot error.
    expect(resolveTransition('idle', 'recoverable_error')).toBeNull();
  });

  it('recoverable_error retries via a fresh credential; fatal requires reset', () => {
    const machine = atState('listening');
    machine.transition('recoverable_error');
    machine.transition('retry');
    expect(machine.state).toBe('minting_credential');

    const fatal = atState('listening');
    fatal.transition('fatal_error');
    expect(fatal.canTransition('retry')).toBe(false);
    fatal.transition('reset');
    expect(fatal.state).toBe('idle');
  });

  it('throws on invalid transitions and leaves state untouched', () => {
    const machine = new RealtimeStateMachine();
    expect(() => machine.transition('resume')).toThrow(InvalidTransitionError);
    expect(machine.state).toBe('idle');
    expect(machine.tryTransition('resume')).toBe('idle'); // safe variant
  });

  it('notifies listeners on change with previous state and event', () => {
    const machine = new RealtimeStateMachine();
    const seen: string[] = [];
    const off = machine.onChange((next, previous, event) => seen.push(`${previous}>${next}:${event}`));
    machine.transition('start');
    off();
    machine.transition('permission_granted');
    expect(seen).toEqual(['idle>requesting_permission:start']);
  });
});

function atState(target: 'listening' | 'ready'): RealtimeStateMachine {
  const machine = new RealtimeStateMachine();
  machine.transition('start');
  machine.transition('permission_granted');
  machine.transition('microphone_open');
  machine.transition('credential_minted');
  machine.transition('negotiated');
  if (target === 'listening') machine.transition('start_listening');
  return machine;
}
