/**
 * Classification of `HTMLMediaElement.play()` rejections (spec §40.5).
 *
 * The listener layer used to treat EVERY play() rejection as decode trouble
 * and degrade straight to the poster. Two of the three common rejections are
 * not decode problems at all:
 *
 *   - AbortError    — play() was interrupted by a pause(), a new src, or a
 *                     load(). Entirely routine during a crossfade; whatever
 *                     interrupted it owns the next state, so this must be
 *                     ignored rather than reported as broken media.
 *   - NotAllowedError — the autoplay policy refused. Nothing is wrong with the
 *                     media; retrying (or a user gesture) fixes it. Reporting
 *                     `decode_failure` here sends the operator hunting for a
 *                     codec problem that does not exist.
 *   - anything else — genuine decode/source trouble.
 *
 * Pure logic so the distinction is unit-testable without a DOM.
 */
export type PlayRejection = 'ignored' | 'autoplay_blocked' | 'media_error';

function errorName(reason: unknown): string {
  if (typeof reason === 'object' && reason !== null && 'name' in reason) {
    const name = (reason as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export function classifyPlayRejection(reason: unknown): PlayRejection {
  switch (errorName(reason)) {
    case 'AbortError':
      return 'ignored';
    case 'NotAllowedError':
      return 'autoplay_blocked';
    default:
      return 'media_error';
  }
}
