<!--
  One image in the editor preview (#250, spec §13.2).

  Draws only a url Rust resolved — never the authored href, which the webview
  has no business loading. Everything else is a labelled note, and a note
  never looks like a picture: an image whose file is gone used to read exactly
  like one that works. Phrasing content only, because an image can sit inside
  a paragraph, a link label or a table cell.
-->
<script lang="ts">
  import type { PreviewImageState } from '../lib/preview-images';

  interface Props {
    assetId: string;
    alt: string;
    /** Absent when the caller has no image information at all. */
    image?: PreviewImageState | undefined;
  }

  let { assetId, alt, image }: Props = $props();

  /*
   * The url that failed to load, rather than a flag: a flag would outlive the
   * url and mark its replacement broken too, while this clears itself the
   * moment the url changes.
   */
  let failedUrl = $state<string | null>(null);

  const url = $derived(image?.status === 'resolved' ? image.url : null);
  const failed = $derived(url !== null && failedUrl === url);

  const note = $derived.by((): { label: string; detail: string; problem: boolean } | null => {
    if (!image || (url !== null && !failed)) return null;
    switch (image.status) {
      case 'pending':
        return { label: 'Loading image…', detail: alt, problem: false };
      case 'missing':
        return { label: 'Image not found', detail: alt || image.href, problem: true };
      case 'remote':
        return { label: 'Remote image not shown', detail: alt, problem: false };
      default:
        // A lookup that failed, or a url the webview could not load.
        return { label: 'Image could not be loaded', detail: alt, problem: true };
    }
  });
</script>

{#if !image}
  <span class="image-ref" title={alt}>[Image: {alt || assetId}]</span>
{:else if note}
  <span
    class="image-note"
    class:problem={note.problem}
    data-image-state={failed ? 'error' : image.status}
    title={image.status === 'missing' ? image.href : undefined}
  >
    <span class="label">{note.label}</span>
    {#if note.detail}
      <span class="detail">{note.detail}</span>
    {/if}
  </span>
{:else if url}
  <img
    class="preview-img"
    src={url}
    {alt}
    draggable="false"
    onerror={() => {
      failedUrl = url;
    }}
  />
{/if}

<style>
  .image-ref {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  /* Sized and placed the way the stage places it (BlockView `.figure img`):
     a block of its own, centred, never wider than the column. */
  .preview-img {
    display: block;
    max-width: 100%;
    height: auto;
    max-height: 70vh;
    margin: var(--space-2) auto;
    border-radius: var(--radius-sm);
  }

  /* The dashed edge is the "a picture belongs here" convention. It runs all
     the way round, so it is not a one-sided border on a rounded box. */
  .image-note {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-2);
    max-width: 100%;
    padding: var(--space-1) var(--space-3);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-style: normal;
    font-weight: 400;
    line-height: var(--lh-label);
    letter-spacing: normal;
    overflow-wrap: anywhere;
  }
  .image-note .label {
    font-weight: 600;
  }
  .image-note.problem {
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .image-note.problem .label {
    color: var(--danger);
  }
</style>
