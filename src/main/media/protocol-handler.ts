import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { resolveMediaPath } from './media-resolver';

export const CANDIDCUE_SCHEME = 'candidcue';

/** Privileges must be registered before app `ready` (spec §20.2). */
export function registerCandidCueSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CANDIDCUE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true, // video range requests
        corsEnabled: false,
      },
    },
  ]);
}

/**
 * Serve approved local assets over candidcue://. Media requests are resolved
 * through {@link resolveMediaPath}, which rejects traversal and off-root paths.
 * Renderer bundles are served from their own packaged root. Arbitrary network
 * URLs and user file paths are never proxied.
 */
export function registerCandidCueProtocol(roots: { videosRoot: string; rendererRoot: string }): void {
  protocol.handle(CANDIDCUE_SCHEME, (request) => {
    const url = new URL(request.url);
    try {
      if (url.hostname === 'media') {
        const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
        const abs = resolveMediaPath(roots.videosRoot, rel);
        return net.fetch(pathToFileURL(abs).toString());
      }
      if (url.hostname === 'app') {
        const rel = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'control.html';
        const abs = resolveMediaPath(roots.rendererRoot, rel);
        return net.fetch(pathToFileURL(abs).toString());
      }
      return new Response('Not found', { status: 404 });
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  });
}

/** Build a candidcue://media URL for a manifest relative path. */
export function mediaUrl(relativePath: string): string {
  return `${CANDIDCUE_SCHEME}://media/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}
