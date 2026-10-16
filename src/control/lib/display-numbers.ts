import type { DisplayDescriptor, IdentificationSession } from '../services/stage-types';

/**
 * The number Identify displays puts on each panel, keyed by fingerprint.
 *
 * Rust numbers the overlays by position in `list_displays` order, counting
 * from 1 (`identified_displays` in `windows/mod.rs`), and `listDisplays`
 * returns that same order. Numbering the tiles by the same rule is what lets
 * someone read "2" off the glass and find the tile marked 2 — rather than
 * counting tiles, which the Automatic tile in front of them throws off by one,
 * or reading names, which two monitors of the same model share.
 *
 * Keyed by fingerprint rather than handed out by the template's loop index, so
 * a tile that is not a display (Automatic) can never take a number.
 */
export function displayNumbers(displays: readonly DisplayDescriptor[]): Map<string, number> {
  return new Map(displays.map((display, index) => [display.fingerprint, index + 1]));
}

/**
 * Whether the panels were numbered the way these tiles are.
 *
 * The tiles come from one `list_displays` call and the overlays from another,
 * and a monitor plugged, unplugged or rearranged in between renumbers the
 * glass. When this is false the tile list is stale and has to be read again —
 * a tile showing a number that a different panel is wearing is worse than no
 * number at all.
 *
 * The fingerprint alone is not enough to say "same panel". Two identical
 * monitors are told apart by an ordinal Rust hands out in enumeration order,
 * so if the platform lists them the other way round the ordinals swap with
 * them, every fingerprint still gets the same number, and the tile now
 * describes the other panel: the Primary pill on the wrong one, say. What the
 * session repeats of each panel has to agree too.
 */
export function identificationMatches(
  session: IdentificationSession,
  displays: readonly DisplayDescriptor[],
): boolean {
  if (session.displays.length !== displays.length) return false;
  const numbers = displayNumbers(displays);
  // Two entries for one panel would let the lengths agree while a tile went
  // unaccounted for.
  if (new Set(session.displays.map((d) => d.fingerprint)).size !== numbers.size) return false;
  const byFingerprint = new Map(displays.map((d) => [d.fingerprint, d]));
  return session.displays.every((d) => {
    const tile = byFingerprint.get(d.fingerprint);
    return (
      tile !== undefined &&
      numbers.get(d.fingerprint) === d.number &&
      tile.primary === d.primary &&
      tile.logicalSize.width === d.logicalSize.width &&
      tile.logicalSize.height === d.logicalSize.height
    );
  });
}
