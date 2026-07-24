/**
 * The Coaching Rail's coach layer (§19–§27).
 *
 * Consumers should import from here rather than from the individual modules,
 * so the seam stays visible: candidates in, one `CoachRailState` out.
 */
export * from './tip-catalog';
export * from './cooldowns';
export * from './tip-policy';
export * from './luna-schema';
export * from './luna-observer';
export * from './candidate-generator';
export * from './coach-state';
export * from './ribbon';
export * from './gutter-marks';
export * from './diagnostics';
