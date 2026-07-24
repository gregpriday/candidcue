/**
 * Barrel for the deterministic tracking engine (spec §30–§32, §45.4, App. G).
 */
export * from './types';
export * from './profile';
export * from './normalize';
export * from './ledger';
export * from './matching';
export * from './sequence';
export * from './document-index';
export * from './candidates';
export * from './prior';
export * from './confidence';
export * from './engine';
export * from './pace';
export * from './stage-target';
export * from './worker-protocol';

/* Alignment v2 (companion specification §50.1). */
export * from './speech-units';
export * from './section-graph';
export * from './semantic-assist';
export * from './alignment-v2';
export * from './semantic-filter';
export * from './pace-estimator';
export * from './behavior';
export * from './motion-frame';
export * from './decision-log';
export * from './playback-harness';
