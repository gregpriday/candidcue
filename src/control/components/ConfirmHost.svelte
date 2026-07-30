<!--
  Renders the pending promise-based confirmation (stores/confirm.ts) as a
  dialog with F.19 destructive styling when requested.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { pendingConfirm, settleConfirm } from '../stores/confirm';
</script>

{#if $pendingConfirm}
  {@const request = $pendingConfirm.request}
  <Dialog open title={request.title} onclose={() => settleConfirm(false)}>
    <p class="confirm-body">{request.body}</p>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => settleConfirm(false)}>
        {request.cancelLabel ?? 'Cancel'}
      </Button>
      {#if request.danger}
        <!-- The confirming half of a destructive pair, so it is filled: this is
             the click that cannot be taken back, and it used to carry exactly
             the weight of the Cancel beside it. -->
        <Button variant="danger-primary" onclick={() => settleConfirm(true)}>
          {request.confirmLabel}
        </Button>
      {:else}
        <Button variant="primary" onclick={() => settleConfirm(true)}>{request.confirmLabel}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .confirm-body {
    margin: 0;
  }
</style>
