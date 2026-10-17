/**
 * What the editor preview knows about each image in the script (#250).
 *
 * The preview drew every image as the text `[Image: alt]`, so a picture that
 * worked and one whose file was missing looked exactly alike. It now asks Rust
 * for the same scoped urls the stage draws from, and every image is in one of
 * these states:
 *
 *   - `resolved`: Rust found the file; draw it.
 *   - `pending`:  asked, no answer yet. Only an image never answered for
 *                 before is ever in this state (see `beginImageResolution`).
 *   - `missing`:  Rust answered and left this id out, which is how it says
 *                 the file is not there.
 *   - `error`:    the lookup itself failed, so nothing is known about the file.
 *                 Saying "missing" here would be a guess.
 *   - `remote`:   an http(s) image, which is never loaded (§24.2).
 */
import type { CompiledScript } from '../../shared/contracts';
import {
  localImageRequests,
  type AssetUrlRequest,
  type ResolvedAssetUrl,
} from '../services/assets';

export type PreviewImageState =
  | { status: 'resolved'; url: string }
  | { status: 'pending' }
  /** `href` is what the Markdown asked for, so the author can tell which file. */
  | { status: 'missing'; href: string }
  | { status: 'error' }
  | { status: 'remote' };

/** Per compiler asset id. */
export type PreviewImages = Record<string, PreviewImageState>;

/** One `resolve_asset_urls` call, exactly as the preview will make it. */
export interface PreviewImageRequest {
  scriptId: string;
  assets: AssetUrlRequest[];
}

/**
 * The request a compile calls for, as a string, or `null` when the script has
 * no local image to ask about.
 *
 * A string so it can drive an effect: the compile is a new object on every
 * keystroke, but this only changes when the script does or its set of local
 * images does. Typing prose around a picture never asks Rust again. Sorted, so
 * moving an image does not count as a change either. `parsePreviewImageRequest`
 * turns it back into the request.
 */
export function previewImageRequestKey(script: CompiledScript | null | undefined): string | null {
  if (!script) return null;
  const seen = new Set<string>();
  const assets: AssetUrlRequest[] = [];
  for (const request of localImageRequests(script.assets)) {
    // One picture used twice is one asset id, and Rust needs asking once.
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    assets.push(request);
  }
  if (assets.length === 0) return null;
  assets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const request: PreviewImageRequest = { scriptId: script.scriptId, assets };
  return JSON.stringify(request);
}

export function parsePreviewImageRequest(key: string): PreviewImageRequest {
  return JSON.parse(key) as PreviewImageRequest;
}

/** Where the preview's lookup for one request stands. */
export interface ImageResolution {
  scriptId: string;
  status: 'pending' | 'resolved' | 'error';
  /** Every id the last answer covered: the ids it was asked about. */
  answered: string[];
  /** The urls in that answer. An answered id not in here is missing. */
  urls: Record<string, ResolvedAssetUrl>;
}

/**
 * The state to show while a new request is in flight.
 *
 * The last answer for the same script stays on screen: an image id is a hash
 * of its authored path, and within one script one path is one file, so the
 * old answer for an id is still the right one until the new answer lands.
 * Without that, adding one picture would flash every other picture to a
 * placeholder and back. A previous answer for another script is dropped, since
 * two scripts can each have their own `assets/chart.png`.
 */
export function beginImageResolution(
  previous: ImageResolution | null,
  scriptId: string,
): ImageResolution {
  const carried = previous?.scriptId === scriptId && previous.status !== 'error';
  return {
    scriptId,
    status: 'pending',
    answered: carried ? previous.answered : [],
    urls: carried ? previous.urls : {},
  };
}

export function resolvedImages(
  scriptId: string,
  request: PreviewImageRequest,
  urls: Record<string, ResolvedAssetUrl>,
): ImageResolution {
  return { scriptId, status: 'resolved', answered: request.assets.map((a) => a.id), urls };
}

export function failedImages(scriptId: string): ImageResolution {
  return { scriptId, status: 'error', answered: [], urls: {} };
}

/**
 * Each image's state, for the renderers. A resolution that belongs to another
 * script says nothing about this one: until this script's own answer lands,
 * its images are pending.
 */
export function previewImageStates(
  script: CompiledScript | null | undefined,
  resolution: ImageResolution | null,
): PreviewImages {
  const states: PreviewImages = {};
  if (!script) return states;
  const current = resolution?.scriptId === script.scriptId ? resolution : null;
  const answered = new Set(current?.answered ?? []);
  for (const asset of script.assets) {
    if (asset.kind !== 'image') continue;
    if (asset.remote) {
      states[asset.id] = { status: 'remote' };
      continue;
    }
    const resolved = current?.urls[asset.id];
    if (resolved) {
      states[asset.id] = { status: 'resolved', url: resolved.url };
    } else if (answered.has(asset.id)) {
      states[asset.id] = { status: 'missing', href: asset.href };
    } else if (current?.status === 'error') {
      states[asset.id] = { status: 'error' };
    } else {
      // Not asked about yet, or asked and waiting.
      states[asset.id] = { status: 'pending' };
    }
  }
  return states;
}
