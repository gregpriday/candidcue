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

  const url = $derived(image?.status === 'resolved' ? image.url : null);

  /*
   * The url that failed to load. Derived from `url` so that it resets every
   * time the url changes: the replacement gets a fresh attempt, and so does a
   * url that failed once and comes back (a file put back, an edit undone).
   * `onerror` overrides it until then.
   */
  let failedUrl = $derived.by((): string | null => {
    void url;
    return null;
  });
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
  /* Sized with the document (View › Larger / Smaller Editor Text), like the
     words around it, rather than at the chrome's fixed size. */
  .image-ref {
    color: var(--text-muted);
    font-size: calc(var(--text-sm) * var(--doc-scale, 1));
  }

  /* Sized and placed the way the stage places it (BlockView `.figure img`):
     a block of its own, centred, never wider than the column. */
  .preview-img {
    display: block;
    max-width: 100%;
    height: auto;
    max-height: 70vh;
    margin: calc(var(--space-2) * var(--doc-scale, 1)) auto;
    border-radius: var(--radius-sm);
  }

  /* The dashed edge is the "a picture belongs here" convention. It runs all
     the way round, so it is not a one-sided border on a rounded box. */
  .image-note {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 calc(var(--space-2) * var(--doc-scale, 1));
    max-width: 100%;
    padding: calc(var(--space-1) * var(--doc-scale, 1)) calc(var(--space-3) * var(--doc-scale, 1));
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    color: var(--text-secondary);
    font-size: calc(var(--text-sm) * var(--doc-scale, 1));
    font-style: normal;
    font-weight: 400;
    line-height: calc(var(--lh-label) * var(--doc-scale, 1));
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
