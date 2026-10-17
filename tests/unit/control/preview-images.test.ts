/**
 * The editor preview's image lookup (#250).
 *
 * Every image in the preview rendered as `[Image: alt]`, so a picture whose
 * file was missing read exactly like one that worked. These pin the two things
 * the fix rests on: absence from Rust's answer is the only thing that means
 * "missing" (a failed lookup must not), and the lookup is asked again only when
 * the script's set of images changes, never on an ordinary keystroke.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  beginImageResolution,
  failedImages,
  parsePreviewImageRequest,
  previewImageRequestKey,
  previewImageStates,
  resolvedImages,
} from '../../../src/control/lib/preview-images';
import {
  localImageRequests,
  resolveAssetUrls,
} from '../../../src/control/services/assets';
import { resolveDocumentAssets } from '../../../src/control/services/stage-envelope';
import { setInvokeForTesting, type InvokeFn } from '../../../src/control/services/ipc';

const SOURCE = [
  '# Launch',
  '',
  'Here is the chart.',
  '',
  '![Revenue by month](assets/revenue.png)',
  '',
  '![Gone](assets/gone.png)',
  '',
  '![Remote chart](https://example.com/chart.png)',
].join('\n');

function script(source = SOURCE, scriptId = 'script-a') {
  return compile(source, { scriptId });
}

function idFor(compiled: ReturnType<typeof script>, href: string): string {
  const asset = compiled.assets.find((a) => a.href === href);
  expect(asset, `the fixture must produce an asset for ${href}`).toBeDefined();
  return asset!.id;
}

afterEach(() => setInvokeForTesting(null));

describe('previewImageRequestKey', () => {
  it('asks about local images only, never a remote one', () => {
    const compiled = script();
    const request = parsePreviewImageRequest(previewImageRequestKey(compiled)!);
    expect(request.scriptId).toBe('script-a');
    expect(request.assets.map((a) => a.href).sort()).toEqual([
      'assets/gone.png',
      'assets/revenue.png',
    ]);
  });

  it('has nothing to ask when there is no local image', () => {
    expect(previewImageRequestKey(null)).toBeNull();
    expect(previewImageRequestKey(script('Just words.'))).toBeNull();
    expect(previewImageRequestKey(script('![Remote](https://example.com/a.png)'))).toBeNull();
  });

  it('does not change when only the prose around the images does', () => {
    const before = previewImageRequestKey(script());
    const after = previewImageRequestKey(
      script(SOURCE.replace('Here is the chart.', 'Here is the chart, and a longer sentence.')),
    );
    expect(after).toBe(before);
  });

  it('does not change when the same images move or one is used twice', () => {
    const reordered = [
      '![Gone](assets/gone.png)',
      '',
      '![Revenue by month](assets/revenue.png)',
      '',
      '![Again](assets/revenue.png)',
    ].join('\n');
    expect(previewImageRequestKey(script(reordered))).toBe(previewImageRequestKey(script()));
  });

  it('changes when an image or the script changes', () => {
    const base = previewImageRequestKey(script());
    expect(previewImageRequestKey(script(SOURCE.replace('gone.png', 'other.png')))).not.toBe(base);
    expect(previewImageRequestKey(script(SOURCE, 'script-b'))).not.toBe(base);
  });
});

describe('previewImageStates', () => {
  const compiled = script();
  const revenue = idFor(compiled, 'assets/revenue.png');
  const gone = idFor(compiled, 'assets/gone.png');
  const remote = idFor(compiled, 'https://example.com/chart.png');
  const request = parsePreviewImageRequest(previewImageRequestKey(compiled)!);

  it('is pending, not missing, before any answer', () => {
    const states = previewImageStates(compiled, null);
    expect(states[revenue]).toEqual({ status: 'pending' });
    expect(states[gone]).toEqual({ status: 'pending' });
    expect(states[remote]).toEqual({ status: 'remote' });
  });

  it('draws what Rust found and marks what it left out as missing', () => {
    const states = previewImageStates(
      compiled,
      resolvedImages('script-a', request, {
        [revenue]: { url: 'asset://localhost/revenue.png', mime: 'image/png' },
      }),
    );
    expect(states[revenue]).toEqual({ status: 'resolved', url: 'asset://localhost/revenue.png' });
    expect(states[gone]).toEqual({ status: 'missing', href: 'assets/gone.png' });
    expect(states[remote]).toEqual({ status: 'remote' });
  });

  it('does not call an image missing when the lookup itself failed', () => {
    const states = previewImageStates(compiled, failedImages('script-a'));
    expect(states[revenue]).toEqual({ status: 'error' });
    expect(states[gone]).toEqual({ status: 'error' });
    expect(states[remote]).toEqual({ status: 'remote' });
  });

  it('ignores an answer that belongs to another script', () => {
    const states = previewImageStates(
      compiled,
      resolvedImages('script-b', request, {
        [revenue]: { url: 'asset://localhost/other-script.png', mime: 'image/png' },
      }),
    );
    expect(states[revenue]).toEqual({ status: 'pending' });
    expect(states[gone]).toEqual({ status: 'pending' });
  });
});

describe('beginImageResolution', () => {
  const compiled = script();
  const revenue = idFor(compiled, 'assets/revenue.png');
  const gone = idFor(compiled, 'assets/gone.png');
  const request = parsePreviewImageRequest(previewImageRequestKey(compiled)!);
  const answered = resolvedImages('script-a', request, {
    [revenue]: { url: 'asset://localhost/revenue.png', mime: 'image/png' },
  });

  it('keeps the last answer on screen while the same script asks again', () => {
    // Adding a third picture must not flash the first two to a placeholder.
    const added = script(`${SOURCE}\n\n![New](assets/new.png)`);
    const pending = beginImageResolution(answered, 'script-a');
    const states = previewImageStates(added, pending);
    expect(states[revenue]).toEqual({ status: 'resolved', url: 'asset://localhost/revenue.png' });
    expect(states[gone]).toEqual({ status: 'missing', href: 'assets/gone.png' });
    expect(states[idFor(added, 'assets/new.png')]).toEqual({ status: 'pending' });
  });

  it('starts from nothing for another script, or after a failed lookup', () => {
    expect(beginImageResolution(answered, 'script-b')).toEqual({
      scriptId: 'script-b',
      status: 'pending',
      answered: [],
      urls: {},
    });
    expect(beginImageResolution(failedImages('script-a'), 'script-a').urls).toEqual({});
    expect(beginImageResolution(failedImages('script-a'), 'script-a').answered).toEqual([]);
  });
});

describe('resolveAssetUrls', () => {
  const requests = [
    { id: 'img-1', href: 'assets/one.png' },
    { id: 'img-2', href: 'assets/two.png' },
  ];

  it('sends the exact command and payload, and keeps an omission an omission', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const fake: InvokeFn = async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return { 'img-1': { url: 'asset://localhost/one.png', mime: 'image/png' } } as T;
    };
    setInvokeForTesting(fake);
    await expect(resolveAssetUrls('script-a', requests)).resolves.toEqual({
      'img-1': { url: 'asset://localhost/one.png', mime: 'image/png' },
    });
    expect(calls).toEqual([
      { command: 'resolve_asset_urls', args: { scriptId: 'script-a', assetsToResolve: requests } },
    ]);
  });

  it('does not ask when there is nothing to resolve', async () => {
    let called = false;
    setInvokeForTesting(async <T,>() => {
      called = true;
      return {} as T;
    });
    await expect(resolveAssetUrls('script-a', [])).resolves.toEqual({});
    expect(called).toBe(false);
  });

  it('passes a failed lookup on instead of reporting every image missing', async () => {
    setInvokeForTesting(async () => {
      throw { code: 'INTERNAL', userMessage: 'database is locked' };
    });
    await expect(resolveAssetUrls('script-a', requests)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    setInvokeForTesting(async <T,>() => null as T);
    await expect(resolveAssetUrls('script-a', requests)).rejects.toThrow();
  });

  it('leaves the stage wrapper best-effort, so an image never fails a take', async () => {
    setInvokeForTesting(async () => {
      throw { code: 'INTERNAL', userMessage: 'database is locked' };
    });
    await expect(resolveDocumentAssets(script())).resolves.toEqual({});
  });

  it('filters the compile to its local images', () => {
    expect(localImageRequests(script().assets).map((r) => r.href).sort()).toEqual([
      'assets/gone.png',
      'assets/revenue.png',
    ]);
  });
});
